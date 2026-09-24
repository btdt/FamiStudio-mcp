/**
 * Wrapper around the FamiStudio desktop executable.
 *
 * FamiStudio ships a command-line mode (`FamiStudio <input> <command> <output>
 * [-options]`) which is the only supported way to render a `.fms` to audio or
 * to convert it back to text for verification. This module locates the binary,
 * runs it safely (no shell, no argument interpolation) and reports progress.
 *
 * The process also needs a writable location for `FamiStudio.ini`; the default
 * (`%LOCALAPPDATA%\FamiStudio`) works on a normal desktop, so the INI override
 * is only used when the caller explicitly asks for it.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, platform } from 'node:os';

/** Error raised for configuration/execution problems with FamiStudio itself. */
export class FamiStudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FamiStudioError';
  }
}

/** CLI commands supported by FamiStudio 4.5.x that this server exposes. */
export const EXPORT_COMMANDS = [
  'wav-export',
  'mp3-export',
  'ogg-export',
  'nsf-export',
  'rom-export',
  'fds-export',
  'famitracker-txt-export',
  'famistudio-txt-export',
  'famistudio-asm-export',
  'famistudio-asm-sfx-export',
  'famitone2-asm-export',
  'famitone2-asm-sfx-export',
] as const;

export type ExportCommand = (typeof EXPORT_COMMANDS)[number];

/**
 * Candidate install locations, in priority order.
 *
 * `FAMISTUDIO_EXE` always wins; the rest cover the stock installers plus a few
 * common portable/self-built spots.
 */
export function candidateExecutablePaths(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.FAMISTUDIO_EXE?.trim();
  if (fromEnv) candidates.push(fromEnv);

  const name = platform() === 'win32' ? 'FamiStudio.exe' : 'FamiStudio';

  if (platform() === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'];
    candidates.push(join(programFiles, 'FamiStudio', name));
    candidates.push(join(programFilesX86, 'FamiStudio', name));
    if (localAppData) candidates.push(join(localAppData, 'Programs', 'FamiStudio', name));
    candidates.push(join(homedir(), 'scoop', 'apps', 'famistudio', 'current', name));
  } else if (platform() === 'darwin') {
    candidates.push('/Applications/FamiStudio.app/Contents/MacOS/FamiStudio');
    candidates.push(join(homedir(), 'Applications', 'FamiStudio.app', 'Contents', 'MacOS', 'FamiStudio'));
  } else {
    candidates.push('/usr/local/bin/FamiStudio');
    candidates.push('/usr/bin/FamiStudio');
    candidates.push(join(homedir(), '.local', 'bin', 'FamiStudio'));
  }

  // Anything on PATH, so a hand-installed copy still works.
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const entry of pathEntries) candidates.push(join(entry, name));

  return [...new Set(candidates)];
}

let cachedExecutable: string | null = null;

