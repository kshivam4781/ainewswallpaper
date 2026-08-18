'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = path.join(os.homedir(), '.ai-news-wallpaper');
const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
const IMAGE_DIR = path.join(HOME_DIR, 'images');
const LOG_PATH = path.join(HOME_DIR, 'ai-news-wallpaper.log');

const DEFAULT_FEEDS = [
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=artificial+intelligence+OR+%22AI+model%22+when:2d&hl=en-US&gl=US&ceid=US:en',
    splitSource: true
  },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'VentureBeat', url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
  { name: 'Hacker News', url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+OpenAI+OR+Anthropic&points=80' }
];

const DEFAULTS = {
  // How many headlines to show on the wallpaper.
  count: 7,
  // Minutes between refreshes (used by `watch` and `start`).
  intervalMinutes: 60,
  // Where the headline column sits: left | center | right.
  align: 'right',
  // midnight | carbon | slate | daylight
  theme: 'midnight',
  // null = auto-detect the primary display resolution.
  width: null,
  height: null,
  // Headlines older than this are ignored.
  maxAgeHours: 48,
  // The open-source panel on the opposite side of the headlines.
  tools: {
    enabled: true,
    trending: 3,   // generally trending repos
    forYou: 2      // picked from your own Claude Code session history
  },
  // Leave empty to infer interests from session history. Otherwise a list of
  // strings or { label, query } objects used as GitHub search queries.
  interests: [],
  // Multi-monitor behaviour.
  screens: {
    enabled: true,
    // auto   spread the content out, one kind per screen
    // mirror the same wallpaper everywhere
    // single treat the setup as one display (legacy behaviour)
    mode: 'auto',
    // Optional manual override, one role per screen in Windows' order:
    // "news", "news-more", "tools", "today", "panels", "all"
    assign: []
  },
  // Full-width quote band along the bottom.
  quotes: {
    enabled: true,
    rotate: 'daily',  // 'daily' | 'hourly'
    custom: []        // strings, or { text, author } - replaces the built-in list
  },
  // Who this wallpaper belongs to. Set by `ai-news-wallpaper setup`.
  profile: { name: '', email: '' },
  // Gmail + Calendar panel. Connect with `ai-news-wallpaper connect google`.
  google: {
    enabled: true,
    mail: 4,           // unread messages to show
    events: 4,         // calendar events to show
    morningFrom: 5,    // mail appears from this hour...
    morningTo: 12,     // ...until this one
    alwaysShowMail: false
  },
  // Keyword gate, applied to every feed. Empty array disables filtering.
  keywords: [
    'ai', 'a.i.', 'artificial intelligence', 'machine learning', 'llm', 'gpt',
    'openai', 'anthropic', 'claude', 'gemini', 'deepmind', 'nvidia', 'chatgpt',
    'copilot', 'mistral', 'llama', 'agent', 'neural', 'model', 'chip', 'robot'
  ],
  feeds: DEFAULT_FEEDS
};

function ensureDirs() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

function loadConfig() {
  ensureDirs();
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`Config at ${CONFIG_PATH} is not valid JSON: ${err.message}`);
    }
  }
  return { ...DEFAULTS, ...stored };
}

function saveConfig(config) {
  ensureDirs();
  const stored = { ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2), 'utf8');
  return CONFIG_PATH;
}

module.exports = { DEFAULTS, HOME_DIR, CONFIG_PATH, IMAGE_DIR, LOG_PATH, loadConfig, saveConfig, ensureDirs };
