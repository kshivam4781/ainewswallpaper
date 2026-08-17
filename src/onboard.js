'use strict';

const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { loadConfig, saveConfig } = require('./config');
const google = require('./google');

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

const SETUP_STEPS = `
  To let this tool read your Gmail and Calendar, Google needs an OAuth client.
  It is free and takes about five minutes, once.

    1. Open ${CONSOLE_URL}
    2. Create a project (or pick an existing one).
    3. APIs & Services > Enabled APIs > enable "Gmail API" and "Google Calendar API".
    4. OAuth consent screen > External > add yourself as a Test user.
    5. Credentials > Create credentials > OAuth client ID > Desktop app.
    6. Download the JSON. That is the file you point this command at.
`;

function ask(rl, question, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  return rl.question(`  ${question}${suffix}: `).then((answer) => answer.trim() || fallback);
}

async function confirm(rl, question, defaultYes = true) {
  const answer = (await rl.question(`  ${question} ${defaultYes ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

/**
 * The interactive first-run flow: who you are, then optionally linking Google.
 * Every step is skippable - the wallpaper works without any of it.
 */
async function runSetup({ skipGoogle = false } = {}) {
  if (!stdin.isTTY) {
    throw new Error('Setup needs an interactive terminal. Run "ai-news-wallpaper setup" directly in a console.');
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const config = loadConfig();
    const profile = { ...config.profile };

    console.log('\n  ai-news-wallpaper setup');
    console.log('  ' + '-'.repeat(48));
    console.log('  Press Enter to accept a default, or leave blank to skip.\n');

    profile.name = await ask(rl, 'Your name (used for the morning greeting)', profile.name);
    profile.email = await ask(rl, 'Your email', profile.email);

    saveConfig({ ...config, profile });
    console.log(`\n  Saved.${profile.name ? ` Morning greetings will say "Good morning, ${profile.name}".` : ''}\n`);

    if (skipGoogle) return { profile, google: false };

    console.log('  Gmail + Calendar panel');
    console.log('  ' + '-'.repeat(48));
    console.log('  Shows your unread mail each morning and today\'s events, on the wallpaper.');
    console.log('  Note: anyone who can see your screen can read them. You can turn this');
    console.log('  off at any time with "ai-news-wallpaper disconnect google".\n');

    if (!(await confirm(rl, 'Connect a Google account now?', false))) {
      console.log('\n  Skipped. Connect later with: ai-news-wallpaper connect google\n');
      return { profile, google: false };
    }

    if (!google.loadClient()) {
      console.log(SETUP_STEPS);
      const file = await ask(rl, 'Path to the downloaded client JSON (blank to do this later)');
      if (!file) {
        console.log('\n  No problem. When you have it: ai-news-wallpaper connect google --credentials <file>\n');
        return { profile, google: false };
      }
      google.saveClient({ fromFile: file.replace(/^"|"$/g, '') });
      console.log('  OAuth client saved.\n');
    }

    console.log('  Opening your browser for Google sign-in...');
    console.log('  You sign in yourself - this tool never sees your password.\n');
    await google.authorize({ onUrl: (url) => console.log(`  If nothing opens, visit:\n  ${url}\n`) });
    console.log('  Connected.\n');

    return { profile, google: true };
  } finally {
    rl.close();
  }
}

module.exports = { runSetup, SETUP_STEPS, CONSOLE_URL };
