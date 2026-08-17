'use strict';

const fs = require('fs');
const { loadConfig, LOG_PATH, ensureDirs } = require('./config');
const { collectHeadlines } = require('./feeds');
const { collectRepos } = require('./github');
const { fetchBrief } = require('./google');
const { buildPanels, briefRequest } = require('./panels');
const { pickQuote } = require('./quotes');
const { renderWallpaper } = require('./render');

function log(message) {
  try {
    ensureDirs();
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()}  ${message}\n`, 'utf8');
  } catch { /* logging must never break a refresh */ }
}

/**
 * One full cycle: fetch headlines, render the image, set it as the wallpaper.
 */
async function refresh(overrides = {}, options = {}) {
  const base = loadConfig();
  const config = {
    ...base,
    ...overrides,
    tools: { ...base.tools, ...(overrides.tools || {}) },
    google: { ...base.google, ...(overrides.google || {}) },
    quotes: { ...base.quotes, ...(overrides.quotes || {}) }
  };
  const toolsEnabled = config.tools.enabled !== false;
  const now = new Date();

  // Both side panels are a bonus: if GitHub or Google is unreachable the
  // headlines still render.
  const [news, tools, brief] = await Promise.all([
    collectHeadlines(config),
    toolsEnabled ? collectRepos(config).catch((err) => ({ repos: [], error: err.message })) : Promise.resolve({ repos: [] }),
    fetchBrief(briefRequest(config, now)).catch((err) => ({ connected: false, errors: [err.message] }))
  ]);

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

  const panels = buildPanels({ repos: tools.repos, brief, config, now });
  const quote = pickQuote(config, now);
  const result = await renderWallpaper(news.items, config, { ...options, panels, quote });

  const counts = panels.map((p) => `${p.heading.toLowerCase()}:${p.entries.length}`).join(' ');
  log(`OK    ${result.shown} headlines, ${counts || 'no panels'}, ${result.width}x${result.height}, ${result.imagePath}`);
  if (news.failures.length) {
    log(`WARN  feeds unavailable: ${news.failures.map((f) => `${f.feed} (${f.error})`).join(', ')}`);
  }

  return {
    ...result,
    items: news.items,
    failures: news.failures,
    pool: news.pool,
    repos: tools.repos,
    profile: tools.profile,
    brief,
    panels,
    quote,
    config
  };
}

module.exports = { refresh, log, LOG_PATH };
