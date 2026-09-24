# famistudio-mcp

**English** | [简体中文](README.zh-CN.md)

> **Model Context Protocol server for [FamiStudio](https://famistudio.org).**
> Generate, inspect, validate and render NES `.fms` projects from plain JSON — no
> GUI, no manual format wrangling.

```
compile_song_spec  ──▶  create_fms  ──▶  validate_fms  ──▶  verify_roundtrip  ──▶  export_audio
   JSON notes           .fms file         invariants        FamiStudio agrees       .wav
```

FamiStudio's command line can *read* `.fms`, `.txt`, `.ftm` and `.nsf`, but it has no
`fms-export` command — writing the binary format is the only supported way to *produce*
a `.fms` from a script. `famistudio-mcp` does that the same way FamiStudio 4.5.x does,
validates every load invariant before writing, and proves the result by feeding it back
to FamiStudio.

---

## Quick start

Nothing to install — point your MCP host at the published package:

```jsonc
// Claude Desktop / Cursor / any MCP client that spawns a command
{
  "mcpServers": {
    "famistudio": {
      "command": "npx",
      "args": ["-y", "famistudio-mcp"],
      // Optional fallback; see "Where generated files go" below. If your client can
      // prompt, you will be asked once and can pick a directory per project instead.
      "env": { "FAMISTUDIO_MCP_OUTDIR": "/absolute/path/to/your/audio-work" }
    }
  }
}
```

Bun users can swap the command:

```jsonc
{ "command": "bunx", "args": ["famistudio-mcp"] }
```

Then ask your agent for what you want:

> Build me a 2-second snake-move blip: a bright Square1 arpeggio, a low Triangle pulse
> underneath, and a noise tick. Write it to `D:/Game Assets/snake_move.fms`, verify
> FamiStudio can load it, and render a 44100 Hz WAV next to it.

### Without an MCP host

The same engine ships as a CLI, which is handy for scripts and CI:

```bash
npx -y famistudio-mcp-cli info
npx -y famistudio-mcp-cli compile examples/snake-move.json -o out/snake.fms
npx -y famistudio-mcp-cli verify out/snake.fms
npx -y famistudio-mcp-cli export out/snake.fms out/snake.wav --rate 44100
npx -y famistudio-mcp-cli analyze out/snake.wav --pitch
```

### As a library

```bash
npm install famistudio-mcp
```

```ts
import { compileSongSpec, writeFms, readProject } from 'famistudio-mcp/core';
import { writeFile } from 'node:fs/promises';

const { project } = compileSongSpec({
  name: 'Blip',
  patternLength: 16,
  channels: [
    { channel: 'Square1', notes: [{ time: 0, note: 'C4', duration: 8 }, { time: 8, note: 'stop' }] },
    { channel: 'Triangle', notes: [{ time: 0, note: 'C1', duration: 16 }] },
  ],
});

await writeFile('blip.fms', writeFms(project));
console.log(readProject(writeFms(project)).songs[0].name); // "Blip"
```

---

## Tools

| Tool | Purpose |
|---|---|
| `famistudio_info` | Locate the FamiStudio executable, report its version and the allowed read/write roots |
| `compute_ticks` | Convert between seconds and ticks (`seconds = ticks / 60.0988` NTSC) |
| `compile_song_spec` | Compile a JSON song spec into a complete project object, optionally writing a `.fms` |
| `create_fms` | Same, but always writes a file |
| `validate_fms` | Check every FamiStudio load invariant and list the problems |
| `read_fms` | Decode a `.fms` into structured JSON (songs, channels, patterns, notes, envelopes) |
| `summarize_fms` | Human-readable listing of a project with per-pattern note dumps |
| `diff_fms` | Structural diff of two projects |
| `verify_roundtrip` | Round-trip through FamiStudio: text export + WAV render, checking for desync and silence |
| `export_audio` | Render WAV / MP3 / OGG via the FamiStudio CLI |
| `export_text` | FamiStudio text, FamiTracker text, or sound-engine assembly |
| `analyze_audio` | WAV duration, peak/RMS, silence and pitch detection |
| `run_famistudio` | Escape hatch for any other FamiStudio CLI command (NSF, ROM, ...) |

### Recommended agent workflow

1. `compute_ticks` — decide the tick budget for the sound you want.
2. `compile_song_spec` — build the notes.
3. `create_fms` — write the file (or pass the returned `project` straight on).
4. `verify_roundtrip` — prove FamiStudio loads it and produces audio.
5. `export_audio` — render the `.wav` for your game.
6. `analyze_audio` — confirm duration and pitch, e.g. with `separateChannels`.

`verify_roundtrip`'s `expectDurationSeconds` compares the **audible** length (first to
last sounding frame), not the pattern length, so only pass it when you know when the
sound stops.

