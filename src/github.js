'use strict';

const fs = require('fs');
const path = require('path');
const { HOME_DIR, ensureDirs } = require('./config');
const { resolveInterests } = require('./interests');

const CACHE_PATH = path.join(HOME_DIR, 'cache.json');
const API = 'https://api.github.com/search/repositories';
const PROFILE_TTL_MS = 6 * 3600 * 1000;

function headers() {
  const base = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'ai-news-wallpaper'
  };
  // Optional — only raises the rate limit, nothing here needs auth.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

async function search(query, { sort = 'stars', perPage = 20 } = {}) {
  const url = `${API}?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=${perPage}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { headers: headers(), signal: controller.signal });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return (body.items || []).map(normalize);
  } finally {
    clearTimeout(timer);
  }
}

/** GDI+ draws emoji and other pictographs as empty boxes, so take them out. */
function stripPictographs(text) {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s|·\-–—:,]+$/, '');
}

function normalize(repo) {
  return {
    fullName: repo.full_name,
    description: stripPictographs(repo.description || ''),
    stars: repo.stargazers_count || 0,
    language: repo.language || '',
    topics: repo.topics || [],
    url: repo.html_url,
    pushedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : null
  };
}

function formatStars(count) {
  if (count >= 1000) {
    const k = count / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(count);
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Rotates the slice we show so the wallpaper does not display the same three
 * repos every hour, while still drawing from the top of the ranking.
 */
function rotate(list, count, seed) {
  if (list.length <= count) return list.slice(0, count);
  const start = (seed % Math.max(1, list.length - count + 1));
  return list.slice(start, start + count);
}

/** Curated link lists rank well but are not tools, which is what was asked for. */
const LIST_REPO = /^(awesome|curated|\d+-?)|(awesome|-list|resources)$/i;
const LIST_DESC = /^(a |an )?(curated |comprehensive |awesome |big )?(list|collection|catalog|index|directory) of\b|^awesome\b/i;

function usable(repo) {
  if (repo.description.length < 12 || repo.description.length > 200) return false;
  const name = repo.fullName.split('/')[1] || '';
  if (LIST_REPO.test(name) || LIST_DESC.test(repo.description)) return false;
  return true;
}

async function getTrending(count, seed) {
  // Repos created recently that already have real traction: genuinely rising
  // projects rather than the same all-time giants every refresh.
  const repos = (await search(`created:>${isoDaysAgo(60)} stars:>300`, { perPage: 25 })).filter(usable);
  return rotate(repos, count, seed).map((repo) => ({ ...repo, tag: 'TRENDING' }));
}

const MAX_SEARCHES = 6; // stay inside the unauthenticated search rate limit

async function getForYou(topics, count, seed, exclude) {
  const picks = [];
  const seen = new Set(exclude);
  let searches = 0;

  // One repo per interest, walking down the ranking until we have enough.
  // A narrow query can legitimately return nothing, so each topic gets a
  // second, lower-star attempt before we move on.
  for (const topic of topics) {
    if (picks.length >= count || searches >= MAX_SEARCHES) break;

    for (const minStars of [500, 80]) {
      if (searches >= MAX_SEARCHES) break;
      searches++;
      let repos;
      try {
        repos = await search(`${topic.query} stars:>${minStars} pushed:>${isoDaysAgo(180)}`, { perPage: 20 });
      } catch {
        break;
      }
      const fresh = rotate(repos.filter((r) => usable(r) && !seen.has(r.fullName)), 6, seed);
      if (fresh.length) {
        seen.add(fresh[0].fullName);
        picks.push({ ...fresh[0], tag: 'FOR YOU', reason: topic.label });
        break;
      }
    }
  }
  return picks.slice(0, count);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(patch) {
  ensureDirs();
  const next = { ...readCache(), ...patch };
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch { /* cache is an optimisation, never fatal */ }
  return next;
}

/** Forces the interest profile to be rebuilt from session history right now. */
function refreshProfile(config) {
  const profile = resolveInterests(config);
  writeCache({ profile, profileAt: Date.now() });
  return profile;
}

/** The interest profile is expensive to rebuild, so it is cached for a while. */
function cachedInterests(config) {
  const cache = readCache();
  const manual = Array.isArray(config.interests) && config.interests.length;
  if (!manual && cache.profile && Date.now() - (cache.profileAt || 0) < PROFILE_TTL_MS) {
    return cache.profile;
  }
  const profile = resolveInterests(config);
  writeCache({ profile, profileAt: Date.now() });
  return profile;
}

/**
 * Returns the repo list for the wallpaper: `trending` general picks followed by
 * `forYou` picks derived from the user's own session history. Falls back to the
 * last good result if GitHub is unreachable.
 * @returns {Promise<{repos: Array, profile: object, stale: boolean, error: string|null}>}
 */
async function collectRepos(config) {
  const settings = config.tools || {};
  const trendingCount = Number.isFinite(settings.trending) ? settings.trending : 3;
  const forYouCount = Number.isFinite(settings.forYou) ? settings.forYou : 2;
  const seed = Math.floor(Date.now() / 3600000); // rotates once an hour

  const profile = cachedInterests(config);

  let repos = [];
  let error = null;
  try {
    const trending = await getTrending(trendingCount, seed);
    const forYou = await getForYou(profile.topics, forYouCount, seed, trending.map((r) => r.fullName));
    repos = [...trending, ...forYou];
  } catch (err) {
    error = err.message;
  }

  if (repos.length === 0) {
    const cache = readCache();
    if (Array.isArray(cache.repos) && cache.repos.length) {
      return { repos: cache.repos, profile, stale: true, error };
    }
    return { repos: [], profile, stale: false, error };
  }

  writeCache({ repos, reposAt: Date.now() });
  return { repos, profile, stale: false, error };
}

module.exports = { collectRepos, refreshProfile, getTrending, getForYou, formatStars, search, CACHE_PATH };
