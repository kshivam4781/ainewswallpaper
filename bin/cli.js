#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { refresh, log, LOG_PATH } = require('../src/index');
const { loadConfig, saveConfig, CONFIG_PATH, IMAGE_DIR, DEFAULTS } = require('../src/config');
const { themeNames } = require('../src/themes');
const schedule = require('../src/schedule');
const pkg = require('../package.json');

const NUMBER_FLAGS = new Set(['count', 'interval', 'width', 'height', 'max-age', 'lines', 'trending', 'for-you']);

function parseArgs(argv) {
  const first = argv[0] || '';
  // A bare flag is still a command when it is --version/--help, otherwise
  // we fall through to the default action.
  const command = first && !first.startsWith('-')
    ? first
    : /^--?(v|version)$/i.test(first) ? 'version'
      : /^--?(h|help|\?)$/i.test(first) ? 'help'
        : 'update';
  const flags = {};
  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
  // e.g. "connect google" - the word after the command, when it is not a flag.
  const target = rest[0] && !rest[0].startsWith('-') ? rest[0] : null;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase();
    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else if (rest[i + 1] && !rest[i + 1].startsWith('--')) {
      value = rest[++i];
    } else {
      value = true;
    }
    flags[name] = NUMBER_FLAGS.has(name) && value !== true ? Number(value) : value;
  }
  return { command, flags, target };
}

/** Maps CLI flags onto config keys. */
function overridesFrom(flags) {
  const out = {};
  if (Number.isFinite(flags.count)) out.count = Math.max(1, Math.min(14, flags.count));
  if (Number.isFinite(flags.interval)) out.intervalMinutes = Math.max(1, flags.interval);
  if (Number.isFinite(flags.width)) out.width = flags.width;
  if (Number.isFinite(flags.height)) out.height = flags.height;
  if (Number.isFinite(flags['max-age'])) out.maxAgeHours = flags['max-age'];
  if (typeof flags.theme === 'string') out.theme = flags.theme;
  if (typeof flags.align === 'string') out.align = flags.align;

  const screens = {};
  if (typeof flags.screens === 'string') screens.mode = flags.screens;
  if (flags['no-screens'] === true) screens.enabled = false;
  if (Object.keys(screens).length) out.screens = screens;

  const quotes = {};
  if (flags['no-quote'] === true) quotes.enabled = false;
  if (flags.quote === true) quotes.enabled = true;
  if (typeof flags.rotate === 'string') quotes.rotate = flags.rotate;
  if (Object.keys(quotes).length) out.quotes = quotes;

  const tools = {};
  if (flags['no-tools'] === true) tools.enabled = false;
  if (flags.tools === true) tools.enabled = true;
  if (Number.isFinite(flags.trending)) tools.trending = Math.max(0, Math.min(6, flags.trending));
  if (Number.isFinite(flags['for-you'])) tools.forYou = Math.max(0, Math.min(6, flags['for-you']));
  if (Object.keys(tools).length) out.tools = tools;

  return out;
}

function validate(overrides) {
  if (overrides.theme && !themeNames.includes(overrides.theme)) {
    throw new Error(`Unknown theme "${overrides.theme}". Available: ${themeNames.join(', ')}.`);
  }
  if (overrides.align && !['left', 'center', 'right'].includes(overrides.align)) {
    throw new Error(`Unknown align "${overrides.align}". Use left, center or right.`);
  }
  if (overrides.screens && overrides.screens.mode &&
      !['auto', 'mirror', 'single'].includes(overrides.screens.mode)) {
    throw new Error(`Unknown screens mode "${overrides.screens.mode}". Use auto, mirror or single.`);
  }
}

