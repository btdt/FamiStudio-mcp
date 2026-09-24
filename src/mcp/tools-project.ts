/**
 * Project creation tools: `compile_song_spec`, `create_fms`, `validate_fms`.
 */
import { z } from 'zod';
import {
  EFFECT_ORDER,
  compileSongSpec,
  validateProject,
  type SongSpecDocument,
} from '../core/index.js';
import { defineTool, type ToolRegistry } from '../server.js';
import {
  READ_ONLY,
  WRITES_FILES,
  formatProjectSummary,
  projectPayloadSchema,
  resolveProject,
  summarizeProject,
  toToolResult,
  toolText,
} from './shared.js';

/**
 * Loose per-note effect map; the compiler checks effect names and ranges.
 *
 * Declared as a plain `z.record(z.number())` rather than an enum-keyed record so
 * that building the JSON Schema stays cheap.
 */
const effectRecord = z
  .record(z.number())
  .describe(`Per-note effects keyed by name. Known keys: ${EFFECT_ORDER.join(', ')}.`);

/**
 * One note, in any accepted form.
 *
 * The note object is loose on purpose: the compiler validates every field
 * semantically and reports precise errors.
 */
const noteSchema = z.union([
  z.null(),
  z.string().describe('Shorthand: a bare note name such as "C4".'),
  z
    .object({
      time: z.number().int().min(0).optional().describe('Absolute tick inside the pattern.'),
      note: z
        .union([z.string(), z.number().int()])
        .optional()
        .describe('e.g. "C4", "stop", "release", or a raw note value.'),
      value: z.union([z.string(), z.number().int()]).optional().describe('Alias of "note".'),
      duration: z.number().int().min(0).optional().describe('Length in ticks.'),
      durationSeconds: z.number().min(0).optional().describe('Length in seconds.'),
      instrument: z.union([z.string(), z.number().int()]).optional(),
      noAttack: z.boolean().optional().describe('Add the no-attack flag.'),
      slide: z.union([z.string(), z.number().int()]).optional(),
      release: z.number().int().min(0).optional(),
      volume: z.number().int().min(0).max(15).optional().describe('Shorthand for effects.volume.'),
      dutyCycle: z.number().int().min(0).max(3).optional().describe('Shorthand for effects.dutyCycle.'),
      arpeggio: z.union([z.string(), z.number().int()]).optional(),
      effects: effectRecord.optional(),
    })
    .describe('A note with explicit attributes.'),
]);

/** A track: absolute-time notes, or a tick grid (cells may hold several notes). */
const trackSchema = z.union([
  z.array(noteSchema),
  z.array(z.union([noteSchema, z.array(noteSchema)])),
]);

const channelSchema = z.object({
  channel: z
    .union([z.string(), z.number().int()])
    .describe('Square1 / Square2 / Triangle / Noise / DPCM (aliases: sq1, pulse1, tri, dmc, or 0..4).'),
  notes: trackSchema.optional().describe('Inline notes; becomes the channel first pattern.'),
  patterns: z.array(trackSchema).optional().describe('Explicit patterns, played in order.'),
  noteLength: z.number().int().min(1).optional().describe('Default note length in ticks for this channel.'),
  instrument: z.union([z.string(), z.number().int()]).optional(),
});

const instrumentSchema = z.object({
  name: z.string().min(1),
  color: z.number().int().optional().describe('ARGB color, e.g. 0xffbba868.'),
  volume: z.array(z.number().int().min(0).max(15)).optional().describe('Volume envelope, one value per tick.'),
  dutyCycle: z.array(z.number().int().min(0).max(3)).optional(),
  pitch: z.array(z.number().int()).optional().describe('Pitch envelope, signed semitone offsets.'),
  arpeggio: z.array(z.number().int()).optional(),
  loop: z.number().int().min(0).optional().describe('Loop point applied to every envelope.'),
});

const songSchema = z.object({
  name: z.string().optional(),
  patternLength: z.number().int().min(1).max(256).optional().describe('Ticks per pattern (default 128).'),
  songLength: z.number().int().min(1).max(256).optional().describe('Number of patterns played.'),
  beatLength: z.number().int().min(1).optional(),
  noteLength: z.number().int().min(1).optional().describe('Default note length in ticks (default 8).'),
  groove: z
    .union([z.number().int().min(1).max(255), z.array(z.number().int().min(1).max(255))])
    .optional()
    .describe('FamiStudio groove. A single value means one tick per frame.'),
  loopPoint: z.number().int().min(0).optional(),
  color: z.number().int().optional(),
  channels: z.array(channelSchema).optional(),
});

const specSchema = z
  .object({
    name: z.string().optional().describe('Project name; also the default song name.'),
    author: z.string().optional(),
    copyright: z.string().optional(),
    pal: z.boolean().optional().describe('PAL timing instead of NTSC.'),
    tuning: z.number().int().optional().describe('A4 tuning in Hz (default 440).'),
    patternLength: z.number().int().min(1).max(256).optional(),
    songLength: z.number().int().min(1).max(256).optional(),
    noteLength: z.number().int().min(1).optional(),
    groove: z.union([z.number().int().min(1).max(255), z.array(z.number().int().min(1).max(255))]).optional(),
    channels: z.array(channelSchema).optional().describe('Channels of the single implied song.'),
    song: songSchema.optional().describe('Single song, spelled out.'),
    songs: z.array(songSchema).optional().describe('Multiple songs.'),
    instruments: z
      .array(instrumentSchema)
      .optional()
      .describe('Instruments; a default "Lead" is created when omitted.'),
    defaultInstrument: z.string().optional(),
    truncate: z.boolean().optional().describe('Drop notes/patterns that overflow instead of failing.'),
  })
  .describe('Song specification: a project of one or more songs made of per-channel note tracks.');

