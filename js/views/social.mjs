// PlotMyPub — Social tab. The people side of a group: a header with the group's
// name + invite word, a locked Achievements placeholder (markup in index.html),
// and a members list showing each person's pubs-rated count and the average
// score they give. Tapping a member expands their category profile + their
// kindest / harshest ratings. Everything is computed from ratings already in the
// database — no backend work. See memory: social-tab-design.
import { registerView } from '../router.mjs';
import { S, colourFor, escapeHtml } from '../core.mjs';
import { CATS } from '../config.mjs';
import { fetchMembers, fetchPubs } from '../api.mjs';

const el = document.querySelector('.view-ph[data-view="social"]');

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);   if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);   if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);   if (d < 7)  return d + 'd ago';
  const w = Math.round(d / 7);    if (w < 5)  return w + 'w ago';
  const mo = Math.round(d / 30);  if (mo < 12) return mo + 'mo ago';
  return Math.round(d / 365) + 'y ago';
}

function activeGroup() {
  return S.GROUPS.find((g) => S.ACTIVE_GROUP && g.id === S.ACTIVE_GROUP.id) || {};
}

// ---------- invite sharing (mirrors the avatar-menu share flow) ----------
function setShareMsg(text, cls) {
  const m = document.getElementById('soShareMsg');
  if (m) { m.textContent = text || ''; m.className = 'social-msg' + (cls ? ' ' + cls : ''); }
}
async function shareInvite() {
  const g = activeGroup();
  if (!g || !g.invite_code) { setShareMsg('No invite word for this group.', 'bad'); return; }
  const url = location.origin + '/?join=' + encodeURIComponent(g.invite_code);
  const shareData = { title: 'PlotMyPub', text: 'Join "' + g.name + '" on PlotMyPub', url };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); setShareMsg('Invite link copied ✓', 'good'); }
  catch (e) { setShareMsg(url, ''); }
}

// ---------- header ----------
function renderHeader() {
  const g = activeGroup();
  const name = (S.ACTIVE_GROUP && S.ACTIVE_GROUP.name) || g.name || 'Your group';
  const invite = g.invite_code
    ? '<div class="invite" id="soInvite" role="button" tabindex="0">' +
        'Invite word <span class="word">' + escapeHtml(g.invite_code) + '</span>' +
        '<span class="share">Share ↗</span>' +
      '</div>'
    : '';
  document.getElementById('soHead').innerHTML =
    '<div class="ghead">' +
      '<div class="ghead-row">' +
        '<div class="gcrest">🍺</div>' +
        '<div class="gmeta">' +
          '<div class="gname">' + escapeHtml(name) + '</div>' +
          '<div class="gsub" id="soSub">…</div>' +
        '</div>' +
      '</div>' + invite +
      '<div id="soShareMsg" class="social-msg"></div>' +
    '</div>';

  const inv = document.getElementById('soInvite');
  if (inv) {
    inv.addEventListener('click', shareInvite);
    inv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); shareInvite(); }
    });
  }
}

// ---------- members ----------
function statsByMember(pubs) {
  const stat = {};
  pubs.forEach((p) => {
    (p.ratings || []).forEach((r) => {
      let s = stat[r.profileId];
      if (!s) s = stat[r.profileId] = { count: 0, sum: 0, lastAt: null, lastPub: null, ratings: [] };
      s.count += 1;
      s.sum += r.score;
      if (r.ratedAt && (!s.lastAt || r.ratedAt > s.lastAt)) { s.lastAt = r.ratedAt; s.lastPub = p.pub; }
      s.ratings.push({ pub: p.pub, score: r.score, cats: r.cats });
    });
  });
  return stat;
}

function detailHtml(rows) {
  // per-category average (0–5) as colour-ramped bars + kindest / harshest pub
  const catAvg = CATS.map((c) => {
    const vals = rows.map((r) => (r.cats ? r.cats[c.key] : null)).filter((v) => v != null);
    const v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return { label: c.label, v };
  });
  const bars = catAvg.map((c) => {
    const pct = c.v == null ? 0 : (c.v / 5) * 100;
    const col = c.v == null ? '#e3e3e0' : colourFor(c.v * 2);
    return '<div class="mbar">' +
      '<span class="mbar-l">' + c.label + '</span>' +
      '<span class="mbar-t"><i style="width:' + pct.toFixed(0) + '%;background:' + col + '"></i></span>' +
      '<b>' + (c.v == null ? '—' : c.v.toFixed(1)) + '</b>' +
    '</div>';
  }).join('');

  const sorted = rows.slice().sort((a, b) => b.score - a.score);
  const top = sorted[0], bot = sorted[sorted.length - 1];
  const extreme = (icon, label, r) => r
    ? '<div class="mex"><span>' + icon + ' ' + label + '</span>' +
      '<b title="' + escapeHtml(r.pub) + '">' + escapeHtml(r.pub) + '</b>' +
      '<span class="mex-sc" style="background:' + colourFor(r.score) + '">' + r.score.toFixed(1) + '</span></div>'
    : '';
  const extremes = (top && bot && top !== bot)
    ? '<div class="mextremes">' + extreme('👍', 'Kindest', top) + extreme('👎', 'Harshest', bot) + '</div>'
    : '';

  return '<div class="mbars">' + bars + '</div>' + extremes;
}

