/**
 * Where generated files land.
 *
 * This server deliberately makes **no decision** about the output location: the
 * caller decides. The resolution order below encodes that, highest priority
 * first:
 *
 *   1. an absolute path in the tool call    - the agent or its user already decided
 *   2. the session cache                    - the user decided earlier this session
 *   3. an elicitation prompt                - the user decides now (pre-filled)
 *   4. FAMISTUDIO_MCP_OUTDIR/WORKSPACE      - the user decided when configuring the host
 *   5. `<project>/audio/famistudio`         - a guess, only when the workspace is known
 *   6. the OS temp directory                - last resort, keeps the server usable
 *
 * Nothing is written to disk to remember a choice: it lives in this process
 * only. Instead the caller is handed a hint describing how to record the choice
 * in the workspace's own `AGENTS.md`/`CLAUDE.md`, so that later calls pass it
 * explicitly and step 1 takes over.
 *
 * Kept free of imports from `./shared.js` so the two modules cannot form an
 * import cycle.
 */
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';

/** Subdirectory of the workspace offered as the default when asking the user. */
export const DEFAULT_OUTPUT_SUBDIR = join('audio', 'famistudio');

/** How the session output directory was determined. */
export type OutputDirSource = 'session' | 'elicitation' | 'env' | 'project' | 'temp';

/** The resolved session output directory plus how it was chosen. */
export interface OutputDirResolution {
  /** Absolute path generated files land in by default. */
  directory: string;
  source: OutputDirSource;
  /** `true` when this process asked the user and they answered. */
  asked: boolean;
  /** Workspace root the default was derived from, when one could be found. */
  projectDir: string | null;
}

/** Environment-derived configuration the resolver needs. */
export interface OutputDirConfig {
  /** Roots configured by the user, if any (`FAMISTUDIO_MCP_OUTDIR` / `_WORKSPACE`). */
  envRoots: string[];
  /** `true` when {@link envRoots} came from the environment rather than the built-in default. */
  fromEnv: boolean;
  /** Built-in scratch directory used when nothing else applies. */
  tempRoot: string;
}

/**
 * Files/directories that mark a directory as a workspace root.
 *
 * Used only to decide whether `process.cwd()` is worth treating as a project;
 * this deliberately does not walk upwards, because guessing a workspace is a
 * decision this server should not make.
 */
const PROJECT_MARKERS = [
  '.git',
  '.mcp.json',
  '.famistudio-mcp.json',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursor',
  '.vscode',
  'package.json',
  'project.godot',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
];

/** Same idea, for markers that are only recognisable by extension. */
const PROJECT_MARKER_EXTENSIONS = ['.uproject', '.sln', '.godot'];

/** `true` when `directory` looks like the root of somebody's project. */
export function looksLikeProjectDirectory(directory: string): boolean {
  try {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(directory, marker))) return true;
    }
    for (const entry of readdirSync(directory)) {
      if (PROJECT_MARKER_EXTENSIONS.some((extension) => entry.endsWith(extension))) return true;
    }
  } catch {
    // Unreadable or missing: not a usable workspace root.
  }
  return false;
}

/**
 * Find the workspace root.
 *
 * The MCP `roots` capability is authoritative when the client advertises it.
 * Hosts that configure this server globally (and therefore cannot know which
 * project is being worked on) usually advertise nothing, in which case the
 * process working directory is the only signal - and only when it actually
 * looks like a project.
 */
export async function findProjectDirectory(server: Server | null): Promise<string | null> {
  const capabilities = server?.getClientCapabilities() as { roots?: unknown } | undefined;
  if (server && capabilities?.roots) {
    try {
      const { roots } = await server.listRoots();
      for (const root of roots) {
        if (typeof root.uri === 'string' && root.uri.startsWith('file:')) {
          const directory = fileURLToPath(root.uri);
          if (existsSync(directory)) return directory;
        }
      }
    } catch {
      // A client that advertises roots but fails the request is not fatal.
    }
  }

  const cwd = process.cwd();
  return looksLikeProjectDirectory(cwd) ? cwd : null;
}

/** `true` when the client can be asked a question. */
function canElicit(server: Server): boolean {
  const capabilities = server.getClientCapabilities() as { elicitation?: unknown } | undefined;
  return Boolean(capabilities?.elicitation);
}

/**
 * Ask the user where output should go.
 *
 * @returns the chosen absolute directory, or `null` when the user declined.
 */
async function elicitOutputDirectory(
  server: Server,
  suggested: string,
  projectDir: string | null,
): Promise<string | null> {
  let result: ElicitResult;
  try {
    result = await server.elicitInput({
      message:
        'Where should famistudio-mcp write the .fms projects and audio it generates for this ' +
        'workspace?\n\n' +
        'You can also skip this and pass an absolute path on each tool call instead.',
      requestedSchema: {
        type: 'object',
        properties: {
          outputDirectory: {
            type: 'string',
            title: 'Output directory',
            description:
              'Absolute path, or a path relative to the workspace root. ' +
              'Use "audio/famistudio" to keep it inside the project.',
            default: suggested,
          },
        },
        required: ['outputDirectory'],
      },
    });
  } catch {
    // The client declared the capability but the request failed; fall through to
    // the configured/default behaviour rather than failing the tool call.
    return null;
  }

  if (result.action !== 'accept') return null;
  const raw = (result.content as Record<string, unknown> | undefined)?.outputDirectory;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  const value = raw.trim();
  return isAbsolute(value) ? resolve(value) : resolve(projectDir ?? process.cwd(), value);
}

/** Resolves - and caches - the directory generated files land in. */
export class OutputDirResolver {
  private cached: OutputDirResolution | null = null;

  constructor(private readonly config: OutputDirConfig) {}

  /** The resolution made earlier in this session, if any. */
  get resolution(): OutputDirResolution | null {
    return this.cached;
  }

  /** Seed the session cache, bypassing any prompt. */
  seed(directory: string, source: OutputDirSource = 'session', projectDir: string | null = null): OutputDirResolution {
    return this.remember(resolve(directory), source, false, projectDir);
  }

  /** Resolve the session output directory, asking the user at most once. */
  async resolve(server: Server | null): Promise<OutputDirResolution> {
    if (this.cached) return this.cached;

    const projectDir = await findProjectDirectory(server);
    const projectDefault = projectDir ? join(projectDir, DEFAULT_OUTPUT_SUBDIR) : null;
    const configured = this.config.fromEnv ? (this.config.envRoots[0] ?? null) : null;

    if (server && canElicit(server)) {
      const chosen = await elicitOutputDirectory(
        server,
        projectDefault ?? configured ?? this.config.tempRoot,
        projectDir,
      );
      if (chosen) return this.remember(chosen, 'elicitation', true, projectDir);
      // The user declined to choose: honour what they configured at setup time.
    }

    if (configured) return this.remember(configured, 'env', false, projectDir);
    if (projectDefault) return this.remember(projectDefault, 'project', false, projectDir);
    return this.remember(this.config.tempRoot, 'temp', false, projectDir);
  }

  private remember(
    directory: string,
    source: OutputDirSource,
    asked: boolean,
    projectDir: string | null,
  ): OutputDirResolution {
    this.cached = { directory, source, asked, projectDir };
    return this.cached;
  }
}

/** The OS scratch directory used when nothing else applies. */
export function defaultTempRoot(): string {
  return resolve(join(tmpdir(), 'famistudio-mcp'));
}