const SPEC_HINT = [
  'Notes can be written two ways:',
  '  absolute: {"channel":"Square1","notes":[{"time":0,"note":"C4","duration":8},{"time":8,"note":"E4"}]}',
  '  grid:     {"channel":"Square1","notes":["C4",null,null,null,"E4"]}   // one entry per tick',
  'In grid form a note without "duration" sustains until the next filled cell.',
  'FamiStudio note names are one octave above standard pitch: its "C4" sounds ~523 Hz,',
  'so write melodies one octave below the pitch you hear in a tracker.',
].join('\n');

/** Register the project creation tools. */
export function registerProjectTools(registry: ToolRegistry): void {
  defineTool(registry, {
    name: 'compile_song_spec',
    title: 'Compile a song spec into a FamiStudio project',
    description:
      'Compile a compact JSON song specification (channels + notes) into a complete FamiStudio project ' +
      'object, optionally writing it to a .fms file. Object ids, the mandatory instrument envelope ' +
      'masks and the fixed 256-slot pattern tables are filled in automatically. The returned "project" ' +
      'can be passed straight to export_audio / verify_roundtrip / validate_fms.\n\n' +
      SPEC_HINT,
    inputShape: {
      spec: specSchema,
      outputPath: z
        .string()
        .optional()
        .describe('Where to write the .fms file; relative paths resolve inside the output directory.'),
    },
    annotations: WRITES_FILES,
    handler: async (args, context) => {
      const compiled = compileSongSpec(args.spec as SongSpecDocument);
      const outputPath = args.outputPath as string | undefined;
      const artifacts = outputPath ? [await context.saveProject(compiled.project, outputPath)] : [];
      const summary = summarizeProject(compiled.project);
      const warnings = compiled.warnings.filter((warning) => warning.code !== 'compiled');

      return toToolResult({
        summary: `Compiled "${compiled.project.name}" (${compiled.songs.length} song(s))${
          outputPath ? ` -> ${outputPath}` : ''
        }`,
        text: toolText(
          formatProjectSummary(summary),
          warnings.length > 0 ? `Warnings:\n${warnings.map((w) => `  ! ${w.message}`).join('\n')}` : '',
        ),
        data: {
          project: compiled.project,
          summary,
          songs: compiled.songs,
          warnings: compiled.warnings,
        },
        artifacts,
      });
    },
  });

  defineTool(registry, {
    name: 'create_fms',
    title: 'Write a FamiStudio .fms file from a song spec',
    description:
      'Convenience wrapper around compile_song_spec that always writes a .fms file and returns its path ' +
      'plus a structural summary. Use this when the goal is a file on disk.',
    inputShape: {
      spec: specSchema,
      outputPath: z.string().describe('Destination path, e.g. "BGM_battle.fms".'),
    },
    annotations: WRITES_FILES,
    handler: async (args, context) => {
      const compiled = compileSongSpec(args.spec as SongSpecDocument);
      const artifact = await context.saveProject(compiled.project, args.outputPath as string);
      const summary = summarizeProject(compiled.project);
      return toToolResult({
        summary: `Wrote ${artifact.path} (${artifact.bytes ?? 0} bytes, ${compiled.songs.length} song(s))`,
        text: formatProjectSummary(summary),
        data: { project: compiled.project, summary, songs: compiled.songs, warnings: compiled.warnings },
        artifacts: [artifact],
      });
    },
  });

  defineTool(registry, {
    name: 'validate_fms',
    title: 'Validate a project against FamiStudio rules',
    description:
      'Check every invariant FamiStudio relies on when loading a project: the mandatory four-envelope ' +
      'instrument masks, the DPCM mapping count, unique object ids, nextUniqueId, reference integrity, ' +
      'note ranges and effect ranges, and the fixed 256-entry pattern tables. Returns the list of problems.',
    inputShape: {
      projectPath: z.string().optional().describe('Path to a .fms file.'),
      project: projectPayloadSchema.optional().describe('Inline project (from compile_song_spec).'),
    },
    annotations: READ_ONLY,
    handler: async (args, context) => {
      const { project, label } = await resolveProject(context, {
        projectPath: args.projectPath as string | undefined,
        project: args.project,
      });
      const problems = validateProject(project);
      const summary = summarizeProject(project);
      return toToolResult({
        summary: problems.length === 0 ? `${label}: valid` : `${label}: ${problems.length} problem(s)`,
        text: toolText(
          problems.length === 0
            ? `${label} is valid.`
            : `${label} has ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
          formatProjectSummary(summary),
        ),
        data: { valid: problems.length === 0, problems, project: label },
      });
    },
  });
}
