// PlotMyPub — the map view: Google Maps render, pin/info-window markup, the
// leaderboard + activity panel, the add-a-pub form, the in-map account/group
// menu, and enterApp() (the bridge the gate calls to drop into the map).
//
// View-local state (the map instance, markers, the loaded pubs, the panel page,
// the pending info-window photo target) lives here as plain module vars. Only
// the cross-view slice (profile / groups / active group) comes from core's S.

import { sb, $, escapeHtml, isMobile, colourFor, colourForKey, S, rememberGroup } from './core.mjs';
import { CATS, MAPS_BROWSER_KEY } from './config.mjs';
import {
  fetchPubs, fetchUsers, submitPub, fetchActivity,
  signedPhoto, uploadPhoto, setRatingPhotoPath, photoPath
} from './api.mjs';
import { loadGroups } from './auth.mjs';
import { showView } from './router.mjs';

// ===========================================================
//  MAP APP
// ===========================================================
var PUBS = [], MARKERS = [], INFO = null, MAP = null, MAPS_LOADED = false;
// Marker class, imported once via importLibrary('marker') in initMap() and
// reused on every render so all markers share the same API realm as MAP.
var AdvancedMarker = null;

function boundsPadding() {
  return isMobile()
    ? { top: 60, right: 40, bottom: Math.round(window.innerHeight * 0.45) + 20, left: 40 }
    : 60;
}

function pinFor(pub) {
  var key = sortKey();
  var v = valueFor(pub, key);
  var el = document.createElement('div');
  el.className = 'pin';
  el.style.background = colourForKey(v, key);
  el.textContent = v == null ? '?' : v.toFixed(1);
  el.title = pub.pub;
  return el;
}

function infoHtml(p) {
  var link = p.placeId
    ? '<a href="https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(p.pub) + '&query_place_id=' + p.placeId +
      '" target="_blank">Open in Google Maps</a>'
    : '';
  var breakdown = '';
  if (p.cats) {
    breakdown = '<div class="brk">' + CATS.map(function (c) {
      var v = p.cats[c.key];
      return '<span>' + c.label + '</span><b>' + (v == null ? '—' : v.toFixed(1)) + '</b>';
    }).join('') + '</div>';
  }
  var by = '';
  if (p.soloAuthor) {
    by = '<div class="by">' + escapeHtml(p.soloAuthor) + "'s rating</div>";
  } else if (p.raters > 1) {
    var spread = p.ratings.map(function (r) {
      return escapeHtml(r.author) + ' ' + r.score.toFixed(1);
    }).join(' · ');
    by = '<div class="by">average of ' + p.raters + ' — ' + spread + '</div>';
  } else if (p.ratings && p.ratings.length) {
    by = '<div class="by">rated by ' + escapeHtml(p.ratings[0].author) + '</div>';
  }

  // Notes: one short line per rater who wrote one. In solo view the
  // author is already named above, so just show the text.
  var notes = '';
  var withNotes = (p.ratings || []).filter(function (r) { return r.note; });
  if (withNotes.length) {
    notes = '<div class="notes">' + withNotes.map(function (r) {
      return '<div class="note">' +
        (p.soloAuthor ? '' : '<b>' + escapeHtml(r.author) + '</b> ') +
        escapeHtml(r.note) +
      '</div>';
    }).join('') + '</div>';
  }

  // Photo strip: solo view -> that author's one photo; average view ->
  // one thumb per rater who has one. Slots fill in async after open.
  var shots = '';
  var withPhotos = (p.ratings || []).filter(function (r) { return r.photoPath; });
  if (withPhotos.length) {
    shots = '<div class="shots">' + withPhotos.map(function (r) {
      return '<figure>' +
        '<img data-photo="' + escapeHtml(r.photoPath) + '" alt="' +
          escapeHtml(r.author) + "'s photo\" />" +
        (p.soloAuthor ? '' : '<figcaption>' + escapeHtml(r.author) + '</figcaption>') +
      '</figure>';
    }).join('') + '</div>';
  }

  // Do I have a rating of this pub? If so, offer photo add/replace.
  var mineHere = S.PROFILE && (p.ratings || []).some(function (r) {
    return r.profileId === S.PROFILE.id;
  });
  var myPhoto = '';
  if (mineHere && p.pubId && p.groupId) {
    var mineRow = (p.ratings || []).filter(function (r) { return r.profileId === S.PROFILE.id; })[0];
    var verb = (mineRow && mineRow.photoPath) ? 'Replace my photo' : 'Add my photo';
    myPhoto = '<div style="margin-top:6px"><a href="#" class="addPhoto" ' +
      'data-pub="' + escapeHtml(p.pubId) + '" data-group="' + escapeHtml(p.groupId) +
      '">📷 ' + verb + '</a></div>';
  }

  return '<div class="iw"><b>' + escapeHtml(p.pub) + '</b><br>' +
         '<span style="color:#555">' + escapeHtml(p.area || '') + '</span><br>' +
         '<span class="sc" style="color:' + colourFor(p.score) + '">' +
         (p.score == null ? '—' : p.score.toFixed(2)) + '</span>' +
         '<span style="color:#777"> / 10</span>' +
         breakdown + by + notes + shots + myPhoto + link + '</div>';
}

