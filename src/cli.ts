#!/usr/bin/env node
/**
 * `famistudio-mcp-cli`: the same engine as the MCP server, driven from a shell.
 *
 * Useful for CI, for scripting without an MCP host, and for verifying a
 * generated project end to end:
 *
 *   famistudio-mcp-cli compile spec.json -o out/song.fms
 *   famistudio-mcp-cli verify out/song.fms
 *   famistudio-mcp-cli export out/song.fms out/song.wav
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyzeWav,
  compileSongSpec,
  decodeWav,
  detectPitches,
  famistudioInfo,
  findFamiStudio,
  frameRateFor,
  readProject,
  runExport,
  summarizeProject,
  validateProject,
  writeFms,
  type SongSpecDocument,
} from './core/index.js';

const USAGE = `famistudio-mcp-cli - FamiStudio .fms toolkit

Usage:
  famistudio-mcp-cli info                                  show FamiStudio discovery info
  famistudio-mcp-cli compile <spec.json> [-o out.fms]      compile a JSON song spec
  famistudio-mcp-cli read <file.fms> [--json]              decode a project
  famistudio-mcp-cli validate <file.fms|spec.json>         check project invariants
  famistudio-mcp-cli export <in.fms> <out.wav> [options]   render audio via FamiStudio
  famistudio-mcp-cli txt <in.fms> [out.txt]                export FamiStudio text
  famistudio-mcp-cli verify <file.fms|spec.json>           text+audio round trip report
  famistudio-mcp-cli analyze <file.wav> [--pitch]          audio statistics / pitch list

Options for "export":
  --rate <11025|22050|44100|48000>   sample rate (default 44100)
  --duration <seconds>               render length; 0 = play once and stop
  --loop <count>                     number of loops
  --songs <i,j,...>                  zero-based song indices
  --separate-channels                one file per channel
  --channels <hex mask>              channel enable mask, e.g. 1 for Square1

Notes:
  A spec file may be either the full song spec document or the bare object with
  "channels". Run the compile step to turn it into a .fms file.
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    json: { type: 'boolean' },
    rate: { type: 'string' },
    duration: { type: 'string' },
    loop: { type: 'string' },
    songs: { type: 'string' },
    channels: { type: 'string' },
    'separate-channels': { type: 'boolean' },
    pitch: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...rest] = positionals;

/** Read either a song spec document or a raw project JSON file. */
async function loadSpec(path: string): Promise<SongSpecDocument> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text) as SongSpecDocument;
}

/** Load a project from either a `.fms` file or a JSON spec. */
async function loadAnyProject(path: string): Promise<{ project: ReturnType<typeof compileSongSpec>['project']; label: string }> {
  if (extname(path).toLowerCase() === '.fms') {
    return { project: readProject(await readFile(path)), label: path };
  }
  const spec = await loadSpec(path);
  return { project: compileSongSpec(spec).project, label: path };
}

function printSummary(project: ReturnType<typeof compileSongSpec>['project'], label: string): void {
  const summary = summarizeProject(project);
  process.stdout.write(`# ${label}\n`);
  process.stdout.write(`project "${summary.name}"  version=${summary.version}  ${summary.pal ? 'PAL' : 'NTSC'}\n`);
  for (const song of summary.songs as Record<string, unknown>[]) {
    process.stdout.write(
      `song "${song.name}" id=${song.id} ${song.patternLength}x${song.songLength}=${song.totalTicks} ticks ` +
        `(${song.durationSeconds}s)\n`,
    );
    for (const channel of song.channels as Record<string, unknown>[]) {
      process.stdout.write(`  ${channel.channel}: ${channel.patterns} pattern(s), ${channel.notes} note(s)\n`);
    }
  }
}

function parseSongList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry >= 0);
}

