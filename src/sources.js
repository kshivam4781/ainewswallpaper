'use strict';

/**
 * Extra content sources. Same contract as the news feeds: public endpoints,
 * no API key, no account, no AI - fetch, parse, hand back plain data.
 *
 * Each collector resolves to null rather than throwing, so one dead endpoint
 * can never take the wallpaper down with it.
 */

const { clean } = require('./feeds');

const TIMEOUT_MS = 12000;

async function getJson(url) {
  return request(url, (res) => res.json());
}

async function getText(url) {
  return request(url, (res) => res.text());
}

async function request(url, read) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'ai-news-wallpaper (https://github.com/kshivam4781/ainewswallpaper)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await read(res);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- arxiv

const ARXIV_URL = 'https://export.arxiv.org/api/query';

/** Latest submissions in the given arXiv categories. */
async function collectPapers(config = {}) {
  const settings = config.arxiv || {};
  if (settings.enabled === false) return null;

  const categories = (settings.categories && settings.categories.length)
    ? settings.categories
    : ['cs.AI', 'cs.LG', 'cs.CL'];
  const limit = Number.isFinite(settings.count) ? settings.count : 4;

  const query = categories.map((c) => `cat:${c}`).join('+OR+');
  const url = `${ARXIV_URL}?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=${limit * 3}`;

  const xml = await getText(url);
  const blocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  const papers = [];
  const seen = new Set();
  for (const block of blocks) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    if (!title || title.length < 15) continue;
    const key = title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    const authors = (block.match(/<name>([^<]+)<\/name>/g) || [])
      .map((a) => clean(a.replace(/<\/?name>/g, '')));
    const primary = (block.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1] || categories[0];
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1];

    papers.push({
      title,
      // "Ada Lovelace +4" reads better than a wall of names.
      authors: authors.length > 1 ? `${authors[0]} +${authors.length - 1}` : (authors[0] || ''),
      category: primary,
      publishedAt: published ? Date.parse(published) : null
    });
    if (papers.length >= limit) break;
  }

  return papers.length ? papers : null;
}

// ------------------------------------------------------------------ markets

const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

const DEFAULT_SYMBOLS = [
  { symbol: 'GC=F', label: 'Gold' },
  { symbol: 'BTC-USD', label: 'Bitcoin' },
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: 'INR=X', label: 'USD/INR' }
];

function formatPrice(value, symbol) {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(4);
}

async function quoteFromYahoo(entry) {
  const body = await getJson(`${YAHOO_URL}/${encodeURIComponent(entry.symbol)}?interval=1d&range=5d`);
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  if (!result || !result.meta) throw new Error('no data');

  const price = result.meta.regularMarketPrice;
  const previous = result.meta.chartPreviousClose || result.meta.previousClose;
  if (!Number.isFinite(price)) throw new Error('no price');

  const changePct = Number.isFinite(previous) && previous !== 0 ? ((price - previous) / previous) * 100 : null;
  return {
    label: entry.label || result.meta.symbol,
    symbol: entry.symbol,
    price,
    priceText: formatPrice(price, entry.symbol),
    currency: result.meta.currency || '',
    changePct
  };
}

/**
 * Yahoo's chart endpoint is undocumented, so Stooq stands in when it changes
 * or rate-limits. Stooq returns a two-line CSV: header, then the day's OHLC.
 */
async function quoteFromStooq(entry) {
  const map = { 'GC=F': 'xauusd', 'BTC-USD': 'btcusd', '^GSPC': '^spx', 'INR=X': 'usdinr', 'SI=F': 'xagusd' };
  const ticker = map[entry.symbol];
  if (!ticker) throw new Error('no stooq equivalent');

  const csv = await getText(`https://stooq.com/q/l/?s=${ticker}&f=sd2t2ohlcv&h&e=csv`);
  const row = csv.trim().split(/\r?\n/)[1];
  if (!row) throw new Error('no stooq row');
  const cols = row.split(',');
  const close = Number(cols[6]);
  const open = Number(cols[3]);
  if (!Number.isFinite(close)) throw new Error('no stooq close');

  return {
    label: entry.label || entry.symbol,
    symbol: entry.symbol,
    price: close,
    priceText: formatPrice(close, entry.symbol),
    currency: '',
    changePct: Number.isFinite(open) && open !== 0 ? ((close - open) / open) * 100 : null
  };
}

async function collectMarkets(config = {}) {
  const settings = config.markets || {};
  if (settings.enabled === false) return null;
  const symbols = (settings.symbols && settings.symbols.length) ? settings.symbols : DEFAULT_SYMBOLS;

  const quotes = await Promise.all(symbols.slice(0, 6).map(async (entry) => {
    const spec = typeof entry === 'string' ? { symbol: entry, label: entry } : entry;
    try {
      return await quoteFromYahoo(spec);
    } catch {
      try {
        return await quoteFromStooq(spec);
      } catch {
        return null;
      }
    }
  }));

  const usable = quotes.filter(Boolean);
  return usable.length ? usable : null;
}