/** After an info-window renders, swap each photo slot's data-photo path
 *  for a signed thumbnail URL, and wire tap-to-enlarge. */
async function fillPhotoSlots() {
  var imgs = document.querySelectorAll('.iw .shots img[data-photo]');
  for (var i = 0; i < imgs.length; i++) {
    (function (img) {
      var path = img.getAttribute('data-photo');
      img.removeAttribute('data-photo');
      signedPhoto(path, 108).then(function (url) {   // 2x for retina at 54px
        if (url) img.src = url;
      });
      img.addEventListener('click', function () {
        signedPhoto(path, null).then(function (full) {
          if (full) openLightbox(full);
        });
      });
    })(imgs[i]);
  }

  // "Add/replace my photo" link -> shared hidden file input
  var link = document.querySelector('.iw a.addPhoto');
  if (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      IW_PHOTO_TARGET = {
        pubId: link.getAttribute('data-pub'),
        groupId: link.getAttribute('data-group')
      };
      $('iwPhotoInput').click();
    });
  }
}

// Shared hidden input the info-window link drives.
var IW_PHOTO_TARGET = null;
$('iwPhotoInput').addEventListener('change', function () {
  var file = (this.files || [])[0];
  var t = IW_PHOTO_TARGET;
  this.value = '';
  if (!file || !t) return;
  var path = photoPath(t.groupId, t.pubId, S.PROFILE.id);
  uploadPhoto(path, file)
    .then(function () { return setRatingPhotoPath(t.pubId, path); })
    .then(function () { return renderPubs(); })
    .then(function () {
      // reopen the pub so the new photo shows
      var again = PUBS.filter(function (p) { return p.pubId === t.pubId; })[0];
      if (again) focusPub(viewOf(again) || again);
    })
    .catch(function (e) { showError('Photo upload failed: ' + (e.message || e)); });
});

function openLightbox(url) {
  var lb = $('lightbox');
  $('lightboxImg').src = url;
  lb.classList.add('open');
}

// ---------- map init ----------
async function initMap() {
  const { Map, InfoWindow } = await google.maps.importLibrary('maps');
  const marker = await google.maps.importLibrary('marker');
  AdvancedMarker = marker.AdvancedMarkerElement;

  MAP = new Map($('map'), {
    mapId: 'DEMO_MAP_ID',
    center: { lat: 52.2, lng: -1.5 },
    zoom: 6,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: !isMobile(),
    gestureHandling: 'greedy'
  });
  INFO = new InfoWindow();
  INFO.addListener('domready', fillPhotoSlots);
  await renderPubs();
}

