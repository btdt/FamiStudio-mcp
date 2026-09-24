#!/usr/bin/env node
/**
 * Dev-only: dump the byte offset of every region of an uncompressed project
 * payload, and compare two payloads region by region.
 *
 *   node scripts/offsets.mjs <file.fms> [<file2.fms>]
 *
 * Region-level deltas localize a serialization bug far faster than a raw byte
 * diff, because every region boundary is an independent proof of correctness.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const core = await import(pathToFileURL(join(root, 'dist', 'core', 'index.js')).href);

/** A cursor that records named offsets. */
class Cursor {
  constructor(buffer) {
    this.b = buffer;
    this.p = 0;
    this.marks = [];
  }
  mark(label) {
    this.marks.push({ label, offset: this.p });
  }
  i32() {
    const v = this.b.readInt32LE(this.p);
    this.p += 4;
    return v;
  }
  u16() {
    const v = this.b.readUInt16LE(this.p);
    this.p += 2;
    return v;
  }
  i16() {
    const v = this.b.readInt16LE(this.p);
    this.p += 2;
    return v;
  }
  u8() {
    return this.b[this.p++];
  }
  i8() {
    return this.b.readInt8(this.p++);
  }
  bool() {
    return this.b[this.p++] !== 0;
  }
  str() {
    const len = this.i32();
    if (len < 0) return '';
    const s = this.b.toString('utf16le', this.p, this.p + len);
    this.p += len;
    return s;
  }
  arr(read, tag) {
    const len = this.i32();
    this.mark(`${tag}[len=${len}]`);
    if (len < 0) return null;
    const out = [];
    for (let i = 0; i < len; i += 1) out.push(read());
    return out;
  }
}

