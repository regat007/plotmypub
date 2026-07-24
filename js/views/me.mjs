// PlotMyPub — Me tab. Your personal drinking dashboard: heavy stats and, true to
// the app's name, actual PLOTS of how you rate. Everything is computed from the
// ratings already in the database (same source as Feed/Social — no backend work):
//   • a radar "taste fingerprint" of your five category averages
//   • a histogram of how you spread your overall scores (colour-ramped)
//   • a timeline of pubs plotted per month
//   • superlatives (favourite, harshest, softest/toughest category)
//   • how generous you are versus the rest of the group
// The chart builders are pure string→SVG and exported so a standalone preview
// page can render them with mock data. See memory: demo-in-browser-during-dev.
import { registerView } from '../router.mjs';
import { S, colourFor, escapeHtml } from '../core.mjs';
import { CATS } from '../config.mjs';
import { fetchPubs } from '../api.mjs';

const el = document.querySelector('.view-ph[data-view="me"]');

// short axis labels for the radar (CATS labels are too long to ring a small chart)
const SHORT = { location: 'Location', beer: 'Beer', value: 'Value', facilities: 'Facilities', vibe: 'Vibe' };

// drinker rank, earned by how many pubs you've plotted
const RANKS = [
  { at: 0,  title: 'New in town',        icon: '🌱' },
  { at: 1,  title: 'First Rounds',       icon: '🍺' },
  { at: 5,  title: 'Regular',            icon: '🍻' },
  { at: 15, title: 'Seasoned Regular',   icon: '🎖️' },
  { at: 30, title: "Landlord's Favourite", icon: '🏅' },
  { at: 50, title: 'Pub Legend',         icon: '👑' }
];
function rankFor(n) { let r = RANKS[0]; for (const x of RANKS) if (n >= x.at) r = x; return r; }

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function fmt(v, d = 1) { return v == null || isNaN(v) ? '—' : v.toFixed(d); }

// ======================= stats =======================
// Reduce the group's pubs down to just my ratings and everything derived from them.
export function computeStats(pubs, meId) {
  const mine = [];               // { pub, area, city, score, cats, ratedAt }
  let groupSum = 0, groupN = 0;
  pubs.forEach((p) => {
    (p.ratings || []).forEach((r) => {
      groupSum += r.score; groupN += 1;
      if (r.profileId === meId) {
        mine.push({
          pub: p.pub, area: p.area || '',
          city: (p.area || '').split(',')[0].trim() || p.area || '',
          score: r.score, cats: r.cats || {}, ratedAt: r.ratedAt
        });
      }
    });
  });

  const count = mine.length;
  const scores = mine.map((m) => m.score);
  const avg = count ? scores.reduce((a, b) => a + b, 0) / count : null;
  const groupAvg = groupN ? groupSum / groupN : null;

  // per-category averages, 0–5
  const catAvg = CATS.map((c) => {
    const vals = mine.map((m) => m.cats[c.key]).filter((v) => v != null);
    const v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return { key: c.key, label: c.label, short: SHORT[c.key] || c.label, v };
  });

  // superlatives
  const sorted = mine.slice().sort((a, b) => b.score - a.score);
  const fav = sorted[0] || null;
  const worst = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  const rated = catAvg.filter((c) => c.v != null);
  const soft = rated.length ? rated.slice().sort((a, b) => b.v - a.v)[0] : null;   // you score highest
  const tough = rated.length ? rated.slice().sort((a, b) => a.v - b.v)[0] : null;  // you score lowest

  const cities = new Set(mine.map((m) => m.city).filter(Boolean));

  return {
    count, avg, groupAvg, catAvg, mine, scores,
    top: fav ? fav.score : null, favPub: fav,
    worstPub: worst, soft, tough,
    cities: cities.size,
    tendency: (avg != null && groupAvg != null) ? avg - groupAvg : null
  };
}