/** (Re)load pubs for the active group and (re)draw everything. */
async function renderPubs() {
  // clear old markers
  MARKERS.forEach((m) => { m.marker.map = null; });
  MARKERS = [];
  if (INFO) INFO.close();

  try {
    PUBS = await fetchPubs();
  } catch (e) {
    showError('Could not load pubs: ' + (e.message || e));
    PUBS = [];
  }

  var bounds = new google.maps.LatLngBounds();
  PUBS.forEach(function (p) {
    var m = new AdvancedMarker({
      map: MAP,
      position: { lat: p.lat, lng: p.lng },
      content: pinFor(p),
      title: p.pub + ' — ' + (p.score == null ? '?' : p.score.toFixed(2))
    });
    var entry = { marker: m, pub: p, view: p };
    m.addListener('click', function () {
      INFO.setContent(infoHtml(entry.view || entry.pub));
      INFO.open(MAP, m);
    });
    MARKERS.push(entry);
    bounds.extend({ lat: p.lat, lng: p.lng });
  });

  if (PUBS.length) {
    MAP.fitBounds(bounds, boundsPadding());
    if (PUBS.length === 1) MAP.setZoom(15);
  }
  refreshFilterLists();
  updateLegend();
  applyFilters();
  loadUsers();
  loadActivity();
  if (isMobile()) $('panel').classList.add('collapsed');
}

function renderStats(list) {
  var scored = list.filter(function (p) { return p.score != null; });
  $('count').textContent = list.length;
  $('avg').textContent = scored.length
    ? (scored.reduce(function (a, p) { return a + p.score; }, 0) / scored.length).toFixed(2)
    : '—';
  $('best').textContent = scored.length
    ? Math.max.apply(null, scored.map(function (p) { return p.score; })).toFixed(2)
    : '—';
}

// ---------- leaderboard ----------
function cityOf(area) { return String(area || '').split(',')[0].trim() || '—'; }

function refreshFilterLists() {
  fillSelect('city', PUBS.map(function (p) { return cityOf(p.area); }), 'All cities');
  var names = [];
  PUBS.forEach(function (p) {
    (p.ratings || []).forEach(function (r) { names.push(r.author); });
  });
  fillSelect('author', names, 'Everyone (average)');
}

function fillSelect(id, rawValues, allLabel) {
  var sel = $(id);
  var current = sel.value;
  var vals = [];
  rawValues.forEach(function (v) {
    v = String(v || '').trim();
    if (v && vals.indexOf(v) === -1) vals.push(v);
  });
  vals.sort();
  sel.innerHTML = '<option value="">' + allLabel + '</option>';
  vals.forEach(function (v) {
    var o = document.createElement('option');
    o.value = v; o.textContent = v; sel.appendChild(o);
  });
  sel.value = vals.indexOf(current) === -1 ? '' : current;
}

function viewOf(p) {
  var author = $('author').value;
  if (!author) return p;
  var mine = (p.ratings || []).filter(function (r) {
    return String(r.author || '').trim() === author;
  })[0];
  if (!mine) return null;
  return {
    pub: p.pub, area: p.area, lat: p.lat, lng: p.lng, placeId: p.placeId,
    score: mine.score, cats: mine.cats,
    ratings: [mine], raters: 1, soloAuthor: author,
    pubId: p.pubId, groupId: p.groupId
  };
}

function visiblePubs() {
  var city = $('city').value;
  var out = [];
  PUBS.forEach(function (p) {
    if (city && cityOf(p.area) !== city) return;
    var v = viewOf(p);
    if (v) out.push(v);
  });
  return out;
}

function sortKey() { return $('sortBy').value; }
function valueFor(p, key) {
  if (key === 'score') return p.score;
  return p.cats ? p.cats[key] : null;
}

function renderBoard(list) {
  var key = sortKey();
  var body = $('boardBody');
  body.innerHTML = '';
  var scored = list.filter(function (p) { return valueFor(p, key) != null; });
  if (!scored.length) {
    body.innerHTML = '<tr><td class="none" colspan="4">No pubs match.</td></tr>';
    return;
  }
  scored.slice()
    .sort(function (a, b) { return valueFor(b, key) - valueFor(a, key); })
    .forEach(function (p, i) {
      var v = valueFor(p, key);
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="pos">' + (i + 1) + '</td>' +
        '<td class="dot"><i style="background:' + colourForKey(v, key) + '"></i></td>' +
        '<td class="nm" title="' + escapeHtml(p.pub + ' — ' + p.area) + '">' +
          escapeHtml(p.pub) + '</td>' +
        '<td class="sc">' + v.toFixed(key === 'score' ? 2 : 1) + '</td>';
      tr.addEventListener('click', function () { focusPub(p); });
      body.appendChild(tr);
    });
}

