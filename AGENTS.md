# AGENTS.md

Agent-facing notes for `famistudio-mcp`. **This file is for coding agents.** Humans
should read [README.md](README.md) (usage) and [CONTRIBUTING.md](CONTRIBUTING.md)
(contribution process) instead.

The single most important fact about this repository: **the `.fms` byte layout is the
contract.** A change that passes the test suite but desynchronizes the payload produces
files that FamiStudio either refuses to open or crashes on. Read
[Non-negotiable invariants](#4-non-negotiable-invariants) before touching
`src/core/fms.ts`, `src/core/effects.ts` or `src/core/model.ts`.

---

## 1. Repository map

```
src/
  core/                 dependency-free toolkit (no MCP SDK, no zod) — exported as `famistudio-mcp/core`
    constants.ts        FMS_VERSION=19, magic, NTSC/PAL frame rates, channel + note enums, name<->value
    primitives.ts       ProjectBuffer: the byte-level reader/writer every other core module uses
    effects.ts          effect bit indices (`Note.EffectXxx`) + per-effect value widths
    model.ts            Project/Song/Channel/Pattern/Note/Instrument/Envelope types
    fms.ts              container read/write + `validateProject` (the format core)
    compiler.ts         JSON song spec -> Project
    report.ts           structural summary, pattern dump, project diff
    wav.ts              RIFF decode, peak/RMS/silence stats, autocorrelation pitch detection
    famistudio.ts       executable discovery + FamiStudio CLI argument building
    index.ts            public barrel; everything reachable from here is API
  mcp/
    shared.ts           ServerContext path policy, ProjectInput resolution, ToolError, toToolResult
    output-dir.ts       where generated files go: session cache, elicitation, roots, env fallback
    tools-project.ts    famistudio_info, compute_ticks, compile_song_spec, create_fms, validate_fms
    tools-inspect.ts    read_fms, summarize_fms, diff_fms
    tools-export.ts     export_audio, export_text, verify_roundtrip, analyze_audio, run_famistudio
  server.ts             tool registry, `defineTool`, `validateArgs`, stdio JSON-RPC server
  json-schema.ts        hand-rolled zod v3 -> JSON Schema converter (see §6)
  tools.ts              TOOL_NAMES + buildRegistry — the single source of truth for the tool surface
  index.ts              bin `famistudio-mcp`
  cli.ts                bin `famistudio-mcp-cli`
test/
  core.test.mjs         codec + DSL tests (no FamiStudio needed)
  mcp.test.mjs          spawns dist/index.js and drives real JSON-RPC over stdio
scripts/
  build.mjs             esbuild bundle -> dist/
  verify.mjs            end-to-end: compile, payload round-trip, FamiStudio text/WAV export
  oracle.mjs            decode+re-encode FamiStudio's own demo projects, require identical payload
  pitch-probe.mjs       pitch detection against synthetic tones
  inspect-fms.mjs       first differing byte between a file and its re-encode
  offsets.mjs           byte offset of every payload region (with `--notes`, every note)
docs/FMS_FORMAT.md      the authoritative byte-layout reference, as implemented
examples/snake-move.json
.github/workflows/ci.yml
README.md               human-facing usage docs (English)
README.zh-CN.md         the same in Simplified Chinese — keep the two in step
```

Artifacts (`dist/`) are generated. Never edit them by hand, never commit them.

---

## 2. Commands

Verified on Windows with Node 24 and bun 1.4.2; CI runs the same steps on Node 18/20/22.

**bun is this project's package manager.** `bun.lock` is the committed lockfile and CI
installs with `bun install --frozen-lockfile`, so run `bun install`. Do not commit a
`package-lock.json`. Because bun produces a standard `node_modules/`, the `npm run
<script>` invocations below work unchanged on a bun-installed tree — `npm` is only
genuinely required by end users installing the published tarball.

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies (`bun.lock`; CI uses `--frozen-lockfile`). |
| `npm run typecheck` | `tsc --noEmit`. Fast; run it first. |
| `npm run build` | esbuild bundle -> `dist/`. **Required before `npm test`.** |
| `npm test` | `node --test` — 48 tests, no FamiStudio required. |
| `npm run build:types` | Emit `.d.ts` declarations alongside `dist/`. |
| `npm run verify` | End-to-end: compile a spec, payload-round-trip real `.fms` files, then drive FamiStudio text + WAV export. |
| `npm run oracle` | Payload-identical round trip over FamiStudio's own demo projects. |
| `npm run pitch` | Pitch-detection accuracy on synthetic square/pulse/sine/triangle tones. |
| `npm pack --dry-run` | Check the published tarball contents. |

Focused dev commands:

```bash
node dist/index.js --version          # bin smoke test
node dist/index.js --tools            # print the tool list
node dist/cli.js info                 # FamiStudio discovery + version
node dist/cli.js compile examples/snake-move.json -o out/snake.fms
node dist/cli.js verify out/snake.fms # text + audio round trip, writes .verify-*.{txt,wav} in cwd
node scripts/inspect-fms.mjs <file.fms> [--dump]
node scripts/offsets.mjs <file.fms> [--notes]
npm run verify -- --fms-dir <dir> --out <dir>
npm run oracle -- --dir "<dir>" --limit 50
```

### Command gotchas

- **`npm test` tests `dist/`, not `src/`.** `test/core.test.mjs` imports
  `dist/core/index.js` and `test/mcp.test.mjs` spawns `dist/index.js`. Always
  `npm run build` before `npm test`, or you will test stale output. (`npm run
  prepublishOnly` chains build -> test -> verify for this reason.)
- `npm run verify` defaults `--fms-dir` to `D:\BANANA!! Assets`. Pass `--fms-dir`
  explicitly, or it fails with "sample directory not found". Artifacts land in
  `--out` (default `<tmp>/famistudio-mcp-verify`).
- `npm run oracle` defaults `--dir` to `C:\Program Files\FamiStudio\Demo Songs`.
  Most files there were written by older FamiStudio releases; the oracle reports those as
  *skipped* and only asserts on version-19 files, so it is safe to point at any directory.
- **`npm run verify --fms-dir` needs a directory of version-19 projects.** A legacy file is
  counted as a *failure* by `verify.mjs` (unlike `oracle.mjs`, which skips it), so pointing
  it at the stock demo folder reports ~30 failures even though the codec is fine — only
  `Mega Man 2.fms` there is version 19. Point it at your own re-saved projects, or use
  `npm run oracle` for the demo folder.
- **Never put a glob in the `test` script.** `node --test` only understands glob patterns
  from **Node 21**; CI covers 18/20/22, so `node --test "test/**/*.test.mjs"` dies on the
  two older jobs with `Could not find '.../test/**/*.test.mjs'` before running a single
  test. Bare `node --test` is the portable form: Node discovers test files itself, skipping
  `node_modules` and treating **every** `.js`/`.cjs`/`.mjs` under a `test/` directory as a
  test file. Passing a directory (`node --test test/`) does *not* work either — Node tries
  to load it as a module.
- `npm run pitch` and the FamiStudio half of `npm test` need a real FamiStudio
  install; set `FAMISTUDIO_EXE` if auto-discovery misses it. The FamiStudio-free
  core tests still pass without it.
- `test/mcp.test.mjs` spawns a child process with **piped stdio**. Confined
  sandboxes that forbid named pipes make it fail with `EPERM`; run the suite in an
  unsandboxed shell.

---

## 3. Change checklist

Do this before claiming any task is done:

1. `npm run typecheck && npm run build && npm test` — all green.
2. If you touched `src/core/fms.ts`, `src/core/effects.ts`, `src/core/primitives.ts`
   or `src/core/model.ts`: **also** run `npm run oracle` and
   `npm run verify -- --fms-dir <a real project dir>`, and update
   [docs/FMS_FORMAT.md](docs/FMS_FORMAT.md) in the same change.
3. If you added or renamed a tool: update `TOOL_NAMES` in `src/tools.ts` **and** the
   `tools/list` assertion in `test/mcp.test.mjs`, then update the tool table in **both**
   README.md and README.zh-CN.md.
4. If you added a new desync trap: add it to the trap table in this file.
5. Add a `CHANGELOG.md` entry under an `Unreleased` heading for anything notable.
6. Do not commit `dist/`, `node_modules/`, or any generated audio (`.wav`, `.mp3`,
   `.ogg`, `.nsf`, `tmp-*`, `.verify-*` are gitignored — keep it that way).

---

## 4. Non-negotiable invariants

These are the traps that make a `.fms` file fail *silently or catastrophically*. Each
one has burned this project at least once. Full byte layout: [docs/FMS_FORMAT.md](docs/FMS_FORMAT.md).

| Invariant | If violated |
|---|---|
| A regular (2A03) instrument must declare all four envelopes — Volume, Arpeggio, Pitch, DutyCycle (`REGULAR_ENVELOPE_MASK = 0x000f`), plus the v15+ DPCM mapping count | The FamiStudio **GUI crashes on open** (DEBUG assertion; release build dereferences a null envelope) |
| Effect **bit indices** follow `Note.EffectXxx`, **not** the serialization order | "Project file appears to be corrupted" — the byte stream desynchronizes, but only for specific effects |
| Every note effect has its own integer width (`u8` / `sbyte` / `u16`), never `int` | The same desync |
| Envelope value arrays are always **256 bytes**, including past `length` | Payload mismatch on re-encode; FamiStudio reads uninitialized data |
| The 12 export configs are written with Music/Sfx **alternating** | Field desync: `Tuning="-1"`, `VolumeDb="NaN"` |
| `patternInstances` is always **256** ints | Truncated patterns on load |
| Note ticks are a normal model field | The project will not survive JSON serialization through an MCP client |

Other standing constraints:

- **Version 19 only** (= FamiStudio 4.5.x). Reading versions 10–18 is deliberately
  unsupported; generation is unaffected.
- **Plain 2A03 only.** No expansion audio (VRC6/FDS/N163/S5B/VRC7/EPSM). DPCM sample
  payloads in an existing project are preserved byte-for-byte but cannot be authored.
- **The container is raw DEFLATE and its bytes are not reproducible.** FamiStudio's own
  deflate stream differs even for identical input. Correctness is defined as the
  *uncompressed payload* matching, which is exactly what `verify.mjs` and `oracle.mjs`
  assert. Never write a test that demands byte-identical containers.
- **Note spelling is FamiStudio's**: its `"C4"` (value 49) sounds at 523.25 Hz, one
  octave above scientific pitch. Do not "fix" this; `analyze_audio` reports names in
  the same system, and the whole DSL is calibrated to it.

---

## 5. Adding or changing a tool

1. `defineTool(registry, { name, title, description, inputShape, annotations, handler })`
   in the matching `src/mcp/tools-*.ts`.
2. Add the name to `TOOL_NAMES` in `src/tools.ts` (registration order matters — the
   protocol test asserts the exact list).
3. Write `description` for a model that has not read the source: say what it does, what
   is required, and what it returns. Tool descriptions **are** the public contract.
4. Return `toToolResult({ summary, text, data, artifacts })` so the result is both
   readable and machine-parseable. Reuse `READ_ONLY` / `WRITES_FILES` for annotations.
5. Throw `ToolError` for user-facing problems — the server converts those to `isError`
   results. Reserve plain `Error` for genuine bugs.
6. Route every caller-supplied path through `ServerContext.resolveReadPath(path)` or
   `await ServerContext.resolveWritePath(path)` — see §7. Never touch the filesystem
   directly with a client-supplied path.
7. Add a test in `test/mcp.test.mjs` that calls the tool over real JSON-RPC.

For the CLI (`src/cli.ts`): options are parsed with `node:util` `parseArgs`; add the
command to `USAGE` and to the `switch`. The CLI bypasses the MCP path policy — it is a
local developer tool and is expected to touch arbitrary paths.

---

## 6. Code style and structural gotchas

- TypeScript `strict`, ESM, `NodeNext` — **relative imports must carry the `.js`
  extension** (`./server.js`), even from a `.ts` file.
- Prefer explicit parameter and return types in `src/core` and `src/mcp`. Zod schemas are
  plain shapes validated by `validateArgs`.
- **Avoid deep generic inference over Zod schemas.** It previously made `tsc` exhaust
  several gigabytes of heap. That is why `src/mcp/shared.ts` types inline projects with
  `z.custom` (`projectPayloadSchema`) instead of `z.record(z.unknown())`: the loose record
  makes the MCP SDK's `ShapeOutput` mapping blow up.
- `src/json-schema.ts` is a hand-written zod v3 -> JSON Schema converter, because the
  SDK's converter needs zod v4 and a second copy of zod is not worth it. It **throws**
  on unsupported constructs rather than emitting `{}`. If a tool schema starts using a
  new zod feature, extend the converter — do not let it emit a silently empty schema.
- **On the server, stdout is JSON-RPC and nothing else.** All diagnostics, banners and
  errors go to `stderr` (see `src/index.ts`). A stray `console.log` corrupts the
  protocol stream and breaks the client.
- `scripts/build.mjs` injects a `createRequire` banner because some bundled dependencies
  use `require`. Keep it when editing the build. `--standalone` inlines all
  dependencies for `bun build --compile`.
- Comments should explain **why**, especially where the format is counter-intuitive
  ("FamiStudio writes bytes where you expect ints" is worth a comment; "increment i" is
  not).

---

## 7. Path policy and the output directory (`src/mcp/shared.ts`, `src/mcp/output-dir.ts`)

**This server does not decide where output belongs.** The caller does. Every change here
must preserve that; if you find yourself adding a heuristic that picks a location, stop.

Reads go through `ServerContext.resolveReadPath(path)`:

- Relative paths resolve against the current session output directory.
- Absolute paths are accepted only inside a configured read root (`FAMISTUDIO_MCP_*`,
  plus the session output directory), so a misbehaving client cannot use the server to
  read arbitrary files.

Writes go through `await ServerContext.resolveWritePath(path)`:

- **Absolute paths are used exactly as given.** Naming an absolute path *is* the caller's
  decision; refusing it would mean the server deciding instead. Do not re-add a
  containment check for absolute paths.
- Relative paths land inside the session output directory and may not climb out with
  `..`. That containment check is the only remaining guard — keep it.

The session output directory is resolved once per process by `OutputDirResolver`
(`src/mcp/output-dir.ts`), first source wins:

1. an absolute path on the tool call
2. the session cache
3. an **elicitation** prompt, pre-filled with `<workspace>/audio/famistudio`
4. `FAMISTUDIO_MCP_OUTDIR` / `FAMISTUDIO_MCP_WORKSPACE` (also what a declined prompt falls
   back to)
5. `<workspace>/audio/famistudio`
6. `<tmp>/famistudio-mcp`

Related rules:

- **Nothing is persisted.** There is deliberately no `.famistudio-mcp.json` and no
  `.gitignore` editing: the server must not mutate a user's workspace. The chosen
  directory lives in `OutputDirResolver` for the life of the process.
- Instead, `ServerContext.consumeAgentHint()` hands the calling agent a one-shot
  `agentHint` telling it to record the directory in the workspace's own
  `AGENTS.md`/`CLAUDE.md`. `server.ts` attaches it to the result. It must fire **once per
  session** — `hintEmitted` exists precisely because `resolution.asked` stays true forever
  and would otherwise re-emit on every call.
- The workspace root comes from the MCP `roots` capability when the client offers it,
  otherwise `process.cwd()` **only if it looks like a project** (`looksLikeProjectDirectory`
  in `output-dir.ts`). There is deliberately no upward walk: guessing a workspace is a
  decision this server should not make.
- `elicitation` and `roots` are client capabilities: always check
  `server.getClientCapabilities()` before `elicitInput` / `listRoots`, and degrade
  silently when absent or when the request fails.
- List separators are platform-dependent: on Windows `;` or `,` (never `:`, which is part
  of every drive letter); on POSIX `;`, `:`, or `,`.
- `test/mcp.test.mjs` pins all of this: absolute paths honoured, `..` refused, prompt
  asked once and cached, decline falling back to the workspace default, and no prompt at
  all for a client without the capability. Update those tests deliberately, not to make a
  failure go away.

---

## 8. Debugging a desync

`Project file appears to be corrupted` / `Tuning="-1"` / `VolumeDb="NaN"` almost always
means the payload layout drifted out of sync with FamiStudio 4.5.x.

1. `node scripts/inspect-fms.mjs <file.fms>` — dumps the decoded structure and the first
   byte where a re-encode diverges.
2. `node scripts/offsets.mjs <file.fms> --notes` — byte offset of every payload region
   and every note. Far faster than a raw diff for localizing a layout bug to one field.
3. Compare against the section of [docs/FMS_FORMAT.md](docs/FMS_FORMAT.md) that covers the
   region the offset falls in.
4. `npm run oracle` — if a demo project mismatches, its report prints the first differing
   offset plus an effect census and hex context on both sides.
5. `npm run verify` — compiles a spec and feeds the result through FamiStudio's text and
   WAV exporters; a desync shows up as the `Tuning="-1"` / `VolumeDb="NaN"` markers.

`scripts/verify.mjs` writes `FAILED-<name>` payload dumps into its `--out` directory when a
round trip mismatches.

---

## 9. Environment notes for this checkout

- Windows. FamiStudio 4.5.3 is installed at
  `C:\Program Files\FamiStudio\FamiStudio.exe` and is auto-discovered; `FAMISTUDIO_EXE`
  is normally unset.
- Verified with Node 24.20.0 and bun 1.4.2; the published bundle targets Node >= 18.
- Remote: `https://github.com/btdt/FamiStudio-mcp`, default branch `main`. CI
  (`.github/workflows/ci.yml`) runs on every push and pull request across Node 18/20/22.
