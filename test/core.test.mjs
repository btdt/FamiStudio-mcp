/**
 * Core codec and DSL tests.
 *
 * These need no FamiStudio install: they exercise the `.fms` writer/reader and
 * the JSON song-spec compiler on their own. Run `npm run verify` for the
 * end-to-end checks that do require FamiStudio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const require = createRequire(import.meta.url);
/** The core bundle is ESM; `require` of an ESM file is not allowed, so import it. */
const core = await import(new URL(`file://${join(root, 'dist', 'core', 'index.js').replace(/\\/g, '/')}`).href);
void require;

const { compileSongSpec, writeFms, readProject, validateProject, readFmsPayload, writeProjectPayload } = core;

test('constants match FamiStudio 4.5.x', () => {
  assert.equal(core.FMS_VERSION, 19);
  assert.equal(core.FMS_MAGIC, 0x21534d46);
  assert.equal(core.NTSC_FRAME_RATE.toFixed(3), '60.099');
  assert.equal(core.REGULAR_ENVELOPE_MASK, 0x000f);
  assert.equal(core.SONG_MAX_LENGTH, 256);
  assert.equal(core.ENVELOPE_MAX_LENGTH, 256);
});

test('note names follow FamiStudio numbering', () => {
  // FamiStudio's "C4" is value 49 and sounds at 523.25 Hz.
  assert.equal(core.noteNameToValue('C4'), 49);
  assert.equal(core.noteNameToValue('C0'), 1);
  assert.equal(core.noteNameToValue('B7'), 96);
  assert.equal(core.noteNameToValue('A3'), 46);
  assert.equal(core.noteNameToValue('A#3'), 47);
  assert.equal(core.noteNameToValue('Bb3'), 47, 'flats must be accepted');
  assert.equal(core.noteNameToValue('c4'), 49, 'case must not matter');
  assert.equal(core.valueToNoteName(49), 'C4');
  assert.equal(core.valueToNoteName(1), 'C0');
  assert.equal(core.valueToNoteName(96), 'B7');

  assert.throws(() => core.noteNameToValue('H4'), /Invalid note name/);
  assert.throws(() => core.noteNameToValue('C9'), /outside the FamiStudio range/);

  // Name -> frequency -> name must be stable for every note.
  for (let value = 1; value <= 96; value += 1) {
    const name = core.valueToNoteName(value);
    const frequency = core.valueToFrequency(value);
    const back = core.frequencyToNote(frequency);
    assert.equal(back.note, name, `${name} (value ${value})`);
    assert.equal(back.cents, 0, `${name} should be exact`);
  }
});

test('an exact note reports +0 cents, never -0', () => {
  // `Math.round` of a tiny negative residual returns -0, and `assert.strictEqual`
  // uses Object.is, which treats -0 and 0 as different. Whether that residual
  // lands below or above zero depends on the last bit of Math.log2, which differs
  // between platforms - Linux reported -0 for F#2 where Windows reported +0. Pin
  // the normalisation on both sides of zero so it cannot regress silently.
  for (const name of ['F#2', 'C4', 'A3', 'B7']) {
    const exact = core.valueToFrequency(core.noteNameToValue(name));
    for (const frequency of [exact, exact * (1 - 1e-12), exact * (1 + 1e-12)]) {
      const { note, cents } = core.frequencyToNote(frequency);
      assert.equal(note, name, `${name} at ${frequency} Hz`);
      assert.ok(Object.is(cents, 0), `${name} must report +0 cents, got ${cents}`);
    }
  }
});

test('channel aliases resolve', () => {
  assert.equal(core.resolveChannelType('Square1'), 0);
  assert.equal(core.resolveChannelType('sq1'), 0);
  assert.equal(core.resolveChannelType('pulse2'), 1);
  assert.equal(core.resolveChannelType('Triangle'), 2);
  assert.equal(core.resolveChannelType('tri'), 2);
  assert.equal(core.resolveChannelType('noise'), 3);
  assert.equal(core.resolveChannelType('DPCM'), 4);
  assert.equal(core.resolveChannelType('dmc'), 4);
  assert.equal(core.resolveChannelType(3), 3);
  assert.throws(() => core.resolveChannelType('Banjo'), /Unknown channel/);
});

