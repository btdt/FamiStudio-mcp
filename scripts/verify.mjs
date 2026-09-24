#!/usr/bin/env node
/**
 * End-to-end verification harness.
 *
 * Usage:
 *   node scripts/verify.mjs [--fms-dir <dir with real .fms files>] [--out <dir>]
 *
 * Steps performed:
 *   1. Compile the bundled sample song spec and assert structural invariants.
 *   2. Decode -> re-encode every `.fms` in the sample directory and require a
 *      BYTE IDENTICAL result (this is the real proof the format is right).
 *   3. If FamiStudio is available: round-trip each generated project through
 *      `famistudio-txt-export` and check for the known desync symptoms
 *      (Tuning="-1", VolumeDb="NaN", SongCount=0).
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const core = await import(pathToFileURL(join(root, 'dist', 'core', 'index.js')).href);

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const fmsDir = argOf('--fms-dir', 'D:\\BANANA!! Assets');
const outDir = argOf('--out', join(tmpdir(), 'famistudio-mcp-verify'));

let failures = 0;
const pass = (message) => console.log(`  \u2713 ${message}`);
const fail = (message) => {
  failures += 1;
  console.error(`  \u2717 ${message}`);
};
const section = (title) => console.log(`\n${title}`);

await mkdir(outDir, { recursive: true });

/* -------------------------------------------------------------------------- */
section('1. Compile a spec');
/* -------------------------------------------------------------------------- */

const spec = {
  name: 'Verify',
  author: 'famistudio-mcp',
  channels: [
    {
      channel: 'Square1',
      notes: [
        { time: 0, note: 'C4', duration: 8 },
        { time: 8, note: 'E4', duration: 8 },
        { time: 16, note: 'G4', duration: 16 },
        { time: 32, note: 'C5', duration: 4, effects: { volume: 12, dutyCycle: 1 } },
        { time: 36, note: 'stop' },
      ],
    },
    { channel: 'Triangle', patternLength: 64, notes: [{ time: 0, note: 'C2', duration: 32 }, { time: 32, note: 'G1', duration: 32 }] },
    {
      channel: 'Noise',
      // Grid form: one entry per tick, and a nested array means "several
      // events land on this tick".
      notes: [
        [{ note: 'C4', duration: 2 }, null, null, null],
        null,
        null,
        null,
      ],
    },
  ],
  patternLength: 64,
};

let compiled;
try {
  compiled = core.compileSongSpec(spec);
  pass(`compiled ${compiled.songs.length} song(s), ${compiled.project.instruments.length} instrument(s)`);
} catch (error) {
  fail(`compileSongSpec threw: ${error.message}`);
  process.exit(1);
}

const problems = core.validateProject(compiled.project);
if (problems.length === 0) pass('validateProject found no problems');
else fail(`validateProject: ${problems.join('; ')}`);

try {
  const bytes = core.writeFms(compiled.project);
  await writeFile(join(outDir, 'verify.fms'), bytes);
  const reread = core.readProject(bytes);
  const rewrote = core.writeFms(reread);
  if (bytes.equals(rewrote)) pass(`write -> read -> write is byte identical (${bytes.byteLength} bytes)`);
  else fail('write -> read -> write differs (model round trip is lossy)');
} catch (error) {
  fail(`write/read failed: ${error.stack}`);
}

/* -------------------------------------------------------------------------- */
section(`2. Real-file round trip (${fmsDir})`);
/* -------------------------------------------------------------------------- */

