/**
 * Export and audio-verification tools.
 *
 * These wrap the FamiStudio command line, which is the only supported way to
 * turn a project into audio or to convert it to text.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  EXPORT_COMMANDS,
  type ExportCommand,
  FamiStudioError,
  analyzeWav,
  decodeWav,
  detectPitches,
  estimatePitch,
  famistudioInfo,
  findFamiStudio,
  runCli,
  runExport,
} from '../core/index.js';
import { defineTool, type ToolRegistry } from '../server.js';
import {
  READ_ONLY,
  WRITES_FILES,
  ToolError,
  projectPayloadSchema,
  resolveProject,
  toToolResult,
  toolText,
  type ServerContext,
} from './shared.js';

/** Ensure a render lands with the extension FamiStudio expects. */
function withExtension(path: string, extension: string): string {
  return extname(path).toLowerCase() === extension ? path : `${path}${extension}`;
}

/** Write an inline project to a scratch file so the CLI has something to read. */
async function materializeProject(
  context: ServerContext,
  projectPath: string | undefined,
  project: unknown,
): Promise<{ path: string; cleanup: () => Promise<void>; label: string }> {
  if (projectPath) {
    const resolved = await resolveProject(context, { projectPath });
    return { path: resolved.path as string, cleanup: async () => {}, label: resolved.label };
  }
  const resolved = await resolveProject(context, { project });
  const dir = await context.ensureDir(join(context.defaultOutputRoot, '.scratch'));
  const path = join(dir, `inline-${randomUUID().slice(0, 8)}.fms`);
  await context.saveProject(resolved.project, path);
  return { path, cleanup: async () => rm(path, { force: true }), label: resolved.label };
}

/** Turn a FamiStudio CLI failure into a tool error. */
function rethrow(error: unknown): never {
  if (error instanceof FamiStudioError) throw new ToolError(error.message);
  throw error;
}

