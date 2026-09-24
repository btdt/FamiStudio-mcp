/**
 * In-memory object model of a FamiStudio project.
 *
 * Field-for-field mirror of the C# classes in `FamiStudio/Source/Project`
 * (Project, Instrument, Envelope, Arpeggio, Song, Channel, Pattern, Note,
 * DPCMSample, Folder) restricted to what version 19 serializes for 2A03
 * projects. The model is JSON-serializable on purpose: it doubles as the
 * machine-readable output of `read_fms`.
 */
import {
  ALL_CHANNELS,
  CHANNEL_NAMES,
  ENVELOPE_MAX_LENGTH,
  ENVELOPE_TYPE_COUNT,
  EnvelopeType,
  GroovePaddingType,
  NOTE_INVALID,
  NOTE_RELEASE,
  NOTE_STOP,
  REGULAR_ENVELOPE_MASK,
  SONG_MAX_LENGTH,
  TEMPO_MODE_FAMISTUDIO,
  TARGET_FAMISTUDIO,
  isMusicalNote,
} from './constants.js';

/** A single envelope track (`Envelope.Serialize`). */
export interface Envelope {
  /** Active value count, 1..256. */
  length: number;
  /** Loop index, `-1` for none. */
  loop: number;
  /** Release index, `-1` for none. */
  release: number;
  /** Whether values are relative to the previous value. */
  relative: boolean;
  /** Always `ENVELOPE_MAX_LENGTH` (256) entries when serialized. */
  values: number[];
}

/** A 2A03 instrument (`Instrument.Serialize`, `expansion = 0`). */
export interface Instrument {
  id: number;
  name: string;
  /** ARGB, unsigned. */
  color: number;
  /** Always 0 for 2A03. */
  expansion: number;
  /** Bit `i` set means `envelopes[i]` is present. Always includes 0x000F. */
  envelopeMask: number;
  /** Indexed by `EnvelopeType`; `null` for absent slots. */
  envelopes: (Envelope | null)[];
  folderName: string;
  /** Indices into `Project.samples`; always empty for the bundled writer. */
  sampleMappings: { note: number; sampleId: number; loop: boolean; pitch: number }[];
}

/** A note placed at one tick inside a pattern. */
export interface Note {
  /**
   * Tick position inside the pattern.
   *
   * The binary format encodes this through array order, but the model keeps it
   * as an ordinary field so notes survive JSON serialization - that is what
   * makes a project object usable as a tool argument after a round trip through
   * an MCP client.
   */
  time: number;
  /** FamiStudio note value: 0 = stop, 1..0x60 = musical, 0x80 = release. */
  value: number;
  /** Bit 0 = no-attack. */
  flags: number;
  /** Slide target note value, 0 for none. */
  slide: number;
  /** Instrument id, `-1` for none. */
  instrumentId: number;
  /** Length in ticks (musical notes only). */
  duration: number;
  /** Release offset in ticks (musical notes only). */
  release: number;
  effectMask: number;
  effectValues: Record<string, number>;
  /** Arpeggio id, `-1` for none. */
  arpeggioId: number;
}

/** A channel pattern (`Pattern.Serialize`). */
export interface Pattern {
  id: number;
  name: string;
  channelType: number;
  color: number;
  songId: number;
  /** Sparse ticks, ascending. */
  notes: Note[];
}

/** One of the five channels of a song (`Channel.Serialize`). */
export interface Channel {
  /** Owning song id. */
  songId: number;
  type: number;
  name: string;
  patterns: Pattern[];
  /** Exactly `SONG_MAX_LENGTH` (256) entries; unused slots are `-1`. */
  patternInstances: number[];
}

/** Per-pattern tempo overrides (`Song.PatternCustomSetting`). */
export interface PatternCustomSettings {
  useCustomSettings: boolean;
  patternLength: number;
  noteLength: number;
  beatLength: number;
  groove: number[] | null;
  groovePaddingMode: number;
}

/** A song (`Song.Serialize`). */
export interface Song {
  id: number;
  patternLength: number;
  songLength: number;
  beatLength: number;
  name: string;
  famitrackerTempo: number;
  famitrackerSpeed: number;
  color: number;
  loopPoint: number;
  noteLength: number;
  groove: number[];
  groovePaddingMode: number;
  patternCustomSettings: PatternCustomSettings[];
  folderName: string;
  /** Exactly 5 channels, ordered Square1..DPCM. */
  channels: Channel[];
}

