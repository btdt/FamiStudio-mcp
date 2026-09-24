/**
 * Project reporting helpers: a compact structural summary plus its text
 * rendering. Shared by the CLI, the MCP tools and the test suite.
 */
import { frameRateFor, isMusicalNote, valueToNoteName } from './constants.js';
import {
  noteTime,
  songChannels,
  songDurationSeconds,
  songTotalTicks,
  type Note,
  type Pattern,
  type Project,
} from './model.js';

/** One note rendered for humans. */
export function describeNote(note: Note): string {
  const time = noteTime(note);
  const value =
    note.value === 0x00
      ? 'stop'
      : note.value === 0x80
        ? 'release'
        : note.value === 0xff
          ? 'invalid'
          : valueToNoteName(note.value);
  const parts = [`t=${time}`, value];
  if (isMusicalNote(note.value)) {
    parts.push(`dur=${note.duration}`);
    if (note.instrumentId !== -1) parts.push(`inst=${note.instrumentId}`);
  }
  const effects = Object.entries(note.effectValues)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`);
  if (effects.length > 0) parts.push(effects.join(' '));
  return parts.join(' ');
}

/** Render one pattern as an indented text block. */
export function formatPattern(pattern: Pattern, frameRate: number): string {
  const lines = [`    ${pattern.name}:`];
  const notes = [...pattern.notes].sort((a, b) => noteTime(a) - noteTime(b));
  if (notes.length === 0) {
    lines.push('      (empty)');
    return lines.join('\n');
  }
  for (const note of notes) {
    const seconds = (noteTime(note) / frameRate).toFixed(4);
    lines.push(`      ${seconds.padStart(8)}s  ${describeNote(note)}`);
  }
  return lines.join('\n');
}

/** Structural summary of a project, safe to JSON-serialize. */
export function summarizeProject(project: Project): Record<string, unknown> {
  const frameRate = frameRateFor(project.pal);
  return {
    name: project.name,
    author: project.author,
    copyright: project.copyright,
    version: project.version,
    pal: project.pal,
    tuning: project.tuning,
    frameRate: Number(frameRate.toFixed(4)),
    instruments: project.instruments.map((instrument) => ({
      id: instrument.id,
      name: instrument.name,
      envelopeMask: `0x${instrument.envelopeMask.toString(16).padStart(4, '0')}`,
      envelopeLengths: instrument.envelopes.map((envelope) => (envelope ? envelope.length : null)),
    })),
    arpeggios: project.arpeggios.map((arpeggio) => ({ id: arpeggio.id, name: arpeggio.name })),
    samples: project.samples.map((sample) => ({
      id: sample.id,
      name: sample.name,
      bytes: sample.rawPayload.length,
    })),
    songs: project.songs.map((song) => ({
      id: song.id,
      name: song.name,
      patternLength: song.patternLength,
      songLength: song.songLength,
      noteLength: song.noteLength,
      groove: song.groove,
      totalTicks: songTotalTicks(song),
      durationSeconds: Number(songDurationSeconds(song, frameRate).toFixed(4)),
      channels: songChannels(song).map((channel) => ({
        channel: channel.name,
        patterns: channel.patterns.length,
        notes: channel.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0),
      })),
    })),
  };
}

/** Render {@link summarizeProject} as readable text. */
export function formatProjectSummary(summary: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Project "${summary.name}"${summary.author ? ` by ${summary.author}` : ''}`);
  const instruments = summary.instruments as unknown[];
  lines.push(
    `  version ${summary.version}, ${summary.pal ? 'PAL' : 'NTSC'}, tuning ${summary.tuning} Hz, ` +
      `${instruments.length} instrument(s)`,
  );
  for (const song of summary.songs as Record<string, unknown>[]) {
    lines.push(
      `  Song "${song.name}" (id ${song.id}): ${song.patternLength} ticks x ${song.songLength} patterns = ` +
        `${song.totalTicks} ticks, ${song.durationSeconds}s`,
    );
    const channels = (song.channels as Record<string, unknown>[]).filter(
      (channel) => (channel.patterns as number) > 0,
    );
    if (channels.length === 0) lines.push('    (no notes)');
    for (const channel of channels) {
      lines.push(`    ${channel.channel}: ${channel.patterns} pattern(s), ${channel.notes} note(s)`);
    }
  }
  return lines.join('\n');
}
