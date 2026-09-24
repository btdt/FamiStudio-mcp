/**
 * `.fms` container codec: turns a {@link Project} into the bytes FamiStudio
 * writes, and back again.
 *
 * Layout (FamiStudio 4.5.x, `Project.Version` 19):
 *
 * ```
 * "FMS!" (4) | version u32 (4) | uncompressedSize u32 (4) | raw DEFLATE stream
 * ```
 *
 * The payload is `Project.Serialize` for version 19, with fields in a strictly
 * fixed order. Two layout traps are encoded in {@link writeProject} and
 * {@link readProject} on purpose:
 *
 * 1. The 12 export configs end with Music/Sfx *alternating*
 *    (`famiStudioMusic`, `famiStudioSfx`, `famiTone2Music`, `famiTone2Sfx`).
 * 2. A regular instrument carries four envelopes *and* a DPCM mapping count,
 *    even when both are trivially empty.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  ENVELOPE_MAX_LENGTH,
  ENVELOPE_TYPE_COUNT,
  FMS_HEADER_SIZE,
  FMS_MAGIC,
  FMS_VERSION,
  NOTE_INVALID,
  REGULAR_ENVELOPE_MASK,
  SONG_MAX_LENGTH,
  isMusicalNote,
} from './constants.js';
import { Reader, Writer } from './primitives.js';
import { EFFECT_ORDER, EffectBit, VIBRATO_BITS, type EffectName } from './effects.js';
import {
  type Arpeggio,
  type Channel,
  type DpcmSample,
  type Envelope,
  type Instrument,
  type Note,
  type Pattern,
  type Project,
  type Song,
  createNote,
  noteTime,
  setNoteTime,
} from './model.js';

export { EFFECT_ORDER, EffectBit, VIBRATO_BITS };
export type { EffectName };

/** Error raised when a project cannot be represented as a valid `.fms`. */
export class ProjectValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Project is not valid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ProjectValidationError';
    this.problems = problems;
  }
}

/** Raised when a file is not a readable FamiStudio project. */
export class FmsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FmsFormatError';
  }
}

/**
 * Structural checks that mirror what FamiStudio asserts when loading a file.
 *
 * @returns the list of problems; empty means the project can be written safely.
 */
