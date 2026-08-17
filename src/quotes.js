'use strict';

/**
 * Short, hard-edged, attributed lines. Kept deliberately brief - a wallpaper is
 * read in a glance, and short quotations with attribution are the safe kind to
 * ship. Users can replace the whole list via `quotes.custom` in config.json.
 */
const QUOTES = [
  { text: 'Suffer now and live the rest of your life as a champion.', author: 'Muhammad Ali' },
  { text: "Don't count the days. Make the days count.", author: 'Muhammad Ali' },
  { text: 'Everybody has a plan until they get punched in the mouth.', author: 'Mike Tyson' },
  { text: 'Discipline is doing what you hate to do but doing it like you love it.', author: 'Mike Tyson' },
  { text: 'Discipline equals freedom.', author: 'Jocko Willink' },
  { text: 'Get comfortable being uncomfortable.', author: 'David Goggins' },
  { text: "You are stopping at 40% of what you're capable of.", author: 'David Goggins' },
  { text: 'Hard choices, easy life. Easy choices, hard life.', author: 'Jerzy Gregorek' },
  { text: 'The only easy day was yesterday.', author: 'US Navy SEALs' },
  { text: 'Under pressure you sink to the level of your training.', author: 'Archilochus' },

  { text: 'What stands in the way becomes the way.', author: 'Marcus Aurelius' },
  { text: 'You have power over your mind, not outside events. Realise this, and you will find strength.', author: 'Marcus Aurelius' },
  { text: 'Waste no more time arguing what a good man should be. Be one.', author: 'Marcus Aurelius' },
  { text: 'We suffer more often in imagination than in reality.', author: 'Seneca' },
  { text: 'Difficulties strengthen the mind, as labour does the body.', author: 'Seneca' },
  { text: 'It is not that we have a short time to live, but that we waste a lot of it.', author: 'Seneca' },
  { text: 'No man is free who is not master of himself.', author: 'Epictetus' },
  { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
  { text: 'That which does not kill us makes us stronger.', author: 'Friedrich Nietzsche' },
  { text: 'The man who moves a mountain begins by carrying away small stones.', author: 'Confucius' },

  { text: 'It is not the critic who counts.', author: 'Theodore Roosevelt' },
  { text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt' },
  { text: 'Whether you think you can or think you cannot, you are right.', author: 'Henry Ford' },
  { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
  { text: 'Nothing will work unless you do.', author: 'Maya Angelou' },
  { text: 'Amateurs sit and wait for inspiration. The rest of us just get up and go to work.', author: 'Stephen King' },
  { text: 'Action is the foundational key to all success.', author: 'Pablo Picasso' },
  { text: 'Either you run the day, or the day runs you.', author: 'Jim Rohn' },
  { text: 'Excellence is not an act, but a habit.', author: 'Will Durant' },
  { text: 'A year from now you may wish you had started today.', author: 'Karen Lamb' },

  { text: 'It is not whether you get knocked down. It is whether you get up.', author: 'Vince Lombardi' },
  { text: 'Chase perfection and you can catch excellence.', author: 'Vince Lombardi' },
  { text: "If you're afraid to fail, then you're probably going to fail.", author: 'Kobe Bryant' },
  { text: 'Pain is temporary. Quitting lasts forever.', author: 'Lance Armstrong' },
  { text: 'I fear the man who has practised one kick ten thousand times.', author: 'Bruce Lee' },
  { text: 'Do not pray for an easy life. Pray for the strength to endure a difficult one.', author: 'Bruce Lee' },
  { text: 'The successful warrior is the average man, with laser-like focus.', author: 'Bruce Lee' },
  { text: 'The best revenge is massive success.', author: 'Frank Sinatra' },
  { text: 'Comfort is the enemy of progress.', author: 'P. T. Barnum' },
  { text: 'Fall seven times, stand up eight.', author: 'Japanese proverb' }
];

/** Days since the epoch, in local time - the seed for "quote of the day". */
function dayIndex(now) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(midnight.getTime() / 86400000);
}

function hourIndex(now) {
  return Math.floor(now.getTime() / 3600000);
}

/**
 * Picks the quote for this moment. Daily by default, so it reads as a "quote of
 * the day" instead of flickering on every hourly refresh.
 * @returns {{text: string, author: string}|null}
 */
function pickQuote(config = {}, now = new Date()) {
  const settings = config.quotes || {};
  if (settings.enabled === false) return null;

  const custom = Array.isArray(settings.custom) ? settings.custom.filter(Boolean) : [];
  const pool = custom.length
    ? custom.map((entry) => (typeof entry === 'string' ? { text: entry, author: '' } : entry))
    : QUOTES;
  if (!pool.length) return null;

  const seed = settings.rotate === 'hourly' ? hourIndex(now) : dayIndex(now);
  const quote = pool[((seed % pool.length) + pool.length) % pool.length];

  return { text: String(quote.text || '').trim(), author: String(quote.author || '').trim() };
}

module.exports = { pickQuote, QUOTES };
