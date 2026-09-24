#!/usr/bin/env node
/**
 * Dev-only diagnostic: dump the decoded structure of a `.fms` file field by
 * field, and show the first byte where a re-encode diverges.
 *
 *   node scripts/inspect-fms.mjs <file.fms> [--dump]
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const core = await import(pathToFileURL(join(root, 'dist', 'core', 'index.js')).href);

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-fms.mjs <file.fms>');
  process.exit(2);
}

const original = await readFile(file);
const header = core.readFmsHeader(original);
console.log(`file: ${file}`);
console.log(`  version=${header.version} uncompressed=${header.uncompressedSize}`);

const project = core.readProject(original);
console.log(
  `  name="${project.name}" author="${project.author}" tuning=${project.tuning} pal=${project.pal} ` +
    `expansionMask=${project.expansionMask} nextUniqueId=${project.nextUniqueId}`,
);
console.log(`  samples=${project.samples.length} instruments=${project.instruments.length} arpeggios=${project.arpeggios.length} songs=${project.songs.length}`);
for (const sample of project.samples) {
  console.log(`    sample ${sample.id} "${sample.name}" payload=${sample.rawPayload.length}B`);
}
for (const instrument of project.instruments) {
  console.log(
    `    instrument ${instrument.id} "${instrument.name}" mask=0x${instrument.envelopeMask.toString(16)} ` +
      `color=0x${(instrument.color >>> 0).toString(16)} mappings=${instrument.sampleMappings.length}`,
  );
}
for (const song of project.songs) {
  console.log(
    `    song ${song.id} "${song.name}" patternLength=${song.patternLength} songLength=${song.songLength} ` +
      `noteLength=${song.noteLength} groove=[${song.groove}]`,
  );
  for (const channel of song.channels) {
    const notes = channel.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0);
    console.log(`      ${channel.name}: ${channel.patterns.length} patterns, ${notes} notes`);
  }
}

const problems = core.validateProject(project);
console.log(`  validateProject: ${problems.length === 0 ? 'OK' : problems.join(' | ')}`);

let reencoded;
try {
  reencoded = core.writeFms(project);
} catch (error) {
  console.error(`  re-encode failed: ${error.message}`);
  process.exit(1);
}

console.log(`  original=${original.byteLength}B re-encoded=${reencoded.byteLength}B`);
if (original.equals(reencoded)) {
  console.log('  BYTE IDENTICAL');
  process.exit(0);
}

const limit = Math.min(original.byteLength, reencoded.byteLength);
let firstDiff = -1;
for (let i = 0; i < limit; i += 1) {
  if (original[i] !== reencoded[i]) {
    firstDiff = i;
    break;
  }
}
console.log(`  first difference at byte ${firstDiff}`);
console.log(`    original : ${original.subarray(Math.max(0, firstDiff - 16), firstDiff + 32).toString('hex')}`);
console.log(`    re-encoded: ${reencoded.subarray(Math.max(0, firstDiff - 16), firstDiff + 32).toString('hex')}`);

// Compare the uncompressed payloads: the deflate stream can legitimately differ
// in bytes even for equal input, so the payload is what matters.
const payloadA = core.readFmsPayload(original);
const payloadB = core.writeProjectPayload(project);
console.log(`  payload original=${payloadA.byteLength} re-encoded=${payloadB.byteLength}`);
let payloadDiff = -1;
for (let i = 0; i < Math.min(payloadA.byteLength, payloadB.byteLength); i += 1) {
  if (payloadA[i] !== payloadB[i]) {
    payloadDiff = i;
    break;
  }
}
if (payloadDiff < 0) {
  console.log('  payloads are identical (only the deflate stream differs)');
} else {
  console.log(`  first payload difference at byte ${payloadDiff}`);
  console.log(`    original : ${payloadA.subarray(Math.max(0, payloadDiff - 24), payloadDiff + 40).toString('hex')}`);
  console.log(`    re-encoded: ${payloadB.subarray(Math.max(0, payloadDiff - 24), payloadDiff + 40).toString('hex')}`);
  console.log(`    original (ascii): ${JSON.stringify(payloadA.subarray(Math.max(0, payloadDiff - 24), payloadDiff + 40).toString('latin1'))}`);
  console.log(`    re-encoded(ascii): ${JSON.stringify(payloadB.subarray(Math.max(0, payloadDiff - 24), payloadDiff + 40).toString('latin1'))}`);
  if (process.argv.includes('--dump')) {
    console.log('  original tail :', payloadA.subarray(payloadDiff).toString('hex'));
    console.log('  re-encoded tail:', payloadB.subarray(payloadDiff).toString('hex'));
  }
}
process.exit(1);