/** An arpeggio (`Arpeggio.Serialize`). */
export interface Arpeggio {
  id: number;
  name: string;
  color: number;
  folderName: string;
  envelope: Envelope;
}

/** A project-explorer folder (`Folder.Serialize`). */
export interface Folder {
  type: number;
  name: string;
  expanded: boolean;
}

/**
 * Export settings blobs.
 *
 * FamiStudio stores 12 of these verbatim in the project file. They are only
 * UI conveniences, so this library preserves them when reading and writes the
 * application defaults when generating.
 */
export interface ExportConfigBlobs {
  audio: Record<string, unknown>;
  video: Record<string, unknown>;
  nsf: Record<string, unknown>;
  romFds: Record<string, unknown>;
  midi: Record<string, unknown>;
  vgm: Record<string, unknown>;
  famiStudioText: Record<string, unknown>;
  famiTrackerText: Record<string, unknown>;
  famiStudioMusic: Record<string, unknown>;
  famiStudioSfx: Record<string, unknown>;
  famiTone2Music: Record<string, unknown>;
  famiTone2Sfx: Record<string, unknown>;
}

/** A complete FamiStudio project. */
export interface Project {
  /** Serialization version; always 19 for this library. */
  version: number;
  /** Id handed out to the next created object; must exceed every existing id. */
  nextUniqueId: number;
  sortSongs: boolean;
  sortInstruments: boolean;
  sortSamples: boolean;
  sortArpeggios: boolean;
  name: string;
  author: string;
  copyright: string;
  /** 0 = plain 2A03, no expansion audio. */
  expansionMask: number;
  expansionNumN163Channels: number;
  /** 0 = FamiStudio tempo, 1 = FamiTracker tempo. */
  tempoMode: number;
  pal: boolean;
  exportConfigs: ExportConfigBlobs;
  tuning: number;
  folders: Folder[];
  soundEngineUsesExtendedInstruments: boolean;
  soundEngineUsesExtendedDpcm: boolean;
  soundEngineUsesBankSwitching: boolean;
  overrideBassCutoffHz: boolean;
  bassCutoffHz: number;
  overrideMask: number;
  samples: DpcmSample[];
  instruments: Instrument[];
  arpeggios: Arpeggio[];
  songs: Song[];
}

/**
 * A DPCM sample.
 *
 * The full v19 sample payload (source data, volume envelope, processing flags)
 * is preserved byte-for-byte in `rawPayload` when a project is read, and written
 * back verbatim, so that projects containing DPCM samples survive a
 * read/modify/write round trip without implementing the DPCM audio pipeline.
 */
export interface DpcmSample {
  id: number;
  name: string;
  /** Serialized payload bytes after `name`, including the version-9 branch. */
  rawPayload: Buffer;
}

/** Default palette color used by FamiStudio for a new song/instrument. */
export const DEFAULT_SONG_COLOR = 0xff6f5fa8;
/** Default instrument color. */
export const DEFAULT_INSTRUMENT_COLOR = 0xffbba868;
/** Default arpeggio color. */
export const DEFAULT_ARPEGGIO_COLOR = 0xff9696ff;

/** Create an empty envelope of the given kind, matching FamiStudio defaults. */
export function createEnvelope(type: number): Envelope {
  const values = new Array<number>(ENVELOPE_MAX_LENGTH).fill(0);
  const envelope: Envelope = {
    length: 1,
    loop: -1,
    release: -1,
    relative: false,
    values,
  };

  switch (type) {
    case EnvelopeType.Volume: {
      // Default FamiStudio volume envelope fades 15 -> 0 over 16 frames.
      envelope.length = 16;
      for (let i = 0; i < 16; i += 1) values[i] = 15 - i;
      break;
    }
    case EnvelopeType.DutyCycle: {
      envelope.length = 1;
      values[0] = 2; // 50% duty.
      break;
    }
    case EnvelopeType.Arpeggio:
    case EnvelopeType.Pitch: {
      envelope.length = 1;
      values[0] = 0;
      break;
    }
    default: {
      envelope.length = 1;
      values[0] = 0;
      break;
    }
  }

  return envelope;
}

/**
 * Create the four mandatory envelopes of a 2A03 instrument.
 *
 * The mask is forced to {@link REGULAR_ENVELOPE_MASK}: FamiStudio's GUI crashes
 * on load when a regular instrument omits any of Volume/Arpeggio/Pitch/DutyCycle.
 */
