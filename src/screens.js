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
 * One screen keeps everything together, but only two panels fit legibly beside
 * the headlines, so the rest rotate through the second slot. With more screens
 * the panels get homes of their own, at most two per screen.
 *
 * @param blocks ordered panel headings that actually have content
 * @returns Array<{monitor, role, index, blocks?}>
 */
function planScreens(monitors, { blocks = [], mode = 'auto', assign = [], seed = 0 } = {}) {
  const screens = monitors.length ? monitors : [{ id: '', width: 0, height: 0, primary: true }];

  if (mode === 'single' || screens.length === 1) {
    return [{ monitor: screens[0], role: 'all', index: 0, blocks: pickForOneScreen(blocks, seed) }];
  }
  if (mode === 'mirror') {
    return screens.map((monitor, index) => ({
      monitor, role: 'all', index, blocks: pickForOneScreen(blocks, seed)
    }));
  }

  if (assign.length) {
    return screens.map((monitor, index) => ({
      monitor, role: assign[index] || 'news', index, blocks: [assign[index]]
    }));
  }

  const plan = [{ monitor: screens[0], role: 'news', index: 0, blocks: [] }];
  const rest = screens.slice(1);
  if (rest.length === 0 || blocks.length === 0) return plan;

  // Two panels per screen is the most that stays legible. When there are more
  // panels than slots, rotate the surplus hourly instead of cramming them in -
  // the highest-priority one stays pinned so the layout keeps its shape.
  const capacity = rest.length * 2;
  let show = blocks;
  if (blocks.length > capacity) {
    const pool = blocks.slice(1);
    const offset = ((seed % pool.length) + pool.length) % pool.length;
    show = blocks.slice(0, 1).concat(pool.slice(offset), pool.slice(0, offset)).slice(0, capacity);
  }

  const perScreen = Math.min(2, Math.ceil(show.length / rest.length));
  const queue = show.slice();
  rest.forEach((monitor, i) => {
    const mine = queue.splice(0, perScreen);
    plan.push({ monitor, role: mine.length ? 'panels' : 'news-more', index: i + 1, blocks: mine });
  });

  return plan;
}

/**
 * The two panels a single screen can carry. The first slot is fixed so the
 * layout stays familiar; the second rotates hourly so everything gets seen.
 */
function pickForOneScreen(blocks, seed = 0) {
  if (blocks.length <= 2) return blocks.slice();
  const rest = blocks.slice(1);
  return [blocks[0], rest[((seed % rest.length) + rest.length) % rest.length]];
}

module.exports = { detectScreens, applyWallpaper, planScreens, pickForOneScreen, CACHE_PATH };
