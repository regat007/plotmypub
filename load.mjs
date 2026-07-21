// ============================================================================
// PlotMyPub → Supabase  ·  Phase 2: one-off data loader
// ----------------------------------------------------------------------------
// Reads a CSV export of the "Pub Ratings" tab and loads it into the schema
// from Phase 1. Re-runnable: it upserts, so running twice won't duplicate.
//
//   npm install @supabase/supabase-js papaparse
//   set SUPABASE_URL=https://<ref>.supabase.co
//   set SUPABASE_SERVICE_ROLE_KEY=<service_role key>   (Settings → API; NEVER commit)
//   node load.mjs pub_ratings.csv
//
// Export the CSV from Google Sheets: select the *Pub Ratings* tab →
// File → Download → Comma-separated values (.csv). That exports only that tab.
//
// The service_role key bypasses RLS (that's why the loader can write freely).
// Keep it local; don't paste it into the app or commit it.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import Papa from 'papaparse';
import { readFileSync } from 'node:fs';

// ---- config ----------------------------------------------------------------
const GROUP_NAME  = 'Rookery';
const INVITE_CODE = 'rookery';                 // permanent join word (Decision #6)
const SKIP_NAMES  = ['test_account', 'test account'];
const BASELINE    = '2026-07-16T00:00:00+01:00'; // created_at for un-dated legacy rows
const CSV_PATH    = process.argv[2] || 'pub_ratings.csv';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  process.exit(1);
}
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// ---- helpers ---------------------------------------------------------------
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// 0–5 float, else null (a null in any category means we skip that rating).
const cat = (v) => {
  const n = parseFloat(v);
  return Number.isNaN(n) || n < 0 || n > 5 ? null : n;
};

// "2026-07-20 08:08" / "2026-07-19" / "" → ISO. July = BST, so +01:00.
const parseDate = (s) => {
  s = String(s || '').trim();
  if (!s) return BASELINE;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if (!m) return BASELINE;
  const time = m[2] ? m[2] + (m[3] ? ':' + m[3] : ':00') : '00:00:00';
  return `${m[1]}T${time}+01:00`;
};

const die = (label, error) => {
  if (error) { console.error(`✗ ${label}:`, error.message || error); process.exit(1); }
};

// ---- parse CSV -------------------------------------------------------------
const csv = Papa.parse(readFileSync(CSV_PATH, 'utf8'), {
  header: true, skipEmptyLines: true,
  transformHeader: (h) => h.trim(),
});
const rows = csv.data
  .map((r) => ({
    pub:     clean(r['Pub']),
    area:    clean(r['Area']),
    author:  clean(r['Author']),
    location: cat(r['Location']),
    beer:     cat(r['Beer Selection']),
    value:    cat(r['Value']),
    facilities: cat(r['Facilities']),
    vibe:     cat(r['Vibe']),
    lat:      parseFloat(r['Lat']),
    lng:      parseFloat(r['Lng']),
    placeId:  clean(r['Place ID']) || null,
    ratedAt:  parseDate(r['Date of Entry']),
  }))
  .filter((r) => r.pub && r.author && !SKIP_NAMES.includes(norm(r.author)));

console.log(`Parsed ${rows.length} usable rating rows from ${CSV_PATH}.`);

// ---- 1. group --------------------------------------------------------------
let group;
{
  const { data } = await sb.from('groups').select('*').eq('name', GROUP_NAME).maybeSingle();
  if (data) { group = data; console.log(`Group "${GROUP_NAME}" already exists.`); }
  else {
    const res = await sb.from('groups')
      .insert({ name: GROUP_NAME, invite_code: INVITE_CODE }).select().single();
    die('create group', res.error);
    group = res.data;
    console.log(`Created group "${GROUP_NAME}" (code: ${INVITE_CODE}).`);
  }
}

