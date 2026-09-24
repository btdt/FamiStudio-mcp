/**
 * Fixed constants of the FamiStudio `.fms` container format and of the 2A03.
 *
 * Everything in this file is derived from the FamiStudio 4.5.x sources
 * (`Project.Version`, `ChannelType`, `EnvelopeType`, `Note`, `Song`).
 */

/** Serialization version written by FamiStudio 4.5.x. */
export const FMS_VERSION = 19;

/** ASCII "FMS!" as a little-endian uint32. */
export const FMS_MAGIC = 0x21534d46;

/** Bytes of the container header: magic + version. */
export const FMS_HEADER_SIZE = 8;

/** NTSC frame rate used by FamiStudio when converting ticks to seconds. */
export const NTSC_FRAME_RATE = 60.0988118623484;

/** PAL frame rate used by FamiStudio when converting ticks to seconds. */
export const PAL_FRAME_RATE = 50.0069768347802;

/** `Song.MaxLength` - a song can hold at most this many patterns per channel. */
export const SONG_MAX_LENGTH = 256;

/** `Envelope.MaxLength` - envelope value arrays are always serialized fully. */
export const ENVELOPE_MAX_LENGTH = 256;

/** Number of serialized envelopes in `EnvelopeType` (`EnvelopeType.Count`). */
export const ENVELOPE_TYPE_COUNT = 10;

/**
 * Envelope slots that a *regular* (2A03) instrument must always carry.
 *
 * Volume | Arpeggio | Pitch | DutyCycle. Writing a smaller mask makes the
 * FamiStudio GUI crash on load (it dereferences the missing envelopes), so the
 * writer always forces these four bits.
 */
export const REGULAR_ENVELOPE_MASK = 0x000f;

/** `EnvelopeType` indices, in serialization order. */
export const EnvelopeType = {
  Volume: 0,
  Arpeggio: 1,
  Pitch: 2,
  DutyCycle: 3,
  FdsWaveform: 4,
  FdsModulation: 5,
  N163Waveform: 6,
  WaveformRepeat: 7,
  S5BMixer: 8,
  S5BNoiseFreq: 9,
} as const;

/** `ChannelType` indices, in serialization order (one channel per entry). */
export const ChannelType = {
  Square1: 0,
  Square2: 1,
  Triangle: 2,
  Noise: 3,
  DPCM: 4,
} as const;

/** Human-friendly aliases accepted in JSON specs. */
export const CHANNEL_ALIASES: Record<string, number> = {
  square1: 0,
  sq1: 0,
  pulse1: 0,
  square2: 1,
  sq2: 1,
  pulse2: 1,
  triangle: 2,
  tri: 2,
  noise: 3,
  dpcm: 4,
  dmc: 4,
};

/** Canonical channel names indexed by `ChannelType`. */
export const CHANNEL_NAMES = ['Square1', 'Square2', 'Triangle', 'Noise', 'DPCM'] as const;

/** Every channel is serialized for every song, in this order. */
export const ALL_CHANNELS = [0, 1, 2, 3, 4] as const;

/** `TempoType.FamiStudio` - groove driven tempo (what the generators use). */
export const TEMPO_MODE_FAMISTUDIO = 0;

/** `TempoType.FamiTracker`. */
export const TEMPO_MODE_FAMITRACKER = 1;

/** `Note.NoteInvalid`. */
export const NOTE_INVALID = 0xff;
/** `Note.NoteStop` - cut the channel, no attack. */
export const NOTE_STOP = 0x00;
/** `Note.NoteRelease` - release the currently playing note. */
export const NOTE_RELEASE = 0x80;
/** Lowest musical note value (`C0` in FamiStudio naming). */
export const MUSICAL_NOTE_MIN = 0x01;
/** Highest musical note value (`B7` in FamiStudio naming). */
export const MUSICAL_NOTE_MAX = 0x60;
/** `Note.NoteFlagsNoAttack`. */
export const NOTE_FLAG_NO_ATTACK = 0x01;

/** `Pattern` / `Channel` custom settings groove padding modes. */
export const GroovePaddingType = { Beginning: 0, Middle: 1, End: 2 } as const;

/** `FolderType`. */
export const FolderType = { Song: 0, Instrument: 1, Arpeggio: 2, Sample: 3 } as const;