---

## The song spec

A spec is a project with one or more songs made of per-channel note tracks.

```jsonc
{
  "name": "Snake Move",
  "author": "you",
  "patternLength": 32,        // ticks per pattern (default 128)
  "noteLength": 4,            // default note length in ticks (default 8)
  "instruments": [
    { "name": "Blip", "volume": [15, 14, 12, 10, 8, 6, 4, 2, 0], "dutyCycle": [2] }
  ],
  "channels": [
    {
      "channel": "Square1",
      "notes": [
        { "time": 0, "note": "C4", "duration": 4 },
        { "time": 4, "note": "E4", "duration": 4, "volume": 12 },
        { "time": 8, "note": "G4", "duration": 8, "effects": { "dutyCycle": 1, "vibrato": 194 } },
        { "time": 16, "note": "stop" }
      ]
    },
    { "channel": "Triangle", "notes": [{ "time": 0, "note": "C1", "duration": 16 }] },
    { "channel": "Noise",    "notes": [["C4", null, null, null]] },
    { "channel": "Square2",  "patterns": [ /* pattern 0 */, /* pattern 1 */ ] }
  ]
}
```

Channel names accept aliases: `Square1`/`sq1`/`pulse1`, `Square2`/`sq2`/`pulse2`,
`Triangle`/`tri`, `Noise`, `DPCM`/`dmc`, or the indices `0..4`. Omitted channels are
emitted empty, as FamiStudio requires all five.

### Two ways to write notes

**Absolute time** — a list of note objects; `time` may be omitted to continue from the
previous note:

```jsonc
"notes": [ { "time": 0, "note": "C4", "duration": 8 }, { "time": 8, "note": "E4" } ]
```

**Tick grid** — one entry per tick; an entry may be a note name, a raw note value, a
note object, an array of those (a chord), or `null` for an empty cell. A note without
an explicit `duration` sustains until the next distinct cell, or uses `noteLength` if
nothing follows:

```jsonc
"notes": [ "C4", null, null, null, ["E4", "G4"], null, null, null ]
```

Accepted note spellings: names (`"C4"`, `"F#3"`, `"Bb2"`), `"stop"`/`0`,
`"release"`/`128`, and raw values `1..96` for C0..B7.

### Per-note effects

| Key | Range | Notes |
|---|---|---|
| `volume` | 0..15 | Volume override |
| `vibrato` | packed | `speed << 4 \| depth` (speed 0..12, depth 0..15) |
| `speed` | 0..255 | Fxx |
| `finePitch` | -128..127 | Pxx |
| `dutyCycle` | 0..3 | Vxx, Square channels only |
| `noteDelay` | 0..31 | Gxx |
| `cutDelay` | 0..31 | Sxx |
| `fdsModSpeed` / `fdsModDepth` | 0..4095 / 0..63 | expansion only |
| `volumeSlide` | 0..15 | requires `volume` to be set too |
| `dmcCounter` | 0..127 | DPCM channel |
| `phaseReset` | 0..1 | |
| `envPeriod` | 0..65535 | |

### Pitch conventions (important)

FamiStudio spells note names **one octave above standard pitch**: its `"C4"` sounds at
523.25 Hz. On top of that, the NES **Triangle channel sounds one octave lower** than
its note value because of the hardware divider. Practical consequences:

