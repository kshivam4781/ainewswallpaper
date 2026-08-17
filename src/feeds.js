'use strict';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', trade: '™'
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
    });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function clean(text) {
  if (!text) return '';
  return decodeEntities(String(text))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const match = block.match(re);
    if (match) {
      const value = clean(match[1]);
      if (value) return value;
    }
  }
  return '';
}

function linkValue(block) {
  const rss = tagValue(block, 'link');
  if (rss && /^https?:/i.test(rss)) return rss;
  // Atom: <link rel="alternate" href="..."/>
  const atom = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return atom ? decodeEntities(atom[1]) : '';
}

function parseFeed(xml, feed) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const items = [];

  for (const block of blocks) {
    let title = tagValue(block, 'title');
    if (!title) continue;

    let source = feed.name;
    if (feed.splitSource) {
      // Google News formats titles as "Headline - Publisher".
      const split = title.match(/^(.*)\s[-–]\s([^-–]{2,40})$/);
      if (split) {
        title = split[1].trim();
        source = split[2].trim();
      }
    }

    const dateText = tagValue(block, 'pubDate', 'published', 'updated', 'dc:date');
    const parsed = dateText ? Date.parse(dateText) : NaN;

    items.push({
      title,
      source,
      feedName: feed.name,
      link: linkValue(block),
      publishedAt: Number.isNaN(parsed) ? null : parsed
    });
  }

  return items;
}

async function fetchFeed(feed, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ai-news-wallpaper/1.0',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
      },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text(), feed);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
}

function matchesKeywords(title, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const haystack = ` ${title.toLowerCase()} `;
  return keywords.some((word) => {
    const needle = String(word).toLowerCase();
    // Short tokens like "ai" must match as a whole word, not inside "said".
    if (needle.length <= 3) return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(haystack);
    return haystack.includes(needle);
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Titles that are navigation cruft rather than actual stories. */
const JUNK_TITLE = /(\bpage \d+\b|^\s*(news|home|latest|archive)\b.{0,12}$|\.{3}$)/i;

function isUsableTitle(title) {
  if (title.length < 22 || title.length > 180) return false;
  if (JUNK_TITLE.test(title)) return false;
  // A headline should read as a sentence, not a two-word category label.
  return title.split(/\s+/).length >= 4;
}

/** Round-robin across feeds so one busy feed cannot fill the whole wallpaper. */
function interleave(items, limit) {
  const bySource = new Map();
  for (const item of items) {
    const key = item.feedName || item.source;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(item);
  }
  const queues = [...bySource.values()];
  const out = [];
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (out.length >= limit) break;
      if (queue.length) {
        out.push(queue.shift());
        progressed = true;
      }
    }
  }
  return out;
}

/**
 * Fetches every configured feed, then dedupes, filters and ranks the headlines.
 * Returns { items, sources, failures }.
 */
async function collectHeadlines(config) {
  const feeds = config.feeds || [];
  const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed, 12000)));

  const failures = [];
  const all = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    } else {
      failures.push({ feed: feeds[index].name, error: String(result.reason && result.reason.message || result.reason) });
    }
  });

  const cutoff = config.maxAgeHours ? Date.now() - config.maxAgeHours * 3600 * 1000 : 0;
  const seen = new Set();
  const filtered = [];

  for (const item of all) {
    if (!isUsableTitle(item.title)) continue;
    if (cutoff && item.publishedAt && item.publishedAt < cutoff) continue;
    if (!matchesKeywords(item.title, config.keywords)) continue;
    const key = normalizeTitle(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    filtered.push(item);
  }

  filtered.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  const items = interleave(filtered, config.count || 7);
  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  return { items, sources: new Set(items.map((i) => i.source)).size, failures, pool: filtered.length };
}

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

module.exports = { collectHeadlines, timeAgo, parseFeed, clean, decodeEntities };
