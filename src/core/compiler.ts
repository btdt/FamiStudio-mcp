/**
 * High-level JSON "song spec" compiler.
 *
 * The spec is the authoring surface of this library: it hides FamiStudio's
 * binary quirks (envelope masks, 256-slot pattern tables, object ids) so that a
 * caller only has to describe notes.
 */
import {
  CHANNEL_NAMES,
  MUSICAL_NOTE_MAX,
  MUSICAL_NOTE_MIN,
  NTSC_FRAME_RATE,
  PAL_FRAME_RATE,
  SONG_MAX_LENGTH,
  isMusicalNote,
  noteNameToValue,
  resolveChannelType,
  secondsToTicks,
  valueToNoteName,
} from './constants.js';
import { VIBRATO_BITS, EffectBit, type EffectName } from './effects.js';
import {
  type Note,
  type Pattern,
  type Project,
  type Song,
  createChannel,
  createInstrument,
  createNote,
  createProject,
  createSong,
  setNoteTime,
  songChannels,
  maxObjectId,
  MODEL_TARGET,
} from './model.js';

/** One note in an absolute-time track. */
export interface NoteSpec {
  /** Absolute tick inside the pattern. Defaults to the running cursor. */
  time?: number;
  /** Note name (`"C4"`), `"stop"`, `"release"`, or a raw value 0..0x60. */
  note?: string | number;
  /** Alias of `note` (FamiStudio's own terminology). */
  value?: string | number;
  /** Length in ticks. Omitted means "use the channel default". */
  duration?: number;
  /** Length in seconds; converted with the project frame rate. */
  durationSeconds?: number;
  /** Instrument name or id. Omitted means the shared default instrument. */
  instrument?: string | number;
  /** `true` adds the no-attack flag. */
  noAttack?: boolean;
  /** Raw slide target note value or name. */
  slide?: string | number;
  /** Release offset in ticks. */
  release?: number;
  /** Effect values keyed by effect name (`volume`, `dutyCycle`, ...). */
  effects?: Partial<Record<EffectName, number>>;
  /** Shorthand for `effects.volume`. */
  volume?: number;
  /** Shorthand for `effects.dutyCycle` (0..3). */
  dutyCycle?: number;
  /** Arpeggio name or id. */
  arpeggio?: string | number;
}

/**
 * A track's notes: either absolute-time notes or a tick grid.
 *
 * In grid form every entry is one tick cell; a cell may hold several notes
 * (chords / attacks plus effects). A note without an explicit `duration`
 * sustains until the next filled cell on the same track.
 */
export type TrackNotes = NoteSpec[] | (NoteSpec | NoteSpec[] | null)[];

/** One channel of a song spec. */
export interface ChannelSpec {
  /** Channel name: Square1 / Square2 / Triangle / Noise / DPCM (aliases allowed). */
  channel: string | number;
  /** Inline notes shorthand: `notes` becomes this channel's first pattern. */
  notes?: TrackNotes;
  /** Explicit patterns; each entry becomes one pattern slot in song order. */
  patterns?: TrackNotes[];
  /** Default note length in ticks for this channel. */
  noteLength?: number;
  /** Default instrument (name or id) for this channel. */
  instrument?: string | number;
}

/** Tempo/groove settings of a song spec. */
export interface SongSpec {
  name?: string;
  /** Ticks per pattern. Default 128. */
  patternLength?: number;
  /** Number of patterns played; defaults to the longest channel track count. */
  songLength?: number;
  /** Ticks per beat. Default 32. */
  beatLength?: number;
  /** FamiStudio tempo: groove value; a single value means one tick per frame. */
  groove?: number | number[];
  /** Default note length in ticks. Default 8. */
  noteLength?: number;
  /** Pattern index the song loops back to. Default 0. */
  loopPoint?: number;
  /** ARGB color. */
  color?: number;
  /** Channels to use; omitted channels are emitted empty. */
  channels?: ChannelSpec[];
}