function walk(payload) {
  const c = new Cursor(payload);
  c.mark('start');
  c.i32(); // nextUniqueId
  c.bool();
  c.bool();
  c.bool();
  c.bool();
  c.str();
  c.str();
  c.str();
  c.i32(); // expansionMask
  c.i32(); // n163 channels
  c.i32(); // tempoMode
  c.bool(); // pal
  c.mark('after metadata+audio flags');

  // 12 export configs: skip by re-reading the structure the same way the writer does.
  const skipChannels = () => {
    const n = c.i32();
    for (let i = 0; i < n; i += 1) {
      c.i32();
      c.i32();
      c.bool();
      c.i32();
      c.i32();
      c.i32();
    }
  };
  const skipSongList = () => {
    const n = c.i32();
    for (let i = 0; i < n; i += 1) {
      c.i32();
      c.bool();
    }
  };

  // audio
  c.i32();
  c.str();
  c.str();
  c.str();
  c.str();
  c.i32();
  c.i32();
  c.i32();
  c.bool();
  c.bool();
  c.bool();
  skipChannels();
  c.mark('after audio config');
  // video
  c.i32();
  c.str();
  c.str();
  c.str();
  c.str();
  c.str();
  c.i32();
  c.i32();
  c.i32();
  c.i32();
  c.i32();
  c.str();
  c.str();
  c.str();
  c.i32();
  c.str();
  c.bool();
  c.bool();
  skipChannels();
  c.mark('after video config');
  // nsf
  c.str();
  c.str();
  c.str();
  c.str();
  c.str();
  skipSongList();
  // romFds
  c.str();
  c.str();
  c.str();
  c.str();
  skipSongList();
  // midi
  c.i32();
  c.bool();
  c.bool();
  c.i32();
  c.str();
  {
    const n = c.i32();
    for (let i = 0; i < n; i += 1) {
      c.i32();
      c.i32();
      c.i32();
      c.i32();
    }
  }
  // vgm
  c.i32();
  for (let i = 0; i < 7; i += 1) c.str();
  c.bool();
  // famiStudioText
  c.bool();
  skipSongList();
  // famiTrackerText
  skipSongList();
  c.mark('after configs 1-8');
  // music/sfx x2
  for (let i = 0; i < 2; i += 1) {
    c.str();
    c.bool();
    c.str();
    c.str();
    c.str();
    c.bool();
    c.bool();
    skipSongList();
    c.str();
    c.str();
    c.bool();
    skipSongList();
  }
  c.mark('after all 12 configs');

  c.i32(); // tuning
  {
    const n = c.i32();
    c.mark(`folders[${n}]`);
    for (let i = 0; i < n; i += 1) {
      c.i32();
      c.str();
      c.bool();
    }
  }
  c.bool();
  c.bool();
  c.bool();
  c.bool(); // overrideBassCutoffHz
  c.i32(); // overrideMask
  c.mark('after folders + mixer');

  // samples: skip generically (none expected in our generated files)
  {
    const n = c.i32();
    c.mark(`samples[${n}]`);
    for (let i = 0; i < n; i += 1) {
      c.i32();
      c.str();
      const isWav = c.bool();
      if (isWav) {
        c.i32();
        c.arr(() => c.i16(), 'wavData');
      } else {
        c.arr(() => c.u8(), 'dmcData');
      }
      c.i32();
      c.i32();
      c.str();
      c.i32();
      c.i32();
      c.i32();
      c.i32();
      c.bool();
      c.bool();
      c.bool();
      for (let k = 0; k < 4; k += 1) {
        c.i32();
        c.b.readFloatLE(c.p);
        c.p += 4;
      }
      c.str();
      c.i32();
      c.i32();
    }
  }
  c.mark('after samples');

  const instrumentCount = c.i32();
  c.mark(`instruments[${instrumentCount}]`);
  for (let i = 0; i < instrumentCount; i += 1) {
    const id = c.i32();
    const name = c.str();
    c.i32();
    const expansion = c.i32();
    const mask = c.u16();
    let envelopeBytes = 0;
    for (let t = 0; t < 10; t += 1) {
      if ((mask & (1 << t)) === 0) continue;
      c.i32();
      c.i32();
      c.i32();
      c.bool();
      const len = c.i32();
      c.p += len;
      envelopeBytes += len;
    }
    c.str();
    const mappingCount = c.i32();
    for (let k = 0; k < mappingCount; k += 1) c.i32();
    for (let k = 0; k < mappingCount; k += 1) {
      c.i32();
      c.bool();
      c.i32();
      c.bool();
      c.i32();
    }
    c.mark(`  instrument ${i} id=${id} "${name}" exp=${expansion} mask=0x${mask.toString(16)} envValues=${envelopeBytes} maps=${mappingCount}`);
  }
  c.mark('after instruments');

  const arpeggioCount = c.i32();
  c.mark(`arpeggios[${arpeggioCount}]`);
  for (let i = 0; i < arpeggioCount; i += 1) {
    c.i32();
    c.str();
    c.i32();
    c.str();
    c.i32();
    c.i32();
    c.i32();
    c.bool();
    const len = c.i32();
    c.p += len;
  }
  c.mark('after arpeggios');

  const songCount = c.i32();
  c.mark(`songs[${songCount}]`);
  for (let i = 0; i < songCount; i += 1) {
    const id = c.i32();
    const patternLength = c.i32();
    const songLength = c.i32();
    c.i32();
    const name = c.str();
    c.i32();
    c.i32();
    c.i32();
    c.i32();
    c.i32();
    c.arr(() => c.i32(), 'groove');
    c.i32();
    for (let k = 0; k < songLength; k += 1) {
      c.bool();
      c.i32();
      c.i32();
      c.i32();
      c.arr(() => c.i32(), 'pcs.groove');
      c.i32();
    }
    c.str();
    c.mark(`  song ${i} id=${id} "${name}" patternLength=${patternLength} songLength=${songLength}`);
    for (let ch = 0; ch < 5; ch += 1) {
      const songRef = c.i32();
      const patternCount = c.i32();
      const type = c.i32();
      c.mark(`    channel ${ch} type=${type} ref=${songRef} patterns=${patternCount}`);
      for (let p = 0; p < patternCount; p += 1) {
        const pid = c.i32();
        const pname = c.str();
        c.i32();
        c.i32();
        c.i32();
        const noteCount = c.i32();
        for (let n = 0; n < noteCount; n += 1) {
          const time = c.i16();
          const value = c.u8();
          const flags = c.u8();
          const musical = value !== 0 && value !== 0x80 && value !== 0xff;
          if (musical) {
            c.u8();
            c.i32();
          }
          if (musical) {
            c.u16();
            c.u16();
          }
          const effectMask = c.u16();
          // Bit order taken from Note.Serialize + Note.EffectXxx.
          if (effectMask & (1 << 0)) c.u8(); // volume
          if (effectMask & ((1 << 1) | (1 << 2))) c.u8(); // vibrato (two bits, one byte)
          if (effectMask & (1 << 4)) c.u8(); // speed
          if (effectMask & (1 << 3)) c.i8(); // finePitch
          if (effectMask & (1 << 6)) c.u16(); // fdsModSpeed
          if (effectMask & (1 << 5)) c.u8(); // fdsModDepth
          if (effectMask & (1 << 7)) c.u8(); // dutyCycle
          if (effectMask & (1 << 8)) c.u8(); // noteDelay
          if (effectMask & (1 << 9)) c.u8(); // cutDelay
          if ((effectMask & ((1 << 0) | (1 << 10))) === ((1 << 0) | (1 << 10))) c.u8(); // volumeSlide
          if (effectMask & (1 << 11)) c.u8(); // dmcCounter
          if (effectMask & (1 << 12)) c.u8(); // phaseReset
          if (effectMask & (1 << 13)) c.u16(); // envPeriod
          c.i32(); // arpeggio ref
          c.mark(`      note t=${time} v=${value} mask=0x${effectMask.toString(16)}`);
        }
        c.mark(`      pattern ${p} id=${pid} "${pname}" notes=${noteCount}`);
      }
      c.i32();
      c.p += 255 * 4;
      c.mark(`    channel ${ch} end`);
    }
  }
  c.mark('end');
  return c;
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: node scripts/offsets.mjs <file.fms> [<file2.fms>]');
  process.exit(2);
}

const runs = [];
for (const file of files) {
  const payload = core.readFmsPayload(await readFile(file));
  const cursor = walk(payload);
  runs.push({ file, payload, cursor });
  console.log(`\n=== ${file} (payload ${payload.byteLength}B) ===`);
  for (const mark of cursor.marks) {
    if (mark.label.startsWith('      note') && !process.argv.includes('--notes')) continue;
    console.log(`  ${String(mark.offset).padStart(6)}  ${mark.label}`);
  }
  console.log(`  ${String(cursor.p).padStart(6)}  [consumed ${cursor.p}/${payload.byteLength}]`);
}
