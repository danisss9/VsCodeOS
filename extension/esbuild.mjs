// Bundler for VsCodeOsCore.
//
// Two very different targets come out of one config:
//
//   src/extension.ts   -> dist/extension.js       Node/CJS, runs in the extension host
//   media/src/*.ts     -> media/dist/*.js         browser/IIFE, runs inside each webview
//
// Nothing is left in node_modules: the shipped extension is package.json, dist/
// and media/, which keeps the payload that goes into every image small.

import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// One entry point per page. Shared code lives in media/src/lib and is inlined
// into each bundle rather than emitted as a script of its own.
const webviewEntries = readdirSync(join(root, 'media', 'src'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(root, 'media', 'src', entry.name));

/** @type {import('esbuild').BuildOptions} */
const common = {
    bundle: true,
    minify: production,
    sourcemap: production ? false : 'inline',
    logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
    {
        ...common,
        entryPoints: [join(root, 'src', 'extension.ts')],
        outfile: join(root, 'dist', 'extension.js'),
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        // Supplied by the extension host at run time, never bundled.
        external: ['vscode'],
    },
    {
        ...common,
        entryPoints: webviewEntries,
        outdir: join(root, 'media', 'dist'),
        platform: 'browser',
        target: 'es2021',
        format: 'iife',
    },
];

if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching…');
} else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
}