test('tempo arithmetic uses the frame rate', () => {
  assert.equal(core.secondsToTicks(1), 60);
  assert.equal(Math.round(core.ticksToSeconds(601) * 1000) / 1000, 10);
  assert.equal(core.secondsToTicks(1, core.PAL_FRAME_RATE), 50);
});

test('the effect bit table matches FamiStudio Note.EffectXxx', () => {
  // A wrong bit here desynchronizes the whole file, so pin it to the C# source.
  assert.deepEqual(core.EffectBit, {
    volume: 0,
    vibrato: 1,
    speed: 4,
    finePitch: 3,
    fdsModDepth: 5,
    fdsModSpeed: 6,
    dutyCycle: 7,
    noteDelay: 8,
    cutDelay: 9,
    volumeSlide: 10,
    dmcCounter: 11,
    phaseReset: 12,
    envPeriod: 13,
  });
  assert.deepEqual(core.VIBRATO_BITS, [1, 2]);
});

test('a compiled project has the invariants FamiStudio requires', () => {
  const { project } = compileSongSpec({
    name: 'Invariants',
    patternLength: 16,
    channels: [{ channel: 'Square1', notes: [{ time: 0, note: 'C4' }] }],
  });

  assert.deepEqual(validateProject(project), []);
  assert.equal(project.version, 19);
  assert.equal(project.tempoMode, 0);
  assert.equal(project.expansionMask, 0);
  assert.equal(project.songs.length, 1);

  for (const instrument of project.instruments) {
    // FamiStudio's GUI dereferences these four envelopes on load.
    assert.equal(instrument.envelopeMask & 0x000f, 0x000f);
    for (let type = 0; type < 4; type += 1) {
      const envelope = instrument.envelopes[type];
      assert.ok(envelope, `envelope ${type} must exist`);
      // The writer always emits the full 256-slot array.
      assert.equal(envelope.values.length, 256);
    }
  }

  const song = project.songs[0];
  assert.equal(song.channels.length, 5, 'every song carries all five channels');
  for (const channel of song.channels) {
    assert.equal(channel.patternInstances.length, 256, 'pattern table is fixed length');
  }
  assert.ok(project.nextUniqueId > Math.max(...project.instruments.map((i) => i.id)));
});

test('validateProject reports the classic desync traps', () => {
  const { project } = compileSongSpec({
    name: 'Traps',
    patternLength: 16,
    channels: [{ channel: 'Square1', notes: [{ time: 0, note: 'C4' }] }],
  });

  const brokenMask = structuredClone(project);
  brokenMask.instruments[0].envelopeMask = 0x0001;
  assert.match(validateProject(brokenMask).join('\n'), /missing mandatory envelopes/);

  const brokenId = structuredClone(project);
  brokenId.nextUniqueId = 0;
  assert.match(validateProject(brokenId).join('\n'), /nextUniqueId/);

  const brokenRef = structuredClone(project);
  brokenRef.songs[0].channels[0].patterns[0].notes[0].instrumentId = 999;
  assert.match(validateProject(brokenRef).join('\n'), /unknown instrument 999/);

  const brokenPattern = structuredClone(project);
  brokenPattern.songs[0].channels[0].patternInstances[0] = 12345;
  assert.match(validateProject(brokenPattern).join('\n'), /unknown pattern 12345/);

  const brokenEffect = structuredClone(project);
  brokenEffect.songs[0].channels[0].patterns[0].notes[0].effectValues.volume = 99;
  assert.match(validateProject(brokenEffect).join('\n'), /effect volume=99/);

  const brokenEnvelope = structuredClone(project);
  brokenEnvelope.instruments[0].envelopes[0].values = [1, 2, 3];
  assert.match(validateProject(brokenEnvelope).join('\n'), /values must hold exactly 256/);
});