export function createRegularEnvelopes(): (Envelope | null)[] {
  const envelopes = new Array<Envelope | null>(ENVELOPE_TYPE_COUNT).fill(null);
  for (const type of [
    EnvelopeType.Volume,
    EnvelopeType.Arpeggio,
    EnvelopeType.Pitch,
    EnvelopeType.DutyCycle,
  ]) {
    envelopes[type] = createEnvelope(type);
  }
  return envelopes;
}

/** Create an instrument with the default envelope set. */
export function createInstrument(id: number, name: string, color = DEFAULT_INSTRUMENT_COLOR): Instrument {
  const envelopes = createRegularEnvelopes();
  let mask = 0;
  for (let i = 0; i < envelopes.length; i += 1) {
    if (envelopes[i]) mask |= 1 << i;
  }
  return {
    id,
    name,
    color,
    expansion: 0,
    envelopeMask: mask | REGULAR_ENVELOPE_MASK,
    envelopes,
    folderName: '',
    sampleMappings: [],
  };
}

/** Create an empty channel of the given type for a song. */
export function createChannel(songId: number, type: number): Channel {
  return {
    songId,
    type,
    name: CHANNEL_NAMES[type],
    patterns: [],
    patternInstances: new Array<number>(SONG_MAX_LENGTH).fill(-1),
  };
}

/** Create default per-pattern custom settings (all overrides off). */
export function createPatternCustomSettings(): PatternCustomSettings {
  return {
    useCustomSettings: false,
    patternLength: 0,
    noteLength: 0,
    beatLength: 0,
    groove: null,
    groovePaddingMode: GroovePaddingType.Middle,
  };
}

/** Create an empty song with all five channels. */
export function createSong(id: number, name: string, color = DEFAULT_SONG_COLOR): Song {
  const song: Song = {
    id,
    patternLength: 128,
    songLength: 5,
    beatLength: 32,
    name,
    famitrackerTempo: 150,
    famitrackerSpeed: 6,
    color,
    loopPoint: 0,
    noteLength: 8,
    groove: [8],
    groovePaddingMode: GroovePaddingType.Middle,
    patternCustomSettings: [],
    folderName: '',
    channels: [],
  };
  for (let i = 0; i < SONG_MAX_LENGTH; i += 1) {
    song.patternCustomSettings.push(createPatternCustomSettings());
  }
  song.channels = ALL_CHANNELS.map((type) => createChannel(id, type));
  return song;
}

/** Create an empty note (FamiStudio `new Note()`). */
export function createNote(): Note {
  return {
    time: 0,
    value: NOTE_INVALID,
    flags: 0,
    slide: 0,
    instrumentId: -1,
    duration: 0,
    release: 0,
    effectMask: 0,
    effectValues: {},
    arpeggioId: -1,
  };
}

/** Application-default export settings, matching a stock FamiStudio install. */
export function createDefaultExportConfigs(): ExportConfigBlobs {
  return {
    audio: {
      songId: -1,
      format: '',
      samplerate: '',
      bitRate: '',
      loopMode: '',
      loopCount: 1,
      duration: 120,
      delay: 0,
      separateFiles: false,
      separateIntro: false,
      stereo: false,
      channels: [],
    },
    video: {
      songId: -1,
      mode: '',
      resolution: '',
      frameRate: '',
      audioBitRate: '',
      videoBitRate: '',
      loopCount: 1,
      delay: 0,
      oscColumns: -1,
      oscWindow: 2,
      oscThickness: 2,
      oscColour: '',
      pianoRollWidth: '',
      pianoRollZoom: '',
      pianoRollRows: -1,
      pianoRollPerspective: '',
      overlayRegisters: false,
      stereo: false,
      channels: [],
    },
    nsf: { name: '', artist: '', copyright: '', format: '', mode: '', songList: [] },
    romFds: { type: '', name: '', artist: '', mode: '', songList: [] },
    midi: {
      songId: -1,
      volumeVelocity: true,
      slidesAsPitch: true,
      pitchWheelRange: 24,
      mode: '',
      midiInstruments: [],
    },
    vgm: {
      songId: -1,
      trackTitle: '',
      gameName: '',
      system: '',
      composer: '',
      date: '',
      vgmBy: '',
      notes: '',
      smoothLoop: true,
    },
    famiStudioText: { deleteUnusedData: false, songList: [] },
    famiTrackerText: { songList: [] },
    famiStudioMusic: {
      format: '',
      separate: false,
      songName: '{project}_{song}',
      dmcName: '{project}',
      dmcExportMode: '',
      unusedMappings: false,
      songListInclude: false,
      songList: [],
    },
    famiStudioSfx: { format: '', mode: '', include: false, songList: [] },
    famiTone2Music: {
      format: '',
      separate: false,
      songName: '{project}_{song}',
      dmcName: '{project}',
      dmcExportMode: '',
      unusedMappings: false,
      songListInclude: false,
      songList: [],
    },
    famiTone2Sfx: { format: '', mode: '', include: false, songList: [] },
  };
}

