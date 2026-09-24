/**
 * Shared server infrastructure: workspace policy, project inputs and uniform
 * tool result shaping.
 *
 * Every path a tool receives is resolved through {@link ServerContext} so that
 * the server cannot be tricked into reading or writing outside the directories
 * the user opted into.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type Project, readProject, validateProject, writeFms } from '../core/index.js';
import { OutputDirResolver, defaultTempRoot, type OutputDirResolution } from './output-dir.js';

/** Raised for policy violations and other user-facing tool errors. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Runtime configuration of the server, derived from the environment. */
export interface ServerConfig {
  /** Directories tools may write into. */
  outputRoots: string[];
  /** Directories tools may read project files from. */
  inputRoots: string[];
  /** Extra read roots, e.g. a game project importing the generated audio. */
  extraReadRoots: string[];
  /** FamiStudio executable override. */
  famistudioExe?: string;
  /**
   * Where `outputRoots[0]` came from.
   *
   * `'env'` means the user configured it (`FAMISTUDIO_MCP_OUTDIR` /
   * `FAMISTUDIO_MCP_WORKSPACE`) and it should be honoured before any guess;
   * `'temp'` means it is only the built-in scratch directory.
   */
  outputRootSource: 'env' | 'temp';
}

/** Build the configuration from `FAMISTUDIO_MCP_*` environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const outDir = env.FAMISTUDIO_MCP_OUTDIR?.trim();
  const readDirs = env.FAMISTUDIO_MCP_READDIRS?.trim();
  const workspace = env.FAMISTUDIO_MCP_WORKSPACE?.trim();

  const outputRoots = outDir ? splitList(outDir) : [resolve(workspace ?? defaultTempRoot())];

  const inputRoots = [
    ...outputRoots,
    ...(readDirs ? splitList(readDirs) : []),
    ...(workspace ? [resolve(workspace)] : []),
  ];

  return {
    outputRoots: [...new Set(outputRoots)],
    inputRoots: [...new Set(inputRoots)],
    extraReadRoots: readDirs ? [...new Set(splitList(readDirs))] : [],
    famistudioExe: env.FAMISTUDIO_EXE?.trim() || undefined,
    outputRootSource: outDir || workspace ? 'env' : 'temp',
  };
}

/**
 * Split a path list on the platform's separator.
 *
 * `:` is only a separator on POSIX: on Windows it is part of every drive letter,
 * so splitting on it would turn `D:\work` into `D` and `\work`.
 */
function splitList(value: string): string[] {
  const separator = process.platform === 'win32' ? /[;,]/ : /[;:,]/;
  return value
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry));
}

/** A file the server produced, or a file it read. */
export interface ArtifactRef {
  path: string;
  bytes?: number;
}

/**
 * Schema for an inline project payload (the result of `compile_song_spec` or a
 * project read from disk).
 *
 * Expressed with `z.custom` rather than `z.record(z.unknown())`: the loose record
 * makes TypeScript's inference over the MCP SDK's `ShapeOutput` mapping blow up,
 * and the shape is validated by {@link resolveProject} anyway.
 */
export const projectPayloadSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  { message: 'expected a project object' },
);

/** True when `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Strip the quotes a JSON client may have kept around a path. */
function cleanPath(input: string, mode: 'read' | 'write'): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new ToolError(`${mode} path must be a non-empty string.`);
  }
  return input.trim().replace(/^"(.*)"$/, '$1');
}

/**
 * Recording how to persist a freshly chosen output directory.
 *
 * Produced once per session, right after the user answers the prompt. The
 * server never writes this to disk itself - deciding where a project keeps its
 * files is the caller's job, not the server's.
 */
export interface AgentHint {
  kind: 'record-output-directory';
  outputDirectory: string;
  message: string;
  suggestedAgentsMdSection: string;
}

/** Per-call context: path resolution plus the artifacts a call produced. */
export class ServerContext {
  readonly config: ServerConfig;
  readonly artifacts: ArtifactRef[] = [];
  /** Resolves - and caches - the directory generated files land in. */
  readonly outputDirs: OutputDirResolver;

  private server: Server | null = null;
  private pendingHint: AgentHint | null = null;
  private hintEmitted = false;

  constructor(config: ServerConfig = configFromEnv()) {
    this.config = config;
    this.outputDirs = new OutputDirResolver({
      envRoots: config.outputRoots,
      fromEnv: config.outputRootSource === 'env',
      tempRoot: defaultTempRoot(),
    });
  }

