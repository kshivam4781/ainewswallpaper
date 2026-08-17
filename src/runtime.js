'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOME_DIR, ensureDirs } = require('./config');

/**
 * Bridges the two ways this tool runs:
 *
 *   dev / npm   node bin/cli.js ...      render.ps1 sits next to this file
 *   packed exe  ai-news-wallpaper.exe    render.ps1 is an embedded SEA asset
 *
 * Everything that touches the filesystem layout or spawns the tool again
 * (the scheduled task) has to go through here.
 */

let seaApi = null;
try {
  // Present from Node 20 on; absent on older runtimes, which is fine.
  seaApi = require('node:sea');
} catch { /* not a SEA-capable runtime */ }

function isSea() {
  try {
    return Boolean(seaApi && seaApi.isSea());
  } catch {
    return false;
  }
}

/**
 * Returns a real path to render.ps1. Inside a packed executable the script is
 * unpacked next to the config, keyed by content hash so an upgraded binary
 * writes a fresh copy instead of reusing a stale one.
 */
function renderScriptPath() {
  const onDisk = path.join(__dirname, 'render.ps1');
  if (!isSea()) return onDisk;

  const source = seaApi.getAsset('render.ps1', 'utf8');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
  const target = path.join(HOME_DIR, `render-${hash}.ps1`);

  if (!fs.existsSync(target)) {
    ensureDirs();
    // ASCII only by contract - see the header of render.ps1.
    fs.writeFileSync(target, source, { encoding: 'ascii' });
    pruneOldScripts(target);
  }
  return target;
}

function pruneOldScripts(keep) {
  try {
    for (const name of fs.readdirSync(HOME_DIR)) {
      if (!/^render-[0-9a-f]{12}\.ps1$/.test(name)) continue;
      const full = path.join(HOME_DIR, name);
      if (full !== keep) {
        try { fs.unlinkSync(full); } catch { /* in use, leave it */ }
      }
    }
  } catch { /* nothing to prune */ }
}

/**
 * How to invoke this tool again from the Windows scheduled task. A packed
 * executable calls itself; a source checkout needs node plus the CLI entry.
 * Returned as a ready-to-quote argv array.
 */
function relaunchArgv(args = ['update', '--quiet']) {
  if (isSea()) return [process.execPath, ...args];
  return [process.execPath, path.join(__dirname, '..', 'bin', 'cli.js'), ...args];
}

/** Human-readable, for `status`. */
function runtimeLabel() {
  return isSea() ? 'packaged executable' : 'node (source)';
}

module.exports = { isSea, renderScriptPath, relaunchArgv, runtimeLabel };