if (!existsSync(fmsDir)) {
  fail(`sample directory not found: ${fmsDir} (pass --fms-dir)`);
} else {
  const files = (await readdir(fmsDir)).filter((name) => extname(name).toLowerCase() === '.fms');
  if (files.length === 0) fail(`no .fms files in ${fmsDir}`);

  for (const name of files) {
    const original = await readFile(join(fmsDir, name));
    try {
      const project = core.readProject(original);
      const reencoded = core.writeFms(project);

      // The deflate stream is free to differ between encoders; what must match
      // exactly is the *uncompressed* payload, i.e. the serialized structure.
      const payloadOriginal = core.readFmsPayload(original);
      const payloadReencoded = core.writeProjectPayload(project);

      if (payloadReencoded.equals(payloadOriginal)) {
        const containerNote = reencoded.equals(original)
          ? 'byte identical'
          : `payload identical, container ${original.byteLength}B -> ${reencoded.byteLength}B (deflate differs)`;
        pass(
          `${name} (${project.songs.length} song(s), ${project.instruments.length} instrument(s), ${payloadOriginal.byteLength}B payload): ${containerNote}`,
        );
      } else {
        let firstDiff = -1;
        for (let i = 0; i < Math.min(payloadOriginal.byteLength, payloadReencoded.byteLength); i += 1) {
          if (payloadOriginal[i] !== payloadReencoded[i]) {
            firstDiff = i;
            break;
          }
        }
        fail(
          `${name}: payload differs (${payloadOriginal.byteLength}B -> ${payloadReencoded.byteLength}B), ` +
            `first difference at ${firstDiff}`,
        );
        await writeFile(join(outDir, `FAILED-${basename(name)}`), payloadReencoded);
      }
    } catch (error) {
      fail(`${name}: ${error.message}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
section('3. FamiStudio CLI round trip');
/* -------------------------------------------------------------------------- */

const info = await core.famistudioInfo();
if (!info.found) {
  console.log('  - FamiStudio not found; skipping CLI checks');
} else {
  console.log(`  - using ${info.executable}${info.version ? ` (v${info.version})` : ''}`);

  const input = join(outDir, 'verify.fms');
  const txt = join(outDir, 'verify.txt');
  const wav = join(outDir, 'verify.wav');

  try {
    const textResult = await core.runExport(input, { command: 'famistudio-txt-export', outputPath: txt });
    const text = await readFile(txt, 'utf8');
    if (/Tuning="-1"|VolumeDb="NaN"/.test(text)) {
      fail('text export shows desync symptoms (Tuning="-1" / VolumeDb="NaN")');
    } else {
      pass('famistudio-txt-export produced a clean text file');
    }
    if (!/Song\s/.test(text)) fail('text export contains no Song block');
    else pass('text export contains Song data');
    if (textResult.log.length > 0) console.log(`    log: ${textResult.log.join(' | ')}`);
  } catch (error) {
    fail(`famistudio-txt-export failed: ${error.message}`);
  }

  try {
    const wavResult = await core.runExport(input, {
      command: 'wav-export',
      outputPath: wav,
      rate: 44100,
      durationSeconds: 5,
    });
    const wavData = await readFile(wav);
    const decoded = core.decodeWav(wavData);
    const analysis = core.analyzeWav(decoded);
    if (analysis.durationSeconds > 0.5) {
      pass(
        `wav-export produced ${analysis.durationSeconds.toFixed(3)}s @ ${decoded.sampleRate}Hz, ` +
          `peak ${analysis.peak.toFixed(3)} (${analysis.peakDbfs.toFixed(1)} dBFS), audible ${analysis.audibleSeconds.toFixed(3)}s`,
      );
    } else {
      fail(`wav-export produced a suspiciously short file (${analysis.durationSeconds}s)`);
    }
    if (analysis.silent) fail('wav-export produced silence');
    else pass('wav-export is not silent');

    // Pitch check on the first tone (C4 -> ~523.25 Hz in FamiStudio naming).
    const pitch = core.estimatePitch(decoded.samples, Math.floor(0.01 * decoded.sampleRate), 4096, decoded.sampleRate, {
      minFrequency: 200,
      maxFrequency: 1200,
    });
    const expected = 523.25;
    const centsOff = pitch.frequency > 0 ? Math.abs(1200 * Math.log2(pitch.frequency / expected)) : Infinity;
    if (pitch.frequency > 0 && centsOff < 120 && pitch.note === 'C4') {
      pass(`first note detected as ${pitch.note} (${pitch.frequency.toFixed(1)} Hz, ${centsOff.toFixed(0)} cents off C4)`);
    } else {
      fail(
        `pitch detection off: got ${pitch.frequency.toFixed(1)} Hz named ${pitch.note}, expected ~${expected} Hz named C4`,
      );
    }
    void wavResult;
  } catch (error) {
    fail(`wav-export failed: ${error.message}`);
  }
}

/* -------------------------------------------------------------------------- */

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (artifacts in ${outDir})`);
process.exit(failures === 0 ? 0 : 1);
