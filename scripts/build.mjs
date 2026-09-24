#!/usr/bin/env node
/**
 * Build script: bundles the executables with esbuild.
 *
 * By default runtime dependencies (@modelcontextprotocol/sdk, zod) are kept
 * EXTERNAL so `dist/index.js` stays a normal, debuggable Node ESM program that
 * resolves its deps from node_modules.
 *
 * Pass `--standalone` to inline every dependency into a single self-contained
 * file (useful for `bun build --compile` / shipping a single artifact).
 */
import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const standalone = process.argv.includes('--standalone');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  packages: standalone ? undefined : 'external',
  banner: {
    js: [
      "import { createRequire as __fsmcpCreateRequire } from 'node:module';",
      'const require = __fsmcpCreateRequire(import.meta.url);',
    ].join('\n'),
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, 'core'), { recursive: true });

const entries = [
  ['src/index.ts', 'dist/index.js'],
  ['src/cli.ts', 'dist/cli.js'],
  ['src/core/index.ts', 'dist/core/index.js'],
];

for (const [from, to] of entries) {
  await build({
    ...shared,
    entryPoints: [resolve(root, from)],
    outfile: resolve(root, to),
  });
}

console.error(`[build] ok (${standalone ? 'standalone' : 'external deps'}): ${entries.map((e) => e[1]).join(', ')}`);