// ---- 2. profiles (unclaimed) ----------------------------------------------
const byName = new Map();                        // normalised name → profile row
{
  const { data: existing } = await sb.from('profiles').select('*');
  (existing || []).forEach((p) => byName.set(norm(p.display_name), p));

  const wanted = new Map();                       // norm → first-seen display spelling
  rows.forEach((r) => { if (!wanted.has(norm(r.author))) wanted.set(norm(r.author), clean(r.author)); });

  const missing = [...wanted.entries()].filter(([n]) => !byName.has(n));
  if (missing.length) {
    const res = await sb.from('profiles')
      .insert(missing.map(([, display]) => ({ display_name: display }))).select();
    die('insert profiles', res.error);
    res.data.forEach((p) => byName.set(norm(p.display_name), p));
  }
  console.log(`Profiles: ${wanted.size} raters (${missing.length} new, unclaimed).`);
}

// ---- 3. group_members ------------------------------------------------------
// Pre-seed membership for every migrated profile so that when a person later
// signs in and claims their legacy name, they immediately see Rookery's data.
{
  const memberRows = [...byName.values()].map((p) => ({ group_id: group.id, profile_id: p.id }));
  const res = await sb.from('group_members')
    .upsert(memberRows, { onConflict: 'group_id,profile_id', ignoreDuplicates: true });
  die('seed members', res.error);
  console.log(`Members: ${memberRows.length} profiles attached to ${GROUP_NAME}.`);
}

// ---- 4. pubs (dedupe on place_id; first-seen wins) -------------------------
const pubKey = (r) => r.placeId || `${norm(r.pub)}|${norm(r.area)}`;
const byPub = new Map();                          // pubKey → pub row
{
  const { data: existing } = await sb.from('pubs').select('*').eq('group_id', group.id);
  (existing || []).forEach((p) => byPub.set(p.place_id || `${norm(p.name)}|${norm(p.area)}`, p));

  const firstSeen = new Map();                    // pubKey → row (first occurrence)
  rows.forEach((r) => { const k = pubKey(r); if (!firstSeen.has(k)) firstSeen.set(k, r); });

  const missing = [...firstSeen.entries()].filter(([k]) => !byPub.has(k));
  if (missing.length) {
    const res = await sb.from('pubs').insert(missing.map(([, r]) => ({
      group_id: group.id, name: r.pub, area: r.area,
      lat: Number.isFinite(r.lat) ? r.lat : null,
      lng: Number.isFinite(r.lng) ? r.lng : null,
      place_id: r.placeId,
    }))).select();
    die('insert pubs', res.error);
    res.data.forEach((p) => byPub.set(p.place_id || `${norm(p.name)}|${norm(p.area)}`, p));
  }
  console.log(`Pubs: ${firstSeen.size} distinct (${missing.length} new).`);
}

// ---- 5. ratings (one per pub+author; last spelling of a dupe wins) ---------
{
  const seen = new Map();                          // pubId|profileId → rating payload
  let skipped = 0;
  for (const r of rows) {
    if ([r.location, r.beer, r.value, r.facilities, r.vibe].some((v) => v === null)) { skipped++; continue; }
    const pub = byPub.get(pubKey(r));
    const prof = byName.get(norm(r.author));
    if (!pub || !prof) { skipped++; continue; }
    seen.set(`${pub.id}|${prof.id}`, {
      pub_id: pub.id, group_id: group.id, profile_id: prof.id,
      location: r.location, beer: r.beer, value: r.value,
      facilities: r.facilities, vibe: r.vibe,
      created_at: r.ratedAt, updated_at: r.ratedAt,
    });
  }
  const payload = [...seen.values()];
  const res = await sb.from('ratings').upsert(payload, { onConflict: 'pub_id,profile_id' });
  die('insert ratings', res.error);
  console.log(`Ratings: ${payload.length} loaded${skipped ? `, ${skipped} skipped` : ''}.`);
}

console.log('\n✓ Migration complete. Spot-check pub_scores in the SQL editor:');
console.log("   select name, area, raters, round(score::numeric,2) as score");
console.log("   from pub_scores order by score desc nulls last limit 10;");
