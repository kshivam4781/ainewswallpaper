'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { HOME_DIR, ensureDirs } = require('./config');
const { renderScriptPath } = require('./runtime');

const CACHE_PATH = path.join(HOME_DIR, 'screens.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const bundled = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(bundled) ? bundled : 'powershell.exe';
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', renderScriptPath(), ...args],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message).toString().trim()));
        resolve(stdout.toString());
      }
    );
  });
}

/**
 * The attached displays, newest first in Windows' own order.
 * @returns {Promise<{perMonitor: boolean, monitors: Array}>}
 */
async function detectScreens({ fresh = false } = {}) {
  if (!fresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (Date.now() - cached.at < CACHE_TTL_MS && Array.isArray(cached.monitors)) return cached;
    } catch { /* no usable cache */ }
  }

  let result;
  try {
    const out = await runScript(['-Detect']);
    const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('{'));
    result = JSON.parse(line);
  } catch (err) {
    // Never let display detection break a refresh.
    result = { perMonitor: false, monitors: [{ id: '', x: 0, y: 0, width: 0, height: 0, primary: true }], error: err.message };
  }

  // Primary first, then left-to-right.
  result.monitors.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.x - b.x);
  const payload = { ...result, at: Date.now() };
  try {
    ensureDirs();
    fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch { /* cache is optional */ }
  return payload;
}

async function applyWallpaper(imagePath, monitorId) {
  const args = ['-ApplyPath', imagePath];
  if (monitorId) args.push('-MonitorId', monitorId);
  const out = await runScript(args);
  if (!out.includes('APPLY_OK')) throw new Error(`Could not set the wallpaper: ${out.trim() || '(no output)'}`);
}

/**
 * Decides what each screen shows.
 *
 * One screen keeps everything together. With more, the content splits up so no
 * screen has to squeeze: headlines get their own display, and the panels spread
 * across the rest. Extra screens beyond the available content show a second
 * page of headlines rather than a duplicate.
 *
 * @returns {Array<{monitor: object, role: string, index: number}>}
 */
function planScreens(monitors, { hasRepos = false, hasBrief = false, mode = 'auto', assign = [] } = {}) {
  const screens = monitors.length ? monitors : [{ id: '', width: 0, height: 0, primary: true }];

  if (mode === 'single' || screens.length === 1) {
    return [{ monitor: screens[0], role: 'all', index: 0 }];
  }
  if (mode === 'mirror') {
    return screens.map((monitor, index) => ({ monitor, role: 'all', index }));
  }

  // Explicit override, e.g. ["news", "today", "tools"].
  if (assign.length) {
    return screens.map((monitor, index) => ({ monitor, role: assign[index] || 'news', index }));
  }

  const extras = [];
  if (hasRepos) extras.push('tools');
  if (hasBrief) extras.push('today');

  // Nothing but headlines to show: page them across the screens.
  if (extras.length === 0) {
    return screens.map((monitor, index) => ({ monitor, role: index === 0 ? 'news' : 'news-more', index }));
  }

  const plan = [{ monitor: screens[0], role: 'news', index: 0 }];
  const rest = screens.slice(1);

  if (rest.length >= extras.length) {
    extras.forEach((role, i) => plan.push({ monitor: rest[i], role, index: i + 1 }));
    rest.slice(extras.length).forEach((monitor, i) => {
      plan.push({ monitor, role: 'news-more', index: extras.length + 1 + i });
    });
  } else {
    // Fewer screens than blocks: the second screen carries all the panels.
    rest.forEach((monitor, i) => {
      plan.push({ monitor, role: i === 0 ? 'panels' : 'news-more', index: i + 1 });
    });
  }

  return plan;
}

module.exports = { detectScreens, applyWallpaper, planScreens, CACHE_PATH };