/** Register the export tools. */
export function registerExportTools(registry: ToolRegistry): void {
  defineTool(registry, {
    name: 'export_audio',
    title: 'Export a project to WAV/MP3/OGG',
    description:
      'Render a FamiStudio project to an audio file with the FamiStudio command line. Requires ' +
      'FamiStudio 4.5.x to be installed; call famistudio_info first if unsure. Returns the artifact path ' +
      'plus duration, peak level and an audibility check for WAV output.',
    inputShape: {
      projectPath: z.string().optional().describe('Path to a .fms file.'),
      project: projectPayloadSchema.optional().describe('Inline project (from compile_song_spec).'),
      outputPath: z.string().describe('Destination audio path, e.g. "out/snake_move.wav".'),
      format: z.enum(['wav', 'mp3', 'ogg']).optional().describe('Default wav.'),
      rate: z.union([z.literal(11025), z.literal(22050), z.literal(44100), z.literal(48000)]).optional(),
      durationSeconds: z
        .number()
        .min(0)
        .optional()
        .describe('Render length in seconds; 0 plays the song once and stops (FamiStudio default).'),
      loopCount: z.number().int().min(1).optional(),
      songs: z.array(z.number().int().min(0)).optional().describe('Zero-based song indices; default all.'),
      separateChannels: z
        .boolean()
        .optional()
        .describe('Write one file per channel (suffixed _0.._4); useful for pitch verification.'),
      channelMask: z.number().int().min(0).max(0xff).optional().describe('Channel enable mask, e.g. 1 for Square1.'),
    },
    annotations: WRITES_FILES,
    handler: async (args, context) => {
      const format = (args.format as string | undefined) ?? 'wav';
      const command = `${format}-export` as ExportCommand;
      const outputPath = withExtension(await context.resolveWritePath(args.outputPath as string), `.${format}`);
      await context.ensureDir(resolve(outputPath, '..'));

      const materialized = await materializeProject(
        context,
        args.projectPath as string | undefined,
        args.project,
      );
      try {
        const result = await runExport(materialized.path, {
          command,
          outputPath,
          rate: args.rate as number | undefined,
          durationSeconds: args.durationSeconds as number | undefined,
          loopCount: args.loopCount as number | undefined,
          songs: args.songs as number[] | undefined,
          separateChannels: args.separateChannels as boolean | undefined,
          channelMask: args.channelMask as number | undefined,
          executable: context.config.famistudioExe,
        });

        const artifacts = [await context.track(outputPath)];
        let analysis: Record<string, unknown> | null = null;
        if (format === 'wav' && existsSync(outputPath)) {
          const stats = analyzeWav(decodeWav(await readFile(outputPath)));
          analysis = {
            sampleRate: stats.sampleRate,
            channels: stats.channels,
            bitsPerSample: stats.bitsPerSample,
            durationSeconds: Number(stats.durationSeconds.toFixed(4)),
            audibleSeconds: Number(stats.audibleSeconds.toFixed(4)),
            peak: Number(stats.peak.toFixed(4)),
            peakDbfs: Number.isFinite(stats.peakDbfs) ? Number(stats.peakDbfs.toFixed(2)) : null,
            rms: Number(stats.rms.toFixed(4)),
            silent: stats.silent,
          };
        }

        return toToolResult({
          summary: `Rendered ${basename(outputPath)} (${
            analysis ? `${analysis.durationSeconds}s` : format
          })${analysis?.silent ? ' [SILENT]' : ''}`,
          text: toolText(
            `Exported ${outputPath}`,
            `argv: ${result.args.join(' ')}`,
            analysis
              ? toolText(
                  `duration: ${analysis.durationSeconds}s (audible ${analysis.audibleSeconds}s)`,
                  `peak: ${analysis.peak} (${analysis.peakDbfs ?? '-inf'} dBFS)` +
                    (analysis.silent ? '  [SILENT!]' : ''),
                )
              : '',
            result.log.length > 0 ? `log: ${result.log.join(' | ')}` : '',
          ),
          data: {
            outputPath,
            command,
            argv: result.args,
            log: result.log,
            analysis,
            durationMs: result.durationMs,
          },
          artifacts,
        });
      } catch (error) {
        rethrow(error);
      } finally {
        await materialized.cleanup();
      }
    },
  });

  defineTool(registry, {
    name: 'export_text',
    title: 'Export a project to text or assembly',
    description:
      'Convert a project with `famistudio-txt-export` (FamiStudio text - excellent for verification and ' +
      'for reading note data), `famitracker-txt-export`, or a sound-engine assembly exporter ' +
      '(`famistudio-asm-export`, `famitone2-asm-export`, ...). Returns a preview of the produced file.',
    inputShape: {
      projectPath: z.string().optional(),
      project: projectPayloadSchema.optional(),
      outputPath: z.string().describe('Destination path, e.g. "out/verify.txt".'),
      command: z
        .enum([
          'famistudio-txt-export',
          'famitracker-txt-export',
          'famistudio-asm-export',
          'famistudio-asm-sfx-export',
          'famitone2-asm-export',
          'famitone2-asm-sfx-export',
        ])
        .optional()
        .describe('Default famistudio-txt-export.'),
      cleanup: z.boolean().optional().describe('Drop unused data (FamiStudio text export only).'),
      asmFormat: z.enum(['nesasm', 'ca65', 'asm6']).optional(),
      songs: z.array(z.number().int().min(0)).optional(),
      maxBytes: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe('Truncate the returned text preview at this many bytes (default 20000).'),
    },
    annotations: WRITES_FILES,
    handler: async (args, context) => {
      const command = ((args.command as string | undefined) ?? 'famistudio-txt-export') as ExportCommand;
      const extension = command.includes('txt') ? '.txt' : '.s';
      const outputPath = withExtension(await context.resolveWritePath(args.outputPath as string), extension);
      await context.ensureDir(resolve(outputPath, '..'));

      const materialized = await materializeProject(
        context,
        args.projectPath as string | undefined,
        args.project,
      );
      try {
        const result = await runExport(materialized.path, {
          command,
          outputPath,
          songs: args.songs as number[] | undefined,
          cleanupText: args.cleanup as boolean | undefined,
          asmFormat: args.asmFormat as 'nesasm' | 'ca65' | 'asm6' | undefined,
          executable: context.config.famistudioExe,
        });

        const artifact = await context.track(outputPath);
        const contents = await readFile(outputPath, 'utf8');
        const limit = (args.maxBytes as number | undefined) ?? 20_000;
        const preview = contents.length > limit ? `${contents.slice(0, limit)}\n... [truncated]` : contents;
        // Desync symptoms: FamiStudio reports nonsense values when the field
        // order in the file is wrong.
        const desync = /Tuning="-1"|VolumeDb="NaN"/.test(contents);

        return toToolResult({
          summary: `Exported ${basename(outputPath)} with ${command} (${contents.length} chars)${
            desync ? ' [DESYNC]' : ''
          }`,
          text: toolText(
            `Exported ${outputPath} with ${command}`,
            `argv: ${result.args.join(' ')}`,
            desync ? 'WARNING: text contains Tuning="-1" / VolumeDb="NaN" (field desync).' : '',
            result.log.length > 0 ? `log: ${result.log.join(' | ')}` : '',
            preview,
          ),
          data: {
            outputPath,
            command,
            argv: result.args,
            log: result.log,
            desync,
            bytes: contents.length,
            preview: contents.slice(0, limit),
          },
          artifacts: [artifact],
        });
      } catch (error) {
        rethrow(error);
      } finally {
        await materialized.cleanup();
      }
    },
  });

  defineTool(registry, {
    name: 'verify_roundtrip',
    title: 'Round-trip a project through FamiStudio',
    description:
      'The end-to-end validity check: re-export the project to FamiStudio text and render a WAV, then ' +
      'report whether FamiStudio loaded the file cleanly (no field desync) and produced audio of the ' +
      'expected length. Run this after generating a .fms file.',
    inputShape: {
      projectPath: z.string().optional(),
      project: projectPayloadSchema.optional(),
      workDir: z.string().optional().describe('Where to place the intermediate files.'),
      renderAudio: z
        .boolean()
        .optional()
        .describe('Also render a WAV and report duration/peak (default true).'),
      durationSeconds: z.number().min(0).optional().describe('Cap the render at this length.'),
      expectDurationSeconds: z
        .number()
        .min(0)
        .optional()
        .describe('Fail the check when the audible duration differs by more than 5%.'),
    },
    annotations: WRITES_FILES,
    handler: async (args, context) => {
      const workDir = await context.resolveOutputDir(args.workDir as string | undefined);
      const slot = randomUUID().slice(0, 8);
      const txtPath = join(workDir, `roundtrip-${slot}.txt`);
      const wavPath = join(workDir, `roundtrip-${slot}.wav`);

      const materialized = await materializeProject(
        context,
        args.projectPath as string | undefined,
        args.project,
      );
      const checks: { name: string; passed: boolean; detail: string }[] = [];
      const artifacts: { path: string; bytes?: number }[] = [];

      try {
        // 1. Text round trip.
        await runExport(materialized.path, {
          command: 'famistudio-txt-export',
          outputPath: txtPath,
          executable: context.config.famistudioExe,
        });
        const text = await readFile(txtPath, 'utf8');
        artifacts.push(await context.track(txtPath));

        const desync = /Tuning="-1"|VolumeDb="NaN"/.test(text);
        checks.push({
          name: 'loads_without_desync',
          passed: !desync,
          detail: desync
            ? 'text export contains Tuning="-1" or VolumeDb="NaN"; the serializer field order is wrong'
            : 'FamiStudio parsed the file and reported sane project properties',
        });

        const songCount = (text.match(/Song\s+"/g) ?? []).length + (text.match(/^\s*Song\s/gm) ?? []).length;
        checks.push({
          name: 'contains_songs',
          passed: songCount > 0,
          detail: `${songCount} song reference(s) in the text export`,
        });

        // 2. Audio render.
        let audio: Record<string, unknown> | null = null;
        if ((args.renderAudio as boolean | undefined) ?? true) {
          await runExport(materialized.path, {
            command: 'wav-export',
            outputPath: wavPath,
            rate: 44100,
            durationSeconds: (args.durationSeconds as number | undefined) ?? 0,
            executable: context.config.famistudioExe,
          });
          artifacts.push(await context.track(wavPath));
          const stats = analyzeWav(decodeWav(await readFile(wavPath)));
          audio = {
            sampleRate: stats.sampleRate,
            durationSeconds: Number(stats.durationSeconds.toFixed(4)),
            audibleSeconds: Number(stats.audibleSeconds.toFixed(4)),
            peak: Number(stats.peak.toFixed(4)),
            peakDbfs: Number.isFinite(stats.peakDbfs) ? Number(stats.peakDbfs.toFixed(2)) : null,
            silent: stats.silent,
          };
          checks.push({
            name: 'produces_audio',
            passed: !stats.silent && stats.durationSeconds > 0.05,
            detail: stats.silent
              ? 'render is silent'
              : `${stats.durationSeconds.toFixed(3)}s, peak ${stats.peak.toFixed(3)}`,
          });

          const expected = args.expectDurationSeconds as number | undefined;
          if (expected !== undefined) {
            const tolerance = Math.max(0.05, expected * 0.05);
            const delta = Math.abs(stats.audibleSeconds - expected);
            checks.push({
              name: 'duration_matches_expectation',
              passed: delta <= tolerance,
              detail: `audible ${stats.audibleSeconds.toFixed(3)}s vs expected ${expected}s (delta ${delta.toFixed(3)}s)`,
            });
          }
        }

        const failed = checks.filter((check) => !check.passed);
        return toToolResult({
          summary:
            failed.length === 0
              ? `Round trip OK for ${materialized.label}`
              : `Round trip FAILED (${failed.map((check) => check.name).join(', ')})`,
          text: toolText(
            `Round-trip report for ${materialized.label}`,
            checks.map((check) => `  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name}: ${check.detail}`).join('\n'),
          ),
          data: { ok: failed.length === 0, checks, audio, project: materialized.label },
          artifacts,
        });
      } catch (error) {
        rethrow(error);
      } finally {
        await materialized.cleanup();
      }
    },
  });
}

/** Register the analysis and environment tools. */
export function registerAnalysisTools(registry: ToolRegistry): void {
  defineTool(registry, {
    name: 'famistudio_info',
    title: 'Locate FamiStudio',
    description:
      'Report whether the FamiStudio executable was found, which version it is, and the paths that were ' +
      'probed. Also lists the CLI export commands this server can run, and the directories it is allowed ' +
      'to read and write.',
    inputShape: {},
    annotations: READ_ONLY,
    handler: async (_args, context) => {
      const info = await famistudioInfo();
      return toToolResult({
        summary: info.found
          ? `FamiStudio ${info.version ?? '(version unknown)'} at ${info.executable}`
          : 'FamiStudio not found',
        text: toolText(
          info.found
            ? `FamiStudio found: ${info.executable}${info.version ? ` (v${info.version})` : ''}`
            : 'FamiStudio NOT found. Install FamiStudio 4.5.x or set FAMISTUDIO_EXE.',
          `export commands: ${EXPORT_COMMANDS.join(', ')}`,
          `write roots: ${context.config.outputRoots.join(', ')}`,
          `read roots: ${context.config.inputRoots.join(', ')}`,
          !info.found ? `probed:\n${info.candidates.map((path) => `  ${path}`).join('\n')}` : '',
        ),
        data: {
          found: info.found,
          executable: info.executable,
          version: info.version,
          probedPaths: info.candidates,
          exportCommands: [...EXPORT_COMMANDS],
          outputRoots: context.config.outputRoots,
          inputRoots: context.config.inputRoots,
        },
      });
    },
  });

  defineTool(registry, {
    name: 'compute_ticks',
    title: 'Convert between seconds and ticks',
    description:
      'FamiStudio tempo arithmetic: with a uniform groove one tick equals one frame, so duration is ' +
      'ticks / frameRate (60.0988 NTSC, 50.007 PAL). Use it to turn a target duration into the tick count ' +
      'a spec needs, or to check how long a pattern budget lasts.',
    inputShape: {
      seconds: z.number().min(0).optional().describe('Duration to convert into ticks.'),
      ticks: z.number().min(0).optional().describe('Tick count to convert into seconds.'),
      pal: z.boolean().optional().describe('Use PAL timing (default false = NTSC).'),
      noteLength: z.number().int().min(1).optional().describe('Default note length, to report a note budget.'),
      patternLength: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Pattern length, to report how many patterns a tick budget fills.'),
    },
    annotations: READ_ONLY,
    handler: async (args) => {
      const frameRate = (args.pal as boolean | undefined) ? 50.0069768347802 : 60.0988118623484;
      const data: Record<string, unknown> = { frameRate: Number(frameRate.toFixed(6)), pal: Boolean(args.pal) };
      const lines = [`frame rate: ${frameRate.toFixed(4)} Hz (${args.pal ? 'PAL' : 'NTSC'})`];

      const seconds = args.seconds as number | undefined;
      const ticks = args.ticks as number | undefined;
      const noteLength = args.noteLength as number | undefined;
      const patternLength = args.patternLength as number | undefined;

      if (seconds !== undefined) {
        const asTicks = Math.round(seconds * frameRate);
        data.ticks = asTicks;
        lines.push(`${seconds}s = ${asTicks} ticks`);
        if (noteLength) lines.push(`  ~${(asTicks / noteLength).toFixed(2)} notes at noteLength ${noteLength}`);
        if (patternLength) lines.push(`  ~${(asTicks / patternLength).toFixed(2)} patterns at ${patternLength} ticks`);
      }
      if (ticks !== undefined) {
        data.seconds = Number((ticks / frameRate).toFixed(6));
        lines.push(`${ticks} ticks = ${(ticks / frameRate).toFixed(4)}s`);
        if (noteLength) lines.push(`  ~${(ticks / noteLength).toFixed(2)} notes at noteLength ${noteLength}`);
        if (patternLength) lines.push(`  exactly ${(ticks / patternLength).toFixed(2)} patterns at ${patternLength} ticks`);
      }
      if (seconds === undefined && ticks === undefined) {
        lines.push('Provide "seconds" or "ticks" (or both) to convert.');
      }

      return toToolResult({
        summary: lines[lines.length - 1],
        text: lines.join('\n'),
        data,
      });
    },
  });

  defineTool(registry, {
    name: 'analyze_audio',
    title: 'Analyze a rendered WAV',
    description:
      'Report duration, peak/RMS level and silence for a WAV file, and optionally detect the pitch ' +
      'sequence. Pitch detection expects a monophonic render, e.g. a single channel exported with ' +
      'export_audio + separateChannels.',
    inputShape: {
      path: z.string().describe('Path to the WAV file.'),
      channel: z.number().int().min(0).optional().describe('Channel index to analyze (default 0).'),
      detectPitch: z.boolean().optional().describe('Run pitch detection over the file (default false).'),
      minFrequency: z.number().min(10).optional().describe('Pitch search lower bound in Hz (default 40).'),
      maxFrequency: z.number().min(20).optional().describe('Pitch search upper bound in Hz (default 4000).'),
      windowSeconds: z.number().min(0.01).optional().describe('Analysis window, default 0.08s.'),
      maxSegments: z.number().int().min(1).optional().describe('Cap on returned pitch segments (default 64).'),
    },
    annotations: READ_ONLY,
    handler: async (args, context) => {
      const file = context.resolveReadPath(args.path as string);
      if (!existsSync(file)) throw new ToolError(`File not found: ${file}`);
      const decoded = decodeWav(await readFile(file));
      const channel = (args.channel as number | undefined) ?? 0;
      const stats = analyzeWav(decoded, channel);
      const minFrequency = args.minFrequency as number | undefined;
      const maxFrequency = args.maxFrequency as number | undefined;

      const data: Record<string, unknown> = {
        path: file,
        sampleRate: stats.sampleRate,
        channels: stats.channels,
        bitsPerSample: stats.bitsPerSample,
        frames: stats.frames,
        durationSeconds: Number(stats.durationSeconds.toFixed(5)),
        audibleSeconds: Number(stats.audibleSeconds.toFixed(5)),
        peak: Number(stats.peak.toFixed(5)),
        peakDbfs: Number.isFinite(stats.peakDbfs) ? Number(stats.peakDbfs.toFixed(2)) : null,
        rms: Number(stats.rms.toFixed(5)),
        silent: stats.silent,
      };

      const lines = [
        `${basename(file)}: ${stats.channels}ch @ ${stats.sampleRate}Hz, ${stats.durationSeconds.toFixed(4)}s`,
        `  audible ${stats.audibleSeconds.toFixed(4)}s, peak ${stats.peak.toFixed(4)} ` +
          `(${data.peakDbfs ?? '-inf'} dBFS), rms ${stats.rms.toFixed(4)}`,
        ...(stats.silent ? ['  [SILENT]'] : []),
      ];

      if (args.detectPitch) {
        const segments = detectPitches(decoded, {
          channel,
          minFrequency,
          maxFrequency,
          windowSeconds: args.windowSeconds as number | undefined,
        });
        const cap = (args.maxSegments as number | undefined) ?? 64;
        const capped = segments.slice(0, cap);
        data.pitchSegments = capped.map((segment) => ({
          startSeconds: Number(segment.startSeconds.toFixed(4)),
          endSeconds: Number(segment.endSeconds.toFixed(4)),
          frequency: Number(segment.frequency.toFixed(2)),
          note: segment.note,
          cents: segment.cents,
          confidence: Number(segment.confidence.toFixed(3)),
        }));
        data.pitchSegmentCount = segments.length;
        lines.push(`  detected ${segments.length} pitch segment(s):`);
        for (const segment of capped.slice(0, 24)) {
          lines.push(
            `    ${segment.startSeconds.toFixed(3)}-${segment.endSeconds.toFixed(3)}s  ${segment.note} ` +
              `(${segment.frequency.toFixed(1)} Hz, ${segment.cents >= 0 ? '+' : ''}${segment.cents} cents, ` +
              `conf ${segment.confidence.toFixed(2)})`,
          );
        }
        if (segments.length > 24) lines.push(`    ... ${segments.length - 24} more`);
        const first = capped.find((segment) => segment.startSeconds > 0.005);
        data.firstPitch = first
          ? { frequency: Number(first.frequency.toFixed(2)), note: first.note, cents: first.cents }
          : null;
      } else {
        const start = Math.min(Math.floor(0.01 * decoded.sampleRate), Math.max(0, decoded.frames - 2048));
        const pitch = estimatePitch(
          decoded.samples,
          start,
          Math.min(2048, decoded.frames),
          decoded.sampleRate,
          { minFrequency, maxFrequency },
        );
        data.instantPitch = {
          frequency: Number(pitch.frequency.toFixed(2)),
          note: pitch.note,
          cents: pitch.cents,
          confidence: Number(pitch.confidence.toFixed(3)),
        };
        lines.push(
          `  first-window pitch: ${pitch.note || 'n/a'} (${pitch.frequency.toFixed(1)} Hz, ` +
            `conf ${pitch.confidence.toFixed(2)})`,
        );
      }

      return toToolResult({
        summary: `${basename(file)}: ${stats.durationSeconds.toFixed(3)}s, peak ${stats.peak.toFixed(3)}${
          stats.silent ? ' [SILENT]' : ''
        }`,
        text: lines.join('\n'),
        data,
      });
    },
  });

  defineTool(registry, {
    name: 'run_famistudio',
    title: 'Run an arbitrary FamiStudio CLI command',
    description:
      'Escape hatch for FamiStudio commands this server does not wrap (NSF export, ROM export, assembly ' +
      'export with exotic options). Runs `FamiStudio <input> <command> <output> [extraArgs...]` with the ' +
      'given argv and no shell involved. Prefer export_audio / export_text when they fit.',
    inputShape: {
      input: z.string().describe('Input file (.fms, .txt, .ftm, .nsf).'),
      command: z.string().describe(`FamiStudio command, e.g. one of: ${EXPORT_COMMANDS.join(', ')}.`),
      output: z.string().describe('Output path.'),
      extraArgs: z
        .array(z.string())
        .optional()
        .describe('Extra switches passed verbatim, e.g. ["-wav-export-rate:44100"].'),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    },
    annotations: WRITES_FILES,
    handler: async (args, context) => {
      if (!(await findFamiStudio()) && !context.config.famistudioExe) {
        throw new ToolError('FamiStudio executable not found. Install FamiStudio 4.5.x or set FAMISTUDIO_EXE.');
      }
      const inputPath = context.resolveReadPath(args.input as string);
      const outputPath = await context.resolveWritePath(args.output as string);
      await context.ensureDir(resolve(outputPath, '..'));

      const result = await runCli([inputPath, args.command as string, outputPath], {
        extraArgs: args.extraArgs as string[] | undefined,
        timeoutMs: args.timeoutMs as number | undefined,
        executable: context.config.famistudioExe,
      });
      const artifact = existsSync(outputPath) ? await context.track(outputPath) : undefined;

      return toToolResult({
        summary: `${args.command} -> ${basename(outputPath)} (exit ${result.exitCode}${
          result.timedOut ? ', timed out' : ''
        })`,
        text: toolText(
          `FamiStudio ${args.command}`,
          `argv: ${result.args.join(' ')}`,
          `exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}, took ${result.durationMs} ms`,
          result.log.length > 0 ? `log:\n${result.log.map((line) => `  ${line}`).join('\n')}` : '',
          result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        ),
        data: {
          input: inputPath,
          output: outputPath,
          command: args.command,
          argv: result.args,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          log: result.log,
          stderr: result.stderr,
        },
        artifacts: artifact ? [artifact] : [],
      });
    },
  });
}

export { materializeProject };