export function validateProject(project: Project): string[] {
  const problems: string[] = [];

  if (project.version !== FMS_VERSION) {
    problems.push(`version must be ${FMS_VERSION}, got ${project.version}.`);
  }
  if (project.expansionMask !== 0) {
    problems.push(
      `expansionMask must be 0 (this writer only supports plain 2A03), got ${project.expansionMask}.`,
    );
  }
  if (project.tempoMode !== 0) {
    problems.push(`tempoMode must be 0 (FamiStudio tempo), got ${project.tempoMode}.`);
  }
  if (project.samples.length > 0) {
    const missing = project.samples.filter((sample) => sample.rawPayload.length === 0);
    if (missing.length > 0) {
      problems.push(
        `DPCM samples ${missing.map((s) => s.id).join(', ')} have no preserved payload; ` +
          'this library can only round-trip DPCM samples, not author them.',
      );
    }
  }

  const ids = new Map<number, string>();
  const claimId = (id: number, what: string) => {
    const previous = ids.get(id);
    if (previous !== undefined) problems.push(`duplicate object id ${id} (${previous} and ${what}).`);
    else ids.set(id, what);
  };

  for (const sample of project.samples) claimId(sample.id, `sample "${sample.name}"`);
  for (const instrument of project.instruments) claimId(instrument.id, `instrument "${instrument.name}"`);
  for (const arpeggio of project.arpeggios) claimId(arpeggio.id, `arpeggio "${arpeggio.name}"`);
  for (const song of project.songs) {
    claimId(song.id, `song "${song.name}"`);
    for (const channel of song.channels) {
      for (const pattern of channel.patterns) claimId(pattern.id, `pattern "${pattern.name}"`);
    }
  }

  const highest = [...ids.keys()].reduce((max, id) => Math.max(max, id), -1);
  if (project.nextUniqueId <= highest) {
    problems.push(
      `nextUniqueId (${project.nextUniqueId}) must be greater than every object id (max ${highest}).`,
    );
  }

  for (const instrument of project.instruments) {
    if (instrument.expansion !== 0) {
      problems.push(`instrument "${instrument.name}": expansion must be 0, got ${instrument.expansion}.`);
    }
    if ((instrument.envelopeMask & REGULAR_ENVELOPE_MASK) !== REGULAR_ENVELOPE_MASK) {
      problems.push(
        `instrument "${instrument.name}": envelopeMask 0x${instrument.envelopeMask.toString(16)} is ` +
          `missing mandatory envelopes (Volume/Arpeggio/Pitch/DutyCycle, needs 0x000F).`,
      );
    }
    for (let type = 0; type < ENVELOPE_TYPE_COUNT; type += 1) {
      const active = (instrument.envelopeMask & (1 << type)) !== 0;
      const envelope = instrument.envelopes[type];
      if (active && !envelope) {
        problems.push(`instrument "${instrument.name}": envelopeMask bit ${type} set but envelope is null.`);
      }
      if (!active && envelope) {
        problems.push(`instrument "${instrument.name}": envelope ${type} present but mask bit is clear.`);
      }
      if (envelope) problems.push(...validateEnvelope(envelope, `instrument "${instrument.name}" envelope ${type}`));
    }
    for (const mapping of instrument.sampleMappings) {
      if (!project.samples.some((sample) => sample.id === mapping.sampleId)) {
        problems.push(
          `instrument "${instrument.name}": DPCM mapping note ${mapping.note} references missing sample ${mapping.sampleId}.`,
        );
      }
    }
  }

  for (const arpeggio of project.arpeggios) {
    problems.push(...validateEnvelope(arpeggio.envelope, `arpeggio "${arpeggio.name}"`));
  }

  if (project.songs.length === 0) {
    problems.push('project must contain at least one song.');
  }

  const instrumentIds = new Set(project.instruments.map((instrument) => instrument.id));
  const arpeggioIds = new Set(project.arpeggios.map((arpeggio) => arpeggio.id));

  for (const song of project.songs) {
    const label = `song "${song.name}"`;
    if (!Number.isInteger(song.patternLength) || song.patternLength < 1 || song.patternLength > 256) {
      problems.push(`${label}: patternLength must be 1..256, got ${song.patternLength}.`);
    }
    if (!Number.isInteger(song.songLength) || song.songLength < 1 || song.songLength > SONG_MAX_LENGTH) {
      problems.push(`${label}: songLength must be 1..${SONG_MAX_LENGTH}, got ${song.songLength}.`);
    }
    if (song.channels.length !== 5) {
      problems.push(`${label}: expected 5 channels, got ${song.channels.length}.`);
    }
    for (const channel of song.channels) {
      const channelLabel = `${label} ${channel.name}`;
      if (channel.patternInstances.length !== SONG_MAX_LENGTH) {
        problems.push(
          `${channelLabel}: patternInstances must hold ${SONG_MAX_LENGTH} entries, got ${channel.patternInstances.length}.`,
        );
      }
      const patternIds = new Set(channel.patterns.map((pattern) => pattern.id));
      for (let i = 0; i < Math.min(song.songLength, channel.patternInstances.length); i += 1) {
        const instance = channel.patternInstances[i];
        if (instance !== -1 && !patternIds.has(instance)) {
          problems.push(`${channelLabel}: slot ${i} references unknown pattern ${instance}.`);
        }
      }
      for (const pattern of channel.patterns) {
        const patternLabel = `${channelLabel} pattern "${pattern.name}"`;
        if (pattern.channelType !== channel.type) {
          problems.push(`${patternLabel}: channelType ${pattern.channelType} does not match channel ${channel.type}.`);
        }
        if (pattern.songId !== song.id) {
          problems.push(`${patternLabel}: songId ${pattern.songId} does not match song ${song.id}.`);
        }
        for (const note of pattern.notes) {
          if (note.value !== NOTE_INVALID) {
            if (note.value !== 0 && note.value !== 0x80 && (note.value < 1 || note.value > 0x60)) {
              problems.push(`${patternLabel}: note value ${note.value} is out of range.`);
            }
            if (isMusicalNote(note.value)) {
              if (note.instrumentId !== -1 && !instrumentIds.has(note.instrumentId)) {
                problems.push(`${patternLabel}: note references unknown instrument ${note.instrumentId}.`);
              }
              if (!Number.isInteger(note.duration) || note.duration < 0 || note.duration > 0xffff) {
                problems.push(`${patternLabel}: note duration ${note.duration} does not fit a ushort.`);
              }
            }
            if (note.arpeggioId !== -1 && !arpeggioIds.has(note.arpeggioId)) {
              problems.push(`${patternLabel}: note references unknown arpeggio ${note.arpeggioId}.`);
            }
            for (const [name, effectValue] of Object.entries(note.effectValues)) {
              if (effectValue === undefined) continue;
              const range = EFFECT_RANGE[name as EffectName];
              if (!range) {
                problems.push(`${patternLabel}: unknown effect "${name}".`);
                continue;
              }
              if (!Number.isInteger(effectValue) || effectValue < range[0] || effectValue > range[1]) {
                problems.push(
                  `${patternLabel}: effect ${name}=${effectValue} is outside the allowed range ${range[0]}..${range[1]}.`,
                );
              }
            }
          }
        }
        const sorted = [...pattern.notes].sort((a, b) => noteTime(a) - noteTime(b));
        for (let i = 0; i < sorted.length; i += 1) {
          const time = noteTime(sorted[i]);
          if (time < 0 || time > 0x7fff) {
            problems.push(`${patternLabel}: note time ${time} does not fit a short.`);
          }
          if (i > 0 && time === noteTime(sorted[i - 1])) {
            problems.push(`${patternLabel}: two notes share tick ${time}.`);
          }
        }
      }
    }
  }

  return problems;
}

function validateEnvelope(envelope: Envelope, label: string): string[] {
  const problems: string[] = [];
  // Length 0 is legal: FamiStudio keeps the envelope object but marks it empty.
  if (!Number.isInteger(envelope.length) || envelope.length < 0 || envelope.length > ENVELOPE_MAX_LENGTH) {
    problems.push(`${label}: length must be 0..${ENVELOPE_MAX_LENGTH}, got ${envelope.length}.`);
  }
  if (envelope.values.length !== ENVELOPE_MAX_LENGTH) {
    problems.push(
      `${label}: values must hold exactly ${ENVELOPE_MAX_LENGTH} entries, got ${envelope.values.length}. ` +
        'The on-disk format always serializes the full array, so the model keeps it too.',
    );
  }
  return problems;
}

/**
 * Tick position of a note (re-exported from the model).
 *
 * Notes carry their tick implicitly through array order in the serialized
 * format; the JSON model keeps it in a non-enumerable `time` field.
 */
export { noteTime, setNoteTime, noteToJson } from './model.js';

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

function writeEnvelope(writer: Writer, envelope: Envelope): void {
  writer.i32(envelope.length);
  writer.i32(envelope.loop);
  writer.i32(envelope.release);
  writer.bool(envelope.relative);
  // FamiStudio serializes all Envelope.MaxLength (256) slots and never zeroes
  // the ones past `length`; the caller keeps the full array so a read/modify/
  // write round trip stays byte identical.
  writer.sbytes(envelope.values);
}

