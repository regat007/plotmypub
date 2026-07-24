// PlotMyPub — the minimalist XP badge that sits in the top-right of the map:
// just the tier icon + a thin progress bar, no numbers, so it stays out of the
// way. Tapping it jumps to the Levels tab for the full story. Reads the same
// xp.mjs core + xp_events ledger as the Levels tab, so the two always agree.
// Refreshed on entering the app and after each pub is saved (a rating may have
// pushed the bar along). See memory: xp-levels-design.
import { $ } from './core.mjs';
import { showView } from './router.mjs';
import { fetchXp } from './api.mjs';
import { tierFor, progress } from './xp.mjs';

let wired = false;
function wire(el) {
  if (wired) return;
  const open = () => showView('levels');
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  wired = true;
}

/** Fetch the signed-in user's XP and paint the badge. Safe to call repeatedly;
 *  stays hidden if XP can't be read (e.g. the ledger migration isn't pushed). */
export async function refreshMapXp() {
  const el = $('mapXp');
  if (!el) return;
  wire(el);

  let xp = 0;
  try { xp = (await fetchXp()).xp || 0; }
  catch (e) { el.hidden = true; return; }

  const tier = tierFor(xp);
  const p = progress(xp);
  const pct = Math.round(p.frac * 100);
  el.querySelector('.mx-ic').textContent = tier.icon;
  el.querySelector('.mx-fill').style.width = pct + '%';
  el.setAttribute('aria-label', tier.title + ' · ' + xp + ' XP — open Levels');
  el.hidden = false;
}