function focusPub(p) {
  var hit = null;
  MARKERS.forEach(function (m) {
    if ((p.placeId && m.pub.placeId === p.placeId) || m.pub.pub === p.pub) hit = m;
  });
  MAP.panTo({ lat: p.lat, lng: p.lng });
  MAP.setZoom(16);
  if (hit) {
    INFO.setContent(infoHtml(p));
    INFO.open(MAP, hit.marker);
  }
  if (isMobile()) $('panel').classList.add('collapsed');
}

function applyFilters() {
  var shown = visiblePubs();
  var byKey = {};
  shown.forEach(function (v) { byKey[v.placeId || v.pub] = v; });
  MARKERS.forEach(function (m) {
    var v = byKey[m.pub.placeId || m.pub.pub];
    m.marker.map = v ? MAP : null;
    if (v) {
      m.view = v;
      m.marker.content = pinFor(v);
      m.marker.title = v.pub + ' — ' + (v.score == null ? '?' : v.score.toFixed(2));
    }
  });
  if (INFO) INFO.close();
  renderStats(shown);
  renderBoard(shown);
}

function zoomToShown() {
  var shown = visiblePubs();
  if (!shown.length) return;
  var b = new google.maps.LatLngBounds();
  shown.forEach(function (p) { b.extend({ lat: p.lat, lng: p.lng }); });
  MAP.fitBounds(b, boundsPadding());
  if (shown.length === 1) MAP.setZoom(15);
}

$('city').addEventListener('change', function () { applyFilters(); zoomToShown(); });
$('author').addEventListener('change', function () { applyFilters(); zoomToShown(); });
function toggleSheet() {
  if (isMobile()) $('panel').classList.toggle('collapsed');
}
document.querySelector('#panel h1').addEventListener('click', toggleSheet);
$('dragHandle').addEventListener('click', toggleSheet);

function updateLegend() {
  var cat = sortKey() !== 'score';
  $('scLo').textContent = cat ? '2.0' : '4.0';
  $('scMid').textContent = cat ? '3.25' : '6.5';
  $('scHi').textContent = cat ? '4.5' : '9.0';
}
$('sortBy').addEventListener('change', function () { updateLegend(); applyFilters(); });

function showError(msg) {
  var el = $('err');
  el.textContent = msg;
  el.style.display = 'block';
}

// ---------- add-a-pub form ----------
/** Paint one slider: track fill + value chip take the score's colour. */
function updateCatVisual(key) {
  var val = Number($('f_' + key).value);
  var col = colourForKey(val, key);          // colourFor(val*2): red→yellow→green
  var input = $('f_' + key);
  input.style.setProperty('--pct', (val / 5) * 100);
  input.style.setProperty('--cc', col);
  var chip = $('v_' + key);
  chip.textContent = val.toFixed(1);
  chip.style.background = col;
}

(function buildCats() {
  var box = $('cats');
  var step = '0.1';
  CATS.forEach(function (c) {
    var row = document.createElement('div');
    row.className = 'cat';
    row.innerHTML = '<span class="lab">' + c.label + '</span>' +
      '<span class="v" id="v_' + c.key + '">3.0</span>' +
      '<input type="range" id="f_' + c.key + '" min="0" max="5" step="' + step + '" value="3">';
    box.appendChild(row);
  });
  CATS.forEach(function (c) {
    $('f_' + c.key).addEventListener('input', function () {
      updateCatVisual(c.key);
      updateLive();
    });
    updateCatVisual(c.key);
  });
  updateLive();
})();

function updateLive() {
  var total = CATS.reduce(function (a, c) {
    return a + Number($('f_' + c.key).value);
  }, 0);
  var score = total / 25 * 10;
  var el = $('liveScore');
  el.textContent = score.toFixed(2);
  el.style.color = colourFor(score);
}