function writeInstrument(writer: Writer, instrument: Instrument): void {
  writer.i32(instrument.id);
  writer.str(instrument.name);
  writer.color(instrument.color);
  writer.i32(0); // expansion: none for 2A03.

  // Force the four mandatory envelopes so the GUI never dereferences a null one.
  const mask = instrument.envelopeMask | REGULAR_ENVELOPE_MASK;
  writer.u16(mask);
  for (let type = 0; type < ENVELOPE_TYPE_COUNT; type += 1) {
    if ((mask & (1 << type)) === 0) continue;
    const envelope = instrument.envelopes[type];
    writeEnvelope(writer, envelope ?? { length: 1, loop: -1, release: -1, relative: false, values: new Array(ENVELOPE_MAX_LENGTH).fill(0) });
  }

  writer.str(instrument.folderName);

  // v15+: DPCM mapping count. Omitting this desynchronizes every later field.
  writer.i32(instrument.sampleMappings.length);
  for (const mapping of instrument.sampleMappings) writer.i32(mapping.note);
  for (const mapping of instrument.sampleMappings) {
    writer.ref(mapping.sampleId);
    writer.bool(mapping.loop);
    writer.i32(mapping.pitch);
    writer.bool(false); // overrideDmcInitialValue (v13+)
    writer.i32(0); // dmcInitialValueDiv2 (v13+)
  }
}

/**
 * On-disk width of every note effect.
 *
 * `Note.Serialize` passes the underlying C# field to `ProjectBuffer.Serialize`,
 * so overload resolution picks byte / sbyte / ushort - NOT int - for each
 * effect. Writing the wrong width silently desynchronizes the whole stream and
 * FamiStudio reports "project file appears to be corrupted".
 */
const EFFECT_WIDTH: Record<EffectName, 'u8' | 'i8' | 'u16' | 'i32'> = {
  volume: 'u8',
  vibrato: 'u8', // packed speed<<4 | depth
  speed: 'u8',
  finePitch: 'i8',
  fdsModSpeed: 'u16',
  fdsModDepth: 'u8',
  dutyCycle: 'u8',
  noteDelay: 'u8',
  cutDelay: 'u8',
  volumeSlide: 'u8',
  dmcCounter: 'u8',
  phaseReset: 'u8',
  envPeriod: 'u16',
};

/**
 * Value range of every note effect, matching FamiStudio's own clamps
 * (`Note.EffectXxxMax`).
 */
const EFFECT_RANGE: Record<EffectName, [min: number, max: number]> = {
  volume: [0, 15],
  vibrato: [0, 0xcf],
  speed: [0, 255],
  finePitch: [-128, 127],
  fdsModSpeed: [0, 4095],
  fdsModDepth: [0, 63],
  dutyCycle: [0, 3],
  noteDelay: [0, 31],
  cutDelay: [0, 31],
  volumeSlide: [0, 15],
  dmcCounter: [0, 127],
  phaseReset: [0, 1],
  envPeriod: [0, 65535],
};

function writeEffectValue(writer: Writer, width: (typeof EFFECT_WIDTH)[EffectName], value: number): void {
  switch (width) {
    case 'u8':
      writer.u8(value);
      break;
    case 'i8':
      writer.i8(value);
      break;
    case 'u16':
      writer.u16(value);
      break;
    default:
      writer.i32(value);
      break;
  }
}

function readEffectValue(reader: Reader, width: (typeof EFFECT_WIDTH)[EffectName]): number {
  switch (width) {
    case 'u8':
      return reader.u8();
    case 'i8':
      return reader.i8();
    case 'u16':
      return reader.u16();
    default:
      return reader.i32();
  }
}

function writeNote(writer: Writer, note: Note): void {
  writer.u8(note.value);
  writer.u8(note.flags);

  const musical = isMusicalNote(note.value);
  if (musical) {
    writer.u8(note.slide);
    writer.ref(note.instrumentId);
  }

  if (musical) {
    writer.u16(note.duration);
    writer.u16(note.release);
  }

  // Rebuild the effect mask from the values we model. Taken from
  // `Note.EffectXxxMask` semantics: a bit is set when that effect is present.
  // Vibrato is special: it owns two bits and FamiStudio always sets both.
  let mask = 0;
  for (const [name, bit] of Object.entries(EffectBit) as [EffectName, number][]) {
    if (note.effectValues[name] === undefined) continue;
    mask |= 1 << bit;
  }
  if (note.effectValues.vibrato !== undefined) {
    for (const bit of VIBRATO_BITS) mask |= 1 << bit;
  }

  writer.u16(mask);

  // Effect values follow the bit order, each at its own width.
  if (note.effectValues.volume !== undefined) writeEffectValue(writer, 'u8', note.effectValues.volume);
  if (note.effectValues.vibrato !== undefined) writeEffectValue(writer, 'u8', note.effectValues.vibrato);
  if (note.effectValues.speed !== undefined) writeEffectValue(writer, 'u8', note.effectValues.speed);
  if (note.effectValues.finePitch !== undefined) writeEffectValue(writer, 'i8', note.effectValues.finePitch);
  if (note.effectValues.fdsModSpeed !== undefined) writeEffectValue(writer, 'u16', note.effectValues.fdsModSpeed);
  if (note.effectValues.fdsModDepth !== undefined) writeEffectValue(writer, 'u8', note.effectValues.fdsModDepth);
  if (note.effectValues.dutyCycle !== undefined) writeEffectValue(writer, 'u8', note.effectValues.dutyCycle);
  if (note.effectValues.noteDelay !== undefined) writeEffectValue(writer, 'u8', note.effectValues.noteDelay);
  if (note.effectValues.cutDelay !== undefined) writeEffectValue(writer, 'u8', note.effectValues.cutDelay);
  // Volume slide only exists when volume is also set (EffectVolumeAndSlideMask).
  if (
    note.effectValues.volumeSlide !== undefined &&
    note.effectValues.volume !== undefined
  ) {
    writeEffectValue(writer, 'u8', note.effectValues.volumeSlide);
  }
  if (note.effectValues.dmcCounter !== undefined) writeEffectValue(writer, 'u8', note.effectValues.dmcCounter);
  if (note.effectValues.phaseReset !== undefined) writeEffectValue(writer, 'u8', note.effectValues.phaseReset);
  if (note.effectValues.envPeriod !== undefined) writeEffectValue(writer, 'u16', note.effectValues.envPeriod);

  writer.ref(note.arpeggioId);
}

