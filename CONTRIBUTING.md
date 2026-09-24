# Contributing

Thanks for helping improve `famistudio-mcp`. This project writes a binary file format
that another program has to accept, so a few rules matter more here than usual.

[`AGENTS.md`](AGENTS.md) is the technical reference: repository map, the full command
list, the format invariants and the desync-debugging playbook. This file covers the
human contribution process. Where the two overlap, AGENTS.md wins.

## Getting started

`bun` is the package manager: `bun.lock` is committed and CI installs with
`bun install --frozen-lockfile`. Do not commit a `package-lock.json`.

```bash
git clone https://github.com/btdt/FamiStudio-mcp.git && cd FamiStudio-mcp
bun install          # bun.lock; the npm run <script> calls below work afterwards
npm run build        # esbuild bundle -> dist/
npm run typecheck
npm test             # codec, DSL and MCP protocol tests (no FamiStudio needed)
```

`npm test` runs against `dist/`, not `src/`, so build first.

The FamiStudio-backed checks need a local [FamiStudio](https://famistudio.org) 4.5.x
install (or `FAMISTUDIO_EXE` pointing at it), and cannot run in CI:

```bash
npm run verify       # compile a spec, round-trip real .fms files, render audio
npm run oracle       # round-trip FamiStudio's own demo projects
npm run pitch        # pitch-detection accuracy on synthetic tones
```

`npm run oracle -- --dir <somewhere>` points the oracle at a directory of your own
version-19 projects, which is the single most useful check when you touch
`src/core/fms.ts`. The full command list — including the `--fms-dir` default that trips
people up — is in [AGENTS.md §2](AGENTS.md#2-commands).

## The format is the contract

If you change anything in `src/core/fms.ts`, `src/core/effects.ts` or
`src/core/model.ts`, you are changing how bytes are laid out. Before opening a pull
request, confirm all of these:

1. `npm test` passes — in particular the `EffectBit` table test, which pins the effect
   bit indices to `Note.EffectXxx`.
2. `npm run oracle` reports payload-identical for every version-19 project it finds.
3. A freshly generated file loads in FamiStudio without
   `Project file appears to be corrupted`, and its text export contains no
   `Tuning="-1"` / `VolumeDb="NaN"`.

Useful diagnostics when something desyncs (`inspect-fms.mjs`, `offsets.mjs`, `oracle`,
`verify`) are listed in [AGENTS.md §8](AGENTS.md#8-debugging-a-desync).

`docs/FMS_FORMAT.md` is the reference for the layout; update it in the same change as
any format edit, and add the trap you hit to the invariant table in
[AGENTS.md §4](AGENTS.md#4-non-negotiable-invariants) if it is a new one.

## Code style

The authoritative list is in
[AGENTS.md §6](AGENTS.md#6-code-style-and-structural-gotchas). The load-bearing rules:

- TypeScript, `strict`, ESM with `.js` import specifiers (`NodeNext`).
- Prefer explicit parameter and return types in the core and the MCP layer: they keep
  `tsc` fast and the tool contracts readable. Avoid deep generic inference over Zod
  schemas — it is what previously made `tsc` exhaust several gigabytes of heap. Tool
  schemas are plain Zod shapes validated by `validateArgs`.
- Comments should explain *why*, especially where the file format is counter-intuitive.
  "FamiStudio writes bytes where you expect ints" is worth a comment; "increment i" is
  not.
- New tools go in the matching `src/mcp/tools-*.ts` module and must be added to
  `TOOL_NAMES` in `src/tools.ts`; the protocol test asserts the full tool list.

## Adding a tool

1. `defineTool(registry, { name, title, description, inputShape, annotations, handler })`.
2. Give the description enough context that a model can use it without reading the
   source — say what it does, what is required, and what it returns.
3. Return `toToolResult({ summary, text, data, artifacts })` so the result is both
   readable and machine-parseable.
4. Throw `ToolError` for user-facing problems; the server turns those into `isError`
   results with a readable message.
5. Add a test in `test/mcp.test.mjs` that calls it over real JSON-RPC.

## Commits and releases

- Keep commits focused, and describe the user-visible effect.
- Add an entry to `CHANGELOG.md` under an `Unreleased` heading for anything notable.
- Release with `npm version <patch|minor|major>`, which builds and runs the test suite
  via `prepublishOnly`, then `npm publish` and push the tag.

## License

By contributing you agree that your contributions are licensed under the MIT License,
as described in [LICENSE](LICENSE).
