'use strict';

const { formatStars } = require('./github');
const { shortTime } = require('./google');
const { timeAgo } = require('./feeds');

const BULLET = '•';
const STAR = '★';

function join(...parts) {
  return parts.filter(Boolean).join(`  ${BULLET}  `);
}

function greeting(now, name) {
  const hour = now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

function clockLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** True while we are inside the configured morning window. */
function inMorningWindow(now, google) {
  const from = Number.isFinite(google.morningFrom) ? google.morningFrom : 5;
  const to = Number.isFinite(google.morningTo) ? google.morningTo : 12;
  const hour = now.getHours() + now.getMinutes() / 60;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

function eventEntry(event) {
  return {
    tag: event.allDay ? 'ALL DAY' : clockLabel(event.startsAt),
    tagStyle: 'accent',
    title: event.title,
    description: event.location || '',
    meta: join(event.duration, event.guests > 1 ? `${event.guests} guests` : '')
  };
}

function mailEntry(message) {
  return {
    tag: message.starred ? 'STARRED' : message.important ? 'IMPORTANT' : 'UNREAD',
    tagStyle: message.starred || message.important ? 'accent' : 'muted',
    title: message.from,
    description: message.subject,
    meta: shortTime(message.receivedAt)
  };
}

function repoEntry(repo) {
  return {
    tag: repo.tag || '',
    tagStyle: repo.tag === 'FOR YOU' ? 'accent' : 'muted',
    title: repo.fullName,
    description: repo.description,
    meta: join(`${STAR} ${formatStars(repo.stars)}`, repo.language, repo.reason)
  };
}

function paperEntry(paper) {
  return {
    tag: paper.category || 'arXiv',
    tagStyle: 'accent',
    title: paper.title,
    description: paper.authors || '',
    meta: paper.publishedAt ? timeAgo(paper.publishedAt) : 'new'
  };
}

function marketEntry(quote) {
  const move = quote.changePct == null
    ? ''
    : `${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%`;
  return {
    // Direction lives in the tag so it reads at a glance from across the room.
    tag: quote.changePct == null ? '' : (quote.changePct >= 0 ? 'UP' : 'DOWN'),
    tagStyle: quote.changePct == null ? 'muted' : (quote.changePct >= 0 ? 'up' : 'down'),
    title: `${quote.label}  ${quote.priceText}`,
    description: '',
    meta: join(move, quote.currency)
  };
}

function weatherEntries(weather) {
  const unit = weather.unit;
  const entries = [{
    tag: 'NOW',
    tagStyle: 'accent',
    title: `${weather.now}${unit}  ${weather.text}`,
    description: '',
    meta: join(`feels ${weather.feelsLike}${unit}`, weather.wind != null ? `wind ${weather.wind} km/h` : '')
  }];

  const dayName = (iso, i) => {
    if (i === 0) return 'TODAY';
    const d = new Date(`${iso}T12:00:00`);
    return d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  };

  weather.days.slice(0, 3).forEach((day, i) => {
    entries.push({
      tag: dayName(day.date, i),
      tagStyle: 'muted',
      title: `${day.low}${unit} - ${day.high}${unit}`,
      description: day.text,
      meta: day.rainChance != null ? `${day.rainChance}% rain` : ''
    });
  });
  return entries;
}

function hackerNewsEntry(story) {
  return {
    tag: `${story.score}`,
    tagStyle: 'muted',
    title: story.title,
    description: '',
    meta: join(story.site, story.comments ? `${story.comments} comments` : '')
  };
}

function onThisDayEntry(event) {
  return { tag: event.year, tagStyle: 'muted', title: event.text, description: '', meta: '' };
}

/**
 * Builds the stacked panels for the side column. `TODAY` comes first when there
 * is anything in it, because the day's commitments outrank a repo suggestion.
 */
function buildPanels({ repos = [], brief = null, extras = {}, config = {}, now = new Date() }) {
  const panels = [];
  const google = config.google || {};
  const profile = config.profile || {};

  if (brief && brief.connected) {
    const entries = [];
    const events = (brief.agenda && brief.agenda.events) || [];
    const messages = (brief.mail && brief.mail.messages) || [];

    entries.push(...events.map(eventEntry));
    entries.push(...messages.map(mailEntry));

    if (entries.length) {
      const bits = [];
      if (brief.agenda) {
        bits.push(events.length
          ? `${brief.agenda.total} event${brief.agenda.total === 1 ? '' : 's'} left today`
          : 'nothing left on the calendar');
      }
      if (brief.mail) bits.push(`${brief.mail.unread} unread`);
      panels.push({
        heading: 'TODAY',
        subheading: `${greeting(now, profile.name)}${bits.length ? `  ${BULLET}  ${bits.join(`  ${BULLET}  `)}` : ''}`,
        entries
      });
    }
  }

  if (repos.length) {
    panels.push({
      heading: 'OPEN SOURCE',
      subheading: 'trending on github, and picks for your work',
      entries: repos.map(repoEntry)
    });
  }

  if (extras.papers && extras.papers.length) {
    panels.push({
      heading: 'PAPERS',
      subheading: 'latest on arxiv',
      entries: extras.papers.map(paperEntry)
    });
  }

  if (extras.markets && extras.markets.length) {
    panels.push({
      heading: 'MARKETS',
      subheading: 'last close and change',
      entries: extras.markets.map(marketEntry)
    });
  }

  if (extras.weather) {
    panels.push({
      heading: 'WEATHER',
      subheading: extras.weather.place + (extras.weather.guessed ? '  (from your IP)' : ''),
      entries: weatherEntries(extras.weather)
    });
  }

  if (extras.hackerNews && extras.hackerNews.length) {
    panels.push({
      heading: 'HACKER NEWS',
      subheading: 'top of the front page',
      entries: extras.hackerNews.map(hackerNewsEntry)
    });
  } else if (extras.onThisDay && extras.onThisDay.length) {
    panels.push({
      heading: 'ON THIS DAY',
      subheading: 'from wikipedia',
      entries: extras.onThisDay.map(onThisDayEntry)
    });
  }

  return panels;
}

/** What to ask Google for on this run, given the time of day and settings. */
function briefRequest(config, now = new Date()) {
  const google = config.google || {};
  if (google.enabled === false) return { includeMail: false, includeCalendar: false };
  const morning = inMorningWindow(now, google);
  return {
    mailCount: Number.isFinite(google.mail) ? google.mail : 4,
    eventCount: Number.isFinite(google.events) ? google.events : 4,
    // Mail is a morning briefing by default; the calendar stays useful all day.
    includeMail: google.alwaysShowMail === true || morning,
    includeCalendar: true
  };
}

module.exports = { buildPanels, briefRequest, inMorningWindow, BULLET, STAR };
