#!/usr/bin/env node
/**
 * Builds the server for the runtime image.
 *
 * Bundles rather than compiling file-by-file, for one specific reason: the
 * workspace packages export their TypeScript sources (`@reharvest/core/crypto`
 * resolves to `src/crypto.ts`), so a plain `tsc` build produced JavaScript that
 * still imported `.ts` files at runtime and died on the first parameter
 * property. Bundling resolves those imports at build time and the output has no
 * TypeScript in it at all.
 *
 * The image therefore runs ordinary Node on ordinary JavaScript. Strip-only
 * execution is a development convenience; depending on it in production means
 * shipping a runtime that must parse types, with the failure modes that brings.
 *
 * Dependencies stay external — they are installed in the image from the
 * lockfile, which keeps native modules working and the bundle small.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

// Everything the lockfile installs is left external; only our own workspace
// code is bundled in.
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  'hono', '@hono/node-server', 'drizzle-orm', 'postgres', 'esbuild',
].filter((d) => !d.startsWith('@reharvest/'));

const result = await build({
  entryPoints: [resolve(root, 'apps/api/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(root, 'dist/server.js'),
  sourcemap: true,
  external,
  // Node's ESM loader needs these shims when a bundle uses CommonJS interop.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`\nBundled ${Math.round(bytes / 1024)} kB to dist/server.js`);
console.log(`External dependencies: ${external.length} (installed from the lockfile in the image)`);