const HELP = `
ai-news-wallpaper v${pkg.version}
Keeps your Windows wallpaper updated with the latest AI headlines.

Usage
  ai-news-wallpaper <command> [options]

Commands
  setup               Register your name/email and optionally link Google
  connect google      Link Gmail + Calendar (read-only) via OAuth
  disconnect google   Revoke the token and remove it from this machine
  brief               Print today's calendar and unread mail
  update              Fetch the news and set the wallpaper once (default)
  start               Install a Windows scheduled task that refreshes automatically
  stop                Remove the scheduled task
  status              Show the schedule, last refresh and current settings
  watch               Refresh on an interval in the foreground (Ctrl+C to stop)
  preview             Render to a PNG without changing the wallpaper
  config              Show or change saved settings
  headlines           Print the headlines that would be used
  tools               Show the inferred interests and the repos that would show
  screens             Show the detected displays and what each will show
  log                 Show the last lines of the activity log
  help                Show this message

Options
  --count <n>         Headlines to show (1-14, default ${DEFAULTS.count})
  --interval <min>    Minutes between refreshes (default ${DEFAULTS.intervalMinutes})
  --theme <name>      ${themeNames.join(' | ')}
  --align <pos>       left | center | right (default ${DEFAULTS.align})
  --width/--height    Force a canvas size instead of auto-detecting the display
  --max-age <hours>   Ignore headlines older than this (default ${DEFAULTS.maxAgeHours})
  --trending <n>      Generally trending repos to show (default 3)
  --for-you <n>       Repos matched to your work from session history (default 2)
  --no-tools          Hide the open-source panel entirely
  --rescan            With "tools", rebuild the interest profile from scratch
  --screens <mode>    auto | mirror | single - how to use multiple displays
  --no-quote          Hide the quote band and give the space back to the columns
  --rotate <when>     daily | hourly - how often the quote changes
  --list              With "quote", print the whole pool
  --credentials <f>   With "connect google", the client JSON from Google Cloud
  --no-google         With "setup", skip the Google step
  --out <file>        Output path for "preview"
  --save              With "config", persist the given options
  --quiet             Suppress normal output (used by the scheduled task)

Examples
  ai-news-wallpaper update
  ai-news-wallpaper start --interval 30 --theme carbon
  ai-news-wallpaper config --count 9 --align left --save
  ai-news-wallpaper stop
`;

function printRepos(repos) {
  const { formatStars } = require('../src/github');
  repos.forEach((repo) => {
    const bits = [`${formatStars(repo.stars)} stars`];
    if (repo.language) bits.push(repo.language);
    if (repo.reason) bits.push(`matched: ${repo.reason}`);
    console.log(`  [${(repo.tag || '').padEnd(8)}] ${repo.fullName}`);
    console.log(`             ${repo.description}`);
    console.log(`             ${bits.join('  ·  ')}`);
  });
}

function printHeadlines(items) {
  const { timeAgo } = require('../src/feeds');
  items.forEach((item, i) => {
    console.log(`  ${String(i + 1).padStart(2, '0')}  ${item.title}`);
    console.log(`      ${item.source}${item.publishedAt ? `  ·  ${timeAgo(item.publishedAt)}` : ''}`);
  });
}

async function cmdUpdate(flags, quiet) {
  const overrides = overridesFrom(flags);
  validate(overrides);
  const result = await refresh(overrides);
  if (!quiet) {
    console.log(`\nWallpaper updated — ${result.shown} headlines at ${result.width}x${result.height}.`);
    printHeadlines(result.items.slice(0, result.shown));
    if (result.failures.length) {
      console.log(`\n  Note: ${result.failures.length} feed(s) unavailable: ${result.failures.map((f) => f.feed).join(', ')}`);
    }
    console.log(`\n  Image: ${result.imagePath}`);
  }
  return result;
}