// ======================= chart builders (pure) =======================
function roundedTopBar(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return 'M' + x + ',' + (y + h) +
    'V' + (y + r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + (-r) +
    'h' + (w - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
    'V' + (y + h) + 'Z';
}

// Radar / pentagon of the five category averages (0–5). One entity, five axes —
// a single slate fill with each vertex dotted in its own score colour.
export function buildRadar(catAvg) {
  const W = 280, H = 232, cx = 140, cy = 112, R = 78, n = catAvg.length;
  const ang = (i) => (-90 + i * (360 / n)) * Math.PI / 180;
  const at = (val, i, rad) => {
    const rr = (val / 5) * (rad == null ? R : rad);
    return [cx + rr * Math.cos(ang(i)), cy + rr * Math.sin(ang(i))];
  };
  const poly = (vals) => vals.map((v, i) => at(v, i).join(',')).join(' ');

  // concentric grid rings at 1..5, spokes, and the outer boundary
  let grid = '';
  for (let lvl = 1; lvl <= 5; lvl++) {
    const pts = catAvg.map((_, i) => at(lvl, i).join(',')).join(' ');
    grid += '<polygon points="' + pts + '" fill="none" stroke="#e3e3e0" stroke-width="1"' +
      (lvl === 5 ? ' stroke="#d3d5d1"' : '') + '/>';
  }
  catAvg.forEach((_, i) => {
    const [x, y] = at(5, i);
    grid += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y + '" stroke="#ececea" stroke-width="1"/>';
  });

  // labels around the outside
  let labels = '';
  catAvg.forEach((c, i) => {
    const [lx, ly] = at(5, i, R + 16);
    const cos = Math.cos(ang(i)), sin = Math.sin(ang(i));
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    const dy = sin > 0.3 ? 12 : sin < -0.3 ? -4 : 4;
    labels += '<text x="' + lx.toFixed(1) + '" y="' + (ly + dy).toFixed(1) + '" text-anchor="' + anchor +
      '" font-size="11" fill="#6b7280">' + escapeHtml(c.short) +
      ' <tspan font-weight="700" fill="#14213d">' + fmt(c.v) + '</tspan></text>';
  });

  const have = catAvg.every((c) => c.v != null);
  let shape = '';
  if (have) {
    // fill + outline on the shared score ramp, keyed to the overall average
    const meanV = catAvg.reduce((a, c) => a + c.v, 0) / catAvg.length;   // 0–5
    const col = colourFor(meanV * 2);
    shape += '<polygon points="' + poly(catAvg.map((c) => c.v)) +
      '" fill="' + col + '" fill-opacity="0.20" stroke="' + col + '" stroke-width="2" stroke-linejoin="round"/>';
    catAvg.forEach((c, i) => {
      const [x, y] = at(c.v, i);
      shape += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="' +
        colourFor(c.v * 2) + '" stroke="#fff" stroke-width="1.5"/>';
    });
  }

  return '<svg class="chart radar" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
    'aria-label="Radar of your average score in each category">' + grid + shape + labels + '</svg>';
}

// Histogram of overall scores (0–10) in ten unit-wide bins, each bar carrying its
// own colour from the shared score ramp so the shape reads red→green left→right.
export function buildHistogram(scores) {
  const W = 280, H = 156, padB = 24, padT = 16, x0 = 6, x1 = W - 6, gap = 3;
  const bins = new Array(10).fill(0);
  scores.forEach((s) => { bins[Math.max(0, Math.min(9, Math.floor(s)))] += 1; });
  const max = Math.max(1, ...bins);
  const bw = (x1 - x0 - gap * 9) / 10;
  const base = H - padB, top = padT, plotH = base - top;

  let bars = '';
  bins.forEach((c, i) => {
    const x = x0 + i * (bw + gap);
    const h = (c / max) * plotH;
    const y = base - h;
    const col = colourFor(i + 0.5);
    bars += '<path d="' + roundedTopBar(x, y, bw, Math.max(c ? 2 : 0, h), 3) + '" fill="' +
      (c ? col : '#eeedea') + '"><title>' + i + '–' + (i + 1) + ': ' + c + '</title></path>';
    if (c) bars += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) +
      '" text-anchor="middle" font-size="10" font-weight="700" fill="#14213d">' + c + '</text>';
  });
  // baseline + a few x ticks
  let axis = '<line x1="' + x0 + '" y1="' + base + '" x2="' + x1 + '" y2="' + base + '" stroke="#e3e3e0"/>';
  [0, 2, 4, 6, 8, 10].forEach((t) => {
    const x = x0 + (t / 10) * (x1 - x0);
    axis += '<text x="' + x.toFixed(1) + '" y="' + (base + 14) + '" text-anchor="middle" font-size="10" fill="#9aa0a6">' + t + '</text>';
  });

  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
    'aria-label="Histogram of how you spread your overall scores from 0 to 10">' + axis + bars + '</svg>';
}

// Pubs plotted per month, zero-filled across the span, last 9 shown. Bar height is
// the count; bar colour is that month's average rating on the shared score ramp.
export function buildTimeline(mine) {
  const stamped = mine.filter((m) => m.ratedAt);
  const W = 280, H = 150, padB = 22, padT = 16, x0 = 6, x1 = W - 6, gap = 4;
  if (!stamped.length) {
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="No dated ratings yet">' +
      '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" font-size="12" fill="#9aa0a6">No dated ratings yet</text></svg>';
  }
  const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const counts = {}, sums = {};
  let min = Infinity;
  stamped.forEach((m) => {
    const d = new Date(m.ratedAt); const k = key(d);
    counts[k] = (counts[k] || 0) + 1; sums[k] = (sums[k] || 0) + m.score;
    if (d < min) min = d.getTime();
  });

  // build a continuous month list from the first rating to now
  const months = [];
  const cur = new Date(); cur.setDate(1);
  const start = new Date(min); start.setDate(1);
  const walk = new Date(start);
  while (walk <= cur) { months.push(new Date(walk)); walk.setMonth(walk.getMonth() + 1); }
  const shown = months.slice(-9);

  const vals = shown.map((d) => { const k = key(d); const c = counts[k] || 0; return { d, c, avg: c ? sums[k] / c : null }; });
  const max = Math.max(1, ...vals.map((v) => v.c));
  const bw = (x1 - x0 - gap * (shown.length - 1)) / shown.length;
  const base = H - padB, top = padT, plotH = base - top;
  const ML = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

  let bars = '', axis = '<line x1="' + x0 + '" y1="' + base + '" x2="' + x1 + '" y2="' + base + '" stroke="#e3e3e0"/>';
  vals.forEach((v, i) => {
    const x = x0 + i * (bw + gap);
    const h = (v.c / max) * plotH, y = base - h;
    bars += '<path d="' + roundedTopBar(x, y, bw, Math.max(v.c ? 2 : 0, h), 3) + '" fill="' +
      (v.c ? colourFor(v.avg) : '#eeedea') + '"><title>' +
      ML[v.d.getMonth()] + ' ' + v.d.getFullYear() + ': ' + v.c + (v.avg != null ? ' · avg ' + v.avg.toFixed(1) : '') + '</title></path>';
    if (v.c) bars += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) +
      '" text-anchor="middle" font-size="10" font-weight="700" fill="#14213d">' + v.c + '</text>';
    axis += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (base + 14) + '" text-anchor="middle" font-size="10" fill="#9aa0a6">' +
      ML[v.d.getMonth()] + '</text>';
  });

  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
    'aria-label="Bar chart of pubs you plotted per month">' + axis + bars + '</svg>';
}