// ------------------------------------------------------------------ weather

const WMO = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm'
};

/**
 * Resolves a place name to coordinates. A configured city beats IP lookup,
 * which routinely reports the far end of a VPN rather than where you are.
 */
async function resolveLocation(settings) {
  if (Number.isFinite(settings.latitude) && Number.isFinite(settings.longitude)) {
    return { latitude: settings.latitude, longitude: settings.longitude, name: settings.city || 'Home' };
  }

  if (settings.city) {
    const body = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(settings.city)}&count=1&language=en&format=json`);
    const hit = body && body.results && body.results[0];
    if (hit) return { latitude: hit.latitude, longitude: hit.longitude, name: hit.name };
    throw new Error(`could not find "${settings.city}"`);
  }

  const ip = await getJson('https://ipapi.co/json/');
  if (!Number.isFinite(ip.latitude)) throw new Error('could not locate you');
  return { latitude: ip.latitude, longitude: ip.longitude, name: ip.city || 'Here', guessed: true };
}

async function collectWeather(config = {}) {
  const settings = config.weather || {};
  if (settings.enabled === false) return null;

  const place = await resolveLocation(settings);
  const units = settings.units === 'imperial' ? 'fahrenheit' : 'celsius';
  const unitLabel = units === 'fahrenheit' ? 'F' : 'C';

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    `&timezone=auto&forecast_days=3&temperature_unit=${units}`;

  const body = await getJson(url);
  if (!body || !body.current || !body.daily) throw new Error('no forecast');

  const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);
  const days = body.daily.time.map((date, i) => ({
    date,
    high: round(body.daily.temperature_2m_max[i]),
    low: round(body.daily.temperature_2m_min[i]),
    text: WMO[body.daily.weather_code[i]] || '',
    rainChance: body.daily.precipitation_probability_max ? body.daily.precipitation_probability_max[i] : null
  }));

  return {
    place: place.name,
    guessed: Boolean(place.guessed),
    unit: unitLabel,
    now: round(body.current.temperature_2m),
    feelsLike: round(body.current.apparent_temperature),
    text: WMO[body.current.weather_code] || '',
    wind: round(body.current.wind_speed_10m),
    days
  };
}

// ------------------------------------------------------------------- filler

/**
 * Notable events on today's date, from Wikipedia. Not the default filler:
 * Wikipedia's date events skew heavily to atrocities and disasters, which
 * reads badly on a wallpaper sitting next to a motivational quote.
 */
async function collectOnThisDay(config = {}, now = new Date()) {
  const settings = config.filler || {};
  if (settings.enabled === false) return null;

  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const body = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`);

  const limit = Number.isFinite(settings.count) ? settings.count : 4;
  const events = (body.events || [])
    .filter((e) => e.year && e.text)
    .sort((a, b) => b.year - a.year)
    .slice(0, limit)
    .map((e) => ({ year: String(e.year), text: clean(e.text) }));

  return events.length ? events : null;
}

// -------------------------------------------------------------- hacker news

const HN = 'https://hacker-news.firebaseio.com/v0';

/** Top-ranked Hacker News stories right now. */
async function collectHackerNews(config = {}) {
  const settings = config.filler || {};
  if (settings.enabled === false) return null;
  const limit = Number.isFinite(settings.count) ? settings.count : 5;

  const ids = await getJson(`${HN}/topstories.json`);
  if (!Array.isArray(ids) || !ids.length) throw new Error('no stories');

  const items = await Promise.all(ids.slice(0, limit * 2).map((id) =>
    getJson(`${HN}/item/${id}.json`).catch(() => null)));

  const stories = items
    .filter((it) => it && it.title && it.type === 'story')
    .slice(0, limit)
    .map((it) => ({
      title: clean(it.title),
      score: it.score || 0,
      comments: it.descendants || 0,
      by: it.by || '',
      // "github.com" is more use at a glance than the full URL.
      site: it.url ? (it.url.match(/^https?:\/\/(?:www\.)?([^/]+)/) || [])[1] || '' : 'news.ycombinator.com'
    }));

  return stories.length ? stories : null;
}

/**
 * Fetches every extra source that this run asked for. Failures come back as
 * warnings; the caller renders whatever succeeded.
 */
async function collectExtras(config, wanted = [], now = new Date()) {
  const jobs = {
    papers: () => collectPapers(config),
    markets: () => collectMarkets(config),
    weather: () => collectWeather(config),
    hackerNews: () => collectHackerNews(config),
    onThisDay: () => collectOnThisDay(config, now)
  };

  const out = { warnings: [] };
  await Promise.all(wanted.map(async (name) => {
    const job = jobs[name];
    if (!job) return;
    try {
      out[name] = await job();
    } catch (err) {
      out[name] = null;
      out.warnings.push(`${name}: ${err.message}`);
    }
  }));
  return out;
}

module.exports = {
  collectExtras, collectPapers, collectMarkets, collectWeather, collectHackerNews, collectOnThisDay,
  DEFAULT_SYMBOLS
};