test('write -> read -> write is byte identical', () => {
  const { project } = compileSongSpec({
    name: 'RoundTrip',
    patternLength: 32,
    noteLength: 4,
    author: 'tests',
    copyright: 'MIT',
    instruments: [
      { name: 'Lead', volume: [15, 13, 11, 9, 7, 5, 3, 1, 0], loop: 0 },
      { name: 'Bass', volume: [15, 10, 5, 0], dutyCycle: [2] },
    ],
    channels: [
      {
        channel: 'Square1',
        notes: [
          { time: 0, note: 'C4', duration: 4 },
          { time: 4, note: 'E4', duration: 4, volume: 12 },
          { time: 8, note: 'G4', duration: 8, effects: { dutyCycle: 1, vibrato: 0x0c2 } },
          { time: 16, note: 'C4', duration: 4, instrument: 'Bass' },
          { time: 20, note: 'stop' },
          { time: 24, note: 'release' },
        ],
      },
      { channel: 'Square2', notes: [{ time: 0, note: 'C3', duration: 32 }] },
      { channel: 'Triangle', notes: [{ time: 0, note: 'C1', duration: 32 }] },
      { channel: 'Noise', notes: [{ time: 0, note: 'C4', duration: 8 }] },
      { channel: 'DPCM', notes: [{ time: 0, note: 'C4', duration: 8, effects: { dmcCounter: 64 } }] },
    ],
  });

  const bytes = writeFms(project);
  assert.equal(bytes.readUInt32LE(0), core.FMS_MAGIC);
  assert.equal(bytes.readUInt32LE(4), 19);

  const again = writeFms(readProject(bytes));
  assert.ok(bytes.equals(again), 'container bytes must survive a round trip');

  const payload = writeProjectPayload(project);
  assert.equal(readFmsPayload(bytes).byteLength, payload.byteLength);
  assert.ok(readFmsPayload(bytes).equals(payload));

  // Every note and effect must come back intact.
  const reread = readProject(bytes);
  const notes = reread.songs[0].channels.find((c) => c.type === 0).patterns[0].notes;
  assert.deepEqual(
    notes.map((note) => [note.time, core.valueToNoteName(note.value), note.duration]),
    [
      [0, 'C4', 4],
      [4, 'E4', 4],
      [8, 'G4', 8],
      [16, 'C4', 4],
      [20, 'stop', 1],
      [24, 'release', 0],
    ],
  );
  assert.equal(notes[1].effectValues.volume, 12);
  assert.equal(notes[2].effectValues.dutyCycle, 1);
  assert.equal(notes[2].effectValues.vibrato, 0xc2);
  assert.equal(reread.instruments.length, 2);
  assert.equal(reread.instruments[1].name, 'Bass');
  assert.deepEqual(reread.instruments[0].envelopes[0].values.slice(0, 9), [15, 13, 11, 9, 7, 5, 3, 1, 0]);
  assert.equal(reread.instruments[0].envelopes[0].loop, 0);
});

test('the compiled project survives JSON serialization', () => {
  // An MCP client sends tool results back as JSON, so a project object must stay
  // usable (including note ticks) after a JSON round trip.
  const { project } = compileSongSpec({
    name: 'JsonSafe',
    patternLength: 32,
    noteLength: 4,
    channels: [
      {
        channel: 'Square1',
        notes: [
          { time: 0, note: 'C4', duration: 4 },
          { time: 8, note: 'E4', duration: 4 },
        ],
      },
    ],
  });

  const revived = JSON.parse(JSON.stringify(project));
  assert.deepEqual(validateProject(revived), []);
  assert.ok(writeFms(revived).equals(writeFms(project)));

  const notes = revived.songs[0].channels[0].patterns[0].notes;
  assert.deepEqual(notes.map((note) => note.time), [0, 8]);
});