// Gaussian KDE density at value y over a set of samples, bandwidth h.
function kde(values, y, h) {
  let s = 0;
  for (let i = 0; i < values.length; i++) { const u = (y - values[i]) / h; s += Math.exp(-0.5 * u * u); }
  return s / (values.length * h * Math.sqrt(2 * Math.PI));
}

// One vertical violin: the KDE-smoothed distribution of a category's 0–5 scores,
// mirrored around a centreline, filled on the shared score ramp by its mean, with
// a mean line. Each violin is width-normalised to its own peak, so shapes compare.
export function buildViolin(values, mean) {
  const W = 104, H = 150, cx = W / 2, padT = 9, padB = 9;
  const base = H - padB, plotH = H - padT - padB;
  const yPix = (v) => base - (v / 5) * plotH;

  // faint 0–5 gridlines, numbers only at the ends
  let grid = '';
  for (let g = 0; g <= 5; g++) {
    const y = yPix(g).toFixed(1);
    grid += '<line x1="4" y1="' + y + '" x2="' + (W - 4) + '" y2="' + y + '" stroke="#f0efec"/>';
  }
  grid += '<text x="3" y="' + (yPix(5) + 3).toFixed(1) + '" font-size="8" fill="#c2c5c0">5</text>' +
          '<text x="3" y="' + (yPix(0) + 3).toFixed(1) + '" font-size="8" fill="#c2c5c0">0</text>';

  if (!values.length) {
    return '<svg class="vln" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="No ratings">' + grid +
      '<text x="' + cx + '" y="' + (H / 2) + '" text-anchor="middle" font-size="10" fill="#c2c5c0">—</text></svg>';
  }

  const n = values.length;
  const m = mean == null ? values.reduce((a, b) => a + b, 0) / n : mean;
  const varc = values.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
  const h = Math.max(0.4, 1.06 * Math.sqrt(varc) * Math.pow(n, -0.2));   // Silverman, floored

  const steps = 48, maxHW = cx - 5;
  const pts = [];
  let maxD = 1e-9;
  for (let i = 0; i <= steps; i++) {
    const v = (5 * i) / steps;
    const d = kde(values, v, h);
    pts.push({ yp: yPix(v), d });
    if (d > maxD) maxD = d;
  }
  pts.forEach((p) => { p.hw = (p.d / maxD) * maxHW; });

  let d = '';
  for (let i = steps; i >= 0; i--) d += (i === steps ? 'M' : 'L') + (cx + pts[i].hw).toFixed(1) + ',' + pts[i].yp.toFixed(1);
  for (let i = 0; i <= steps; i++) d += 'L' + (cx - pts[i].hw).toFixed(1) + ',' + pts[i].yp.toFixed(1);
  d += 'Z';

  const col = colourFor(m * 2);
  const yM = yPix(m), hwM = (kde(values, m, h) / maxD) * maxHW;
  const violin = '<path d="' + d + '" fill="' + col + '" fill-opacity="0.82" stroke="' + col + '" stroke-width="1.5" stroke-linejoin="round"/>';
  const meanMark = '<line x1="' + (cx - hwM).toFixed(1) + '" y1="' + yM.toFixed(1) + '" x2="' + (cx + hwM).toFixed(1) +
    '" y2="' + yM.toFixed(1) + '" stroke="#fff" stroke-width="2"/>' +
    '<circle cx="' + cx + '" cy="' + yM.toFixed(1) + '" r="2.2" fill="#14213d"/>';

  return '<svg class="vln" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
    'aria-label="Distribution of your scores, mean ' + fmt(m) + ' out of 5">' + grid + violin + meanMark + '</svg>';
}