/** Version of FamiStudio whose sources this writer targets. */
export const TARGET_FAMISTUDIO = '4.5.x';

/** Equally-tempered note names, FamiStudio spelling. */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Sharp-to-flat aliases accepted when parsing note names. */
export const FLAT_ALIASES: Record<string, string> = {
  DB: 'C#',
  EB: 'D#',
  GB: 'F#',
  AB: 'G#',
  BB: 'A#',
};

/**
 * Convert a scientific-pitch note name to a FamiStudio note value.
 *
 * FamiStudio names notes one octave above standard pitch: its `C4` (value 49)
 * sounds at ~523 Hz. `value = octave * 12 + semitoneIndex + 1`.
 *
 * @throws if the name is not a recognizable note.
 */
export function noteNameToValue(name: string): number {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!match) {
    throw new Error(
      `Invalid note name "${name}". Expected something like "C4", "F#3" or "Bb2".`,
    );
  }
  const letter = match[1].toUpperCase();
  const accidental = match[2];
  const octave = Number.parseInt(match[3], 10);

  let canonical = `${letter}${accidental === '#' ? '#' : ''}`;
  if (accidental === 'b') {
    canonical = FLAT_ALIASES[`${letter}B`] ?? letter;
  }

  const semitone = NOTE_NAMES.indexOf(canonical as (typeof NOTE_NAMES)[number]);
  if (semitone < 0) throw new Error(`Invalid note name "${name}".`);

  const value = octave * 12 + semitone + 1;
  if (value < MUSICAL_NOTE_MIN || value > MUSICAL_NOTE_MAX) {
    throw new Error(
      `Note "${name}" maps to value ${value}, outside the FamiStudio range ` +
        `${MUSICAL_NOTE_MIN}..${MUSICAL_NOTE_MAX} (C0..B7).`,
    );
  }
  return value;
}

/** Convert a FamiStudio note value back to its canonical name (`49` -> `"C4"`). */
export function valueToNoteName(value: number): string {
  if (value === NOTE_STOP) return 'stop';
  if (value === NOTE_RELEASE) return 'release';
  if (value === NOTE_INVALID) return 'invalid';
  const octave = Math.floor((value - 1) / 12);
  const semitone = (value - 1) % 12;
  return `${NOTE_NAMES[semitone]}${octave}`;
}

/** Resolve a channel name, alias or numeric index to a `ChannelType`. */
export function resolveChannelType(channel: string | number): number {
  if (typeof channel === 'number') {
    if (!Number.isInteger(channel) || channel < 0 || channel > 4) {
      throw new Error(`Channel index ${channel} is out of range 0..4.`);
    }
    return channel;
  }
  const key = channel.trim().toLowerCase();
  const byIndex = Number.parseInt(key, 10);
  if (!Number.isNaN(byIndex) && String(byIndex) === key) return resolveChannelType(byIndex);
  const resolved = CHANNEL_ALIASES[key];
  if (resolved === undefined) {
    throw new Error(
      `Unknown channel "${channel}". Use one of: Square1, Square2, Triangle, Noise, DPCM.`,
    );
  }
  return resolved;
}

/**
 * Convert a duration in seconds to a tick count.
 *
 * In FamiStudio tempo mode with a uniform groove the play head advances one
 * tick per frame (`ShouldAdvanceSong` is constant true), so
 * `seconds = ticks / frameRate`.
 */
export function secondsToTicks(seconds: number, frameRate: number = NTSC_FRAME_RATE): number {
  return Math.round(seconds * frameRate);
}

/** Convert a tick count to seconds. Inverse of {@link secondsToTicks}. */
export function ticksToSeconds(ticks: number, frameRate: number = NTSC_FRAME_RATE): number {
  return ticks / frameRate;
}

/** Frame rate for a project tempo/machine selection. */
export function frameRateFor(pal: boolean): number {
  return pal ? PAL_FRAME_RATE : NTSC_FRAME_RATE;
}

/**
 * `true` when `value` is a musical note (FamiStudio `Note.IsMusical`).
 *
 * `NoteStop` (0), `NoteRelease` (0x80) and `NoteInvalid` (0xff) are not
 * musical; only musical notes carry an instrument and a duration.
 */
export function isMusicalNote(value: number): boolean {
  return value !== NOTE_STOP && value !== NOTE_RELEASE && value !== NOTE_INVALID;
}