/** Resolve the FamiStudio executable path, or `null` when not installed. */
export async function findFamiStudio(): Promise<string | null> {
  if (cachedExecutable && existsSync(cachedExecutable)) return cachedExecutable;
  for (const candidate of candidateExecutablePaths()) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      cachedExecutable = candidate;
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/** Forget the cached executable path (used by tests). */
export function resetFamiStudioCache(): void {
  cachedExecutable = null;
}

/** Result of one CLI invocation. */
export interface CliResult {
  executable: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** `true` when the process was terminated because of the timeout. */
  timedOut: boolean;
  /** Lines FamiStudio logged, with its 4-space indent and log levels stripped. */
  log: string[];
}

/** Options for {@link runCli}. */
export interface RunCliOptions {
  /** Override the executable path. */
  executable?: string;
  timeoutMs?: number;
  /** Extra CLI switches, passed through verbatim as separate argv entries. */
  extraArgs?: string[];
}

/** Arguments for {@link runExport}. */
export interface RunExportOptions extends RunCliOptions {
  command: ExportCommand;
  outputPath: string;
  /** Zero-based song indices; omitted means "all songs". */
  songs?: number[];
  /** WAV/MP3/OGG sample rate. */
  rate?: number;
  /** `-wav-export-separate-channels`. */
  separateChannels?: boolean;
  /** `-wav-export-separate-intro`. */
  separateIntro?: boolean;
  /** WAV export duration in seconds; 0 means "play once and stop". */
  durationSeconds?: number;
  /** Number of times to loop. */
  loopCount?: number;
  /** Channel mask, e.g. 0xff. */
  channelMask?: number;
  /** FamiStudio text export: drop unused data. */
  cleanupText?: boolean;
  /** Assembly format for the asm exporters. */
  asmFormat?: 'nesasm' | 'ca65' | 'asm6';
}

/**
 * Run the FamiStudio executable with an explicit argv array.
 *
 * Never uses a shell, so paths containing spaces and quotes cannot be
 * misinterpreted.
 */
export async function runCli(inputArgs: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const executable = options.executable ?? (await findFamiStudio());
  if (!executable) {
    throw new FamiStudioError(
      'FamiStudio executable not found. Install FamiStudio 4.5.x (https://famistudio.org) ' +
        'or set the FAMISTUDIO_EXE environment variable to the full path of the binary.',
    );
  }

  const args = [...inputArgs, ...(options.extraArgs ?? [])];
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Run from the output directory's parent when possible so relative
      // outputs land next to their input.
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new FamiStudioError(`Failed to start ${executable}: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const log = stdout
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s{1,8}/, '').trim())
        .filter((line) => line.length > 0);
      resolve({
        executable,
        args,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        log,
      });
    });
  });
}

/** Build the argv for an export run. */
export function buildExportArgs(inputPath: string, options: RunExportOptions): string[] {
  const args = [inputPath, options.command, options.outputPath];

  if (options.songs && options.songs.length > 0) {
    args.push(`-export-songs:${options.songs.join(',')}`);
  }

  const isAudio = options.command === 'wav-export' || options.command === 'mp3-export' || options.command === 'ogg-export';
  const isMp3 = options.command === 'mp3-export';
  const isOgg = options.command === 'ogg-export';

  if (isAudio) {
    const prefix = isMp3 ? 'mp3' : isOgg ? 'ogg' : 'wav';
    if (options.rate) args.push(`-${prefix}-export-rate:${options.rate}`);
    if (options.durationSeconds !== undefined) args.push(`-${prefix}-export-duration:${options.durationSeconds}`);
    if (options.loopCount !== undefined) args.push(`-${prefix}-export-loop:${options.loopCount}`);
    if (options.channelMask !== undefined) {
      args.push(`-${prefix}-export-channels:${options.channelMask.toString(16)}`);
    }
    if (options.separateChannels) args.push(`-${prefix}-export-separate-channels`);
    if (options.separateIntro) args.push(`-${prefix}-export-separate-intro`);
  }

  if (options.command === 'famistudio-txt-export' && options.cleanupText) {
    args.push('-famistudio-txt-cleanup');
  }

  if (
    (options.command === 'famistudio-asm-export' ||
      options.command === 'famistudio-asm-sfx-export' ||
      options.command === 'famitone2-asm-export' ||
      options.command === 'famitone2-asm-sfx-export') &&
    options.asmFormat
  ) {
    const flag = options.command.startsWith('famistudio') ? '-famistudio-asm-format' : '-famitone2-asm-format';
    args.push(`${flag}:${options.asmFormat}`);
  }

  return args;
}

/** Run one export and surface FamiStudio's own log lines in the result. */
export async function runExport(inputPath: string, options: RunExportOptions): Promise<CliResult> {
  const args = buildExportArgs(inputPath, options);
  const result = await runCli(args, options);
  if (result.exitCode !== 0 && !result.timedOut) {
    throw new FamiStudioError(
      `FamiStudio exited with code ${result.exitCode} for "${options.command}".\n` +
        `argv: ${args.join(' ')}\n${result.log.join('\n') || result.stderr}`,
    );
  }
  return result;
}

/** Report the FamiStudio build this server can talk to. */
export async function famistudioInfo(): Promise<{
  found: boolean;
  executable: string | null;
  version: string | null;
  candidates: string[];
}> {
  const executable = await findFamiStudio();
  let version: string | null = null;
  if (executable) {
    try {
      const result = await runCli(['-help'], { executable, timeoutMs: 30_000 });
      const match = /FamiStudio\s+([0-9][0-9.]*)\s+Command-Line/i.exec(result.stdout);
      version = match ? match[1] : null;
    } catch {
      version = null;
    }
  }
  return { found: executable !== null, executable, version, candidates: candidateExecutablePaths() };
}