// A horizontally-scrollable strip of one violin per category.
export function buildViolins(mine) {
  return '<div class="me-violins">' + CATS.map((c) => {
    const vals = mine.map((m) => m.cats[c.key]).filter((v) => v != null);
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return '<div class="me-violin">' + buildViolin(vals, mean) +
      '<div class="mv-lab">' + escapeHtml(SHORT[c.key] || c.label) + ' <b>' + fmt(mean) + '</b></div></div>';
  }).join('') + '</div>';
}

// ======================= page render =======================
function tile(value, label) {
  return '<div class="stat-tile"><b>' + value + '</b><span>' + label + '</span></div>';
}
function chip(score) {
  return score == null
    ? '<span class="me-chip me-chip-none">—</span>'
    : '<span class="me-chip" style="background:' + colourFor(score) + '">' + score.toFixed(1) + '</span>';
}
// category chip: shows the native 0–5 average, coloured on the shared ramp
function chip5(v) {
  return '<span class="me-chip" style="background:' + colourFor(v * 2) + '">' + fmt(v) + '</span>';
}
function superCard(icon, label, name, chipHtml, sub) {
  return '<div class="me-super">' +
    '<div class="me-super-ic">' + icon + '</div>' +
    '<div class="me-super-body">' +
      '<div class="me-super-lab">' + label + '</div>' +
      '<div class="me-super-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</div>' +
      (sub ? '<div class="me-super-sub">' + escapeHtml(sub) + '</div>' : '') +
    '</div>' + (chipHtml || '') +
  '</div>';
}

function tendencyCard(t) {
  if (t == null) return '';
  const mag = Math.round(Math.abs(t) * 10) / 10;    // round once, so label + verdict agree
  const generous = t >= 0;
  const strong = mag >= 0.5;
  const verdict = !strong ? 'Bang in the middle'
    : generous ? 'Generous pourer' : 'Tough critic';
  const blurb = !strong ? 'You rate right around the group average.'
    : generous ? 'You mark pubs kinder than the rest of your group.'
    : 'You mark pubs harder than the rest of your group.';
  // diverging bar: neutral centre, fill toward the generous (green) or tough (red) side
  const pct = Math.min(100, (mag / 2) * 100);       // ±2.0 pts spans half the track
  const col = generous ? '#63be7b' : '#f8696b';
  const sideStyle = generous
    ? 'left:50%;width:' + (pct / 2).toFixed(1) + '%'
    : 'right:50%;width:' + (pct / 2).toFixed(1) + '%';
  const sign = generous ? '+' : '−';
  return '<div class="me-tend">' +
    '<div class="me-tend-head">' +
      '<div class="me-tend-verdict">' + verdict + '</div>' +
      '<div class="me-tend-num">' + sign + mag.toFixed(1) + ' <span>vs group</span></div>' +
    '</div>' +
    '<div class="me-tend-track"><i class="me-tend-mid"></i><i class="me-tend-fill" style="' + sideStyle + ';background:' + col + '"></i></div>' +
    '<div class="me-tend-blurb">' + blurb + '</div>' +
  '</div>';
}