function writePattern(writer: Writer, pattern: Pattern): void {
  writer.i32(pattern.id);
  writer.str(pattern.name);
  writer.i32(pattern.channelType);
  writer.color(pattern.color);
  writer.ref(pattern.songId);

  const notes = [...pattern.notes].sort((a, b) => noteTime(a) - noteTime(b));
  writer.i32(notes.length);
  for (const note of notes) {
    writer.i16(noteTime(note));
    writeNote(writer, note);
  }
}

function writeChannel(writer: Writer, channel: Channel, song: Song): void {
  writer.ref(song.id);
  writer.i32(channel.patterns.length);
  writer.i32(channel.type);
  for (const pattern of channel.patterns) writePattern(writer, pattern);

  // Always exactly Song.MaxLength ints; unused slots are -1.
  for (let i = 0; i < SONG_MAX_LENGTH; i += 1) {
    writer.i32(channel.patternInstances[i] ?? -1);
  }
}

function writeSong(writer: Writer, song: Song): void {
  writer.i32(song.id);
  writer.i32(song.patternLength);
  writer.i32(song.songLength);
  writer.i32(song.beatLength);
  writer.str(song.name);
  writer.i32(song.famitrackerTempo);
  writer.i32(song.famitrackerSpeed);
  writer.color(song.color);
  writer.i32(song.loopPoint);
  writer.i32(song.noteLength);
  writer.ints(song.groove);
  writer.i32(song.groovePaddingMode);

  for (let i = 0; i < song.songLength; i += 1) {
    const custom = song.patternCustomSettings[i];
    writer.bool(custom?.useCustomSettings ?? false);
    writer.i32(custom?.patternLength ?? 0);
    writer.i32(custom?.noteLength ?? 0);
    writer.i32(custom?.beatLength ?? 0);
    writer.ints(custom?.groove ?? null);
    writer.i32(custom?.groovePaddingMode ?? 1);
  }

  writer.str(song.folderName);

  for (const channel of song.channels) writeChannel(writer, channel, song);
}

function writeArpeggio(writer: Writer, arpeggio: Arpeggio): void {
  writer.i32(arpeggio.id);
  writer.str(arpeggio.name);
  writer.color(arpeggio.color);
  writer.str(arpeggio.folderName);
  writeEnvelope(writer, arpeggio.envelope);
}

function writeSongList(writer: Writer, list: unknown): void {
  const entries = Array.isArray(list) ? list : [];
  writer.i32(entries.length);
  for (const entry of entries as { songId?: number; enabled?: boolean }[]) {
    writer.i32(entry.songId ?? -1);
    writer.bool(entry.enabled ?? false);
  }
}

function writeChannels(writer: Writer, list: unknown): void {
  const entries = Array.isArray(list) ? list : [];
  writer.i32(entries.length);
  for (const entry of entries as Record<string, number | boolean>[]) {
    writer.i32((entry.songId as number) ?? -1);
    writer.i32((entry.channelType as number) ?? 0);
    writer.bool((entry.enabled as boolean) ?? false);
    writer.i32((entry.panning as number) ?? 0);
    writer.i32((entry.transpose as number) ?? 0);
    writer.i32((entry.trigger as number) ?? 0);
  }
}

