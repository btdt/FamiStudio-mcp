/**
 * Inspection tools: `read_fms`, `summarize_fms` and `diff_fms`.
 */
import { z } from 'zod';
import {
  frameRateFor,
  isMusicalNote,
  noteTime,
  songChannels,
  songTotalTicks,
  valueToNoteName,
  type Note,
  type Pattern,
  type Project,
  type Song,
} from '../core/index.js';
import { defineTool, type ToolRegistry } from '../server.js';
import {
  READ_ONLY,
  ToolError,
  formatProjectSummary,
  projectPayloadSchema,
  resolveProject,
  summarizeProject,
  toToolResult,
  toolText,
} from './shared.js';

/** Render one pattern as an indented text grid for humans. */
function patternToText(pattern: Pattern, frameRate: number): string {
  const lines: string[] = [`    ${pattern.name}:`];
  const notes = [...pattern.notes].sort((a, b) => noteTime(a) - noteTime(b));
  if (notes.length === 0) {
    lines.push('      (empty)');
    return lines.join('\n');
  }
  for (const note of notes) {
    const time = noteTime(note);
    const seconds = (time / frameRate).toFixed(4);
    const value =
      note.value === 0x00
        ? 'stop'
        : note.value === 0x80
          ? 'release'
          : note.value === 0xff
            ? 'invalid'
            : valueToNoteName(note.value);
    const parts = [`t=${String(time).padStart(4)}`, `(${seconds.padStart(8)}s)`, value.padEnd(8)];
    if (isMusicalNote(note.value)) {
      parts.push(`dur=${String(note.duration).padEnd(5)}`);
      if (note.instrumentId !== -1) parts.push(`inst=${String(note.instrumentId).padEnd(4)}`);
    }
    if (note.flags & 0x01) parts.push('no-attack');
    if (note.slide) parts.push(`slide=${valueToNoteName(note.slide)}`);
    if (note.release) parts.push(`rel=${note.release}`);
    const effects = Object.entries(note.effectValues)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}=${value}`);
    if (effects.length > 0) parts.push(effects.join(' '));
    lines.push(`      ${parts.join(' ')}`);
  }
  return lines.join('\n');
}

/** Convert a pattern into a JSON-friendly list of notes. */
function patternToJson(pattern: Pattern, frameRate: number): Record<string, unknown>[] {
  return [...pattern.notes]
    .sort((a, b) => noteTime(a) - noteTime(b))
    .map((note) => {
      const time = noteTime(note);
      const entry: Record<string, unknown> = {
        time,
        seconds: Number((time / frameRate).toFixed(5)),
        note:
          note.value === 0x00 ? 'stop' : note.value === 0x80 ? 'release' : valueToNoteName(note.value),
        value: note.value,
      };
      if (isMusicalNote(note.value)) {
        entry.duration = note.duration;
        if (note.release) entry.release = note.release;
        if (note.slide) entry.slide = valueToNoteName(note.slide);
        if (note.instrumentId !== -1) entry.instrumentId = note.instrumentId;
      }
      if (note.flags) entry.flags = note.flags;
      const effects = Object.fromEntries(
        Object.entries(note.effectValues).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(effects).length > 0) entry.effects = effects;
      if (note.arpeggioId !== -1) entry.arpeggioId = note.arpeggioId;
      return entry;
    });
}

/** Song -> JSON, optionally including note detail. */
function songToJson(song: Song, frameRate: number, includeNotes: boolean): Record<string, unknown> {
  return {
    id: song.id,
    name: song.name,
    patternLength: song.patternLength,
    songLength: song.songLength,
    beatLength: song.beatLength,
    noteLength: song.noteLength,
    groove: song.groove,
    loopPoint: song.loopPoint,
    totalTicks: songTotalTicks(song),
    durationSeconds: Number((songTotalTicks(song) / frameRate).toFixed(4)),
    channels: songChannels(song).map((channel) => ({
      channel: channel.name,
      type: channel.type,
      patternInstances: channel.patternInstances.slice(0, song.songLength),
      patterns: channel.patterns.map((pattern) => ({
        id: pattern.id,
        name: pattern.name,
        noteCount: pattern.notes.length,
        ...(includeNotes ? { notes: patternToJson(pattern, frameRate) } : {}),
      })),
    })),
  };
}

/** Stable key/value list of a note's effects, for comparison. */
function effectPairs(note: Note): [string, number][] {
  return Object.entries(note.effectValues)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as [string, number][];
}

/** Structural diff between two projects. */
function diffProjects(a: Project, b: Project, labelA: string, labelB: string): string[] {
  const differences: string[] = [];
  if (a.name !== b.name) differences.push(`name: "${a.name}" -> "${b.name}"`);
  if (a.pal !== b.pal) differences.push(`pal: ${a.pal} -> ${b.pal}`);
  if (a.tuning !== b.tuning) differences.push(`tuning: ${a.tuning} -> ${b.tuning}`);

  if (a.instruments.length !== b.instruments.length) {
    differences.push(`instruments: ${a.instruments.length} -> ${b.instruments.length}`);
  } else {
    for (let i = 0; i < a.instruments.length; i += 1) {
      if (a.instruments[i].name !== b.instruments[i].name) {
        differences.push(`instrument ${i}: "${a.instruments[i].name}" -> "${b.instruments[i].name}"`);
      }
    }
  }

  if (a.songs.length !== b.songs.length) differences.push(`songs: ${a.songs.length} -> ${b.songs.length}`);

  for (let i = 0; i < Math.min(a.songs.length, b.songs.length); i += 1) {
    const songA = a.songs[i];
    const songB = b.songs[i];
    const tag = `song ${i} ("${songA.name}")`;
    if (songA.name !== songB.name) differences.push(`${tag}: name -> "${songB.name}"`);
    for (const field of ['patternLength', 'songLength', 'beatLength', 'noteLength'] as const) {
      if (songA[field] !== songB[field]) differences.push(`${tag}: ${field} ${songA[field]} -> ${songB[field]}`);
    }
    if (songA.groove.join(',') !== songB.groove.join(',')) {
      differences.push(`${tag}: groove [${songA.groove}] -> [${songB.groove}]`);
    }

    const channelsA = songChannels(songA);
    const channelsB = songChannels(songB);
    for (let c = 0; c < 5; c += 1) {
      const label = channelsA[c].name;
      const totalA = channelsA[c].patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0);
      const totalB = channelsB[c].patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0);
      if (totalA !== totalB) {
        differences.push(`${tag} ${label}: ${totalA} -> ${totalB} note(s)`);
        continue;
      }
      if (channelsA[c].patterns.length !== channelsB[c].patterns.length) {
        differences.push(
          `${tag} ${label}: ${channelsA[c].patterns.length} -> ${channelsB[c].patterns.length} pattern(s)`,
        );
        continue;
      }
      for (let p = 0; p < channelsA[c].patterns.length; p += 1) {
        const notesA = [...channelsA[c].patterns[p].notes].sort((x, y) => noteTime(x) - noteTime(y));
        const notesB = [...channelsB[c].patterns[p].notes].sort((x, y) => noteTime(x) - noteTime(y));
        const patternName = channelsA[c].patterns[p].name;
        for (let n = 0; n < notesA.length; n += 1) {
          const left = notesA[n];
          const right = notesB[n];
          if (left.value !== right.value || noteTime(left) !== noteTime(right) || left.duration !== right.duration) {
            differences.push(
              `${tag} ${label} ${patternName} #${n}: ` +
                `${valueToNoteName(left.value)}@${noteTime(left)}/${left.duration} -> ` +
                `${valueToNoteName(right.value)}@${noteTime(right)}/${right.duration}`,
            );
          }
          const effectsA = JSON.stringify(effectPairs(left));
          const effectsB = JSON.stringify(effectPairs(right));
          if (effectsA !== effectsB) {
            differences.push(`${tag} ${label} ${patternName} #${n}: effects ${effectsA} -> ${effectsB}`);
          }
        }
      }
    }
  }

  return differences;
}

