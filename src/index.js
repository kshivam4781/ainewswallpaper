'use strict';

const fs = require('fs');
const { loadConfig, LOG_PATH, ensureDirs } = require('./config');
const { collectHeadlines } = require('./feeds');
const { collectRepos } = require('./github');
const { fetchBrief } = require('./google');
const { buildPanels, briefRequest } = require('./panels');
const { pickQuote } = require('./quotes');
const { renderWallpaper, pruneOldImages } = require('./render');
const { detectScreens, applyWallpaper, planScreens } = require('./screens');
const { collectExtras } = require('./sources');

function log(message) {
  try {
    ensureDirs();
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()}  ${message}\n`, 'utf8');
  } catch { /* logging must never break a refresh */ }
}

/**
 * Splits the fetched content across the screens according to each one's role.
 * A screen with no headlines renders its panels across the full width.
 */
function contentForScreen(entry, { items, panels, perScreenNews, page = 0 }) {
  const wanted = entry.blocks || [];
  const chosen = wanted.length
    ? wanted.map((h) => panels.find((p) => p.heading === h)).filter(Boolean)
    : [];

  switch (entry.role) {
    case 'news':
    case 'news-more':
      // Each headline screen takes the next page, so two of them never show
      // the same stories.
      return { items: items.slice(page * perScreenNews, (page + 1) * perScreenNews), panels: [] };
    case 'panels':
      return { items: [], panels: chosen };
    case 'all':
    default:
      return { items: items.slice(0, perScreenNews), panels: chosen };
  }
}

/**
 * Which extra sources this run should fetch. arXiv papers are always on; the
 * rest unlock as screens are added, because a single display has nowhere to
 * put them.
 */
function extrasFor(screenCount, config) {
  const wanted = [];
  if ((config.arxiv || {}).enabled !== false) wanted.push('papers');
  if (screenCount >= 2) {
    if ((config.markets || {}).enabled !== false) wanted.push('markets');
    if ((config.weather || {}).enabled !== false) wanted.push('weather');
  }
  if (screenCount >= 3 && (config.filler || {}).enabled !== false) {
    wanted.push((config.filler || {}).source === 'onThisDay' ? 'onThisDay' : 'hackerNews');
  }
  return wanted;
}

/**
 * One full cycle: fetch everything, then render and apply a wallpaper per
 * screen. On a single display this behaves exactly as it always has.
 */
async function refresh(overrides = {}, options = {}) {
  const base = loadConfig();
  const config = {
    ...base,
    ...overrides,
    tools: { ...base.tools, ...(overrides.tools || {}) },
    google: { ...base.google, ...(overrides.google || {}) },
    quotes: { ...base.quotes, ...(overrides.quotes || {}) },
    screens: { ...base.screens, ...(overrides.screens || {}) },
    arxiv: { ...base.arxiv, ...(overrides.arxiv || {}) },
    markets: { ...base.markets, ...(overrides.markets || {}) },
    weather: { ...base.weather, ...(overrides.weather || {}) },
    filler: { ...base.filler, ...(overrides.filler || {}) }
  };
  const toolsEnabled = config.tools.enabled !== false;
  const now = new Date();

  const displays = await detectScreens({ fresh: options.freshScreens });
  const screenCount = config.screens.enabled === false ? 1 : displays.monitors.length;

  // A dedicated headline screen has room for more than a shared one, and an
  // extra screen shows a second page, so fetch enough to fill them.
  const perScreenNews = screenCount > 1 ? Math.min(14, Math.max(config.count, 10)) : config.count;
  const headlineBudget = Math.min(28, perScreenNews * Math.max(1, screenCount));

  // The side panels are a bonus: if GitHub or Google is unreachable the
  // headlines still render.
  const [news, tools, brief, extras] = await Promise.all([
    collectHeadlines({ ...config, count: headlineBudget }),
    toolsEnabled ? collectRepos(config).catch((err) => ({ repos: [], error: err.message })) : Promise.resolve({ repos: [] }),
    fetchBrief(briefRequest(config, now)).catch((err) => ({ connected: false, errors: [err.message] })),
    collectExtras(config, extrasFor(screenCount, config), now).catch(() => ({ warnings: [] }))
  ]);

  if (extras.warnings && extras.warnings.length) log(`WARN  sources: ${extras.warnings.join('; ')}`);

  if (tools.error) log(`WARN  github: ${tools.error}${tools.stale ? ' (showing cached repos)' : ''}`);
  if (brief.errors && brief.errors.length) log(`WARN  google: ${brief.errors.join('; ')}`);

  if (news.items.length === 0) {
    const reason = news.failures.length
      ? `every feed failed (${news.failures.map((f) => `${f.feed}: ${f.error}`).join('; ')})`
      : 'no headlines matched the current filters';
    log(`SKIP  ${reason}`);
    const error = new Error(`No AI headlines to show — ${reason}.`);
    error.failures = news.failures;
    throw error;
  }

  const panels = buildPanels({ repos: tools.repos, brief, extras, config, now });
  const quote = pickQuote(config, now);

  // Panels in priority order, filtered to the ones that actually have content.
  const blocks = panels.map((p) => p.heading);
  const hourSeed = Math.floor(now.getTime() / 3600000);
  const plan = config.screens.enabled === false
    ? planScreens([displays.monitors[0]], { blocks, mode: 'single', seed: hourSeed })
    : planScreens(displays.monitors, {
      blocks,
      mode: config.screens.mode,
      assign: config.screens.assign,
      seed: hourSeed
    });

  const perMonitor = plan.length > 1 && displays.perMonitor;
  const rendered = [];

  let newsPage = 0;
  for (const entry of plan) {
    const isNews = entry.role === 'news' || entry.role === 'news-more';
    const content = contentForScreen(entry, {
      items: news.items, panels, perScreenNews, page: isNews ? newsPage : 0
    });
    if (isNews) newsPage++;
    if (content.items.length === 0 && content.panels.length === 0) continue;

    const result = await renderWallpaper(content.items, config, {
      ...options,
      // Applying is a separate step so multi-monitor can target each display.
      setWallpaper: false,
      width: entry.monitor.width || config.width,
      height: entry.monitor.height || config.height,
      panels: content.panels,
      // One quote across the desktop, on the primary screen only.
      quote: entry.index === 0 ? quote : null,
      outputPath: options.outputPath && entry.index === 0 ? options.outputPath : undefined
    });

    if (options.setWallpaper !== false) {
      await applyWallpaper(result.imagePath, perMonitor ? entry.monitor.id : null);
    }
    rendered.push({ ...result, role: entry.role, blocks: entry.blocks || [], monitor: entry.monitor });

    // Without per-monitor support there is only one wallpaper to set.
    if (!perMonitor && options.setWallpaper !== false) break;
  }

  // Prune only once every screen has its image, so nothing in use is deleted.
  pruneOldImages(rendered.map((r) => r.imagePath));

  const summary = rendered.map((r) =>
    `${r.role}${r.blocks && r.blocks.length ? `(${r.blocks.join('+')})` : ''}@${r.width}x${r.height}`).join(' ');
  log(`OK    ${rendered.length} screen(s): ${summary}${perMonitor ? ' [per-monitor]' : ''}`);
  if (news.failures.length) {
    log(`WARN  feeds unavailable: ${news.failures.map((f) => `${f.feed} (${f.error})`).join(', ')}`);
  }

  const primary = rendered[0] || {};
  return {
    ...primary,
    screens: rendered,
    displays,
    plan,
    perMonitor,
    items: news.items,
    failures: news.failures,
    pool: news.pool,
    repos: tools.repos,
    profile: tools.profile,
    brief,
    extras,
    panels,
    quote,
    config
  };
}

module.exports = { refresh, log, LOG_PATH };
