'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TRANSCRIPT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const MAX_FILES = 24;
const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;

/**
 * Topics we know how to turn into a useful GitHub search. `match` is tested
 * against the user's own words from past sessions; `query` is what we ask
 * GitHub for when the topic ranks highly.
 */
const TOPICS = [
  {
    id: 'trading',
    label: 'Algorithmic trading',
    match: /\b(xauusd|forex|candlestick|ohlcv|backtest\w*|pine ?script|tradingview|scalping|order ?book|trading ?(bot|strategy|terminal|chart)|technical indicator)\b/gi,
    query: 'algorithmic trading'
  },
  {
    id: 'marketdata',
    label: 'Market data',
    match: /\b(market data|price feed|tick data|yfinance|broker api|mt4|mt5|metatrader|binance|oanda)\b/gi,
    query: 'market data api'
  },
  {
    id: 'charting',
    label: 'Charting & dataviz',
    match: /\b(chart(ing|s)?|lightweight-charts|d3\b|plotly|recharts|candlestick chart|data ?viz|visuali[sz]ation)\b/gi,
    query: 'charting library'
  },
  {
    id: 'agents',
    label: 'AI agents',
    match: /\b(ai agent|agentic|mcp server|model context protocol|tool ?use|subagent|claude code|llm agent|autonomous agent)\b/gi,
    query: 'ai agent framework'
  },
  {
    id: 'llmapps',
    label: 'LLM tooling',
    match: /\b(llm|prompt(ing| engineering)?|rag\b|embedding|vector (db|database|store)|fine-?tun\w+|inference|ollama|langchain)\b/gi,
    query: 'llm framework'
  },
  {
    id: 'knowledge',
    label: 'Notes & knowledge',
    match: /\b(obsidian|zettelkasten|knowledge base|second brain|markdown notes?|wikilink|dataview|note-?taking)\b/gi,
    query: 'personal knowledge base'
  },
  {
    id: 'automation',
    label: 'Desktop automation',
    match: /\b(automat\w+|scheduled task|cron|powershell|windows service|scrap(e|ing)|workflow engine|self-?host\w*)\b/gi,
    query: 'workflow automation'
  },
  {
    id: 'webapp',
    label: 'Web app stack',
    match: /\b(react|next\.?js|vite|tailwind|typescript|svelte|electron|websocket|fastapi|express)\b/gi,
    query: 'typescript framework'
  },
  {
    id: 'datascience',
    label: 'Data & ML',
    match: /\b(pandas|numpy|jupyter|scikit|pytorch|tensorflow|dataframe|time ?series|forecast\w*|machine learning)\b/gi,
    query: 'time series forecasting'
  },
  {
    id: 'devtools',
    label: 'Developer tooling',
    match: /\b(cli tool|terminal ui|\btui\b|dev ?tool|debugger|profiler|linter|monorepo|build tool)\b/gi,
    query: 'terminal cli tool'
  }
];

function recencyWeight(mtimeMs) {
  const days = (Date.now() - mtimeMs) / 86400000;
  if (days <= 7) return 3;
  if (days <= 30) return 2;
  return 1;
}

/** Pulls the user's own words out of a Claude Code transcript line. */
function userTextFromLine(line) {
  if (line.indexOf('"user"') === -1) return '';
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return '';
  }
  const message = record && record.message;
  if (!message || message.role !== 'user') return '';

  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  // Skip tool_result blocks: those are file dumps and command output, not
  // things the user said, and they would swamp the signal.
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function readTranscripts() {
  if (!fs.existsSync(TRANSCRIPT_ROOT)) return [];

  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          files.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch { /* vanished mid-scan */ }
      }
    }
  };
  walk(TRANSCRIPT_ROOT, 0);

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

/**
 * Builds a weighted interest profile from what the user has actually asked for
 * in past Claude Code sessions.
 * @returns {{topics: Array<{id,label,query,score}>, sampledFiles: number}}
 */
function profileFromHistory() {
  const scores = new Map();
  const breadth = new Map();
  const files = readTranscripts();

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    if (raw.length > MAX_BYTES_PER_FILE) raw = raw.slice(-MAX_BYTES_PER_FILE);

    const text = raw.split('\n').map(userTextFromLine).filter(Boolean).join('\n');
    if (!text) continue;

    const weight = recencyWeight(file.mtimeMs);
    for (const topic of TOPICS) {
      topic.match.lastIndex = 0;
      const hits = (text.match(topic.match) || []).length;
      if (hits > 0) {
        // Log scale, so one long repetitive session cannot drown out the rest.
        scores.set(topic.id, (scores.get(topic.id) || 0) + Math.log2(1 + hits) * weight);
        breadth.set(topic.id, (breadth.get(topic.id) || 0) + 1);
      }
    }
  }

  // A topic that keeps coming back across separate sessions is a standing
  // interest; one that spikes inside a single session is usually just today.
  const topics = TOPICS
    .map((topic) => ({
      id: topic.id,
      label: topic.label,
      query: topic.query,
      score: (scores.get(topic.id) || 0) + (breadth.get(topic.id) || 0) * 2.5,
      sessions: breadth.get(topic.id) || 0
    }))
    .filter((topic) => topic.score > 0)
    .sort((a, b) => b.score - a.score);

  return { topics, sampledFiles: files.length };
}

/**
 * The interests to search GitHub for. Explicit config always wins over the
 * inferred profile.
 */
function resolveInterests(config) {
  const manual = Array.isArray(config.interests) ? config.interests.filter(Boolean) : [];
  if (manual.length) {
    return {
      source: 'config',
      sampledFiles: 0,
      topics: manual.map((entry, i) => (
        typeof entry === 'string'
          ? { id: `manual-${i}`, label: entry, query: entry, score: 100 - i }
          : { id: entry.id || `manual-${i}`, label: entry.label || entry.query, query: entry.query, score: 100 - i }
      ))
    };
  }

  const profile = profileFromHistory();
  return { source: profile.topics.length ? 'history' : 'default', ...profile };
}

module.exports = { resolveInterests, profileFromHistory, TOPICS, TRANSCRIPT_ROOT };
