/**
 * MCP server assembly.
 *
 * Registered directly against the low-level `Server` rather than the SDK's
 * `McpServer.registerTool` helper: that helper infers each tool's argument type
 * from its Zod schema through a `ShapeOutput` mapped type, and for schemas even
 * mildly richer than a handful of scalars the inference makes `tsc` exhaust
 * several gigabytes of heap. Registering here keeps schemas as plain Zod objects
 * and validates arguments explicitly, which is cheaper to compile and clearer
 * about what each tool accepts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodShapeToJsonSchema } from './json-schema.js';
import {
  ServerContext,
  ToolError,
  configFromEnv,
  objectArgs,
  type ServerConfig,
  type ToolAnnotations,
} from './mcp/shared.js';

/** Package version reported to MCP clients. */
export const VERSION = '0.1.0';

/** Name reported to MCP clients. */
export const SERVER_NAME = 'famistudio-mcp';

/** One tool as the server sees it. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  /** Raw Zod shape, serialized to JSON Schema for `tools/list`. */
  inputShape?: Record<string, z.ZodTypeAny>;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>, context: ServerContext) => Promise<CallToolResult>;
}

/** Collected tool definitions, keyed by name. */
export type ToolRegistry = Map<string, ToolDefinition>;

/** Create an empty registry. */
export function createRegistry(): ToolRegistry {
  return new Map<string, ToolDefinition>();
}

/** Add a tool, rejecting duplicate names. */
export function defineTool(registry: ToolRegistry, tool: ToolDefinition): void {
  if (registry.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
  registry.set(tool.name, tool);
}

/**
 * Validate `args` against a tool's shape.
 *
 * @returns the parsed args, or a message listing every problem.
 */
export function validateArgs(
  shape: Record<string, z.ZodTypeAny>,
  args: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const schema = z.object(shape).strict();
  const result = schema.safeParse(args ?? {});
  if (result.success) return { ok: true, value: result.data as Record<string, unknown> };
  const problems = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  return { ok: false, message: `Invalid arguments:\n  - ${problems.join('\n  - ')}` };
}

/** Convert a registry entry into the MCP `Tool` descriptor sent to clients. */
function toToolDescriptor(tool: ToolDefinition): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodShapeToJsonSchema(tool.inputShape ?? {}) as Tool['inputSchema'],
    annotations: tool.annotations,
  };
}

/** Render an error as a tool result the client can show to the model. */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Attach the one-shot output-directory hint to a tool result.
 *
 * The hint asks the *calling agent* to record the user's chosen directory in the
 * workspace's own AGENTS.md/CLAUDE.md. Writing that file is the agent's job, not
 * the server's: this server must not make decisions about a workspace's layout.
 */
function withAgentHint(result: CallToolResult, context: ServerContext): CallToolResult {
  const hint = context.consumeAgentHint();
  if (!hint) return result;
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: 'text', text: `${hint.message}\n\n${hint.suggestedAgentsMdSection}` },
    ],
    structuredContent: { ...(result.structuredContent ?? {}), agentHint: { ...hint } },
  };
}

/**
 * Build a server for a registry.
 *
 * Tools are advertised from the registry and dispatched by name; a handler that
 * throws becomes an `isError` result instead of killing the connection.
 */
export function createServerFromRegistry(registry: ToolRegistry, context: ServerContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'FamiStudio .fms authoring and rendering.',
        '',
        'Typical flow: compile_song_spec (or create_fms) -> verify_roundtrip -> export_audio.',
        '',
        'Key factual reminders:',
        '- FamiStudio note names are one octave above standard pitch: "C4" sounds ~523 Hz.',
        '- The NES Triangle channel sounds one octave below its note value; keep bass lines low.',
        '- With a uniform groove one tick is one frame: seconds = ticks / 60.0988 (NTSC).',
        '- This writer targets plain 2A03 only (no expansion audio).',
        '',
        'Output location - this server does not decide where files go; you do:',
        '- Pass an explicit output path on every writing tool. Absolute paths are used as given.',
        '- Relative paths land in the output directory chosen for this workspace. If none has been',
        '  chosen yet the server asks the user once and remembers the answer for this session only;',
        '  nothing is written to disk to remember it.',
        '- When that happens, record the chosen directory in this workspace\'s AGENTS.md or CLAUDE.md,',
        '  then pass it explicitly on every later call so the server never has to guess.',
        '- Use an absolute path for anything that must live elsewhere, and FAMISTUDIO_MCP_READDIRS to',
        '  read project files from outside the output directory.',
      ].join('\n'),
    },
  );

  // The context needs the connection to ask the client for its workspace roots
  // and to prompt the user for an output directory.
  context.attachServer(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.values()].map(toToolDescriptor),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = registry.get(name);
    if (!tool) {
      return errorResult(`Unknown tool "${name}". Known tools: ${[...registry.keys()].join(', ')}.`);
    }

    const args = objectArgs(request.params.arguments);
    const shape = tool.inputShape ?? {};
    const validated =
      Object.keys(shape).length > 0 ? validateArgs(shape, args) : ({ ok: true, value: args } as const);
    if (!validated.ok) return errorResult(`${name}: ${validated.message}`);

    try {
      return withAgentHint(await tool.handler(validated.value, context), context);
    } catch (error) {
      // Domain errors (policy refusals, bad input, FamiStudio failures) are part
      // of the tool contract and belong in the result; anything else is a bug
      // and gets a stack trace in the server log so it can be diagnosed.
      if (error instanceof ToolError) return errorResult(error.message);
      if (error instanceof Error && /^(Project is not valid|Refusing to)/.test(error.message)) {
        return errorResult(error.message);
      }
      process.stderr.write(`[${SERVER_NAME}] tool "${name}" threw: ${(error as Error)?.stack ?? error}\n`);
      return errorResult(`Internal error in "${name}": ${(error as Error)?.message ?? String(error)}`);
    }
  });

  return server;
}

/** Options for {@link runStdio}. */
export interface RunStdioOptions {
  config?: ServerConfig;
  /** Called once the transport is connected. */
  onReady?: (context: ServerContext) => void;
}

/**
 * Serve the MCP protocol over stdio until the client closes the pipe.
 *
 * @returns a handle whose `close()` shuts the server and transport down.
 */
export async function runStdio(options: RunStdioOptions = {}): Promise<{ close: () => Promise<void> }> {
  const context = new ServerContext(options.config ?? configFromEnv());
  const { buildRegistry } = await import('./tools.js');
  const registry = buildRegistry();
  const server = createServerFromRegistry(registry, context);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  options.onReady?.(context);

  return {
    close: async () => {
      await server.close();
    },
  };
}