/** A named instrument in a song spec. */
export interface InstrumentSpec {
  name: string;
  color?: number;
  /** Volume envelope values (0..15); also sets the envelope length. */
  volume?: number[];
  /** Duty cycle envelope values (0..3). */
  dutyCycle?: number[];
  /** Pitch envelope values (signed semitone offsets). */
  pitch?: number[];
  /** Arpeggio envelope values (signed semitone offsets). */
  arpeggio?: number[];
  /** Loop point applied to every envelope that has one. */
  loop?: number;
}

/** Top-level spec accepted by {@link compileSongSpec}. */
export interface SongSpecDocument {
  /** Project name; also used as the default song name. */
  name?: string;
  author?: string;
  copyright?: string;
  /** PAL timing instead of NTSC. */
  pal?: boolean;
  /** A=440 tuning. */
  tuning?: number;
  /** Songs to create. A bare spec has `channels` at the top level. */
  songs?: SongSpec[];
  /** Single-song shorthand. */
  song?: SongSpec;
  channels?: ChannelSpec[];
  patternLength?: number;
  songLength?: number;
  groove?: number | number[];
  noteLength?: number;
  /** Shared instruments. Auto-created when omitted. */
  instruments?: InstrumentSpec[];
  /** Name of the instrument used when a note does not name one. */
  defaultInstrument?: string;
  /** Drop notes past the end of a pattern instead of failing. */
  truncate?: boolean;
  /** Allow the same note to be re-attacked on a later tick even if it never ends. */
  strict?: boolean;
}

/** One thing the compiler changed or ignored, surfaced to the caller. */
export interface CompileWarning {
  code: string;
  message: string;
}

/** Result of {@link compileSongSpec}. */
export interface CompileResult {
  project: Project;
  warnings: CompileWarning[];
  /** Per-song summary, handy for echoing back to an agent/user. */
  songs: {
    name: string;
    id: number;
    patternLength: number;
    songLength: number;
    totalTicks: number;
    durationSeconds: number;
    /** Patterns actually created per channel, in channel order. */
    patternsPerChannel: { channel: string; patterns: number; notes: number }[];
  }[];
}

/**
 * Validate and return a raw numeric note value.
 *
 * FamiStudio's valid set is: 0 = stop, 128 = release, 255 = empty, and 1..96 for
 * musical notes C0..B7. Anything else is rejected here rather than silently
 * producing a file FamiStudio would refuse to load.
 */
function checkRawNoteValue(numeric: number): number {
  if (Number.isInteger(numeric) && (numeric === 0 || numeric === 0x80 || numeric === 0xff)) {
    return numeric;
  }
  if (Number.isInteger(numeric) && numeric >= MUSICAL_NOTE_MIN && numeric <= MUSICAL_NOTE_MAX) {
    return numeric;
  }
  throw new Error(
    `Note value ${numeric} is out of range; use 1..${MUSICAL_NOTE_MAX} (${
      valueToNoteName(MUSICAL_NOTE_MIN)
    }..${valueToNoteName(MUSICAL_NOTE_MAX)}), 0 (stop) or ${0x80} (release).`,
  );
}

/** Parse a note reference into a FamiStudio note value. */
function resolveNoteValue(spec: NoteSpec): number {
  const raw = spec.note ?? spec.value;
  if (raw === undefined) return 0xff;
  if (typeof raw === 'number') return checkRawNoteValue(raw);
  const key = raw.trim().toLowerCase();
  if (key === 'stop' || key === '---' || key === '.') return 0x00;
  if (key === 'release' || key === '===') return 0x80;
  if (/^\d+$/.test(key)) return checkRawNoteValue(Number.parseInt(key, 10));
  return noteNameToValue(raw);
}

/** Parse a slide target. */
function resolveSlideValue(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  if (typeof raw === 'number') return raw;
  return noteNameToValue(raw);
}

/** Normalize the `groove` field into an int array. */
function normalizeGroove(groove: number | number[] | undefined, noteLength: number): number[] {
  if (groove === undefined) return [noteLength];
  const values = Array.isArray(groove) ? groove : [groove];
  if (values.length === 0) return [noteLength];
  return values.map((value) => {
    if (!Number.isInteger(value) || value < 1 || value > 255) {
      throw new Error(`groove values must be integers in 1..255, got ${value}.`);
    }
    return value;
  });
}

