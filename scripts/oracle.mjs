#!/usr/bin/env node
/**
 * Dev-only oracle test against FamiStudio's own project files.
 *
 *   node scripts/oracle.mjs [--dir "<path>"] [--limit N]
 *
 * For every version-19 `.fms` it decodes and re-encodes the project and requires
 * the *uncompressed payload* to match byte for byte. Files written by older
 * FamiStudio versions are reported separately: they are out of scope for a
 * version-19 writer, but they are useful as a census of what is out there.
 *
 * A mismatch means the writer's field layout differs from FamiStudio's; the
 * first differing offset plus the effect census narrows down which field.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const core = await import(pathToFileURL(join(root, 'dist', 'core', 'index.js')).href);

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const dir = argOf('--dir', 'C:\\Program Files\\FamiStudio\\Demo Songs');
const limit = Number.parseInt(argOf('--limit', '500'), 10);

if (!existsSync(dir)) {
  console.error(`directory not found: ${dir}`);
  process.exit(2);
}

const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.fms')).slice(0, limit);
const olderVersions = [];
let identical = 0;
const problems = [];

for (const name of files) {
  let original;
  try {
    original = await readFile(join(dir, name));
  } catch {
    continue;
  }

  let version;
  try {
    version = core.readFmsHeader(original).version;
  } catch (error) {
    problems.push([name, `not a .fms file: ${error.message}`]);
    continue;
  }

  if (version !== 19) {
    olderVersions.push(`${name} (v${version})`);
    continue;
  }

  const project = core.readProject(original);
  const payloadA = core.readFmsPayload(original);
  let payloadB;
  try {
    payloadB = core.writeProjectPayload(project);
  } catch (error) {
    problems.push([name, `re-encode threw: ${error.message}`]);
    continue;
  }

  if (payloadA.equals(payloadB)) {
    identical += 1;
    console.log(`  ok        ${name}`);
    continue;
  }

  let firstDiff = -1;
  for (let i = 0; i < Math.min(payloadA.byteLength, payloadB.byteLength); i += 1) {
    if (payloadA[i] !== payloadB[i]) {
      firstDiff = i;
      break;
    }
  }

  const effects = new Map();
  for (const song of project.songs) {
    for (const channel of song.channels) {
      for (const pattern of channel.patterns) {
        for (const note of pattern.notes) {
          for (const [effect, value] of Object.entries(note.effectValues)) {
            if (value === undefined) continue;
            effects.set(effect, (effects.get(effect) ?? 0) + 1);
          }
        }
      }
    }
  }

  problems.push([
    name,
    `payload ${payloadA.byteLength}B -> ${payloadB.byteLength}B, first diff @${firstDiff}\n` +
      `            effects: ${[...effects.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}\n` +
      `            a: ${payloadA.subarray(Math.max(0, firstDiff - 8), firstDiff + 12).toString('hex')}\n` +
      `            b: ${payloadB.subarray(Math.max(0, firstDiff - 8), firstDiff + 12).toString('hex')}`,
  ]);
}

console.log('');
for (const [name, detail] of problems) console.log(`  MISMATCH  ${name}: ${detail}`);

const v19 = files.length - olderVersions.length;
console.log(`\nversion 19: ${identical}/${v19} payload-identical, ${problems.length} problematic`);
if (olderVersions.length > 0) {
  console.log(`skipped ${olderVersions.length} file(s) written by older FamiStudio versions:`);
  console.log(`  ${olderVersions.join(', ')}`);
}

process.exit(problems.length === 0 ? 0 : 1);