function writeExportConfigs(writer: Writer, project: Project): void {
  const c = project.exportConfigs;

  // 1. AudioExportConfig
  writer.i32((c.audio.songId as number) ?? -1);
  writer.str(c.audio.format as string);
  writer.str(c.audio.samplerate as string);
  writer.str(c.audio.bitRate as string);
  writer.str(c.audio.loopMode as string);
  writer.i32((c.audio.loopCount as number) ?? 1);
  writer.i32((c.audio.duration as number) ?? 120);
  writer.i32((c.audio.delay as number) ?? 0);
  writer.bool(c.audio.separateFiles as boolean);
  writer.bool(c.audio.separateIntro as boolean);
  writer.bool(c.audio.stereo as boolean);
  writeChannels(writer, c.audio.channels);

  // 2. VideoExportConfig
  writer.i32((c.video.songId as number) ?? -1);
  writer.str(c.video.mode as string);
  writer.str(c.video.resolution as string);
  writer.str(c.video.frameRate as string);
  writer.str(c.video.audioBitRate as string);
  writer.str(c.video.videoBitRate as string);
  writer.i32((c.video.loopCount as number) ?? 1);
  writer.i32((c.video.delay as number) ?? 0);
  writer.i32((c.video.oscColumns as number) ?? -1);
  writer.i32((c.video.oscWindow as number) ?? 2);
  writer.i32((c.video.oscThickness as number) ?? 2);
  writer.str(c.video.oscColour as string);
  writer.str(c.video.pianoRollWidth as string);
  writer.str(c.video.pianoRollZoom as string);
  writer.i32((c.video.pianoRollRows as number) ?? -1);
  writer.str(c.video.pianoRollPerspective as string);
  writer.bool(c.video.overlayRegisters as boolean);
  writer.bool(c.video.stereo as boolean);
  writeChannels(writer, c.video.channels);

  // 3. NsfExportConfig
  writer.str(c.nsf.name as string);
  writer.str(c.nsf.artist as string);
  writer.str(c.nsf.copyright as string);
  writer.str(c.nsf.format as string);
  writer.str(c.nsf.mode as string);
  writeSongList(writer, c.nsf.songList);

  // 4. RomFdsExportConfig
  writer.str(c.romFds.type as string);
  writer.str(c.romFds.name as string);
  writer.str(c.romFds.artist as string);
  writer.str(c.romFds.mode as string);
  writeSongList(writer, c.romFds.songList);

  // 5. MidiExportConfig
  writer.i32((c.midi.songId as number) ?? -1);
  writer.bool(c.midi.volumeVelocity as boolean);
  writer.bool(c.midi.slidesAsPitch as boolean);
  writer.i32((c.midi.pitchWheelRange as number) ?? 24);
  writer.str(c.midi.mode as string);
  const midiInstruments = Array.isArray(c.midi.midiInstruments) ? c.midi.midiInstruments : [];
  writer.i32(midiInstruments.length);
  for (const inst of midiInstruments as Record<string, number>[]) {
    writer.i32(inst.songId ?? -1);
    writer.i32(inst.mode ?? 0);
    writer.i32(inst.typeId ?? 0);
    writer.i32(inst.index ?? 0);
  }

  // 6. VgmExportConfig
  writer.i32((c.vgm.songId as number) ?? -1);
  writer.str(c.vgm.trackTitle as string);
  writer.str(c.vgm.gameName as string);
  writer.str(c.vgm.system as string);
  writer.str(c.vgm.composer as string);
  writer.str(c.vgm.date as string);
  writer.str(c.vgm.vgmBy as string);
  writer.str(c.vgm.notes as string);
  writer.bool(c.vgm.smoothLoop as boolean);

  // 7. FamiStudioTextExportConfig
  writer.bool(c.famiStudioText.deleteUnusedData as boolean);
  writeSongList(writer, c.famiStudioText.songList);

  // 8. FamiTrackerTextExportConfig
  writeSongList(writer, c.famiTrackerText.songList);

  // 9-12: Music/Sfx MUST alternate.
  writer.str(c.famiStudioMusic.format as string);
  writer.bool(c.famiStudioMusic.separate as boolean);
  writer.str(c.famiStudioMusic.songName as string);
  writer.str(c.famiStudioMusic.dmcName as string);
  writer.str(c.famiStudioMusic.dmcExportMode as string);
  writer.bool(c.famiStudioMusic.unusedMappings as boolean);
  writer.bool(c.famiStudioMusic.songListInclude as boolean);
  writeSongList(writer, c.famiStudioMusic.songList);

  writer.str(c.famiStudioSfx.format as string);
  writer.str(c.famiStudioSfx.mode as string);
  writer.bool(c.famiStudioSfx.include as boolean);
  writeSongList(writer, c.famiStudioSfx.songList);

  writer.str(c.famiTone2Music.format as string);
  writer.bool(c.famiTone2Music.separate as boolean);
  writer.str(c.famiTone2Music.songName as string);
  writer.str(c.famiTone2Music.dmcName as string);
  writer.str(c.famiTone2Music.dmcExportMode as string);
  writer.bool(c.famiTone2Music.unusedMappings as boolean);
  writer.bool(c.famiTone2Music.songListInclude as boolean);
  writeSongList(writer, c.famiTone2Music.songList);

  writer.str(c.famiTone2Sfx.format as string);
  writer.str(c.famiTone2Sfx.mode as string);
  writer.bool(c.famiTone2Sfx.include as boolean);
  writeSongList(writer, c.famiTone2Sfx.songList);
}

/** Serialize just the project payload (without the container header). */
export function writeProjectPayload(project: Project): Buffer {
  const problems = validateProject(project);
  if (problems.length > 0) throw new ProjectValidationError(problems);

  const writer = new Writer();

  // 1. Identity / sorting.
  writer.i32(project.nextUniqueId);
  writer.bool(project.sortSongs);
  writer.bool(project.sortInstruments);
  writer.bool(project.sortSamples);
  writer.bool(project.sortArpeggios);

  // 2-3. Metadata.
  writer.str(project.name);
  writer.str(project.author);
  writer.str(project.copyright);

  // 4-7. Audio configuration.
  writer.i32(project.expansionMask);
  writer.i32(project.expansionNumN163Channels);
  writer.i32(project.tempoMode);
  writer.bool(project.pal);

  // 8. The twelve export configs.
  writeExportConfigs(writer, project);

  // 9. Tuning.
  writer.i32(project.tuning);

  // 10. Folders.
  writer.i32(project.folders.length);
  for (const folder of project.folders) {
    writer.i32(folder.type);
    writer.str(folder.name);
    writer.bool(folder.expanded);
  }

  // 11. Sound engine options.
  writer.bool(project.soundEngineUsesExtendedInstruments);
  writer.bool(project.soundEngineUsesExtendedDpcm);
  writer.bool(project.soundEngineUsesBankSwitching);

  // 12. Bass cutoff override.
  writer.bool(project.overrideBassCutoffHz);
  if (project.overrideBassCutoffHz) writer.i32(project.bassCutoffHz);

  // 13. Mixer overrides; this writer never overrides, so the mask is 0 and no
  //     mixer payload follows.
  writer.i32(project.overrideMask);

  // 14. DPCM samples.
  writer.i32(project.samples.length);
  for (const sample of project.samples) {
    writer.i32(sample.id);
    writer.str(sample.name);
    writer.bytes(sample.rawPayload);
  }

  // 15. Instruments.
  writer.i32(project.instruments.length);
  for (const instrument of project.instruments) writeInstrument(writer, instrument);

  // 16. Arpeggios.
  writer.i32(project.arpeggios.length);
  for (const arpeggio of project.arpeggios) writeArpeggio(writer, arpeggio);

  // 17. Songs.
  writer.i32(project.songs.length);
  for (const song of project.songs) writeSong(writer, song);

  return writer.toBuffer();
}