- Write melodies one octave below the pitch you hear in a tracker.
- Triangle bass lines do **not** need an extra octave shift.
- `analyze_audio` reports names in the same system, so a spec note `"C4"` is detected
  as `C4`.

### Timing

With a uniform groove one tick is one frame, so `seconds = ticks / frameRate`
(60.0988 NTSC, 50.007 PAL). A `patternLength` of 128 at `songLength` 1 is therefore
about 2.13 seconds.

---

## Where generated files go

The server does not decide this — you or your agent do. The first source that applies wins:

| # | Source | Notes |
|---|---|---|
| 1 | An **absolute path on the tool call** | `outputPath`, or `workDir` for `verify_roundtrip` |
| 2 | The session's remembered choice | set by an earlier prompt in the same session |
| 3 | An **elicitation prompt** | asked once, pre-filled with `<workspace>/audio/famistudio` |
| 4 | `FAMISTUDIO_MCP_OUTDIR` / `_WORKSPACE` | used when you decline the prompt, or when the client cannot prompt at all |
| 5 | `<workspace>/audio/famistudio` | when there is no env and no prompt |
| 6 | `<tmp>/famistudio-mcp` | last resort |

A **relative** path resolves inside the current output directory and cannot climb out with
`..`. An **absolute** path is used exactly as given — naming a path is your decision, so the
server does not second-guess it. Reads are still policed: an absolute read path outside the
configured roots is refused.

**Nothing is written to disk to remember a choice** — it lives for the session only. When you
answer the prompt, the result carries a hint asking your agent to record the directory in
that workspace's `AGENTS.md` (or `CLAUDE.md`) and to pass it explicitly from then on. That is
what makes the choice stick across sessions without the server touching your files.

Workspace detection uses the MCP `roots` capability when your client provides one, otherwise
the server's working directory when it looks like a project.

## Configuration

| Variable | Meaning |
|---|---|
| `FAMISTUDIO_EXE` | Full path to the FamiStudio binary. Otherwise common install locations and `PATH` are probed, so normally you do **not** need this — set it for a portable build, a custom location, or to pin one of several versions. |
| `FAMISTUDIO_MCP_OUTDIR` | Output directory, used when you decline the prompt (and whenever the client cannot prompt at all). Defaults to `<tmp>/famistudio-mcp`. |
| `FAMISTUDIO_MCP_READDIRS` | Extra directories the server may read project files from. |
| `FAMISTUDIO_MCP_WORKSPACE` | Single-directory shorthand for both of the above. |

Separate multiple directories with `;` (or `,`) on Windows, or `;`/`:` on POSIX.

FamiStudio itself is only needed for `export_audio`, `export_text`, `verify_roundtrip`,
`run_famistudio` and the version line of `famistudio_info`. Generating, reading,
validating and diffing projects works without it.

---

## Compatibility

- **Writes and reads** FamiStudio **4.5.x** project files: serialization version **19**.
- Reading older files (versions 10–18) is **not** supported; open and re-save them in
  FamiStudio to upgrade them. Generation is unaffected.
- Plain **2A03 only** (no expansion audio: VRC6, FDS, N163, S5B, VRC7, EPSM). DPCM
  samples in an existing project are preserved byte-for-byte but cannot be authored.
- The container uses `zlib` raw deflate by design, and a re-encoded container can differ
  byte-for-byte from the original while the decompressed payload is identical.

---

## Documentation

- [`docs/FMS_FORMAT.md`](docs/FMS_FORMAT.md) — the `.fms` container and payload layout as
  implemented, derived from the FamiStudio 4.5.x sources.
- [`AGENTS.md`](AGENTS.md) — build/test/verify commands, architecture notes and the
  format invariants that must not be broken. For coding agents and contributors.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute.
- [`CHANGELOG.md`](CHANGELOG.md) — release history.
- [github.com/btdt/FamiStudio-mcp](https://github.com/btdt/FamiStudio-mcp) — source,
  issues and releases.

---

## License

MIT — see [LICENSE](LICENSE).

FamiStudio itself is a separate project by Mathieu Gauthier-Pilote, licensed under the
MIT license; this server only reads and writes its file format and drives its command
line.