/** Create an empty project with the given name. */
export function createProject(name: string): Project {
  return {
    version: 19,
    nextUniqueId: 0,
    sortSongs: false,
    sortInstruments: false,
    sortSamples: false,
    sortArpeggios: false,
    name,
    author: '',
    copyright: '',
    expansionMask: 0,
    expansionNumN163Channels: 1,
    tempoMode: TEMPO_MODE_FAMISTUDIO,
    pal: false,
    exportConfigs: createDefaultExportConfigs(),
    tuning: 440,
    folders: [],
    soundEngineUsesExtendedInstruments: false,
    soundEngineUsesExtendedDpcm: false,
    soundEngineUsesBankSwitching: false,
    overrideBassCutoffHz: false,
    bassCutoffHz: 0,
    overrideMask: 0,
    samples: [],
    instruments: [],
    arpeggios: [],
    songs: [],
  };
}

/** The five channels of a song, indexed by `ChannelType`. */
export function songChannels(song: Song): Channel[] {
  const byType = new Map<number, Channel>();
  for (const channel of song.channels) byType.set(channel.type, channel);
  return ALL_CHANNELS.map((type) => {
    const channel = byType.get(type);
    if (!channel) throw new Error(`Song "${song.name}" is missing channel ${CHANNEL_NAMES[type]}.`);
    return channel;
  });
}

/** Instrument lookup by id. */
export function findInstrument(project: Project, id: number): Instrument | undefined {
  return project.instruments.find((instrument) => instrument.id === id);
}

/** Total ticks a song occupies: `patternLength * songLength`, honouring overrides. */
export function songTotalTicks(song: Song): number {
  let total = 0;
  for (let i = 0; i < song.songLength; i += 1) {
    const custom = song.patternCustomSettings[i];
    total += custom?.useCustomSettings ? custom.patternLength : song.patternLength;
  }
  return total;
}

/** Duration of a song in seconds (uniform-groove approximation). */
export function songDurationSeconds(song: Song, frameRate: number): number {
  return songTotalTicks(song) / frameRate;
}

/** Highest id used anywhere in the project. */
export function maxObjectId(project: Project): number {
  let max = -1;
  for (const sample of project.samples) max = Math.max(max, sample.id);
  for (const instrument of project.instruments) max = Math.max(max, instrument.id);
  for (const arpeggio of project.arpeggios) max = Math.max(max, arpeggio.id);
  for (const song of project.songs) {
    max = Math.max(max, song.id);
    for (const channel of song.channels) {
      for (const pattern of channel.patterns) max = Math.max(max, pattern.id);
    }
  }
  return max;
}

/** FamiStudio version this model targets. */
export const MODEL_TARGET = TARGET_FAMISTUDIO;

/**
 * Tick position of a note (0 when unset, which only happens for a freshly
 * created note that has not been placed yet).
 */
export function noteTime(note: Note): number {
  return typeof note.time === 'number' ? note.time : 0;
}

/** Place a note at a tick. */
export function setNoteTime(note: Note, time: number): void {
  note.time = time;
}

/** Strip a note down to a plain JSON object. */
export function noteToJson(note: Note): Record<string, unknown> {
  const out: Record<string, unknown> = { time: noteTime(note), value: note.value };
  if (note.value !== NOTE_INVALID) {
    if (note.flags !== 0) out.flags = note.flags;
    if (isMusicalNote(note.value)) {
      if (note.slide !== 0) out.slide = note.slide;
      if (note.instrumentId !== -1) out.instrumentId = note.instrumentId;
      out.duration = note.duration;
      if (note.release !== 0) out.release = note.release;
    }
    if (note.effectMask !== 0) out.effectMask = note.effectMask;
    const effects = Object.fromEntries(
      Object.entries(note.effectValues).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(effects).length > 0) out.effects = effects;
    if (note.arpeggioId !== -1) out.arpeggioId = note.arpeggioId;
  }
  return out;
}

/** Note value helpers re-exported for convenience. */
export { NOTE_INVALID, NOTE_RELEASE, NOTE_STOP, isMusicalNote };
