// PlotMyPub — shared pinned-badge rendering. A compact version of the .ach-medal
// component (styles.css) plus a strip of someone's pinned badges, used wherever
// pins surface outside the Me tab: the map's XP pill (your own) and the Social
// leaderboard (everyone's). The full medallion lives on the Levels/Me tabs; here
// we render the same ring + disc at mini size and drop the rays/gloss/sheen so a
// row of them stays quiet. See memory: achievements-design, me-tab-design.
import { escapeHtml } from './core.mjs';
import { ACHIEVEMENTS } from './achievements.mjs';

const BY_CODE = {};
ACHIEVEMENTS.forEach((a) => { BY_CODE[a.code] = a; });

/** A single mini medallion for a badge code. Unknown codes render nothing. */
export function miniMedal(code) {
  const a = BY_CODE[code];
  if (!a) return '';
  // Divs (not spans) so .ach-ring's width/height apply — it has no display rule
  // of its own; the .pin-strip flex container lays them out in a row regardless.
  return '<div class="ach-medal mini ' + a.rarity + '" title="' + escapeHtml(a.name) + '">' +
    '<div class="ach-ring"><div class="ach-disc"><span class="ach-emoji">' + a.emoji +
      '</span></div></div>' +
  '</div>';
}

/** A horizontal strip of up to 3 pinned badges. Empty string when there are none
 *  (callers use that to skip rendering the container entirely). */
export function pinnedStripHtml(codes, extraClass) {
  const medals = (codes || []).slice(0, 3).map(miniMedal).filter(Boolean).join('');
  if (!medals) return '';
  return '<span class="pin-strip' + (extraClass ? ' ' + extraClass : '') + '">' + medals + '</span>';
}