function toggleForm(open) {
  $('form').style.display = open ? 'flex' : 'none';
  $('fabs').style.display = open ? 'none' : 'flex';
  $('userBar').style.display = open ? 'none' : 'block';
  if (open) {
    $('f_authorName').textContent = S.PROFILE ? S.PROFILE.display_name : '—';
    if (!isMobile()) $('f_pub').focus();
  }
}

// live "N left" counter under the note box
function updateNoteCount() {
  var el = $('f_note');
  $('f_noteCount').textContent = (el.maxLength - el.value.length) + ' left';
}
$('f_note').addEventListener('input', updateNoteCount);
updateNoteCount();

// local preview of the chosen photo (no upload yet)
$('f_photo').addEventListener('change', function () {
  var box = $('f_photoPreview');
  box.innerHTML = '';
  var f = this.files && this.files[0];
  if (!f) return;
  var img = document.createElement('img');
  img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:5px';
  img.src = URL.createObjectURL(f);
  img.onload = function () { URL.revokeObjectURL(img.src); };
  box.appendChild(img);
});

function loadUsers() {
  fetchUsers().then(function () { /* names used only for author filter now */ });
}

$('addBtn').addEventListener('click', function () { toggleForm(true); });
function closeForm() { toggleForm(false); setFormMsg('', ''); }
$('cancel').addEventListener('click', closeForm);
$('formClose').addEventListener('click', closeForm);

function setFormMsg(text, cls) {
  var el = $('formMsg');
  el.textContent = text;
  el.className = cls || '';
}

$('save').addEventListener('click', function () {
  var btn = this;
  var payload = {
    pub: $('f_pub').value.trim(),
    area: $('f_area').value.trim(),
    note: $('f_note').value.trim()
  };
  if (!payload.pub) { setFormMsg('Pub name is required.', 'bad'); return; }
  CATS.forEach(function (c) { payload[c.key] = Number($('f_' + c.key).value); });

  btn.disabled = true;
  setFormMsg('Locating and saving…', '');

  var file = ($('f_photo').files || [])[0] || null;

  submitPub(payload)
    .then(function (saved) {
      // Optional photo: upload after the rating exists (needs pubId).
      if (!file) return saved;
      setFormMsg('Uploading photo…', '');
      var path = photoPath(saved.groupId, saved.pubId, S.PROFILE.id);
      return uploadPhoto(path, file)
        .then(function () { return setRatingPhotoPath(saved.pubId, path); })
        .then(function () { return saved; })
        .catch(function (e) {
          // Rating is saved; only the photo failed. Tell the user, don't lose the rating.
          setFormMsg('Rating saved, but the photo failed: ' + (e.message || e), 'bad');
          throw { handled: true };
        });
    })
    .then(function (saved) {
      btn.disabled = false;
      setFormMsg('Saved ' + saved.pub + ' — ' +
                 (saved.score == null ? '?' : saved.score.toFixed(2)), 'good');
      renderPubs();          // reload group data so averages/pins reflect the new rating
      loadActivity();
      $('f_pub').value = '';
      $('f_area').value = '';
      $('f_note').value = '';
      updateNoteCount();
      $('f_photo').value = '';
      $('f_photoPreview').innerHTML = '';
      setTimeout(function () { toggleForm(false); setFormMsg('', ''); }, 1600);
    })
    .catch(function (e) {
      btn.disabled = false;
      if (e && e.handled) { renderPubs(); return; }  // photo-only failure already messaged
      setFormMsg(e.message || 'Something went wrong.', 'bad');
    });
});

// ---------- recent activity ----------
function relTime(ms) {
  if (!ms) return '';
  var s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}

function renderActivity(items) {
  var box = $('activityList');
  box.innerHTML = '';
  if (!items || !items.length) {
    box.innerHTML = '<div class="none">Nothing yet.</div>';
    return;
  }
  items.forEach(function (a) {
    var row = document.createElement('div');
    row.className = 'act';
    row.innerHTML =
      '<i style="background:' + colourFor(a.score) + '"></i>' +
      '<div class="body">' +
        '<div class="pub">' + escapeHtml(a.pub) + '</div>' +
        '<div class="meta">' + escapeHtml(a.author) +
          (a.ratedAt ? ' · ' + relTime(a.ratedAt) : '') + '</div>' +
      '</div>' +
      '<span class="sc" style="color:' + colourFor(a.score) + '">' +
        (a.score == null ? '—' : a.score.toFixed(1)) + '</span>';
    row.addEventListener('click', function () { focusPub(a); });
    box.appendChild(row);
  });
}