  /** Give the context the server connection, so it can ask the client questions. */
  attachServer(server: Server): void {
    this.server = server;
  }

  /** Default output directory (the first configured write root). */
  get defaultOutputRoot(): string {
    return this.config.outputRoots[0];
  }

  /**
   * The directory the current session writes into.
   *
   * Unlike {@link defaultOutputRoot} this reflects the caller's choice, so it is
   * what relative paths should resolve against.
   */
  get sessionOutputRoot(): string {
    return this.outputDirs.resolution?.directory ?? this.defaultOutputRoot;
  }

  /**
   * Resolve the session output directory, asking the user once if needed.
   *
   * See `src/mcp/output-dir.ts` for the priority order.
   */
  async ensureOutputDir(): Promise<OutputDirResolution> {
    const resolution = await this.outputDirs.resolve(this.server);
    // The resolution keeps reporting that the user was asked, so the one-shot
    // guard has to be separate from the queue that carries the hint out.
    if (resolution.asked && !this.hintEmitted) {
      this.hintEmitted = true;
      this.pendingHint = {
        kind: 'record-output-directory',
        outputDirectory: resolution.directory,
        message:
          `The user chose "${resolution.directory}" as the output directory for this workspace. ` +
          'Nothing was written to disk to remember it. Record it in the workspace\'s AGENTS.md ' +
          '(or CLAUDE.md) so it survives this session, and pass it explicitly on every ' +
          'famistudio-mcp call so the server never has to guess again.',
        suggestedAgentsMdSection: [
          '## famistudio-mcp',
          '',
          `Generated \`.fms\` projects and audio for this workspace go to:`,
          '',
          '```',
          resolution.directory,
          '```',
          '',
          'Pass that path explicitly on every famistudio-mcp tool call (as the `outputPath`,',
          'or the `workDir` of `verify_roundtrip`) so the server never has to guess.',
        ].join('\n'),
      };
    }
    return resolution;
  }

  /** Take the one-shot hint produced by the most recent output-directory prompt. */
  consumeAgentHint(): AgentHint | null {
    const hint = this.pendingHint;
    this.pendingHint = null;
    return hint;
  }

  /** Ensure a directory exists and return it. */
  async ensureDir(path: string): Promise<string> {
    await mkdir(path, { recursive: true });
    return path;
  }

  /**
   * Resolve a path the caller wants to **read** from.
   *
   * Relative paths resolve against the session output directory. Absolute paths
   * are accepted only inside a configured read root, so a misbehaving client
   * cannot use the server to exfiltrate arbitrary files.
   */
  resolveReadPath(input: string): string {
    const trimmed = cleanPath(input, 'read');
    const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(this.sessionOutputRoot, trimmed);
    const roots = [...this.config.inputRoots, this.sessionOutputRoot];
    if (!roots.some((root) => isInside(root, absolute))) {
      throw new ToolError(
        `Not allowed to read "${absolute}".\n` +
          `Allowed read roots: ${roots.join(', ')}.\n` +
          'Set FAMISTUDIO_MCP_READDIRS to allow reading from another location.',
      );
    }
    return absolute;
  }

  /**
   * Resolve a path the caller wants to **write** to.
   *
   * This server does not decide where output belongs. An absolute path is the
   * caller's explicit decision and is accepted as-is; a relative path lands
   * inside the session output directory and may not climb out of it with `..`.
   */
  async resolveWritePath(input: string): Promise<string> {
    const trimmed = cleanPath(input, 'write');
    if (isAbsolute(trimmed)) return resolve(trimmed);

    const { directory } = await this.ensureOutputDir();
    const absolute = resolve(directory, trimmed);
    if (!isInside(directory, absolute)) {
      throw new ToolError(
        `"${input}" resolves outside the output directory "${directory}".\n` +
          'Pass an absolute path to write somewhere else.',
      );
    }
    return absolute;
  }

  /** Resolve an output directory, creating it on demand. */
  async resolveOutputDir(input?: string): Promise<string> {
    const path =
      input && input.trim().length > 0 ? await this.resolveWritePath(input) : (await this.ensureOutputDir()).directory;
    const info = existsSync(path) ? await stat(path) : null;
    if (info && !info.isDirectory()) throw new ToolError(`"${path}" exists and is not a directory.`);
    return this.ensureDir(path);
  }

