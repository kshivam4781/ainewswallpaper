#!/usr/bin/env node
/**
 * Builds a single self-contained ai-news-wallpaper.exe.
 *
 *   1. esbuild flattens bin/cli.js and every local require into one file
 *   2. Node's SEA config embeds that bundle plus render.ps1 as an asset
 *   3. postject injects the resulting blob into a copy of node.exe
 *
 * Run with:  npm run build:exe
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const NAME = 'ai-news-wallpaper';
const EXE = path.join(DIST, `${NAME}.exe`);
const BUNDLE = path.join(DIST, 'bundle.js');
const BLOB = path.join(DIST, 'sea-prep.blob');
const SEA_CONFIG = path.join(DIST, 'sea-config.json');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (n, msg) => console.log(`\n[${n}/5] ${msg}`);
const mb = (file) => `${(statSync(file).size / 1048576).toFixed(1)} MB`;

function run(cmd, args, label) {
  try {
    execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  } catch (err) {
    console.error(`\n${label} failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.platform !== 'win32') {
  console.error('This build produces a Windows executable and must run on Windows.');
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

step(1, 'Bundling with esbuild');
run(process.execPath, [
  path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.join(ROOT, 'bin', 'cli.js'),
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  '--minify',
  '--legal-comments=none',
  `--outfile=${BUNDLE}`
], 'esbuild');
console.log(`      bundle: ${mb(BUNDLE)}`);

step(2, 'Writing SEA config');
writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  // render.ps1 is read at runtime via require('node:sea').getAsset()
  assets: { 'render.ps1': path.join(ROOT, 'src', 'render.ps1') }
}, null, 2));

step(3, 'Generating the SEA blob');
run(process.execPath, ['--experimental-sea-config', SEA_CONFIG], 'sea-config');
console.log(`      blob: ${mb(BLOB)}`);

step(4, 'Copying the Node runtime');
copyFileSync(process.execPath, EXE);
console.log(`      base: ${mb(EXE)} (node ${process.version})`);

step(5, 'Injecting the blob');
run(process.execPath, [
  path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
  EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE
], 'postject');

if (!existsSync(EXE)) {
  console.error('\nNo executable was produced.');
  process.exit(1);
}

console.log(`\nBuilt ${EXE}  (${mb(EXE)})`);
console.log('\nSmoke test it with:');
console.log(`  ${path.relative(ROOT, EXE)} --version`);
console.log(`  ${path.relative(ROOT, EXE)} preview --out test.png`);
console.log('\nNote: the binary is unsigned, so SmartScreen will warn on first run.');