function memberRowHtml(m) {
  const you = m.you ? '<span class="youtag">you</span>' : '';
  const last = m.count
    ? 'last: ' + escapeHtml(m.lastPub) + (m.lastAt ? ' · ' + timeAgo(m.lastAt) : '')
    : 'No ratings yet';
  const chip = m.avg == null
    ? '<span class="chip chip-none">—</span>'
    : '<span class="chip" style="background:' + colourFor(m.avg) + '">' + m.avg.toFixed(1) + '</span>';
  const chev = m.count ? '<div class="chev">›</div>' : '<div class="chev chev-off"></div>';

  return '<div class="mitem" data-id="' + escapeHtml(m.id) + '">' +
    '<div class="mrow' + (m.count ? '' : ' mrow-flat') + '">' +
      '<div class="mav">' + initialsOf(m.name) + '</div>' +
      '<div class="mbody">' +
        '<div class="mname">' + escapeHtml(m.name) + you + '</div>' +
        '<div class="mlast">' + last + '</div>' +
      '</div>' +
      '<div class="mstats">' +
        '<div class="mstat"><b>' + m.count + '</b><span>Rated</span></div>' +
        '<div class="mstat">' + chip + '<span>Avg given</span></div>' +
      '</div>' + chev +
    '</div>' +
    (m.count ? '<div class="mdetail" hidden>' + detailHtml(m.ratings) + '</div>' : '') +
  '</div>';
}

function renderMembers(box, members, stat) {
  const meId = S.PROFILE && S.PROFILE.id;
  const rows = members.map((m) => {
    const s = stat[m.id] || { count: 0, sum: 0, lastAt: null, lastPub: null, ratings: [] };
    return {
      id: m.id, name: m.name, you: m.id === meId,
      count: s.count, avg: s.count ? s.sum / s.count : null,
      lastAt: s.lastAt, lastPub: s.lastPub, ratings: s.ratings
    };
  });
  // you first, then most active, then alphabetical
  rows.sort((a, b) =>
    (b.you - a.you) || (b.count - a.count) || a.name.localeCompare(b.name));

  const label = document.getElementById('soMembersLabel');
  if (label) label.textContent = 'Members · ' + rows.length;

  box.innerHTML = rows.length
    ? rows.map(memberRowHtml).join('')
    : '<div class="mrow mrow-flat"><div class="mlast" style="padding:4px 2px">No members yet.</div></div>';
}

// one delegated click handler: expand/collapse a member's detail
el.addEventListener('click', (e) => {
  const row = e.target.closest('.mrow');
  if (!row) return;
  const item = row.parentNode;
  const detail = item.querySelector('.mdetail');
  if (!detail) return;                       // member with no ratings — nothing to show
  const open = !detail.hasAttribute('hidden');
  if (open) { detail.setAttribute('hidden', ''); item.classList.remove('open'); }
  else { detail.removeAttribute('hidden'); item.classList.add('open'); }
});

// ---------- load + render on each open ----------
let loadToken = 0;
async function render() {
  const token = ++loadToken;
  renderHeader();
  const box = document.getElementById('soMembers');
  box.innerHTML = '<div class="mrow mrow-flat"><div class="mlast" style="padding:4px 2px">Loading…</div></div>';

  let members = [], pubs = [];
  try {
    [members, pubs] = await Promise.all([fetchMembers(), fetchPubs()]);
  } catch (e) {
    if (token !== loadToken) return;
    box.innerHTML = '<div class="mrow mrow-flat"><div class="mlast" style="padding:4px 2px">Could not load your group.</div></div>';
    return;
  }
  if (token !== loadToken) return;           // a newer open superseded this one

  const sub = document.getElementById('soSub');
  if (sub) {
    const mc = members.length, pc = pubs.length;
    sub.textContent = mc + (mc === 1 ? ' drinker' : ' drinkers') +
      ' · ' + pc + (pc === 1 ? ' pub' : ' pubs') + ' mapped together';
  }
  renderMembers(box, members, statsByMember(pubs));
}

registerView('social', { el, onShow: render });