/** Serialize a complete `.fms` file (header + deflate-compressed payload). */
export function writeFms(project: Project): Buffer {
  const payload = writeProjectPayload(project);
  const compressed = deflateRawSync(payload, { level: 9 });

  const header = Buffer.allocUnsafe(FMS_HEADER_SIZE);
  header.writeUInt32LE(FMS_MAGIC, 0);
  header.writeUInt32LE(FMS_VERSION, 4);

  const size = Buffer.allocUnsafe(4);
  size.writeUInt32LE(payload.byteLength, 0);

  return Buffer.concat([header, size, compressed]);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

function readEnvelope(reader: Reader): Envelope {
  const length = reader.i32();
  const loop = reader.i32();
  const release = reader.i32();
  const relative = reader.bool();
  const values = reader.sbytes();
  return { length, loop, release, relative, values };
}

function readInstrument(reader: Reader): Instrument {
  const id = reader.i32();
  const name = reader.str();
  const color = reader.color();
  const expansion = reader.i32();

  const envelopeMask = reader.u16();
  const envelopes = new Array<Envelope | null>(ENVELOPE_TYPE_COUNT).fill(null);
  for (let type = 0; type < ENVELOPE_TYPE_COUNT; type += 1) {
    if ((envelopeMask & (1 << type)) !== 0) envelopes[type] = readEnvelope(reader);
  }

  const folderName = reader.str();

  const sampleMappings: Instrument['sampleMappings'] = [];
  const mappingCount = reader.i32();
  if (mappingCount > 0) {
    const notes: number[] = [];
    for (let i = 0; i < mappingCount; i += 1) notes.push(reader.i32());
    for (let i = 0; i < mappingCount; i += 1) {
      const sampleId = reader.ref();
      const loop = reader.bool();
      const pitch = reader.i32();
      const overrideDmcInitialValue = reader.bool();
      const dmcInitialValueDiv2 = reader.i32();
      void overrideDmcInitialValue;
      void dmcInitialValueDiv2;
      sampleMappings.push({ note: notes[i], sampleId, loop, pitch });
    }
  }

  return { id, name, color, expansion, envelopeMask, envelopes, folderName, sampleMappings };
}

function readNote(reader: Reader): Note {
  const note = createNote();
  note.value = reader.u8();
  note.flags = reader.u8();

  const musical = isMusicalNote(note.value);
  if (musical) {
    note.slide = reader.u8();
    note.instrumentId = reader.ref();
    note.duration = reader.u16();
    note.release = reader.u16();
  } else if (note.value === 0) {
    // FamiStudio coerces stop notes: no instrument, one tick long.
    note.duration = 1;
    note.instrumentId = -1;
  }

  const mask = reader.u16();
  note.effectMask = mask;

  const fv = note.effectValues;
  if (mask & (1 << EffectBit.volume)) fv.volume = readEffectValue(reader, 'u8');
  if ((mask & (1 << VIBRATO_BITS[0])) !== 0 || (mask & (1 << VIBRATO_BITS[1])) !== 0) {
    // FamiStudio writes one packed byte for vibrato (speed<<4 | depth).
    fv.vibrato = readEffectValue(reader, 'u8');
  }
  if (mask & (1 << EffectBit.speed)) fv.speed = readEffectValue(reader, 'u8');
  if (mask & (1 << EffectBit.finePitch)) fv.finePitch = readEffectValue(reader, 'i8');
  if (mask & (1 << EffectBit.fdsModSpeed)) fv.fdsModSpeed = readEffectValue(reader, 'u16');
  if (mask & (1 << EffectBit.fdsModDepth)) fv.fdsModDepth = readEffectValue(reader, 'u8');
  if (mask & (1 << EffectBit.dutyCycle)) fv.dutyCycle = readEffectValue(reader, 'u8');
  if (mask & (1 << EffectBit.noteDelay)) fv.noteDelay = readEffectValue(reader, 'u8');
  if (mask & (1 << EffectBit.cutDelay)) fv.cutDelay = readEffectValue(reader, 'u8');
  if (
    (mask & (1 << EffectBit.volume)) !== 0 &&
    (mask & (1 << EffectBit.volumeSlide)) !== 0
  ) {
    fv.volumeSlide = readEffectValue(reader, 'u8');
  }
  if (mask & (1 << EffectBit.dmcCounter)) fv.dmcCounter = readEffectValue(reader, 'u8');
  if (mask & (1 << EffectBit.phaseReset)) fv.phaseReset = readEffectValue(reader, 'u8');
  if (mask & (1 << EffectBit.envPeriod)) fv.envPeriod = readEffectValue(reader, 'u16');

  note.arpeggioId = reader.ref();
  return note;
}

function readPattern(reader: Reader): Pattern {
  const id = reader.i32();
  const name = reader.str();
  const channelType = reader.i32();
  const color = reader.color();
  const songId = reader.ref();

  const notesCount = reader.i32();
  const notes: Note[] = [];
  for (let i = 0; i < notesCount; i += 1) {
    const time = reader.i16();
    const note = readNote(reader);
    setNoteTime(note, time);
    notes.push(note);
  }

  return { id, name, channelType, color, songId, notes };
}

function readChannel(reader: Reader): Channel {
  const songId = reader.ref();
  const patternCount = reader.i32();
  const type = reader.i32();

  const patterns: Pattern[] = [];
  for (let i = 0; i < patternCount; i += 1) patterns.push(readPattern(reader));

  const patternInstances = new Array<number>(SONG_MAX_LENGTH).fill(-1);
  for (let i = 0; i < SONG_MAX_LENGTH; i += 1) patternInstances[i] = reader.ref();

  return { songId, type, name: '', patterns, patternInstances };
}

function readSong(reader: Reader): Song {
  const id = reader.i32();
  const patternLength = reader.i32();
  const songLength = reader.i32();
  const beatLength = reader.i32();
  const name = reader.str();
  const famitrackerTempo = reader.i32();
  const famitrackerSpeed = reader.i32();
  const color = reader.color();
  const loopPoint = reader.i32();
  const noteLength = reader.i32();
  const groove = reader.ints() ?? [];
  const groovePaddingMode = reader.i32();

  const patternCustomSettings = [];
  for (let i = 0; i < songLength; i += 1) {
    patternCustomSettings.push({
      useCustomSettings: reader.bool(),
      patternLength: reader.i32(),
      noteLength: reader.i32(),
      beatLength: reader.i32(),
      groove: reader.ints(),
      groovePaddingMode: reader.i32(),
    });
  }

  const folderName = reader.str();

  const channels: Channel[] = [];
  for (let i = 0; i < 5; i += 1) channels.push(readChannel(reader));

  return {
    id,
    patternLength,
    songLength,
    beatLength,
    name,
    famitrackerTempo,
    famitrackerSpeed,
    color,
    loopPoint,
    noteLength,
    groove,
    groovePaddingMode,
    patternCustomSettings,
    folderName,
    channels,
  };
}

function readArpeggio(reader: Reader): Arpeggio {
  const id = reader.i32();
  const name = reader.str();
  const color = reader.color();
  const folderName = reader.str();
  const envelope = readEnvelope(reader);
  return { id, name, color, folderName, envelope };
}

function readSongList(reader: Reader): { songId: number; enabled: boolean }[] {
  const count = reader.i32();
  const list: { songId: number; enabled: boolean }[] = [];
  for (let i = 0; i < count; i += 1) list.push({ songId: reader.i32(), enabled: reader.bool() });
  return list;
}

function readChannels(reader: Reader): Record<string, number | boolean>[] {
  const count = reader.i32();
  const list: Record<string, number | boolean>[] = [];
  for (let i = 0; i < count; i += 1) {
    list.push({
      songId: reader.i32(),
      channelType: reader.i32(),
      enabled: reader.bool(),
      panning: reader.i32(),
      transpose: reader.i32(),
      trigger: reader.i32(),
    });
  }
  return list;
}

function readExportConfigs(reader: Reader): Project['exportConfigs'] {
  const audio = {
    songId: reader.i32(),
    format: reader.str(),
    samplerate: reader.str(),
    bitRate: reader.str(),
    loopMode: reader.str(),
    loopCount: reader.i32(),
    duration: reader.i32(),
    delay: reader.i32(),
    separateFiles: reader.bool(),
    separateIntro: reader.bool(),
    stereo: reader.bool(),
    channels: readChannels(reader),
  };

  const video = {
    songId: reader.i32(),
    mode: reader.str(),
    resolution: reader.str(),
    frameRate: reader.str(),
    audioBitRate: reader.str(),
    videoBitRate: reader.str(),
    loopCount: reader.i32(),
    delay: reader.i32(),
    oscColumns: reader.i32(),
    oscWindow: reader.i32(),
    oscThickness: reader.i32(),
    oscColour: reader.str(),
    pianoRollWidth: reader.str(),
    pianoRollZoom: reader.str(),
    pianoRollRows: reader.i32(),
    pianoRollPerspective: reader.str(),
    overlayRegisters: reader.bool(),
    stereo: reader.bool(),
    channels: readChannels(reader),
  };

  const nsf = {
    name: reader.str(),
    artist: reader.str(),
    copyright: reader.str(),
    format: reader.str(),
    mode: reader.str(),
    songList: readSongList(reader),
  };

  const romFds = {
    type: reader.str(),
    name: reader.str(),
    artist: reader.str(),
    mode: reader.str(),
    songList: readSongList(reader),
  };

  const midi: Record<string, unknown> = {
    songId: reader.i32(),
    volumeVelocity: reader.bool(),
    slidesAsPitch: reader.bool(),
    pitchWheelRange: reader.i32(),
    mode: reader.str(),
  };
  const midiCount = reader.i32();
  const midiInstruments: Record<string, number>[] = [];
  for (let i = 0; i < midiCount; i += 1) {
    midiInstruments.push({
      songId: reader.i32(),
      mode: reader.i32(),
      typeId: reader.i32(),
      index: reader.i32(),
    });
  }
  midi.midiInstruments = midiInstruments;

  const vgm = {
    songId: reader.i32(),
    trackTitle: reader.str(),
    gameName: reader.str(),
    system: reader.str(),
    composer: reader.str(),
    date: reader.str(),
    vgmBy: reader.str(),
    notes: reader.str(),
    smoothLoop: reader.bool(),
  };

  const famiStudioText = { deleteUnusedData: reader.bool(), songList: readSongList(reader) };
  const famiTrackerText = { songList: readSongList(reader) };

  const readMusicCode = () => ({
    format: reader.str(),
    separate: reader.bool(),
    songName: reader.str(),
    dmcName: reader.str(),
    dmcExportMode: reader.str(),
    unusedMappings: reader.bool(),
    songListInclude: reader.bool(),
    songList: readSongList(reader),
  });
  const readSfx = () => ({
    format: reader.str(),
    mode: reader.str(),
    include: reader.bool(),
    songList: readSongList(reader),
  });

  const famiStudioMusic = readMusicCode();
  const famiStudioSfx = readSfx();
  const famiTone2Music = readMusicCode();
  const famiTone2Sfx = readSfx();

  return {
    audio,
    video,
    nsf,
    romFds,
    midi,
    vgm,
    famiStudioText,
    famiTrackerText,
    famiStudioMusic,
    famiStudioSfx,
    famiTone2Music,
    famiTone2Sfx,
  };
}

/**
 * Read just the container header.
 *
 * @throws {FmsFormatError} when the file is too short or the magic is wrong.
 */
export function readFmsHeader(data: Buffer): { version: number; uncompressedSize: number } {
  if (data.byteLength < FMS_HEADER_SIZE + 4) {
    throw new FmsFormatError(`File is only ${data.byteLength} bytes; too short to be a .fms file.`);
  }
  const magic = data.readUInt32LE(0);
  if (magic !== FMS_MAGIC) {
    throw new FmsFormatError(
      `Bad magic 0x${magic.toString(16).padStart(8, '0')}; expected 0x${FMS_MAGIC.toString(16)} ("FMS!").`,
    );
  }
  return {
    version: data.readUInt32LE(4),
    uncompressedSize: data.readUInt32LE(FMS_HEADER_SIZE),
  };
}

/** Inflate the project payload of a `.fms` buffer. */
export function readFmsPayload(data: Buffer): Buffer {
  const header = readFmsHeader(data);
  const body = data.subarray(FMS_HEADER_SIZE + 4);
  let payload: Buffer;
  try {
    payload = inflateRawSync(body);
  } catch (error) {
    throw new FmsFormatError(
      `Could not inflate the project payload: ${(error as Error).message}`,
    );
  }
  if (payload.byteLength !== header.uncompressedSize) {
    throw new FmsFormatError(
      `Decompressed size mismatch: header says ${header.uncompressedSize}, got ${payload.byteLength}.`,
    );
  }
  return payload;
}

/**
 * Parse a `.fms` buffer into the object model.
 *
 * Only version 19 payloads are supported; older files must be re-saved by
 * FamiStudio first.
 */
export function readProject(data: Buffer): Project {
  const header = readFmsHeader(data);
  if (header.version !== FMS_VERSION) {
    throw new FmsFormatError(
      `Unsupported .fms version ${header.version}; this library reads version ${FMS_VERSION} ` +
        '(FamiStudio 4.5.x). Open and re-save the file in FamiStudio to upgrade it.',
    );
  }

  const reader = new Reader(readFmsPayload(data));

  const nextUniqueId = reader.i32();
  const sortSongs = reader.bool();
  const sortInstruments = reader.bool();
  const sortSamples = reader.bool();
  const sortArpeggios = reader.bool();
  const name = reader.str();
  const author = reader.str();
  const copyright = reader.str();
  const expansionMask = reader.i32();
  const expansionNumN163Channels = reader.i32();
  const tempoMode = reader.i32();
  const pal = reader.bool();
  const exportConfigs = readExportConfigs(reader);
  const tuning = reader.i32();

  const folderCount = reader.i32();
  const folders = [];
  for (let i = 0; i < folderCount; i += 1) {
    folders.push({ type: reader.i32(), name: reader.str(), expanded: reader.bool() });
  }

  const soundEngineUsesExtendedInstruments = reader.bool();
  const soundEngineUsesExtendedDpcm = reader.bool();
  const soundEngineUsesBankSwitching = reader.bool();

  const overrideBassCutoffHz = reader.bool();
  const bassCutoffHz = overrideBassCutoffHz ? reader.i32() : 0;
  const overrideMask = reader.i32();
  for (let i = 0; i < 16; i += 1) {
    if ((overrideMask & (1 << i)) !== 0) {
      // ExpansionMixerSettings.Serialize: five signed 16-bit values.
      reader.i16();
      reader.i16();
      reader.i16();
      reader.i16();
      reader.i16();
    }
  }

  const sampleCount = reader.i32();
  const samples: DpcmSample[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const id = reader.i32();
    const sampleName = reader.str();
    // The remaining sample payload depends on the version-9 branch and is not
    // interpreted here; capture it verbatim so a round trip is lossless.
    const start = reader.pos;
    skipDpcmSamplePayload(reader);
    const rawPayload = Buffer.from(reader.data.subarray(start, reader.pos));
    samples.push({ id, name: sampleName, rawPayload });
  }

  const instrumentCount = reader.i32();
  const instruments: Instrument[] = [];
  for (let i = 0; i < instrumentCount; i += 1) instruments.push(readInstrument(reader));

  const arpeggioCount = reader.i32();
  const arpeggios: Arpeggio[] = [];
  for (let i = 0; i < arpeggioCount; i += 1) arpeggios.push(readArpeggio(reader));

  const songCount = reader.i32();
  const songs: Song[] = [];
  for (let i = 0; i < songCount; i += 1) songs.push(readSong(reader));

  for (const song of songs) {
    for (const channel of song.channels) {
      channel.name = CHANNEL_LABELS[channel.type] ?? `Channel${channel.type}`;
      channel.songId = song.id;
    }
  }

  return {
    version: header.version,
    nextUniqueId,
    sortSongs,
    sortInstruments,
    sortSamples,
    sortArpeggios,
    name,
    author,
    copyright,
    expansionMask,
    expansionNumN163Channels,
    tempoMode,
    pal,
    exportConfigs,
    tuning,
    folders,
    soundEngineUsesExtendedInstruments,
    soundEngineUsesExtendedDpcm,
    soundEngineUsesBankSwitching,
    overrideBassCutoffHz,
    bassCutoffHz,
    overrideMask,
    samples,
    instruments,
    arpeggios,
    songs,
  };
}

const CHANNEL_LABELS = ['Square1', 'Square2', 'Triangle', 'Noise', 'DPCM'];

/**
 * Advance the reader past a v19 DPCM sample payload.
 *
 * Mirrors `DPCMSample.Serialize` for version >= 9: source data, color, bank,
 * folder, processing parameters, a four-entry volume envelope and the source
 * filename / fine pitch fields.
 */
function skipDpcmSamplePayload(reader: Reader): void {
  const sourceDataIsWav = reader.bool();
  if (sourceDataIsWav) {
    reader.i32(); // sampleRate
    reader.shorts(); // wavData (int[]-style length-prefixed short array)
  } else {
    reader.bytes(); // dmcData
  }
  reader.i32(); // color
  reader.i32(); // bank
  reader.str(); // folderName
  reader.i32(); // sampleRate
  reader.i32(); // previewRate
  reader.i32(); // volumeAdjust
  reader.i32(); // paddingMode
  reader.bool(); // reverseBits
  reader.bool(); // trimZeroVolume
  reader.bool(); // palProcessing
  for (let i = 0; i < 4; i += 1) {
    reader.i32(); // volumeEnvelope[i].sample (SampleVolumePair.sample)
    reader.f32(); // volumeEnvelope[i].volume (SampleVolumePair.volume, a float)
  }
  reader.str(); // sourceFilename (v10+)
  reader.i32(); // finePitch (v11+)
  reader.i32(); // dmcInitialValueDiv2 (v11+)
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/** True when the buffer starts with the `FMS!` magic. */
export function isFmsFile(data: Buffer): boolean {
  return data.byteLength >= 4 && data.readUInt32LE(0) === FMS_MAGIC;
}