test('grid tracks span from one cell to the next', () => {
  const { project } = compileSongSpec({
    name: 'Grid',
    patternLength: 8,
    channels: [
      {
        channel: 'Square1',
        notes: [
          ['C4', null, null, null],
          null,
          null,
          null,
          [{ note: 'E4' }, { note: 'G4' }],
          null,
          null,
          null,
        ],
      },
    ],
  });

  const notes = project.songs[0].channels[0].patterns[0].notes;
  assert.deepEqual(
    notes.map((note) => [note.time, core.valueToNoteName(note.value), note.duration]),
    [
      // The tick-0 cell spans the four ticks to the next cell.
      [0, 'C4', 4],
      // Nothing follows the tick-4 chord, so both members fall back to
      // noteLength (8 by default).
      [4, 'E4', 8],
      [4, 'G4', 8],
    ],
  );
});

test('a grid note sustains to the next distinct cell, not to its chord partner', () => {
  const { project } = compileSongSpec({
    name: 'ChordSpan',
    patternLength: 16,
    channels: [
      {
        channel: 'Square1',
        notes: [
          ['C4', 'E4'],
          null,
          null,
          null,
          ['G4'],
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      },
    ],
  });

  const notes = project.songs[0].channels[0].patterns[0].notes;
  assert.deepEqual(
    notes.map((note) => [note.time, core.valueToNoteName(note.value), note.duration]),
    [
      // The tick-0 chord spans the four ticks to the next chord.
      [0, 'C4', 4],
      [0, 'E4', 4],
      // Nothing follows G4, so it falls back to the default note length.
      [4, 'G4', 8],
    ],
  );
});

test('a grid note with no following cell uses the default note length', () => {
  const { project } = compileSongSpec({
    name: 'GridTail',
    patternLength: 8,
    noteLength: 3,
    channels: [{ channel: 'Square1', notes: ['C4', null, null, null] }],
  });
  const notes = project.songs[0].channels[0].patterns[0].notes;
  assert.equal(notes[0].duration, 3);
});

test('grid cells accept raw FamiStudio note values and words', () => {
  const { project } = compileSongSpec({
    name: 'RawValues',
    patternLength: 16,
    noteLength: 4,
    channels: [
      {
        channel: 'Square1',
        // 49 = C4 and 53 = E4 in FamiStudio numbering, 128 = release, 0 = stop.
        notes: [[49], null, null, null, [53], null, null, null, [128], null, null, null, [0]],
      },
    ],
  });
  const notes = project.songs[0].channels[0].patterns[0].notes;
  assert.deepEqual(
    notes.map((note) => [note.time, note.value]),
    [
      [0, 49],
      [4, 53],
      [8, 128],
      [12, 0],
    ],
  );
  assert.deepEqual(validateProject(project), []);

  // A note name and its numeric value must produce the same note.
  const byName = compileSongSpec({
    name: 'ByName',
    patternLength: 8,
    channels: [{ channel: 'Square1', notes: [['C4'], null, null, null] }],
  }).project;
  const byValue = compileSongSpec({
    name: 'ByValue',
    patternLength: 8,
    channels: [{ channel: 'Square1', notes: [[49], null, null, null] }],
  }).project;
  assert.equal(
    byName.songs[0].channels[0].patterns[0].notes[0].value,
    byValue.songs[0].channels[0].patterns[0].notes[0].value,
  );
});

test('absolute tracks honour an explicit cursor', () => {
  const { project } = compileSongSpec({
    name: 'Absolute',
    patternLength: 64,
    noteLength: 16,
    channels: [
      {
        channel: 'Square1',
        notes: [
          { note: 'C4' },
          { note: 'E4' },
          { note: 'G4', duration: 8 },
        ],
      },
    ],
  });

  const notes = project.songs[0].channels[0].patterns[0].notes;
  assert.deepEqual(notes.map((note) => [note.time, note.duration]), [
    [0, 16],
    [16, 16],
    [32, 8],
  ]);
});

test('the compiler rejects impossible specs with useful messages', () => {
  assert.throws(
    () =>
      compileSongSpec({
        name: 'Overflow',
        patternLength: 16,
        channels: [{ channel: 'Square1', notes: [{ time: 40, note: 'C4' }] }],
      }),
    /tick 40 is outside the pattern/,
  );

  assert.throws(
    () =>
      compileSongSpec({
        name: 'BadChannel',
        channels: [{ channel: 'Saxophone', notes: ['C4'] }],
      }),
    /Unknown channel/,
  );

  assert.throws(
    () =>
      compileSongSpec({
        name: 'BadInstrument',
        instruments: [{ name: 'Lead' }],
        channels: [{ channel: 'Square1', notes: [{ note: 'C4', instrument: 'Fiddle' }] }],
      }),
    /unknown instrument "Fiddle"/,
  );

  assert.throws(
    () =>
      compileSongSpec({
        name: 'BadEffect',
        channels: [{ channel: 'Square1', notes: [{ note: 'C4', effects: { reverb: 3 } }] }],
      }),
    /unknown effect "reverb"/,
  );

  assert.throws(
    () =>
      compileSongSpec({
        name: 'BadGroove',
        groove: [0],
        channels: [{ channel: 'Square1', notes: ['C4'] }],
      }),
    /groove values must be integers in 1..255/,
  );

  // Numeric notes are raw FamiStudio values and are range checked.
  assert.throws(
    () =>
      compileSongSpec({
        name: 'OutOfRange',
        channels: [{ channel: 'Square1', notes: [200] }],
      }),
    /out of range/,
  );
  assert.throws(
    () =>
      compileSongSpec({
        name: 'OutOfRangeObject',
        channels: [{ channel: 'Square1', notes: [{ note: 300 }] }],
      }),
    /out of range/,
  );

  // Truncation is opt-in.
  const truncated = compileSongSpec({
    name: 'Truncated',
    patternLength: 8,
    truncate: true,
    channels: [{ channel: 'Square1', notes: [{ time: 40, note: 'C4' }] }],
  });
  assert.ok(truncated.warnings.some((warning) => warning.code === 'noteTruncated'));
});

test('songLength is inferred from the longest track', () => {
  const { project } = compileSongSpec({
    name: 'Infer',
    patternLength: 16,
    channels: [
      {
        channel: 'Square1',
        patterns: [[{ time: 0, note: 'C4' }], [{ time: 0, note: 'E4' }], [{ time: 0, note: 'G4' }]],
      },
      { channel: 'Triangle', patterns: [[{ time: 0, note: 'C1' }]] },
    ],
  });
  const song = project.songs[0];
  assert.equal(song.songLength, 3);
  const square1 = song.channels.find((channel) => channel.type === 0);
  const triangle = song.channels.find((channel) => channel.type === 2);
  assert.equal(square1.patterns.length, 3);
  assert.equal(triangle.patterns.length, 1);
  // Unused slots stay at -1 and the fixed table is preserved.
  assert.deepEqual(square1.patternInstances.slice(0, 4), [
    square1.patterns[0].id,
    square1.patterns[1].id,
    square1.patterns[2].id,
    -1,
  ]);
  assert.equal(triangle.patternInstances.length, 256);
});

test('multiple songs and PAL timing', () => {
  const { project, songs } = compileSongSpec({
    name: 'Multi',
    pal: true,
    songs: [
      { name: 'Title', patternLength: 16, channels: [{ channel: 'Square1', notes: ['C4'] }] },
      { name: 'Battle', patternLength: 32, channels: [{ channel: 'Square2', notes: ['E4'] }] },
    ],
  });
  assert.equal(project.pal, true);
  assert.equal(project.songs.length, 2);
  assert.equal(songs.length, 2);
  assert.equal(songs[0].durationSeconds, Number((16 / core.PAL_FRAME_RATE).toFixed(4)));
  assert.ok(project.songs[0].id !== project.songs[1].id, 'songs need distinct ids');
});

test('the reader rejects files it cannot trust', () => {
  assert.throws(() => core.readProject(Buffer.from('nope')), /too short/);

  const badMagic = Buffer.alloc(32);
  badMagic.writeUInt32LE(0x12345678, 0);
  assert.throws(() => core.readProject(badMagic), /Bad magic/);

  const { project } = compileSongSpec({ name: 'Version', channels: [{ channel: 'Square1', notes: ['C4'] }] });
  const bytes = writeFms(project);
  bytes.writeUInt32LE(13, 4);
  assert.throws(() => core.readProject(bytes), /Unsupported \.fms version 13/);

  assert.equal(core.isFmsFile(writeFms(project)), true);
  assert.equal(core.isFmsFile(Buffer.from('FMSX')), false);
});

test('the decoder consumes the whole payload', () => {
  // A silent trailing-byte bug would show up as a length mismatch here.
  const { project } = compileSongSpec({
    name: 'Exact',
    patternLength: 32,
    noteLength: 4,
    channels: [
      { channel: 'Square1', notes: [{ time: 0, note: 'C4', duration: 4 }] },
      { channel: 'DPCM', notes: [{ time: 0, note: 'C4', duration: 4 }] },
    ],
  });
  const bytes = writeFms(project);
  const payload = readFmsPayload(bytes);
  assert.equal(payload.byteLength, writeProjectPayload(project).byteLength);
  const reread = readProject(bytes);
  assert.deepEqual(validateProject(reread), []);
});

test('summarizeProject reports ticks and duration', () => {
  const { project } = compileSongSpec({
    name: 'Summary',
    patternLength: 128,
    songLength: 2,
    channels: [{ channel: 'Square1', patterns: [[{ time: 0, note: 'C4' }], [{ time: 0, note: 'E4' }]] }],
  });
  const summary = core.summarizeProject(project);
  assert.equal(summary.name, 'Summary');
  assert.equal(summary.songs[0].totalTicks, 256);
  assert.equal(summary.songs[0].durationSeconds, Number((256 / core.NTSC_FRAME_RATE).toFixed(4)));
  assert.match(core.formatProjectSummary(summary), /Song "Summary"/);
});

test('WAV encoding is decoded correctly', () => {
  // Build a tiny 16-bit mono WAV by hand.
  const sampleRate = 8000;
  const frames = 800;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.byteLength, 40);

  const wav = core.decodeWav(Buffer.concat([header, data]));
  assert.equal(wav.sampleRate, 8000);
  assert.equal(wav.channels, 1);
  assert.equal(wav.bitsPerSample, 16);
  assert.equal(wav.frames, frames);
  assert.equal(wav.samples.length, frames);

  const stats = core.analyzeWav(wav);
  assert.equal(stats.durationSeconds, 0.1);
  assert.equal(stats.silent, false);
  assert.ok(stats.peak > 0.4 && stats.peak <= 0.5, `peak was ${stats.peak}`);

  const pitch = core.estimatePitch(wav.samples, 0, 512, 8000, { minFrequency: 200, maxFrequency: 900 });
  assert.ok(Math.abs(pitch.frequency - 440) < 12, `detected ${pitch.frequency} Hz`);

  assert.throws(() => core.decodeWav(Buffer.from('not a wave file at all')), /RIFF|WAVE/);
});