/** Register the inspection tools. */
export function registerInspectTools(registry: ToolRegistry): void {
  defineTool(registry, {
    name: 'read_fms',
    title: 'Read a .fms file',
    description:
      'Decode a FamiStudio project file into structured JSON: songs, channels, patterns and notes, plus ' +
      'instrument envelope contents. Set includeNotes=false for a structural overview of large projects. ' +
      'Only version 19 files (FamiStudio 4.5.x) can be read; older files must be re-saved by FamiStudio.',
    inputShape: {
      path: z.string().describe('Path to the .fms file.'),
      includeNotes: z.boolean().optional().describe('Include per-note detail (default true).'),
    },
    annotations: READ_ONLY,
    handler: async (args, context) => {
      const includeNotes = (args.includeNotes as boolean | undefined) ?? true;
      const { project, path: file } = await context.loadProjectFile(args.path as string);
      const frameRate = frameRateFor(project.pal);
      const summary = summarizeProject(project);

      return toToolResult({
        summary: `Read ${file}: ${project.songs.length} song(s), ${project.instruments.length} instrument(s)`,
        text: formatProjectSummary(summary),
        data: {
          path: file,
          pal: project.pal,
          tuning: project.tuning,
          instruments: project.instruments.map((instrument) => ({
            id: instrument.id,
            name: instrument.name,
            color: `0x${(instrument.color >>> 0).toString(16).padStart(8, '0')}`,
            envelopeMask: `0x${instrument.envelopeMask.toString(16).padStart(4, '0')}`,
            // Only the active slice is exposed; the full 256-slot array is an
            // on-disk detail the writer preserves internally.
            envelopes: instrument.envelopes.map((envelope, type) =>
              envelope
                ? {
                    type,
                    length: envelope.length,
                    loop: envelope.loop,
                    release: envelope.release,
                    relative: envelope.relative,
                    values: envelope.values.slice(0, Math.max(1, envelope.length)),
                  }
                : null,
            ),
          })),
          songs: project.songs.map((song) => songToJson(song, frameRate, includeNotes)),
          summary,
        },
        artifacts: [{ path: file }],
      });
    },
  });

  defineTool(registry, {
    name: 'summarize_fms',
    title: 'Summarize a .fms project',
    description:
      'Return a readable listing of a project: every song with its pattern order and per-pattern note ' +
      'dumps, plus tick totals and rendered duration. Use this to review what a .fms actually contains.',
    inputShape: {
      projectPath: z.string().optional(),
      project: projectPayloadSchema.optional(),
      maxPatternsPerChannel: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Cap the note dump at this many patterns per channel (default 8).'),
    },
    annotations: READ_ONLY,
    handler: async (args, context) => {
      const { project, label } = await resolveProject(context, {
        projectPath: args.projectPath as string | undefined,
        project: args.project,
      });
      const frameRate = frameRateFor(project.pal);
      const cap = (args.maxPatternsPerChannel as number | undefined) ?? 8;
      const summary = summarizeProject(project);

      const detail = project.songs
        .map((song) => {
          const lines = [`Song "${song.name}" (id ${song.id}):`];
          for (const channel of songChannels(song)) {
            if (channel.patterns.length === 0) continue;
            lines.push(
              `  ${channel.name}  order=[${channel.patternInstances
                .slice(0, song.songLength)
                .map((id) => (id === -1 ? '-' : channel.patterns.findIndex((p) => p.id === id)))
                .join(', ')}]`,
            );
            for (const pattern of channel.patterns.slice(0, cap)) lines.push(patternToText(pattern, frameRate));
            if (channel.patterns.length > cap) {
              lines.push(`    ... ${channel.patterns.length - cap} more pattern(s) not shown`);
            }
          }
          return lines.join('\n');
        })
        .join('\n\n');

      return toToolResult({
        summary: `${label}: ${project.songs.length} song(s)`,
        text: toolText(formatProjectSummary(summary), detail),
        data: { summary, project: label },
      });
    },
  });

  defineTool(registry, {
    name: 'diff_fms',
    title: 'Compare two projects',
    description:
      'Structurally compare two FamiStudio projects (files or inline objects) and list differences in ' +
      'metadata, instruments and per-note content. Use it to confirm that a rewrite did not change the ' +
      'musical content.',
    inputShape: {
      projectPathA: z.string().optional(),
      projectA: projectPayloadSchema.optional(),
      projectPathB: z.string().optional(),
      projectB: projectPayloadSchema.optional(),
    },
    annotations: READ_ONLY,
    handler: async (args, context) => {
      if ((!args.projectPathA && !args.projectA) || (!args.projectPathB && !args.projectB)) {
        throw new ToolError('Provide a side A and a side B, each as projectPath* or project*.');
      }
      const a = await resolveProject(context, {
        projectPath: args.projectPathA as string | undefined,
        project: args.projectA,
      });
      const b = await resolveProject(context, {
        projectPath: args.projectPathB as string | undefined,
        project: args.projectB,
      });
      const differences = diffProjects(a.project, b.project, a.label, b.label);
      return toToolResult({
        summary:
          differences.length === 0
            ? `${a.label} and ${b.label} are structurally identical`
            : `${differences.length} difference(s) between ${a.label} and ${b.label}`,
        text:
          differences.length === 0
            ? `No structural differences between ${a.label} and ${b.label}.`
            : differences.map((line) => `  ${line}`).join('\n'),
        data: { identical: differences.length === 0, differences },
      });
    },
  });
}

export { patternToJson, patternToText, songToJson, diffProjects };