async function cmdWatch(flags) {
  const overrides = overridesFrom(flags);
  validate(overrides);
  const config = { ...loadConfig(), ...overrides };
  const intervalMs = Math.max(1, config.intervalMinutes) * 60000;

  console.log(`Watching AI news — refreshing every ${config.intervalMinutes} minute(s). Press Ctrl+C to stop.`);
  const tick = async () => {
    try {
      const result = await refresh(overrides);
      console.log(`[${new Date().toLocaleTimeString()}] updated with ${result.shown} headlines`);
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] ${err.message}`);
      log(`ERROR ${err.message}`);
    }
  };
  await tick();
  setInterval(tick, intervalMs);
}

async function cmdStart(flags) {
  const overrides = overridesFrom(flags);
  validate(overrides);
  const config = { ...loadConfig(), ...overrides };
  if (Object.keys(overrides).length) saveConfig(config);

  const info = await schedule.installTasks(config.intervalMinutes);
  console.log(`\nScheduled task "${schedule.TASK_NAME}" installed — the wallpaper refreshes`);
  console.log(`every ${info.minutes} minute(s), and once a minute after you log in.`);
  console.log('Running the first refresh now...');
  await cmdUpdate(flags, false);
  console.log('\nStop it any time with:  ai-news-wallpaper stop');
}

async function cmdStop() {
  const results = await schedule.removeTasks();
  const removed = results.filter((r) => r.removed).map((r) => r.name);
  if (removed.length === 0) {
    console.log('No scheduled task was installed.');
  } else {
    console.log(`Removed: ${removed.join(', ')}`);
    console.log('Your current wallpaper stays as it is.');
  }
}

async function cmdStatus() {
  const config = loadConfig();
  const task = await schedule.taskStatus();

  console.log(`\nai-news-wallpaper v${pkg.version}`);
  console.log(`  Schedule     ${task.installed ? `installed (${task.state})` : 'not installed — run: ai-news-wallpaper start'}`);
  if (task.installed) {
    console.log(`  Next run     ${task.nextRun}`);
    console.log(`  Last run     ${task.lastRun} (result ${task.lastResult})`);
  }
  console.log(`  Interval     every ${config.intervalMinutes} minute(s)`);
  console.log(`  Headlines    ${config.count}`);
  console.log(`  Theme        ${config.theme}, aligned ${config.align}`);
  console.log(`  Feeds        ${config.feeds.length}`);

  try {
    const { detectScreens } = require('../src/screens');
    const displays = await detectScreens();
    const n = displays.monitors.length;
    console.log(`  Displays     ${n} (${displays.monitors.map((m) => `${m.width}x${m.height}`).join(', ')})` +
      `${n > 1 ? `, mode ${config.screens.mode}` : ''}${displays.perMonitor ? '' : ' — single wallpaper only'}`);
  } catch { /* status must not fail on display detection */ }

  const info = require('../src/google').connectionInfo();
  const who = config.profile && config.profile.name ? config.profile.name : '(not set — run: setup)';
  console.log(`  Registered   ${who}${config.profile && config.profile.email ? ` <${config.profile.email}>` : ''}`);
  if (info.connected) {
    console.log(`  Google       connected — mail ${config.google.morningFrom}:00-${config.google.morningTo}:00, calendar all day`);
  } else {
    console.log(`  Google       not connected${info.hasClient ? ' (client saved — run: connect google)' : ' — run: setup'}`);
  }
  console.log(`  Config       ${CONFIG_PATH}`);
  console.log(`  Images       ${IMAGE_DIR}`);
  console.log(`  Log          ${LOG_PATH}`);
}

async function cmdPreview(flags) {
  const overrides = overridesFrom(flags);
  validate(overrides);
  const out = typeof flags.out === 'string'
    ? path.resolve(flags.out)
    : path.join(process.cwd(), 'ai-news-preview.png');
  const result = await refresh(overrides, { setWallpaper: false, outputPath: out });
  console.log(`\nPreview written to ${result.imagePath} (${result.width}x${result.height}, ${result.shown} headlines).`);
  printHeadlines(result.items.slice(0, result.shown));
}

async function cmdConfig(flags) {
  const overrides = overridesFrom(flags);
  validate(overrides);
  const config = { ...loadConfig(), ...overrides };

  if (Object.keys(overrides).length && flags.save) {
    saveConfig(config);
    console.log(`Saved to ${CONFIG_PATH}`);
  } else if (Object.keys(overrides).length) {
    console.log('(preview only — add --save to persist)');
  }

  const shown = { ...config };
  shown.feeds = config.feeds.map((f) => f.name);
  shown.keywords = `${config.keywords.length} keyword(s)`;
  console.log(JSON.stringify(shown, null, 2));
}

async function cmdHeadlines(flags) {
  const overrides = overridesFrom(flags);
  validate(overrides);
  const { collectHeadlines } = require('../src/feeds');
  const config = { ...loadConfig(), ...overrides };
  const news = await collectHeadlines(config);
  console.log(`\n${news.items.length} of ${news.pool} matching headlines:\n`);
  printHeadlines(news.items);
  if (news.failures.length) {
    console.log('\nUnavailable feeds:');
    news.failures.forEach((f) => console.log(`  ${f.feed}: ${f.error}`));
  }
}

const ROLE_TEXT = {
  'all': 'everything together',
  'news': 'AI headlines',
  'news-more': 'more headlines (page 2)',
  'tools': 'open-source repos',
  'today': 'calendar + unread mail',
  'panels': 'repos + calendar/mail'
};

async function cmdScreens(flags) {
  const { detectScreens, planScreens } = require('../src/screens');
  const { collectRepos } = require('../src/github');
  const google = require('../src/google');
  const config = loadConfig();

  const displays = await detectScreens({ fresh: true });
  console.log(`
${displays.monitors.length} display(s) detected` +
    `${displays.perMonitor ? '' : '  (per-monitor wallpaper NOT available)'}`);
  if (displays.error) console.log(`  detection warning: ${displays.error}`);

  displays.monitors.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.width}x${m.height} at (${m.x},${m.y})${m.primary ? '  [primary]' : ''}`);
  });

  // What the planner would do given what is actually available right now.
  const hasRepos = config.tools.enabled !== false;
  const hasBrief = google.isConnected();
  const plan = planScreens(displays.monitors, {
    hasRepos, hasBrief, mode: config.screens.mode, assign: config.screens.assign
  });

  console.log(`
Plan (mode: ${config.screens.mode}):`);
  plan.forEach((entry) => {
    console.log(`  Screen ${entry.index + 1}  ->  ${entry.role.padEnd(10)} ${ROLE_TEXT[entry.role] || ''}`);
  });

  if (!hasBrief) console.log('\nGoogle is not connected, so there is no calendar/mail screen to assign.');
  if (displays.monitors.length === 1) {
    console.log('\nWith one display everything shares the screen. Attach another and');
    console.log('  the content spreads out automatically on the next refresh.');
  }
  if (!displays.perMonitor && displays.monitors.length > 1) {
    console.log('\nWindows is not exposing per-monitor wallpapers here, so a single');
    console.log('  image is used for the whole desktop.');
  }
}

