// PlotMyPub admin — the five panels. Each exports a mount(root) that renders
// into the content area and wires its own events via delegation on `root`, so
// re-rendering a panel never leaves stale listeners behind.

import { escapeHtml, colourFor } from '../core.mjs';
import { signedPhoto } from '../api.mjs';
import * as D from './data.mjs';

// ============================================================ small helpers

const el = (id) => document.getElementById(id);

function num(n) {
  return (n == null) ? '—' : Number(n).toLocaleString('en-GB');
}

function date(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
}

function dateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "3d ago" / "just now" — the column you actually scan when looking for
 *  abandoned groups. Falls back to a date past a month. */
function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
  return date(ts);
}

function scorePill(score) {
  if (score == null) return '<span class="pill muted">—</span>';
  const v = Number(score);
  return '<span class="pill" style="background:' + colourFor(v) + '">' +
         v.toFixed(1) + '</span>';
}

export function toast(text, kind) {
  const t = el('toast');
  t.textContent = text;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function loading(root, what) {
  root.innerHTML = '<div class="loading">Loading ' + what + '…</div>';
}

function failed(root, e) {
  root.innerHTML = '<div class="empty"><strong>Could not load.</strong><br>' +
    escapeHtml((e && e.message) || String(e)) + '</div>';
}

/** Guard destructive actions. Deliberately a plain confirm(): this is an
 *  owner-only console, and a custom modal would be ceremony for no safety gain. */
function sure(text) { return window.confirm(text); }

// A lightbox for user-uploaded photos, so moderation doesn't mean opening
// signed URLs in new tabs.
async function showPhoto(path) {
  const url = await signedPhoto(path, 1200);
  if (!url) { toast('That photo could not be loaded.', 'bad'); return; }
  const lb = el('lightbox');
  lb.innerHTML = '<img alt="Pub photo" src="' + escapeHtml(url) + '">';
  lb.classList.add('show');
}
el('lightbox').addEventListener('click', function () {
  this.classList.remove('show');
  this.innerHTML = '';
});

// ============================================================ overview

export async function overview(root) {
  loading(root, 'overview');
  let o;
  try { o = await D.getOverview(); } catch (e) { return failed(root, e); }

  const tiles = [
    ['Groups', o.groups, o.new_groups_7d + ' new this week'],
    ['People', o.people, o.claimed + ' signed in, ' + (o.people - o.claimed) + ' unclaimed'],
    ['Pubs', o.pubs, 'across all groups'],
    ['Ratings', o.ratings, num(o.ratings_7d) + ' this week'],
    ['Active people', o.active_7d, o.active_30d + ' in the last 30 days'],
    ['Photos', o.photos, num(o.notes) + ' ratings carry a note']
  ];

  // Health warnings first — these are the "am I exposed" questions.
  let health = '';
  if (o.weak_codes > 0 || o.ownerless > 0) {
    const items = [];
    if (o.weak_codes > 0) {
      items.push('<li><strong>' + o.weak_codes + ' group' +
        (o.weak_codes === 1 ? '' : 's') + '</strong> still use a short invite ' +
        'word from before codes were generated. Those are guessable — anyone ' +
        'who tries the right word joins. Rotate them from the Groups tab.</li>');
    }
    if (o.ownerless > 0) {
      items.push('<li><strong>' + o.ownerless + ' group' +
        (o.ownerless === 1 ? ' has' : 's have') + ' no owner</strong>, so ' +
        'nobody in them can rename or re-key the group. Promote someone from ' +
        'the group\'s detail view.</li>');
    }
    health = '<div class="alert"><h3>Needs attention</h3><ul>' +
             items.join('') + '</ul></div>';
  }

  const peak = Math.max(1, ...(o.daily || []).map((d) => d.n));
  const bars = (o.daily || []).map((d) =>
    '<i style="height:' + Math.round((d.n / peak) * 100) + '%" title="' +
    escapeHtml(date(d.d)) + ': ' + d.n + '"></i>').join('');

  root.innerHTML =
    health +
    '<div class="tiles">' + tiles.map((t) =>
      '<div class="tile"><span class="tile-n">' + num(t[1]) + '</span>' +
      '<span class="tile-k">' + escapeHtml(t[0]) + '</span>' +
      '<span class="tile-s">' + escapeHtml(String(t[2])) + '</span></div>').join('') +
    '</div>' +
    '<section class="card"><h2>Ratings, last 30 days</h2>' +
    '<div class="spark">' + bars + '</div>' +
    '<p class="foot">' + num(o.ratings_30d) + ' ratings in the last 30 days · ' +
    'most recent ' + escapeHtml(ago(o.last_rating_at)) + '</p></section>' +
    '<section class="card"><h2>Access</h2><p class="foot">' +
    num(o.admins) + ' admin' + (o.admins === 1 ? '' : 's') + '. Admin is granted ' +
    'from the People tab and can never be self-assigned — the column is not ' +
    'writable by the app.</p></section>';
}

// ============================================================ groups

let groupsCache = null;

export async function groups(root) {
  loading(root, 'groups');
  try { groupsCache = await D.getGroups(); } catch (e) { return failed(root, e); }
  drawGroupList(root);
}

function drawGroupList(root) {
  const rows = groupsCache;
  if (!rows.length) {
    root.innerHTML = '<div class="empty">No groups yet.</div>';
    return;
  }

  root.innerHTML =
    '<section class="card">' +
    '<h2>All groups <span class="count">' + rows.length + '</span></h2>' +
    '<div class="scroll"><table class="grid"><thead><tr>' +
    '<th>Group</th><th>Invite code</th><th class="n">Members</th>' +
    '<th class="n">Pubs</th><th class="n">Ratings</th><th class="n">Photos</th>' +
    '<th>Last activity</th><th>Created by</th><th></th>' +
    '</tr></thead><tbody>' +
    rows.map((g) =>
      '<tr data-gid="' + g.id + '">' +
      '<td><span class="cell"><span class="strong">' + escapeHtml(g.name) + '</span>' +
        (g.owners === 0 ? '<span class="flag bad">no owner</span>' : '') + '</span></td>' +
      '<td><span class="cell"><code>' + escapeHtml(g.invite_code) + '</code>' +
        (g.weak_code ? '<span class="flag warn">weak</span>' : '') + '</span></td>' +
      '<td class="n">' + num(g.members) + '</td>' +
      '<td class="n">' + num(g.pubs) + '</td>' +
      '<td class="n">' + num(g.ratings) + '</td>' +
      '<td class="n">' + num(g.photos) + '</td>' +
      '<td>' + escapeHtml(ago(g.last_at)) + '</td>' +
      '<td>' + escapeHtml(g.created_by || '—') + '</td>' +
      '<td class="n"><button class="link" data-open="' + g.id + '">Open</button></td>' +
      '</tr>').join('') +
    '</tbody></table></div></section>';

  root.onchange = null;            // drop the detail view's role-select handler
  root.onclick = (e) => {
    const btn = e.target.closest('[data-open]');
    const row = e.target.closest('tr[data-gid]');
    const id = btn ? btn.dataset.open : (row && row.dataset.gid);
    if (id) groupDetail(root, id);
  };
}

async function groupDetail(root, id) {
  loading(root, 'group');
  let d;
  try { d = await D.getGroup(id); } catch (e) { return failed(root, e); }
  if (!d || !d.group) { root.innerHTML = '<div class="empty">That group is gone.</div>'; return; }

  const g = d.group;

  root.innerHTML =
    '<button class="link back" data-back>← All groups</button>' +

    '<section class="card">' +
    '<h2>' + escapeHtml(g.name) + '</h2>' +
    '<p class="foot">Created ' + escapeHtml(date(g.created_at)) +
      ' by ' + escapeHtml(g.created_by || 'someone since deleted') + '</p>' +
    '<div class="actions">' +
      '<label>Name<input id="gName" type="text" value="' + escapeHtml(g.name) + '"></label>' +
      '<button class="btn" data-rename>Save name</button>' +
    '</div>' +
    '<div class="actions">' +
      '<label>Invite code<input type="text" value="' + escapeHtml(g.invite_code) +
        '" readonly></label>' +
      '<button class="btn ghost" data-rotate>Rotate</button>' +
    '</div>' +
    (g.weak_code
      ? '<p class="foot warn-text">This code predates generated invite codes. ' +
        'It is short enough to guess — rotating replaces it with a strong one. ' +
        'Any link already shared with this code will stop working.</p>'
      : '') +
    '</section>' +

    '<section class="card">' +
    '<h2>Members <span class="count">' + d.members.length + '</span></h2>' +
    '<div class="scroll"><table class="grid"><thead><tr>' +
    '<th>Name</th><th>Role</th><th class="n">Ratings</th><th class="n">XP</th>' +
    '<th>Last rated</th><th>Joined</th><th></th></tr></thead><tbody>' +
    d.members.map((m) =>
      '<tr>' +
      '<td><span class="cell"><span class="strong">' + escapeHtml(m.name) + '</span>' +
        (m.is_admin ? '<span class="flag">admin</span>' : '') +
        (m.claimed ? '' : '<span class="flag warn">unclaimed</span>') + '</span></td>' +
      '<td><select data-role="' + m.id + '">' +
        '<option value="member"' + (m.role === 'owner' ? '' : ' selected') + '>member</option>' +
        '<option value="owner"' + (m.role === 'owner' ? ' selected' : '') + '>owner</option>' +
        '</select></td>' +
      '<td class="n">' + num(m.ratings) + '</td>' +
      '<td class="n">' + num(m.xp) + '</td>' +
      '<td>' + escapeHtml(ago(m.last_at)) + '</td>' +
      '<td>' + escapeHtml(date(m.joined_at)) + '</td>' +
      '<td class="n"><button class="link danger" data-kick="' + m.id +
        '" data-name="' + escapeHtml(m.name) + '">Remove</button></td>' +
      '</tr>').join('') +
    '</tbody></table></div>' +
    '<p class="foot">Removing someone takes them out of the group but leaves ' +
    'their ratings, so the group\'s history stays intact. Delete individual ' +
    'ratings below if the content itself is the problem.</p></section>' +

    '<section class="card">' +
    '<h2>Pubs <span class="count">' + d.pubs.length + '</span></h2>' +
    (d.pubs.length
      ? '<div class="scroll"><table class="grid"><thead><tr><th>Pub</th><th>Area</th>' +
        '<th class="n">Ratings</th><th>Added</th></tr></thead><tbody>' +
        d.pubs.map((p) =>
          '<tr><td class="strong">' + escapeHtml(p.name) + '</td>' +
          '<td>' + escapeHtml(p.area || '—') + '</td>' +
          '<td class="n">' + num(p.ratings) + '</td>' +
          '<td>' + escapeHtml(date(p.created_at)) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<p class="foot">No pubs yet.</p>') +
    '</section>' +

    '<section class="card">' +
    '<h2>Recent ratings <span class="count">' + d.ratings.length + '</span></h2>' +
    (d.ratings.length ? ratingList(d.ratings) : '<p class="foot">Nothing yet.</p>') +
    '</section>';

  root.onclick = async (e) => {
    const t = e.target;

    // Refetch rather than redraw the cached list: names, codes and counts may
    // all have changed while we were in here.
    if (t.closest('[data-back]')) { groups(root); return; }

    if (t.closest('[data-rename]')) {
      const name = el('gName').value.trim();
      if (!name) { toast('Give it a name.', 'bad'); return; }
      try { await D.renameGroup(id, name); toast('Renamed.'); groupDetail(root, id); }
      catch (err) { toast(err.message, 'bad'); }
      return;
    }

    if (t.closest('[data-rotate]')) {
      if (!sure('Rotate the invite code for "' + g.name + '"?\n\n' +
                'Every link already shared for this group stops working ' +
                'immediately. Members already in the group are unaffected.')) return;
      try {
        const code = await D.rotateInvite(id);
        toast('New code: ' + code);
        groupDetail(root, id);
      } catch (err) { toast(err.message, 'bad'); }
      return;
    }

    const kick = t.closest('[data-kick]');
    if (kick) {
      if (!sure('Remove ' + kick.dataset.name + ' from "' + g.name + '"?\n\n' +
                'Their ratings stay in the group.')) return;
      try { await D.removeMember(id, kick.dataset.kick); toast('Removed.'); groupDetail(root, id); }
      catch (err) { toast(err.message, 'bad'); }
      return;
    }

    await ratingAction(t, () => groupDetail(root, id));
  };

  root.onchange = async (e) => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    try { await D.setMemberRole(id, sel.dataset.role, sel.value); toast('Role updated.'); }
    catch (err) { toast(err.message, 'bad'); groupDetail(root, id); }
  };
}

// ============================================================ activity

/** Shared renderer for a list of ratings — used by the group drill-down and the
 *  global feed. `showGroup` adds the group chip the global view needs. */
function ratingList(rows, showGroup) {
  return '<ul class="feed">' + rows.map((r) =>
    '<li>' +
    '<div class="feed-head">' +
      scorePill(r.score) +
      '<span class="strong">' + escapeHtml(r.author) + '</span>' +
      '<span class="muted">rated</span>' +
      '<span class="strong">' + escapeHtml(r.pub) + '</span>' +
      (showGroup && r.group_name
        ? '<span class="chip">' + escapeHtml(r.group_name) + '</span>' : '') +
      '<span class="when">' + escapeHtml(ago(r.created_at)) + '</span>' +
    '</div>' +
    (r.note ? '<p class="note">' + escapeHtml(r.note) + '</p>' : '') +
    '<div class="feed-acts">' +
      (r.photo_path
        ? '<button class="link" data-photo="' + escapeHtml(r.photo_path) + '">View photo</button>' +
          '<button class="link danger" data-unphoto="' + r.id + '">Delete photo</button>'
        : '') +
      '<button class="link danger" data-delrating="' + r.id +
        '" data-what="' + escapeHtml(r.author + '’s rating of ' + r.pub) +
        '">Delete rating</button>' +
    '</div></li>').join('') + '</ul>';
}

/** The rating-row actions, shared by both places ratingList() is rendered.
 *  Returns true if it handled the click. */
async function ratingAction(target, refresh) {
  const photo = target.closest('[data-photo]');
  if (photo) { await showPhoto(photo.dataset.photo); return true; }

  const unphoto = target.closest('[data-unphoto]');
  if (unphoto) {
    if (!sure('Delete this photo?\n\nThe image is removed from storage and the ' +
              'rating keeps its scores. This cannot be undone.')) return true;
    try { await D.clearPhoto(unphoto.dataset.unphoto); toast('Photo deleted.'); refresh(); }
    catch (err) { toast(err.message, 'bad'); }
    return true;
  }

  const del = target.closest('[data-delrating]');
  if (del) {
    if (!sure('Delete ' + del.dataset.what + '?\n\nThis cannot be undone. XP ' +
              'already awarded for it is left alone, so nobody\'s level changes.')) return true;
    try { await D.deleteRating(del.dataset.delrating); toast('Rating deleted.'); refresh(); }
    catch (err) { toast(err.message, 'bad'); }
    return true;
  }
  return false;
}

let feedRows = [];

export async function activity(root) {
  loading(root, 'activity');
  try { feedRows = await D.getActivity(50); } catch (e) { return failed(root, e); }
  drawFeed(root, feedRows.length < 50);

  root.onclick = async (e) => {
    if (await ratingAction(e.target, () => activity(root))) return;

    if (e.target.closest('[data-more]')) {
      const last = feedRows[feedRows.length - 1];
      try {
        const more = await D.getActivity(50, last && last.created_at);
        feedRows = feedRows.concat(more);
        drawFeed(root, more.length < 50);
      } catch (err) { toast(err.message, 'bad'); }
    }
  };
}

function drawFeed(root, exhausted) {
  if (!feedRows.length) {
    root.innerHTML = '<div class="empty">No activity anywhere yet.</div>';
    return;
  }
  root.innerHTML =
    '<section class="card"><h2>Everything, everywhere ' +
    '<span class="count">' + feedRows.length + '</span></h2>' +
    ratingList(feedRows, true) +
    (exhausted
      ? '<p class="foot">That\'s all of it.</p>'
      : '<button class="btn ghost wide" data-more>Load 50 more</button>') +
    '</section>';
}

// ============================================================ people

export async function people(root) {
  loading(root, 'people');
  let rows;
  try { rows = await D.getPeople(); } catch (e) { return failed(root, e); }

  root.innerHTML =
    '<section class="card">' +
    '<h2>Everyone <span class="count">' + rows.length + '</span></h2>' +
    '<div class="scroll"><table class="grid"><thead><tr>' +
    '<th>Name</th><th>Groups</th><th class="n">Ratings</th><th class="n">Photos</th>' +
    '<th>Last rated</th><th>Joined</th><th class="n">Admin</th>' +
    '</tr></thead><tbody>' +
    rows.map((p) =>
      '<tr>' +
      '<td><span class="cell"><span class="strong">' + escapeHtml(p.name) + '</span>' +
        (p.claimed ? '' : '<span class="flag warn">unclaimed</span>') + '</span></td>' +
      '<td>' + (p.group_names.length
        ? p.group_names.map((n) => '<span class="chip">' + escapeHtml(n) + '</span>').join('')
        : '<span class="muted">none</span>') + '</td>' +
      '<td class="n">' + num(p.ratings) + '</td>' +
      '<td class="n">' + num(p.photos) + '</td>' +
      '<td>' + escapeHtml(ago(p.last_at)) + '</td>' +
      '<td>' + escapeHtml(date(p.created_at)) + '</td>' +
      '<td class="n"><input type="checkbox" data-admin="' + p.id + '"' +
        ' data-name="' + escapeHtml(p.name) + '"' +
        (p.is_admin ? ' checked' : '') + (p.claimed ? '' : ' disabled') + '></td>' +
      '</tr>').join('') +
    '</tbody></table></div>' +
    '<p class="foot">Admins see this console and everything in it. Unclaimed ' +
    'profiles are legacy names nobody has signed into yet, so they can\'t hold ' +
    'admin. You cannot remove your own admin access here — that would lock the ' +
    'console with no way back in short of the SQL editor.</p></section>';

  root.onchange = async (e) => {
    const box = e.target.closest('[data-admin]');
    if (!box) return;
    const on = box.checked;
    if (on && !sure('Make ' + box.dataset.name + ' an admin?\n\n' +
                    'They will be able to see every group, every rating and ' +
                    'every photo across the whole app, and to delete them.')) {
      box.checked = false; return;
    }
    try { await D.setAdmin(box.dataset.admin, on); toast(on ? 'Admin granted.' : 'Admin removed.'); }
    catch (err) { toast(err.message, 'bad'); box.checked = !on; }
  };
}

// ============================================================ audit

export async function audit(root) {
  loading(root, 'audit log');
  let rows;
  try { rows = await D.getAudit(200); } catch (e) { return failed(root, e); }

  if (!rows.length) {
    root.innerHTML = '<div class="empty">No admin actions recorded yet.<br>' +
      '<span class="muted">Everything you do from this console lands here.</span></div>';
    return;
  }

  root.innerHTML =
    '<section class="card"><h2>Admin actions <span class="count">' + rows.length + '</span></h2>' +
    '<div class="scroll"><table class="grid"><thead><tr>' +
    '<th>When</th><th>Who</th><th>Action</th><th>Detail</th>' +
    '</tr></thead><tbody>' +
    rows.map((a) =>
      '<tr><td>' + escapeHtml(dateTime(a.created_at)) + '</td>' +
      '<td class="strong">' + escapeHtml(a.actor || '—') + '</td>' +
      '<td><code>' + escapeHtml(a.action) + '</code></td>' +
      '<td class="detail">' + escapeHtml(summarise(a)) + '</td></tr>').join('') +
    '</tbody></table></div></section>';
}

/** Turn an audit row's jsonb detail into a sentence rather than dumping JSON. */
function summarise(a) {
  const d = a.detail || {};
  switch (a.action) {
    case 'rename_group':   return '"' + d.from + '" → "' + d.to + '"';
    case 'rotate_invite':  return d.from + ' → ' + d.to;
    case 'remove_member':  return d.name + ' out of ' + d.group;
    case 'set_member_role':return d.name + ' is now ' + d.role;
    case 'delete_rating':  return d.author + '’s rating of ' + d.pub +
                                  (d.note ? ' (note: "' + d.note + '")' : '');
    case 'clear_photo':    return d.author + '’s photo';
    case 'set_admin':      return d.name + (d.is_admin ? ' granted admin' : ' had admin removed');
    default:               return JSON.stringify(d);
  }
}
