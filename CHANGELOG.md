# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-25

First release.

### Added

- **`.fms` codec** for FamiStudio 4.5.x (serialization version 19): writer, reader and
  structural validator, covering the container header, raw-DEFLATE payload, the twelve
  export configs, instruments with their mandatory envelope set, arpeggios, songs,
  channels, patterns, notes with all thirteen effects, and verbatim preservation of DPCM
  sample payloads.
- **JSON song-spec compiler** with absolute-time and tick-grid note forms, chord cells,
  named instruments with envelope definitions, multi-song projects, PAL timing, groove
  and inference of `songLength` from track length.
- **Project reporting**: structural summaries, human-readable pattern dumps, and
  structural diffing of two projects.
- **FamiStudio CLI wrapper**: executable discovery, argument building for every export
  command, and typed results.
- **WAV analysis**: RIFF decoding, duration/peak/RMS/silence statistics, and
  autocorrelation pitch detection with octave-error correction, plus a
  name↔frequency mapping in FamiStudio's own note numbering.
- **MCP server** over stdio exposing 13 tools: `famistudio_info`, `compute_ticks`,
  `compile_song_spec`, `create_fms`, `validate_fms`, `read_fms`, `summarize_fms`,
  `diff_fms`, `export_audio`, `export_text`, `verify_roundtrip`, `analyze_audio` and
  `run_famistudio`.
- **CLI** (`famistudio-mcp-cli`) with `info`, `compile`, `read`, `validate`, `export`,
  `txt`, `verify` and `analyze` commands for use outside an MCP host.
- **Output-location contract**: the server never decides where generated files go; the
  caller does. The first source that applies wins — an absolute path on the tool call, the
  session's remembered choice, an **elicitation prompt** pre-filled with
  `<workspace>/audio/famistudio`, `FAMISTUDIO_MCP_OUTDIR`/`_WORKSPACE`, the workspace
  default, then the temp directory. Absolute paths are used exactly as given. Nothing is
  written to disk to remember a choice: instead the tool result carries a one-shot hint
  asking the calling agent to record the directory in the workspace's own
  `AGENTS.md`/`CLAUDE.md`. The workspace root comes from the client's MCP `roots`
  capability when it advertises one, otherwise from the working directory when it looks
  like a project. The server's `instructions` field documents this contract for the agent.
- **Path policy**: reads are restricted to the configured roots; writes accept explicit
  absolute paths, and a relative path cannot climb out of the session output directory
  with `..`.
- **Tests**: 48 tests covering the codec, the DSL and the MCP protocol end to end,
  including the path policy and the output-directory resolution; plus `npm run verify`
  (against a real FamiStudio install), `npm run oracle` (round-trips FamiStudio's own demo
  projects) and `npm run pitch`.
- **`AGENTS.md`**, an agent-facing reference covering the repository map, the command set
  with its gotchas, the `.fms` format invariants and a desync-debugging playbook.
  `README.md` is the human-facing usage document and `CONTRIBUTING.md` defers to
  `AGENTS.md` for the technical rules.
- **`README.zh-CN.md`**, a Simplified Chinese translation of the README, with a language
  switcher linking the two.

### Fixed

Found by round-tripping real projects and by feeding generated files back to FamiStudio —
this is why the format notes are so explicit:

- Note effect **bit indices** now match `Note.EffectXxx`, not the serialization order.
- Note effect **value widths** are per effect (`u8`/`sbyte`/`u16`), not `int`.
- Envelope value arrays preserve all 256 slots instead of zero-padding past `length`.
- Instrument serialization always writes the mandatory four-envelope mask and the
  DPCM mapping count.
- The twelve export configs are written in Music/Sfx-interleaved order.
- Note ticks are an ordinary model field, so a project survives JSON serialization
  through an MCP client.
- Grid-mode chord cells share one inferred duration, and bare numeric cells are accepted
  as raw note values with range checking.

Found by CI, on a platform other than the development machine:

- `frequencyToNote` returned `-0` for an exactly-tuned note whose `Math.log2` residual
  landed just below zero. `-0` is not `0` under `Object.is`, so it broke strict
  comparisons and leaked a surprising value from the public API. It only reproduced on
  Linux; Windows happened to compute `+0`. Cent offsets and the averaged cents in
  `detectPitches` are now normalised.
- `npm test` passed a glob pattern to `node --test`, which only understands globs from
  Node 21, so the Node 18 and Node 20 CI jobs failed before running a single test. The
  script now uses bare `node --test`, which discovers the files itself on every supported
  version.

[0.1.0]: https://github.com/btdt/FamiStudio-mcp/releases/tag/v0.1.0