try {
  switch (command) {
    case 'info': {
      const info = await famistudioInfo();
      process.stdout.write(
        info.found
          ? `FamiStudio: ${info.executable}${info.version ? ` (v${info.version})` : ''}\n`
          : 'FamiStudio: not found\n',
      );
      if (!info.found) {
        process.stdout.write('probed paths:\n');
        for (const candidate of info.candidates) process.stdout.write(`  ${candidate}\n`);
      }
      break;
    }

    case 'compile': {
      const specPath = rest[0];
      if (!specPath) throw new Error('compile needs a spec path.');
      const compiled = compileSongSpec(await loadSpec(specPath));
      const problems = validateProject(compiled.project);
      if (problems.length > 0) throw new Error(`compiled project is invalid:\n  - ${problems.join('\n  - ')}`);
      const bytes = writeFms(compiled.project);
      const output = values.output ?? `${compiled.project.name}${extname(specPath) ? '.fms' : '.fms'}`;
      await writeFile(output, bytes);
      printSummary(compiled.project, output);
      process.stdout.write(`wrote ${output} (${bytes.byteLength} bytes)\n`);
      break;
    }

    case 'read': {
      const file = rest[0];
      if (!file) throw new Error('read needs a .fms path.');
      const project = readProject(await readFile(file));
      if (values.json) {
        process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
      } else {
        printSummary(project, file);
      }
      break;
    }

    case 'validate': {
      const file = rest[0];
      if (!file) throw new Error('validate needs a .fms or spec path.');
      const { project, label } = await loadAnyProject(file);
      const problems = validateProject(project);
      if (problems.length === 0) {
        process.stdout.write(`${label}: OK\n`);
      } else {
        process.stdout.write(`${label}: ${problems.length} problem(s)\n`);
        for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
        process.exitCode = 1;
      }
      break;
    }

    case 'export': {
      const [input, output] = rest;
      if (!input || !output) throw new Error('export needs <in.fms> and <out.wav>.');
      if (!(await findFamiStudio())) throw new Error('FamiStudio not found. Set FAMISTUDIO_EXE.');
      const result = await runExport(input, {
        command: 'wav-export',
        outputPath: output,
        rate: values.rate ? Number.parseInt(values.rate, 10) : undefined,
        durationSeconds: values.duration ? Number.parseFloat(values.duration) : undefined,
        loopCount: values.loop ? Number.parseInt(values.loop, 10) : undefined,
        songs: parseSongList(values.songs),
        channelMask: values.channels ? Number.parseInt(values.channels, 16) : undefined,
        separateChannels: values['separate-channels'],
      });
      process.stdout.write(`exported ${output} in ${result.durationMs} ms\n`);
      if (result.log.length > 0) for (const line of result.log) process.stdout.write(`  ${line}\n`);
      if (existsSync(output)) {
        const stats = analyzeWav(decodeWav(await readFile(output)));
        process.stdout.write(
          `  ${stats.durationSeconds.toFixed(3)}s @ ${stats.sampleRate}Hz, peak ${stats.peak.toFixed(4)}` +
            `${stats.silent ? ' [SILENT]' : ''}\n`,
        );
      }
      break;
    }

    case 'txt': {
      const file = rest[0];
      if (!file) throw new Error('txt needs a .fms path.');
      const output = rest[1] ?? `${basename(file, extname(file))}.txt`;
      await runExport(file, { command: 'famistudio-txt-export', outputPath: output });
      process.stdout.write(`wrote ${output}\n`);
      break;
    }

    case 'verify': {
      const file = rest[0];
      if (!file) throw new Error('verify needs a .fms or spec path.');
      const { project, label } = await loadAnyProject(file);
      const frameRate = frameRateFor(project.pal);
      const summary = summarizeProject(project);
      printSummary(project, label);
      const expected = (summary.songs as Record<string, unknown>[])[0]?.durationSeconds as number | undefined;

      const txtPath = join(process.cwd(), `.verify-${Date.now()}.txt`);
      const wavPath = txtPath.replace(/\.txt$/, '.wav');
      await runExport(file, { command: 'famistudio-txt-export', outputPath: txtPath });
      const text = await readFile(txtPath, 'utf8');
      const desync = /Tuning="-1"|VolumeDb="NaN"/.test(text);
      process.stdout.write(`text export: ${desync ? 'DESYNC DETECTED' : 'clean'}\n`);

      await runExport(file, { command: 'wav-export', outputPath: wavPath, rate: 44100, durationSeconds: 0 });
      const stats = analyzeWav(decodeWav(await readFile(wavPath)));
      process.stdout.write(
        `render: ${stats.durationSeconds.toFixed(3)}s, audible ${stats.audibleSeconds.toFixed(3)}s, ` +
          `peak ${stats.peak.toFixed(4)}${stats.silent ? ' [SILENT]' : ''}\n`,
      );
      if (expected !== undefined) {
        const delta = Math.abs(stats.audibleSeconds - expected);
        process.stdout.write(
          `duration check: expected ~${expected}s, got ${stats.audibleSeconds.toFixed(3)}s ` +
            `(${delta <= Math.max(0.05, expected * 0.05) ? 'OK' : 'MISMATCH'})\n`,
        );
      }
      process.stdout.write(`frame rate ${frameRate.toFixed(3)} Hz; intermediates: ${txtPath}, ${wavPath}\n`);
      if (desync || stats.silent) process.exitCode = 1;
      break;
    }

    case 'analyze': {
      const file = rest[0];
      if (!file) throw new Error('analyze needs a .wav path.');
      const wav = decodeWav(await readFile(file));
      const stats = analyzeWav(wav);
      process.stdout.write(
        `${basename(file)}: ${stats.channels}ch @ ${stats.sampleRate}Hz, ${stats.durationSeconds.toFixed(4)}s, ` +
          `peak ${stats.peak.toFixed(4)} (${Number.isFinite(stats.peakDbfs) ? `${stats.peakDbfs.toFixed(1)} dBFS` : '-inf'}), ` +
          `rms ${stats.rms.toFixed(4)}${stats.silent ? ' [SILENT]' : ''}\n`,
      );
      if (values.pitch) {
        for (const segment of detectPitches(wav)) {
          process.stdout.write(
            `  ${segment.startSeconds.toFixed(3)}-${segment.endSeconds.toFixed(3)}s ` +
              `${segment.note} (${segment.frequency.toFixed(1)} Hz, ${segment.cents >= 0 ? '+' : ''}${segment.cents} cents)\n`,
          );
        }
      }
      break;
    }

    case 'help':
    case undefined: {
      process.stdout.write(USAGE);
      break;
    }

    default: {
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  if (process.env.FAMISTUDIO_MCP_DEBUG) process.stderr.write(`${(error as Error).stack}\n`);
  process.exitCode = 1;
}

void resolve;