/** Compute + render the whole Me page into `container` from a render context. */
export function renderMePage(container, ctx) {
  const name = (ctx.profile && ctx.profile.display_name) || 'You';
  const groupName = (ctx.group && ctx.group.name) || '';
  const st = computeStats(ctx.pubs || [], ctx.profile && ctx.profile.id);
  const rank = rankFor(st.count);

  const hero =
    '<div class="me-hero">' +
      '<div class="me-av">' + initialsOf(name) + '</div>' +
      '<div class="me-id">' +
        '<div class="me-name">' + escapeHtml(name) + '</div>' +
        '<div class="me-rank">' + rank.icon + ' ' + rank.title +
          (groupName ? ' <span class="me-dot">·</span> ' + escapeHtml(groupName) : '') + '</div>' +
      '</div>' +
      '<div class="me-hero-num"><b>' + st.count + '</b><span>plotted</span></div>' +
    '</div>';

  if (!st.count) {
    container.innerHTML = hero +
      '<div class="me-empty">' +
        '<div class="me-empty-emoji">📈🍺</div>' +
        '<div class="me-empty-title">No pubs plotted yet</div>' +
        '<p>Rate your first pub from the map and your taste fingerprint, score spread and drinking timeline will plot themselves right here.</p>' +
      '</div>';
    return;
  }

  const tiles =
    '<div class="me-tiles">' +
      tile(st.count, 'Plotted') +
      tile(fmt(st.avg), 'Avg given') +
      tile(fmt(st.top), 'Top score') +
      tile(st.cities, st.cities === 1 ? 'Area' : 'Areas') +
    '</div>';

  const fingerprint =
    '<div class="sec-label">Your taste fingerprint</div>' +
    '<div class="me-card me-card-pad">' + buildRadar(st.catAvg) + '</div>';

  const violins =
    '<div class="sec-label">Category spreads</div>' +
    '<div class="me-card me-card-pad">' + buildViolins(st.mine) + '</div>';

  const spread =
    '<div class="sec-label">How you pour your scores</div>' +
    '<div class="me-card me-card-pad">' + buildHistogram(st.scores) + '</div>';

  const timeline =
    '<div class="sec-label">Your pubs over time</div>' +
    '<div class="me-card me-card-pad">' + buildTimeline(st.mine) + '</div>';

  const supers =
    '<div class="sec-label">Signature pours</div>' +
    '<div class="me-supers">' +
      superCard('⭐', 'Your favourite', st.favPub ? st.favPub.pub : '—', chip(st.top),
        st.favPub ? st.favPub.city : '') +
      (st.worstPub ? superCard('💀', 'Harshest verdict', st.worstPub.pub, chip(st.worstPub.score), st.worstPub.city) : '') +
      (st.soft ? superCard('💚', 'You go easy on', st.soft.short, chip5(st.soft.v), 'out of 5') : '') +
      (st.tough ? superCard('🧊', "You're toughest on", st.tough.short, chip5(st.tough.v), 'out of 5') : '') +
    '</div>' +
    tendencyCard(st.tendency);

  container.innerHTML = hero + tiles + fingerprint + violins + spread + timeline + supers +
    '<p class="me-foot">All plotted from your own ratings.</p>';
}

// ======================= live view =======================
let loadToken = 0;
async function render() {
  const token = ++loadToken;
  const box = document.getElementById('mePage');
  if (!box) return;
  if (!box.childElementCount) box.innerHTML = '<div class="me-loading">Plotting your stats…</div>';

  let pubs = [];
  try { pubs = await fetchPubs(); }
  catch (e) {
    if (token !== loadToken) return;
    box.innerHTML = '<div class="me-loading">Could not load your stats.</div>';
    return;
  }
  if (token !== loadToken) return;
  renderMePage(box, { profile: S.PROFILE, group: S.ACTIVE_GROUP, pubs });
}

registerView('me', { el, onShow: render });