  /** Record a written artifact and return it. */
  async track(path: string): Promise<ArtifactRef> {
    const ref: ArtifactRef = { path };
    try {
      ref.bytes = (await stat(path)).size;
    } catch {
      // Not fatal; the size is informational.
    }
    this.artifacts.push(ref);
    return ref;
  }

  /** Read a project from an absolute or output-directory-relative `.fms` path. */
  async loadProjectFile(path: string): Promise<{ project: Project; path: string }> {
    const file = this.resolveReadPath(path);
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch (error) {
      throw new ToolError(`Could not read "${file}": ${(error as NodeJS.ErrnoException).message}`);
    }
    try {
      return { project: readProject(data), path: file };
    } catch (error) {
      throw new ToolError(`Could not parse "${file}": ${(error as Error).message}`);
    }
  }

  /** Serialize a project to disk. */
  async saveProject(project: Project, path: string): Promise<ArtifactRef> {
    const file = await this.resolveWritePath(path);
    const problems = validateProject(project);
    if (problems.length > 0) {
      throw new ToolError(`Refusing to write an invalid project:\n  - ${problems.join('\n  - ')}`);
    }
    const bytes = writeFms(project);
    await this.ensureDir(resolve(file, '..'));
    await writeFile(file, bytes);
    return this.track(file);
  }
}

/**
 * A project can be supplied either as a `.fms` path or inline as an object.
 *
 * Inline form exists so an agent can chain `compile_song_spec` -> `export_audio`
 * without touching the filesystem in between.
 */
export interface ProjectInput {
  projectPath?: string;
  project?: unknown;
}

/** Normalize an inline project payload, accepting either a model or a song spec. */
function coerceInlineProject(value: unknown): Project {
  if (!value || typeof value !== 'object') {
    throw new ToolError('"project" must be an object.');
  }
  const candidate = value as Project & { channels?: unknown; project?: unknown };
  if (candidate.project && typeof candidate.project === 'object') {
    return candidate.project as Project;
  }
  if (Array.isArray(candidate.songs)) return candidate;
  throw new ToolError(
    '"project" must be a project object (with a "songs" array) or the result of compile_song_spec. ' +
      'Pass "projectPath" to read a .fms file instead.',
  );
}

/** Resolve a {@link ProjectInput} into a project plus a label for messages. */
export async function resolveProject(
  context: ServerContext,
  input: ProjectInput,
): Promise<{ project: Project; label: string; path?: string }> {
  if (input.projectPath) {
    const { project, path } = await context.loadProjectFile(input.projectPath);
    return { project, label: path, path };
  }
  if (input.project !== undefined) {
    const project = coerceInlineProject(input.project);
    return { project, label: project.name || 'inline project' };
  }
  throw new ToolError('Provide either "projectPath" or "project".');
}

/* -------------------------------------------------------------------------- */
/* Result shaping                                                             */
/* -------------------------------------------------------------------------- */

/** Payload returned by every successful tool call. */
export interface ToolPayload {
  /** One-line summary suitable for logs. */
  summary: string;
  /** Human/agent readable detail. */
  text: string;
  /** Machine readable detail (mirrored into `structuredContent`). */
  data: Record<string, unknown>;
  /** Files produced or consumed by this call. */
  artifacts?: ArtifactRef[];
}

/** Coerce raw JSON-RPC arguments into a plain object. */
export function objectArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** MCP tool behavior hints. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Hints for tools that only read. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Hints for tools that write files but are safe to repeat. */
export const WRITES_FILES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Join text blocks, dropping the empty ones. */
export function toolText(...blocks: (string | undefined | null)[]): string {
  return blocks.filter((block): block is string => Boolean(block && block.length > 0)).join('\n\n');
}

/** Convert a {@link ToolPayload} into an MCP `CallToolResult`. */
export function toToolResult(payload: ToolPayload): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const lines = [payload.text];
  if (payload.artifacts && payload.artifacts.length > 0) {
    lines.push('', 'Artifacts:');
    for (const artifact of payload.artifacts) {
      lines.push(`  - ${artifact.path}${artifact.bytes !== undefined ? ` (${artifact.bytes} bytes)` : ''}`);
    }
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      summary: payload.summary,
      ...payload.data,
      artifacts: payload.artifacts ?? [],
    },
  };
}

/** Summarize a project for text output (re-exported from the core report module). */
export { summarizeProject, formatProjectSummary } from '../core/report.js';