function loadActivity() {
  fetchActivity(40).then(renderActivity).catch(function () {});
}

// ---------- panel: leaderboard / activity tabs + swipe ----------
var PANEL_PAGE = 0;                 // 0 = leaderboard, 1 = activity
function setPanelPage(i) {
  PANEL_PAGE = i;
  $('panelTrack').style.transform = 'translateX(' + (-i * 100) + '%)';
  document.querySelectorAll('#panelTabs .ptab').forEach(function (b, idx) {
    var on = idx === i;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (i === 1) loadActivity();     // freshen the feed when it comes into view
}
document.querySelectorAll('#panelTabs .ptab').forEach(function (b) {
  b.addEventListener('click', function () { setPanelPage(Number(b.dataset.page)); });
});

// horizontal swipe between the two pages (touch only; vertical scroll untouched)
(function () {
  var pages = $('panelPages'), track = $('panelTrack');
  var x0 = 0, y0 = 0, dir = 0;     // dir: 0 undecided, 1 horizontal, -1 vertical
  pages.addEventListener('touchstart', function (e) {
    var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dir = 0;
    track.style.transition = 'none';
  }, { passive: true });
  pages.addEventListener('touchmove', function (e) {
    var t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (dir === 0 && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      dir = Math.abs(dx) > Math.abs(dy) ? 1 : -1;
    }
    if (dir !== 1) return;         // let the page scroll vertically
    e.preventDefault();
    var base = -PANEL_PAGE * pages.clientWidth;
    // resist dragging past the first/last page
    if ((PANEL_PAGE === 0 && dx > 0) || (PANEL_PAGE === 1 && dx < 0)) dx *= 0.35;
    track.style.transform = 'translateX(' + (base + dx) + 'px)';
  }, { passive: false });
  pages.addEventListener('touchend', function (e) {
    track.style.transition = '';
    if (dir !== 1) return;
    var dx = e.changedTouches[0].clientX - x0;
    var threshold = pages.clientWidth * 0.2;
    if (dx <= -threshold && PANEL_PAGE === 0) setPanelPage(1);
    else if (dx >= threshold && PANEL_PAGE === 1) setPanelPage(0);
    else setPanelPage(PANEL_PAGE);  // snap back
  });
})();

// close the photo lightbox on any click
$('lightbox').addEventListener('click', function () {
  this.classList.remove('open');
  $('lightboxImg').src = '';
});

// ---------- account + group menu inside the map ----------
function initialsOf(name) {
  var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function syncMapGroupBar() {
  var sel = $('mapGroupSel');
  sel.innerHTML = '';
  S.GROUPS.forEach(function (g) {
    var o = document.createElement('option');
    o.value = g.id; o.textContent = g.name; sel.appendChild(o);
  });
  sel.value = S.ACTIVE_GROUP.id;
  var name = S.PROFILE ? S.PROFILE.display_name : '';
  $('mapMe').textContent = name;
  var ini = initialsOf(name);
  $('avatarInitials').textContent = ini;
  $('avatarInitialsLg').textContent = ini;
}
$('mapGroupSel').addEventListener('change', function () {
  var g = S.GROUPS.find(function (x) { return x.id === $('mapGroupSel').value; });
  if (!g) return;
  S.ACTIVE_GROUP = { id: g.id, name: g.name };
  rememberGroup();
  closeUserMenu();
  renderPubs();
});

// open/close the avatar menu; tap-away and Escape close it
function openUserMenu() {
  $('userMenu').classList.remove('hidden');
  $('avatarBtn').setAttribute('aria-expanded', 'true');
}
function closeUserMenu() {
  $('userMenu').classList.add('hidden');
  $('avatarBtn').setAttribute('aria-expanded', 'false');
  $('mapCreateBox').classList.add('hidden');
  setMapMsg('', '');
  setShareMsg('', '');
}
$('avatarBtn').addEventListener('click', function (e) {
  e.stopPropagation();
  $('userMenu').classList.contains('hidden') ? openUserMenu() : closeUserMenu();
});
$('userMenu').addEventListener('click', function (e) { e.stopPropagation(); });
document.addEventListener('click', function () {
  if (!$('userMenu').classList.contains('hidden')) closeUserMenu();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !$('userMenu').classList.contains('hidden')) closeUserMenu();
});

// share a link that joins the active group directly (the ?join= word)
function setShareMsg(text, cls) {
  var el = $('mapShareMsg');
  el.textContent = text;
  el.className = 'um-msg' + (cls ? ' ' + cls : '');
}
$('mapShare').addEventListener('click', async function () {
  var g = S.GROUPS.find(function (x) { return x.id === S.ACTIVE_GROUP.id; });
  if (!g || !g.invite_code) { setShareMsg('No invite word for this group.', 'bad'); return; }
  var url = location.origin + '/?join=' + encodeURIComponent(g.invite_code);
  var shareData = { title: 'PlotMyPub', text: 'Join "' + g.name + '" on PlotMyPub', url: url };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    setShareMsg('Invite link copied ✓', 'good');
  } catch (e) {
    setShareMsg(url, '');
  }
});

// create a group without leaving the map
function setMapMsg(text, cls) {
  var el = $('mapGroupMsg');
  el.textContent = text;
  el.className = 'um-msg' + (cls ? ' ' + cls : '');
}
$('mapCreateToggle').addEventListener('click', function () {
  var box = $('mapCreateBox');
  var opening = box.classList.contains('hidden');
  box.classList.toggle('hidden');
  if (opening) $('mapNewName').focus();
});
$('mapCreate').addEventListener('click', async function () {
  var name = $('mapNewName').value.trim(), code = $('mapNewCode').value.trim();
  if (!name || !code) { setMapMsg('Name the group and give it an invite word.', 'bad'); return; }
  $('mapCreate').disabled = true; setMapMsg('Creating…', '');
  var res = await sb.rpc('create_group', { p_name: name, p_invite_code: code });
  $('mapCreate').disabled = false;
  if (res.error) { setMapMsg(res.error.message, 'bad'); return; }
  await loadGroups();
  var g = S.GROUPS.find(function (x) { return x.name === name; }) || S.GROUPS[S.GROUPS.length - 1];
  if (g) S.ACTIVE_GROUP = { id: g.id, name: g.name };
  rememberGroup();
  $('mapNewName').value = ''; $('mapNewCode').value = '';
  syncMapGroupBar();
  closeUserMenu();
  renderPubs();
});

// ---------- Maps JS loader (one-time) ----------
function loadGoogleMaps() {
  return new Promise(function (resolve, reject) {
    if (MAPS_LOADED) { resolve(); return; }
    if (MAPS_BROWSER_KEY === 'PASTE_MAPS_BROWSER_KEY_HERE') {
      reject(new Error('Set MAPS_BROWSER_KEY in the page config.'));
      return;
    }
    // Official Google Maps inline bootstrap loader. Defines the single
    // google.maps.importLibrary — every Maps class must come from that.
    // Do NOT add `libraries` here; libraries are requested per importLibrary
    // call. The IIFE is idempotent (warns and ignores if run twice), and the
    // MAPS_LOADED flag keeps us from re-invoking it.
    (g => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams, u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, t => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a); })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)); })({
      key: MAPS_BROWSER_KEY,
      v: "weekly"
    });
    MAPS_LOADED = true;
    resolve();
  });
}

// ---------- enter the map from the gate ----------
export async function enterApp() {
  document.body.className = 'app';
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  showView('map');            // always land on the map when entering
  rememberGroup();
  syncMapGroupBar();
  try {
    await loadGoogleMaps();
    if (!MAP) await initMap();
    else await renderPubs();
  } catch (e) {
    showError(e.message || 'Could not start the map.');
  }
}