test('buildExportArgs produces the documented FamiStudio argv', () => {
  const args = core.buildExportArgs('in.fms', {
    command: 'wav-export',
    outputPath: 'out.wav',
    rate: 44100,
    durationSeconds: 10,
    loopCount: 2,
    songs: [0, 1],
    separateChannels: true,
    channelMask: 0xff,
  });
  assert.deepEqual(args, [
    'in.fms',
    'wav-export',
    'out.wav',
    '-export-songs:0,1',
    '-wav-export-rate:44100',
    '-wav-export-duration:10',
    '-wav-export-loop:2',
    '-wav-export-channels:ff',
    '-wav-export-separate-channels',
  ]);

  const text = core.buildExportArgs('in.fms', {
    command: 'famistudio-txt-export',
    outputPath: 'out.txt',
    cleanupText: true,
  });
  assert.deepEqual(text, ['in.fms', 'famistudio-txt-export', 'out.txt', '-famistudio-txt-cleanup']);

  const asm = core.buildExportArgs('in.fms', {
    command: 'famitone2-asm-export',
    outputPath: 'out.s',
    asmFormat: 'ca65',
  });
  assert.deepEqual(asm, ['in.fms', 'famitone2-asm-export', 'out.s', '-famitone2-asm-format:ca65']);
});