function cmdQuote(flags) {
  const { pickQuote, QUOTES } = require('../src/quotes');
  const config = loadConfig();

  if (flags.list === true) {
    const custom = (config.quotes && config.quotes.custom) || [];
    const pool = custom.length ? custom : QUOTES;
    console.log(`\n${pool.length} quotes in the pool${custom.length ? ' (custom)' : ''}:\n`);
    pool.forEach((q, i) => {
      const entry = typeof q === 'string' ? { text: q, author: '' } : q;
      console.log(`  ${String(i + 1).padStart(2, '0')}  ${entry.text}`);
      if (entry.author) console.log(`      — ${entry.author}`);
    });
    return;
  }

  const quote = pickQuote(config);
  if (!quote) return console.log('Quotes are turned off.');

  const rotate = (config.quotes && config.quotes.rotate) || 'daily';
  console.log(`\n  "${quote.text}"`);
  if (quote.author) console.log(`      — ${quote.author}`);
  console.log(`\n  Rotates ${rotate}. Next change: ${rotate === 'hourly' ? 'top of the hour' : 'midnight'}.`);
}

async function cmdSetup(flags) {
  const { runSetup } = require('../src/onboard');
  await runSetup({ skipGoogle: flags['no-google'] === true });
  console.log('  Next:  ai-news-wallpaper start\n');
}

async function cmdConnect(flags, target) {
  if (target && target !== 'google') throw new Error(`Unknown service "${target}". Only "google" is supported.`);
  const google = require('../src/google');
  const { SETUP_STEPS } = require('../src/onboard');

  if (typeof flags.credentials === 'string') {
    google.saveClient({ fromFile: flags.credentials });
    console.log(`Saved OAuth client to ${google.CLIENT_PATH}`);
  } else if (typeof flags['client-id'] === 'string') {
    google.saveClient({ clientId: flags['client-id'], clientSecret: flags['client-secret'] });
    console.log(`Saved OAuth client to ${google.CLIENT_PATH}`);
  }

  if (!google.loadClient()) {
    console.log(SETUP_STEPS);
    console.log('  Then run:  ai-news-wallpaper connect google --credentials <client_secret.json>\n');
    process.exitCode = 1;
    return;
  }

  console.log('\nOpening your browser for Google sign-in.');
  console.log('You sign in yourself — this tool never sees your password.\n');
  await google.authorize({ onUrl: (url) => console.log(`If nothing opens, visit:\n${url}\n`) });
  console.log('Connected. Scopes granted (read-only, headers only — never message bodies):');
  google.SCOPES.forEach((scope) => console.log(`  ${scope}`));
  console.log('\nRevoke any time with:  ai-news-wallpaper disconnect google');
}

async function cmdDisconnect(target) {
  if (target && target !== 'google') throw new Error(`Unknown service "${target}". Only "google" is supported.`);
  const google = require('../src/google');
  await google.disconnect();
  console.log('Disconnected. The token was revoked with Google and removed from this machine.');
  console.log('The OAuth client details are kept so you can reconnect without redoing the console setup.');
}

