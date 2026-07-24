// PlotMyPub — XP & levels core. Pure: no DOM, no network. The single source of
// truth for how a raw XP total (summed from the xp_events ledger) maps to a
// tier and how far you are through it. Exported so the Levels tab AND a
// standalone demo render from exactly the same numbers. See memory: xp-levels-design.

// What each ledger event is worth. MIRRORS supabase/migrations/0004_xp.sql —
// the database is authoritative (it awards); these are for labels + estimates.
// Keep the two in sync when retuning.
export const XP_VALUES = {
  rate_pub:   50,   // base — every rating earns, unconditionally
  new_area:   20,   // first pub you've rated in an area
  first_map:  10,   // first in the group to map this pub
  with_note:  10,   // you wrote a note
  with_photo: 10    // you added a photo
};

// Human-facing labels for the "recent XP" feed.
export const XP_LABELS = {
  rate_pub:   'Rated a pub',
  new_area:   'New area explored',
  first_map:  'First to map it',
  with_note:  'Wrote a note',
  with_photo: 'Added a photo'
};

// The six tiers, keyed on cumulative XP. Hand-tuned thresholds (deliberately NOT
// a formula — even, round steps read as generic): steepening gaps that keep the
// top open for achievements. Names + emoji match the old pub-count ranks in
// me.mjs, now driven by XP instead of a raw count.
export const TIERS = [
  { at: 0,     title: 'New in town',          icon: '🌱' },
  { at: 50,    title: 'First Rounds',         icon: '🍺' },
  { at: 500,   title: 'Regular',              icon: '🍻' },
  { at: 2500,  title: 'Seasoned Regular',     icon: '🎖️' },
  { at: 7500,  title: "Landlord's Favourite", icon: '🏅' },
  { at: 18000, title: 'Pub Legend',           icon: '👑' }
];

/** Index of the tier a given XP total sits in. */
export function tierIndexFor(xp) {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (xp >= TIERS[k].at) i = k;
  return i;
}

/** The tier a given XP total sits in. */
export function tierFor(xp) { return TIERS[tierIndexFor(xp)]; }

/** The next tier up, or null if already at the top. */
export function nextTier(xp) {
  const i = tierIndexFor(xp);
  return i + 1 < TIERS.length ? TIERS[i + 1] : null;
}

/**
 * Progress through the current tier toward the next.
 * { done, need, frac (0–1), remaining, maxed }. At the top tier: maxed = true,
 * frac = 1, and `done` is XP earned beyond the final threshold.
 */
export function progress(xp) {
  const i = tierIndexFor(xp);
  const cur = TIERS[i];
  const nxt = TIERS[i + 1];
  if (!nxt) return { done: xp - cur.at, need: 0, frac: 1, remaining: 0, maxed: true };
  const done = xp - cur.at;
  const need = nxt.at - cur.at;
  return {
    done, need,
    frac: Math.max(0, Math.min(1, done / need)),
    remaining: nxt.at - xp,
    maxed: false
  };
}

/**
 * Sum ledger rows to a total. `amount` from the DB is authoritative; XP_VALUES
 * is only a fallback for rows/previews that carry a type but no amount.
 */
export function totalXp(events) {
  return (events || []).reduce(
    (a, e) => a + (e.amount != null ? e.amount : (XP_VALUES[e.type] || 0)), 0);
}
