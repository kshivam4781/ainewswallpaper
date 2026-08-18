'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { IMAGE_DIR, ensureDirs } = require('./config');
const { getTheme } = require('./themes');
const { timeAgo } = require('./feeds');
const { BULLET } = require('./panels');
const { renderScriptPath } = require('./runtime');

const KEEP_IMAGES = 3;
const EM_DASH = '—';

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const bundled = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(bundled) ? bundled : 'powershell.exe';
}

function runPowerShell(dataPath) {
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', renderScriptPath(), '-DataPath', dataPath],
      { windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).toString().trim();
          return reject(new Error(`Wallpaper renderer failed: ${detail}`));
        }
        resolve(stdout.toString());
      }
    );
  });
}

function formatSubheading(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function formatClock(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Windows caches the wallpaper by path, so each render gets a fresh filename. */
function nextImagePath(now) {
  ensureDirs();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
    `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return path.join(IMAGE_DIR, `ai-news-${stamp}.png`);
}

/**
 * Drops old renders, never the ones in `keep`. Every image currently applied to
 * a monitor must survive: deleting one blanks that monitor's wallpaper, which
 * is exactly what happens on a multi-screen refresh if you prune per render.
 */
function pruneOldImages(keep = []) {
  const keepSet = new Set(keep.filter(Boolean));
  try {
    const files = fs.readdirSync(IMAGE_DIR)
      .filter((f) => f.startsWith('ai-news-') && f.endsWith('.png'))
      .map((f) => path.join(IMAGE_DIR, f))
      .filter((f) => !keepSet.has(f))
      .sort();
    const budget = Math.max(0, KEEP_IMAGES * Math.max(1, keepSet.size) - keepSet.size);
    for (const file of files.slice(0, Math.max(0, files.length - budget))) {
      try { fs.unlinkSync(file); } catch { /* still in use by the shell, skip */ }
    }
  } catch { /* image dir missing, nothing to prune */ }
}

/**
 * Renders the wallpaper image and (optionally) applies it.
 * @returns {Promise<{imagePath: string, width: number, height: number, shown: number}>}
 */
async function renderWallpaper(items, config, options = {}) {
  const now = new Date();
  const imagePath = options.outputPath || nextImagePath(now);
  const panels = (options.panels || []).filter((panel) => panel.entries && panel.entries.length);

  const payload = {
    outputPath: imagePath,
    width: options.width || config.width || null,
    height: options.height || config.height || null,
    align: config.align || 'right',
    heading: 'AI NEWS',
    subheading: formatSubheading(now),
    // {0} is filled in with the count actually drawn - the renderer may drop a
    // story to fit, and the footer must not overstate.
    footer: `{0} stories  ${BULLET}  refreshed ${formatClock(now)}  ${BULLET}  ai-news-wallpaper`,
    setWallpaper: options.setWallpaper !== false,
    theme: getTheme(config.theme),
    items: items.map((item) => {
      const source = item.source || 'Unknown';
      const age = timeAgo(item.publishedAt);
      return { title: item.title, source, age, meta: age ? `${source}  ${BULLET}  ${age}` : source };
    }),
    // The em-dash is composed here so render.ps1 can stay ASCII-only.
    quote: options.quote
      ? { text: options.quote.text, author: options.quote.author ? `${EM_DASH} ${options.quote.author}` : '' }
      : null,
    panels
  };

  const dataPath = path.join(os.tmpdir(), `ai-news-wallpaper-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(dataPath, JSON.stringify(payload), 'utf8');

  try {
    const stdout = await runPowerShell(dataPath);
    if (process.env.AINW_DEBUG) {
      stdout.split(/\r?\n/).filter((l) => l.startsWith('DEBUG|')).forEach((l) => console.error(l));
    }
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RENDER_OK|'));
    if (!line) throw new Error(`Renderer produced no image. Output: ${stdout.trim() || '(empty)'}`);
    const [, out, width, height, shown] = line.split('|');
    return { imagePath: out, width: Number(width), height: Number(height), shown: Number(shown) };
  } finally {
    try { fs.unlinkSync(dataPath); } catch { /* best effort */ }
  }
}

module.exports = { renderWallpaper, pruneOldImages };