async function cmdBrief(flags) {
  const google = require('../src/google');
  const { briefRequest, inMorningWindow } = require('../src/panels');
  const config = loadConfig();

  const info = google.connectionInfo();
  if (!info.connected) {
    console.log('\nNot connected to Google.');
    console.log(info.hasClient
      ? 'An OAuth client is saved. Run:  ai-news-wallpaper connect google'
      : 'Run:  ai-news-wallpaper setup');
    return;
  }

  const now = new Date();
  const request = briefRequest(config, now);
  const brief = await google.fetchBrief({ ...request, includeMail: true });

  console.log(`\nConnected${info.connectedAt ? ` since ${new Date(info.connectedAt).toLocaleDateString()}` : ''}.`);
  console.log(`Mail shows on the wallpaper between ${config.google.morningFrom}:00 and ${config.google.morningTo}:00` +
    ` (right now: ${inMorningWindow(now, config.google) ? 'yes' : 'no'}).`);

  if (brief.agenda) {
    console.log(`\nToday's calendar (${brief.agenda.total} remaining):`);
    if (!brief.agenda.events.length) console.log('  nothing left today');
    brief.agenda.events.forEach((event) => {
      const when = event.allDay ? 'ALL DAY' : new Date(event.startsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      console.log(`  ${when.padEnd(9)} ${event.title}${event.location ? `  (${event.location})` : ''}`);
    });
  }

  if (brief.mail) {
    console.log(`\nUnread inbox (${brief.mail.unread} total):`);
    if (!brief.mail.messages.length) console.log('  inbox zero');
    brief.mail.messages.forEach((msg) => {
      const tag = msg.starred ? 'STARRED' : msg.important ? 'IMPORTANT' : 'UNREAD';
      console.log(`  [${tag.padEnd(9)}] ${msg.from}`);
      console.log(`              ${msg.subject}`);
    });
  }

  if (brief.errors && brief.errors.length) {
    console.log('\nProblems:');
    brief.errors.forEach((err) => console.log(`  ${err}`));
  }
}

async function cmdTools(flags) {
  const overrides = overridesFrom(flags);
  validate(overrides);
  const { collectRepos, refreshProfile } = require('../src/github');
  const { TRANSCRIPT_ROOT } = require('../src/interests');
  const base = loadConfig();
  const config = { ...base, ...overrides, tools: { ...base.tools, ...(overrides.tools || {}) } };

  if (flags.rescan === true) {
    const fresh = refreshProfile(config);
    console.log(`\nRescanned ${fresh.sampledFiles} session transcripts under ${TRANSCRIPT_ROOT}`);
  }

  const result = await collectRepos(config);

  console.log('\nInterests inferred from your session history:');
  if (!result.profile.topics.length) {
    console.log('  (none yet — set "interests" in config.json to steer this manually)');
  }
  result.profile.topics.slice(0, 6).forEach((topic, i) => {
    console.log(`  ${i + 1}. ${topic.label}${topic.sessions ? `  (${topic.sessions} sessions)` : ''}  ->  "${topic.query}"`);
  });
  console.log(`  source: ${result.profile.source}${result.profile.sampledFiles ? `, ${result.profile.sampledFiles} transcripts scanned` : ''}`);

  console.log('\nRepos on the wallpaper:');
  printRepos(result.repos);
  if (result.error) console.log(`\n  GitHub error: ${result.error}${result.stale ? ' (showing cached repos)' : ''}`);
}

function cmdLog(flags) {
  if (!fs.existsSync(LOG_PATH)) return console.log('No log yet.');
  const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split(/\r?\n/);
  const n = Number.isFinite(flags.lines) ? flags.lines : 20;
  console.log(lines.slice(-n).join('\n'));
}

async function main() {
  const { command, flags, target } = parseArgs(process.argv.slice(2));
  const quiet = flags.quiet === true;

  try {
    switch (command) {
      case 'update': await cmdUpdate(flags, quiet); break;
      case 'setup': case 'register': await cmdSetup(flags); break;
      case 'connect': case 'link': await cmdConnect(flags, target); break;
      case 'disconnect': case 'unlink': await cmdDisconnect(target); break;
      case 'brief': case 'mail': case 'agenda': await cmdBrief(flags); break;
      case 'quote': case 'quotes': cmdQuote(flags); break;
      case 'screens': case 'displays': case 'monitors': await cmdScreens(flags); break;
      case 'watch': await cmdWatch(flags); break;
      case 'start': case 'install': await cmdStart(flags); break;
      case 'stop': case 'uninstall': await cmdStop(); break;
      case 'status': await cmdStatus(); break;
      case 'preview': await cmdPreview(flags); break;
      case 'config': await cmdConfig(flags); break;
      case 'headlines': case 'news': await cmdHeadlines(flags); break;
      case 'tools': case 'repos': await cmdTools(flags); break;
      case 'log': cmdLog(flags); break;
      case 'help': case '--help': case '-h': console.log(HELP); break;
      case 'version': case '--version': console.log(pkg.version); break;
      default:
        console.error(`Unknown command "${command}".`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    log(`ERROR ${err.message}`);
    if (!quiet) console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.platform !== 'win32') {
  console.error('ai-news-wallpaper currently supports Windows only.');
  process.exit(1);
}

main();
