// PlotMyPub — achievements catalogue. Pure data: no DOM, no network. The single
// source of truth for the badge set — the Levels tab renders from this, and the
// server-side award logic (later phase) uses the same codes as ledger types
// ('ach:<code>'). Rarity → XP and the locked/hidden rules live here so the UI
// and the demo stay in lock-step. See memory: achievements-design,
// avoid-generic-ai-gamification.

// Rarity → reward + label. Values users never see as raw points; the badge's
// ring material (blue/amber/purple/gold) is how rarity actually reads.
export const RARITY = {
  common:    { label: 'Common',    xp: 100 },
  rare:      { label: 'Rare',      xp: 300 },
  epic:      { label: 'Epic',      xp: 500 },
  legendary: { label: 'Legendary', xp: 1000 }
};

// Render / evaluation order, cheapest-to-earn first.
export const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];

// Epic + Legendary objectives stay hidden until unlocked — the criteria never
// ship for a locked one (server-side eval keeps them genuinely secret).
export function isHidden(rarity) { return rarity === 'epic' || rarity === 'legendary'; }

// The 25 badges. `code` is stable and doubles as the ledger type suffix
// ('ach:' + code); renaming the display `name` never orphans earned rows.
// `title: true` marks a comparative badge held by one person at a time
// (computed live, not in the append-only ledger — first win pays a one-off XP).
export const ACHIEVEMENTS = [
  // ---- Common ----
  { code: 'journalist',       name: 'Journalist',        emoji: '📰', rarity: 'common', objective: 'Review a pub with a note and a photo' },
  { code: 'nice_gaff',        name: 'Nice Gaff',         emoji: '🚻', rarity: 'common', objective: 'Give a pub 4.5+ for facilities' },
  { code: 'poor_me_poor_me',  name: 'Poor me, poor me…', emoji: '🍺', rarity: 'common', objective: 'Give a pub 4.5+ for beer selection' },
  { code: 'cash_money',       name: 'Cash Money',        emoji: '💷', rarity: 'common', objective: 'Give a pub 4.5+ for value' },
  { code: 'good_vibes',       name: 'Good Vibes',        emoji: '✨', rarity: 'common', objective: 'Give a pub 4.5+ for vibe' },
  { code: 'sheep',            name: 'Sheep',             emoji: '🐑', rarity: 'common', objective: 'Rate a pub five others have already rated' },
  { code: 'pub_crawler_1',    name: 'Pub Crawler I',     emoji: '🚶', rarity: 'common', objective: 'Rate 3 pubs in one day' },
  { code: 'going_sober',      name: 'Going Sober',       emoji: '🚱', rarity: 'common', objective: 'Go four weeks without rating a pub' },
  { code: 'first_beer',       name: 'I Remember My First Beer', emoji: '🍼', rarity: 'common', objective: 'Plot your first pub' },

  // ---- Rare ----
  { code: 'poor_me',          name: 'Poor Me',           emoji: '🥲', rarity: 'rare', objective: 'Give a pub under 1.5 for value' },
  { code: 'accountant',       name: 'Accountant',        emoji: '🧮', rarity: 'rare', objective: 'Rate 10 pubs above 4 for value' },
  { code: 'connoisseur',      name: 'Connoisseur',       emoji: '🧐', rarity: 'rare', objective: 'Rate 10 pubs above 4 for beer selection' },
  { code: 'on_the_sauce',     name: 'On the Sauce',      emoji: '🍷', rarity: 'rare', objective: 'Rate a pub three days running' },
  { code: 'pub_crawler_2',    name: 'Pub Crawler II',    emoji: '🥾', rarity: 'rare', objective: 'Rate 6 pubs in one day' },
  { code: 'brew_with_a_view', name: 'Brew with a View',  emoji: '⛰️', rarity: 'rare', objective: 'Rate a pub 1,000m+ above sea level' },
  { code: 'big_apple',        name: 'Big Apple',         emoji: '🎡', rarity: 'rare', objective: 'Hold the most London pubs in your group', title: true },
  { code: 'northerner',       name: 'Northerner',        emoji: '❄️', rarity: 'rare', objective: 'Map the furthest-north pub in your group', title: true },
  { code: 'southerner',       name: 'Southerner',        emoji: '🌴', rarity: 'rare', objective: 'Map the furthest-south pub in your group', title: true },

  // ---- Epic (objective hidden until unlocked) ----
  { code: 'diamond_in_the_rough', name: 'Diamond in the Rough', emoji: '💎', rarity: 'epic', objective: 'Score a pub under 2 for location but over 4 for vibe' },
  { code: 'blogger',          name: 'Blogger',           emoji: '✍️', rarity: 'epic', objective: 'Write a note that nearly fills the box' },
  { code: 'jet_setter',       name: 'Jet Setter',        emoji: '✈️', rarity: 'epic', objective: 'Rate a pub outside the UK' },
  { code: 'drink_driver',     name: 'Drink Driver',      emoji: '🚗', rarity: 'epic', objective: 'Rate pubs in two cities on the same day' },
  { code: 'pub_crawler_3',    name: 'Pub Crawler III',   emoji: '🏃', rarity: 'epic', objective: 'Rate 10 pubs in one day' },

  // ---- Legendary (objective hidden until unlocked) ----
  { code: 'alcoholic',        name: 'Alcoholic',         emoji: '🥴', rarity: 'legendary', objective: 'Rate a pub seven days running' },
  { code: 'mr_worldwide',     name: 'Mr Worldwide',      emoji: '🌍', rarity: 'legendary', objective: 'Rate pubs in 10 different countries' }
];

/** Ledger type string for a badge code, e.g. 'ach:jet_setter'. */
export function ledgerType(code) { return 'ach:' + code; }

/** How many badges exist in total (for the "n / total earned" counter). */
export const TOTAL = ACHIEVEMENTS.length;