/**
 * Flatten a track (absolute list or grid) into note specs with tick positions.
 *
 * The two forms are told apart by their entries: absolute tracks hold note
 * objects (or `null` gaps), grid tracks hold one cell per tick where a cell is
 * a note, an array of notes, or `null`. A bare note name or number is only
 * meaningful inside a grid, so it selects grid mode.
 */
function normalizeTrack(
  notes: TrackNotes,
  songNoteLength: number,
  channelNoteLength: number | undefined,
  label: string,
): { time: number; spec: NoteSpec }[] {
  const defaultLength = channelNoteLength ?? songNoteLength;
  const out: { time: number; spec: NoteSpec }[] = [];

  if (!Array.isArray(notes) || notes.length === 0) return out;

  // The form is decided by the first entry that carries information. Only a
  // plain note object can express an absolute-time note; a bare note name or
  // note value is only meaningful as a grid cell, and `null` is a gap or an
  // empty cell in either form.
  const firstMeaningful = notes.find((entry) => entry !== null && entry !== undefined);
  if (firstMeaningful === undefined) return out;
  const isGrid = !(typeof firstMeaningful === 'object' && !Array.isArray(firstMeaningful));

  if (!isGrid) {
    // Absolute-time list: honour `time`, or keep a running cursor.
    let cursor = 0;
    for (const entry of notes as (NoteSpec | null)[]) {
      if (entry === null || entry === undefined) continue;
      if (typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(
          `${label}: a track that starts with a note object must contain only note objects; ` +
            `found ${typeof entry}. For a one-entry-per-tick grid, use note names such as "C4".`,
        );
      }
      const time = entry.time ?? cursor;
      const spec: NoteSpec = { ...entry, duration: entry.duration ?? defaultLength };
      out.push({ time, spec });
      cursor = time + (spec.duration ?? defaultLength);
    }
    return out;
  }

  // Grid mode: each index is one tick; later cells extend earlier notes.
  const cells = notes as (NoteSpec | NoteSpec[] | null)[];
  for (let tick = 0; tick < cells.length; tick += 1) {
    const cell = cells[tick];
    if (cell === null || cell === undefined) continue;
    const rawEntries = Array.isArray(cell) ? cell : [cell];
    for (const raw of rawEntries) {
      if (raw === null || raw === undefined) continue;
      if (typeof raw === 'object' && !Array.isArray(raw)) {
        // Already a note object.
        const spec: NoteSpec = { ...raw };
        if (spec.duration === undefined && spec.durationSeconds === undefined) spec.duration = -1;
        out.push({ time: tick, spec });
        continue;
      }
      if (typeof raw === 'string' || typeof raw === 'number') {
        // Shorthand: a note name, or a raw FamiStudio note value.
        const spec: NoteSpec = { note: raw, duration: -1 };
        out.push({ time: tick, spec });
        continue;
      }
      throw new Error(
        `${label}: a grid cell entry must be a note name, a note value, a note object, or null ` +
          `(cell ${tick} held ${typeof raw}).`,
      );
    }
  }

  // Resolve sentinel durations to "until the next *distinct* cell on this track".
  // Notes sharing a tick (a chord) must all get the same length, so the lookup
  // is built from the set of distinct ticks rather than the raw note list.
  const cellTimes = [...new Set(out.map((entry) => entry.time))].sort((a, b) => a - b);
  const nextCell = new Map<number, number>();
  for (let i = 0; i < cellTimes.length; i += 1) {
    nextCell.set(cellTimes[i], i + 1 < cellTimes.length ? cellTimes[i + 1] : Number.POSITIVE_INFINITY);
  }
  for (const entry of out) {
    if (entry.spec.duration !== -1) continue;
    const next = nextCell.get(entry.time) ?? Number.POSITIVE_INFINITY;
    entry.spec.duration = Number.isFinite(next) ? Math.max(1, next - entry.time) : defaultLength;
  }

  return out;
}

