# ai-news-wallpaper

Keeps your Windows desktop wallpaper updated with the latest AI headlines.

It pulls stories from a handful of RSS feeds (Google News, TechCrunch, The Verge,
Ars Technica, VentureBeat, MIT Technology Review, Hacker News), renders a clean
typographic image at your exact screen resolution, and sets it as the wallpaper.
A Windows scheduled task repeats this on an interval.

Alongside the headlines it can show two more panels:

- **OPEN SOURCE** — three repos generally trending on GitHub, plus two picked to
  match what you are actually working on. See [Repo suggestions](#repo-suggestions).
- **TODAY** — your calendar for the day and your top unread mail each morning,
  if you link a Google account. See [Gmail and Calendar](#gmail-and-calendar).

On a wide screen each panel gets its own column; on a narrower one they stack
down the side and the entry counts shrink to fit. Nothing ever overflows.

**No npm dependencies.** News is fetched with Node's built-in `fetch`; the image
is drawn by .NET `System.Drawing` through PowerShell, so there is nothing to
compile and no API keys to configure.

## Install

```bash
npm install -g ai-news-wallpaper
```

Or from a local clone:

```bash
npm install -g .
```

Requires Windows and Node 18+.

Then register yourself and, optionally, link Google:

```bash
ai-news-wallpaper setup
```

Everything in setup is skippable — the wallpaper works with none of it.

## Use

Refresh the wallpaper once:

```bash
ai-news-wallpaper update
```

Turn on automatic refreshing (installs a Windows scheduled task):

```bash
ai-news-wallpaper start --interval 60
```

Turn it off again — your current wallpaper stays as it is:

```bash
ai-news-wallpaper stop
```

## Commands

| Command | What it does |
| --- | --- |
| `setup` | Register your name and email, and optionally link Google |
| `connect google` | Link Gmail + Calendar (read-only) via OAuth |
| `disconnect google` | Revoke the token and delete it from this machine |
| `brief` | Print today's calendar and unread mail to the terminal |
| `quote` | Show today's quote (`--list` for the whole pool) |
| `update` | Fetch the news and set the wallpaper once (default command) |
| `start` | Install the scheduled task and run the first refresh |
| `stop` | Remove the scheduled task |
| `status` | Show the schedule, last run and current settings |
| `watch` | Refresh on an interval in the foreground (Ctrl+C to stop) |
| `preview` | Render to a PNG **without** touching your wallpaper |
| `config` | Show or change saved settings |
| `headlines` | Print the headlines that would be used |
| `tools` | Show the inferred interests and the repos that would be shown |
| `log` | Show recent activity |

## Options

| Flag | Default | Notes |
| --- | --- | --- |
| `--count <n>` | `7` | Headlines to show, 1–14 |
| `--interval <min>` | `60` | Minutes between refreshes |
| `--theme <name>` | `midnight` | `midnight`, `carbon`, `slate`, `daylight` |
| `--align <pos>` | `right` | `left`, `center`, `right` — `right` keeps your desktop icons clear |
| `--width`, `--height` | auto | Force a canvas size instead of detecting the display |
| `--max-age <hours>` | `48` | Ignore headlines older than this |
| `--trending <n>` | `3` | Generally trending repos in the open-source panel |
| `--for-you <n>` | `2` | Repos matched to your work from session history |
| `--no-tools` | — | Hide the open-source panel entirely |
| `--rescan` | — | With `tools`, rebuild the interest profile from scratch |
| `--out <file>` | — | Output path for `preview` |
| `--save` | — | With `config`, persist the given options |

Examples:

```bash
ai-news-wallpaper start --interval 30 --theme carbon
```

```bash
ai-news-wallpaper config --count 9 --align left --save
```

```bash
ai-news-wallpaper preview --theme daylight --out sample.png
```

## Where things live

```
%USERPROFILE%\.ai-news-wallpaper\
  config.json                 saved settings
  cache.json                  cached interest profile and last good repo list
  google-client.json          your Google OAuth client id/secret
  google-auth.json            Google refresh token (user-only ACL)
  images\                     the last 3 rendered wallpapers
  run-hidden.vbs              launcher used by the scheduled task (no console flash)
  ai-news-wallpaper.log       activity log
```

Two scheduled tasks are created by `start`: **AI News Wallpaper** (the interval
refresh) and **AI News Wallpaper Logon** (one refresh a minute after you log in).
`stop` removes both.

## Repo suggestions

The **OPEN SOURCE** panel holds five repos, in two groups.

**3 × `TRENDING`** — a GitHub search for repos created in the last 60 days that
already have real traction, ranked by stars. Newly rising projects, not the same
all-time giants every refresh. The visible slice rotates hourly, so you keep
seeing different ones.

**2 × `FOR YOU`** — matched to what you are actually working on. The tool reads
your local Claude Code session transcripts from
`%USERPROFILE%\.claude\projects\*.jsonl`, extracts **your own messages only**
(tool output and file dumps are skipped so they cannot swamp the signal), and
scores them against a topic vocabulary. The top-ranked topics become GitHub
searches, and the highest-starred well-maintained match for each becomes a pick.
The tag line shows which interest matched.

Scoring is deliberately biased toward standing interests: hits within a session
are counted on a log scale so one long repetitive session cannot dominate, and a
topic gets a bonus for every *separate* session it appears in. Recent sessions
count for more.

See what it inferred, and what that produces:

```bash
ai-news-wallpaper tools --rescan
```

### Privacy

Your transcripts are read locally and never uploaded. What leaves your machine is
a short generic search phrase — `"workflow automation"`, `"charting library"` —
sent to the public GitHub search API. Nothing identifying, no file contents, no
message text. The profile is cached for 6 hours in `cache.json`.

### Steering it manually

If you would rather choose the topics yourself, set `interests` in
`config.json`. Anything there overrides the inferred profile completely:

```json
{
  "interests": [
    "algorithmic trading",
    { "label": "Charting", "query": "candlestick chart library" }
  ]
}
```

Turn the panel off entirely with `--no-tools`, or set `tools.enabled` to `false`.

GitHub's search API is used unauthenticated, which is enough for an hourly
refresh. Set a `GITHUB_TOKEN` environment variable if you want a higher rate
limit. If GitHub is unreachable, the last good repo list is reused and the
headlines render regardless.

## Gmail and Calendar

The **TODAY** panel shows the day's remaining calendar events and, each morning,
your top unread mail — most important first, using Gmail's own importance and
starred markers.

### Read this first

Whatever appears in this panel is **on your desktop background**. Anyone who can
see your screen — over your shoulder, in a screen share, on a projector — can
read your senders and subject lines. That is the point of the feature, but it is
worth deciding deliberately. Turn it off instantly at any time:

```bash
ai-news-wallpaper disconnect google
```

### One-time Google setup

Google requires an OAuth client to let any application read your mail. It is free
and takes about five minutes, once.

1. Open <https://console.cloud.google.com/apis/credentials>
2. Create a project, or pick an existing one.
3. **APIs & Services → Enabled APIs** → enable **Gmail API** and **Google Calendar API**.
4. **OAuth consent screen** → External → add your own address under **Test users**.
5. **Credentials → Create credentials → OAuth client ID → Desktop app**.
6. Download the JSON.

Then:

```bash
ai-news-wallpaper connect google --credentials "C:\path\to\client_secret.json"
```

Your browser opens on Google's consent screen. **You sign in yourself** — the
tool never sees or handles your password. It receives a refresh token on a
loopback redirect and stores it locally.

Check it worked:

```bash
ai-news-wallpaper brief
```

### Scopes

Deliberately the narrowest two that do the job:

| Scope | What it allows |
| --- | --- |
| `gmail.metadata` | Message **headers only** — sender, subject, date. Message bodies and attachments are never requested and cannot be read with this scope. No ability to send, delete, or modify anything. |
| `calendar.events.readonly` | Read-only view of events. No ability to create or change them. |

Tokens live in `%USERPROFILE%\.ai-news-wallpaper\google-auth.json`, restricted to
your Windows user with `icacls`. `disconnect` revokes the token with Google *and*
deletes the local copy. You can also revoke it at
<https://myaccount.google.com/permissions>.

### Timing and tuning

Mail appears during a morning window; the calendar shows all day. Defaults live
under `google` in `config.json`:

```json
{
  "google": {
    "enabled": true,
    "mail": 4,
    "events": 4,
    "morningFrom": 5,
    "morningTo": 12,
    "alwaysShowMail": false
  }
}
```

Set `alwaysShowMail` to `true` to show unread mail around the clock, or
`enabled` to `false` to keep the account linked but hide the panel.

## Motivational quotes

A full-width band along the bottom carries a short, hard-edged quote. It rotates
**daily** by default, so it reads as a quote of the day rather than flickering on
every hourly refresh.

```bash
ai-news-wallpaper quote           # what's showing today
ai-news-wallpaper quote --list    # the whole pool
```

Settings live under `quotes` in `config.json`:

```json
{
  "quotes": {
    "enabled": true,
    "rotate": "daily",
    "custom": []
  }
}
```

Set `rotate` to `"hourly"` to change it every refresh. Turn the band off entirely
with `enabled: false` or `--no-quote` — the columns then reclaim the space.

Anything in `custom` **replaces** the built-in list. Both forms work:

```json
{
  "quotes": {
    "custom": [
      "Ship it.",
      { "text": "Volatility is the price of admission.", "author": "The desk" }
    ]
  }
}
```

## Customising the feeds

Edit `feeds` in `%USERPROFILE%\.ai-news-wallpaper\config.json`. Any RSS or Atom
feed works:

```json
{
  "feeds": [
    { "name": "TechCrunch", "url": "https://techcrunch.com/category/artificial-intelligence/feed/" },
    { "name": "My Source",  "url": "https://example.com/feed.xml" }
  ]
}
```

`splitSource: true` on a feed tells the parser to read Google-News-style
`"Headline - Publisher"` titles and show the publisher as the source.

The `keywords` array gates which headlines qualify as AI news. Set it to `[]` to
accept everything a feed publishes.

## Troubleshooting

- **The wallpaper didn't change.** Run `ai-news-wallpaper log` — every refresh
  writes a line. `OK` means the image was rendered and applied.
- **The task never fires.** `ai-news-wallpaper status` shows the next and last
  run times straight from Task Scheduler. Note that the task only runs while you
  are logged in, which is the only time the wallpaper matters.
- **Wrong resolution on a multi-monitor setup.** The primary display is detected
  automatically; override it with `--width` / `--height` and `--save`.
- **Getting your old wallpaper back.** `ai-news-wallpaper stop`, then pick your
  wallpaper again in Settings → Personalization → Background.

## Licence

MIT