/** Compile a JSON song spec into a full {@link Project}. */
export function compileSongSpec(document: SongSpecDocument): CompileResult {
  const warnings: CompileWarning[] = [];
  const warn = (code: string, message: string) => warnings.push({ code, message });

  const projectName = document.name?.trim() || 'Untitled';
  const project = createProject(projectName);
  project.author = document.author ?? '';
  project.copyright = document.copyright ?? '';
  project.pal = document.pal ?? false;
  project.tuning = document.tuning ?? 440;

  const frameRate = project.pal ? PAL_FRAME_RATE : NTSC_FRAME_RATE;

  // --- Instruments ---------------------------------------------------------
  let nextId = 0;
  const instrumentIds = new Map<string, number>();
  const specs = document.instruments ?? [];
  if (specs.length === 0) {
    const instrument = createInstrument(nextId, 'Lead');
    project.instruments.push(instrument);
    instrumentIds.set('lead', nextId);
    nextId += 1;
  } else {
    for (const spec of specs) {
      if (!spec.name) throw new Error('every instrument needs a name.');
      const instrument = createInstrument(nextId, spec.name, spec.color ?? undefined);
      const { envelopes } = instrument;
      const applyEnvelope = (type: number, values: number[] | undefined) => {
        if (!values || values.length === 0) return;
        const envelope = envelopes[type];
        if (!envelope) throw new Error(`instrument "${spec.name}" cannot carry an envelope of type ${type}.`);
        if (values.length > 256) throw new Error(`envelope values are capped at 256 entries.`);
        envelope.values = new Array<number>(256).fill(0);
        for (let i = 0; i < values.length; i += 1) envelope.values[i] = values[i];
        envelope.length = values.length;
        if (spec.loop !== undefined && spec.loop >= 0) envelope.loop = spec.loop;
      };
      applyEnvelope(0, spec.volume);
      applyEnvelope(1, spec.arpeggio);
      applyEnvelope(2, spec.pitch);
      applyEnvelope(3, spec.dutyCycle);
      project.instruments.push(instrument);
      instrumentIds.set(spec.name.toLowerCase(), nextId);
      nextId += 1;
    }
  }

  const defaultInstrumentName = document.defaultInstrument?.toLowerCase() ?? project.instruments[0].name.toLowerCase();
  if (!instrumentIds.has(defaultInstrumentName)) {
    throw new Error(
      `defaultInstrument "${document.defaultInstrument}" is not defined. Known: ${[...instrumentIds.keys()].join(', ')}.`,
    );
  }

  const resolveInstrumentId = (reference: string | number | undefined, context: string): number => {
    if (reference === undefined) return instrumentIds.get(defaultInstrumentName)!;
    if (typeof reference === 'number') {
      if (!project.instruments.some((instrument) => instrument.id === reference)) {
        throw new Error(`${context}: unknown instrument id ${reference}.`);
      }
      return reference;
    }
    const id = instrumentIds.get(reference.toLowerCase());
    if (id === undefined) {
      throw new Error(
        `${context}: unknown instrument "${reference}". Known: ${[...instrumentIds.keys()].join(', ')}.`,
      );
    }
    return id;
  };

  // --- Songs ---------------------------------------------------------------
  const songDocuments: SongSpec[] = document.songs
    ? document.songs
    : [
        {
          name: document.song?.name ?? projectName,
          ...document.song,
          channels: document.song?.channels ?? document.channels,
          patternLength: document.song?.patternLength ?? document.patternLength,
          songLength: document.song?.songLength ?? document.songLength,
          groove: document.song?.groove ?? document.groove,
          noteLength: document.song?.noteLength ?? document.noteLength,
        },
      ];

  if (songDocuments.length === 0) throw new Error('a project needs at least one song.');

  const summary: CompileResult['songs'] = [];

  for (const songSpec of songDocuments) {
    const songName = songSpec.name?.trim() || `Song${project.songs.length + 1}`;
    const song = createSong(nextId, songName, songSpec.color ?? undefined);
    nextId += 1;

    song.patternLength = songSpec.patternLength ?? 128;
    song.beatLength = songSpec.beatLength ?? 32;
    song.noteLength = songSpec.noteLength ?? 8;
    song.loopPoint = songSpec.loopPoint ?? 0;
    song.groove = normalizeGroove(songSpec.groove, song.noteLength);

    if (song.patternLength < 1 || song.patternLength > 256) {
      throw new Error(`song "${songName}": patternLength must be 1..256.`);
    }
    if (song.loopPoint < 0) throw new Error(`song "${songName}": loopPoint must be >= 0.`);

    // Phase 1: build tracks so songLength can be inferred.
    type Track = { channel: number; patterns: Note[][] };
    const tracks: Track[] = [];
    const seenChannels = new Set<number>();

    for (const channelSpec of songSpec.channels ?? []) {
      const channelType = resolveChannelType(channelSpec.channel);
      const label = `${songName}/${CHANNEL_NAMES[channelType]}`;
      if (seenChannels.has(channelType)) {
        throw new Error(`${label}: channel listed twice.`);
      }
      seenChannels.add(channelType);

      const rawTracks: TrackNotes[] = channelSpec.patterns
        ? channelSpec.patterns
        : channelSpec.notes !== undefined
          ? [channelSpec.notes]
          : [];

      const compiled: Note[][] = [];
      for (let patternIndex = 0; patternIndex < rawTracks.length; patternIndex += 1) {
        const patternLabel = `${label} pattern ${patternIndex}`;
        const entries = normalizeTrack(rawTracks[patternIndex], song.noteLength, channelSpec.noteLength, patternLabel);
        const notes: Note[] = [];

        for (const { time, spec } of entries) {
          if (time < 0) throw new Error(`${patternLabel}: negative tick ${time}.`);
          if (time >= song.patternLength) {
            if (document.truncate) {
              warn('noteTruncated', `${patternLabel}: dropped a note at tick ${time} (pattern length ${song.patternLength}).`);
              continue;
            }
            throw new Error(
              `${patternLabel}: tick ${time} is outside the pattern (length ${song.patternLength}). ` +
                'Raise patternLength, split into more patterns, or pass truncate:true.',
            );
          }

          const value = resolveNoteValue(spec);
          const note = createNote();
          note.value = value;
          setNoteTime(note, time);

          if (spec.noAttack) note.flags |= 0x01;

          if (isMusicalNote(value)) {
            note.instrumentId = resolveInstrumentId(
              spec.instrument ?? channelSpec.instrument,
              patternLabel,
            );
            const duration = spec.durationSeconds !== undefined
              ? secondsToTicks(spec.durationSeconds, frameRate)
              : (spec.duration ?? song.noteLength);
            if (duration < 0 || duration > 0xffff) {
              throw new Error(`${patternLabel}: duration ${duration} is out of range 0..65535.`);
            }
            note.duration = duration;
            note.release = spec.release ?? 0;
            note.slide = resolveSlideValue(spec.slide);
          }

          const effects: Partial<Record<EffectName, number>> = { ...spec.effects };
          if (spec.volume !== undefined) effects.volume = spec.volume;
          if (spec.dutyCycle !== undefined) effects.dutyCycle = spec.dutyCycle;

          for (const [name, effectValue] of Object.entries(effects) as [EffectName, number][]) {
            if (effectValue === undefined) continue;
            if (!(name in EffectBit)) {
              throw new Error(
                `${patternLabel}: unknown effect "${name}". Known: ${Object.keys(EffectBit).join(', ')}.`,
              );
            }
            note.effectValues[name] = effectValue;
          }

          if (spec.arpeggio !== undefined) {
            if (typeof spec.arpeggio === 'number') note.arpeggioId = spec.arpeggio;
            else {
              warn('arpeggioIgnored', `${patternLabel}: arpeggio "${spec.arpeggio}" ignored; define arpeggios via the project API.`);
            }
          }

          notes.push(note);
        }

        notes.sort((a, b) => (a as Note & { time: number }).time - (b as Note & { time: number }).time);
        compiled.push(notes);
      }

      if (compiled.length > SONG_MAX_LENGTH) {
        throw new Error(`${label}: at most ${SONG_MAX_LENGTH} patterns per channel are supported.`);
      }

      tracks.push({ channel: channelType, patterns: compiled });
    }

    // Phase 2: determine songLength.
    const maxPatterns = tracks.reduce((max, track) => Math.max(max, track.patterns.length), 0);
    song.songLength = songSpec.songLength ?? Math.max(1, maxPatterns);
    if (song.songLength > SONG_MAX_LENGTH) {
      throw new Error(`song "${songName}": songLength must be <= ${SONG_MAX_LENGTH}.`);
    }
    if (maxPatterns > song.songLength) {
      if (document.truncate) {
        warn(
          'patternsTruncated',
          `song "${songName}": ${maxPatterns - song.songLength} pattern(s) beyond songLength ${song.songLength} were dropped.`,
        );
      } else {
        throw new Error(
          `song "${songName}": ${maxPatterns} patterns were defined but songLength is ${song.songLength}. ` +
            'Raise songLength or drop patterns.',
        );
      }
    }

    // Phase 3: materialize channels and patterns.
    for (let channelType = 0; channelType < 5; channelType += 1) {
      const channel = createChannel(song.id, channelType);
      const track = tracks.find((candidate) => candidate.channel === channelType);
      const channelPatterns = (track?.patterns ?? []).slice(0, song.songLength);

      for (let slot = 0; slot < channelPatterns.length; slot += 1) {
        const notes = channelPatterns[slot];
        const pattern: Pattern = {
          id: nextId,
          name: `Pattern ${slot}`,
          channelType,
          color: 0,
          songId: song.id,
          notes,
        };
        nextId += 1;
        channel.patterns.push(pattern);
        channel.patternInstances[slot] = pattern.id;
      }

      song.channels.push(channel);
    }

    // Rebuild channels in canonical order (createChannel already does, but be explicit).
    const ordered = songChannels(song);
    song.channels = ordered;

    project.songs.push(song);

    const totalTicks = song.patternLength * song.songLength;
    summary.push({
      name: song.name,
      id: song.id,
      patternLength: song.patternLength,
      songLength: song.songLength,
      totalTicks,
      durationSeconds: Number((totalTicks / frameRate).toFixed(4)),
      patternsPerChannel: ordered.map((channel) => ({
        channel: channel.name,
        patterns: channel.patterns.length,
        notes: channel.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0),
      })),
    });
  }

  project.nextUniqueId = maxObjectId(project) + 1;

  // Sanity: no note may reference an instrument we did not declare.
  for (const song of project.songs) {
    for (const channel of song.channels) {
      for (const pattern of channel.patterns) {
        for (const note of pattern.notes) {
          if (note.instrumentId !== -1 && !project.instruments.some((i) => i.id === note.instrumentId)) {
            throw new Error(
              `song "${song.name}" ${channel.name}: note at tick ${(note as Note & { time: number }).time} ` +
                `references unknown instrument ${note.instrumentId}.`,
            );
          }
        }
      }
    }
  }

  warn('compiled', `Compiled ${project.songs.length} song(s) for FamiStudio ${MODEL_TARGET}.`);

  return { project, warnings, songs: summary };
}

/** Describe a compiled song in human/agent friendly terms. */
export function describeSong(song: Song, frameRate: number): Record<string, unknown> {
  return {
    name: song.name,
    id: song.id,
    patternLength: song.patternLength,
    songLength: song.songLength,
    beatLength: song.beatLength,
    noteLength: song.noteLength,
    groove: song.groove,
    loopPoint: song.loopPoint,
    totalTicks: song.patternLength * song.songLength,
    durationSeconds: Number(((song.patternLength * song.songLength) / frameRate).toFixed(4)),
    channels: songChannels(song).map((channel) => ({
      channel: channel.name,
      patterns: channel.patterns.length,
      notes: channel.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0),
      firstNotes: channel.patterns
        .flatMap((pattern) => pattern.notes)
        .slice(0, 8)
        .map((note) => ({ tick: (note as Note & { time: number }).time, note: valueToNoteName(note.value) })),
    })),
  };
}

export type { EffectName };
export { VIBRATO_BITS };
