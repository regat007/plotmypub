// supabase/functions/backfill-geo/index.ts
//
// One-off admin task: fill country / city / elevation_m on pubs that predate the
// geo migration (0006_geo.sql), from the coordinates already stored on each pub.
// New pubs get these fields at add-time from the geocode function; this is purely
// for history. Uses the same FREE, KEYLESS services as geocode:
//   - country (ISO2) + city ← BigDataCloud reverse-geocode-client
//   - elevation (metres)    ← Open-Meteo elevation API
// No Google APIs are involved here at all.
//
// Runs in batches so a single invocation can't run away — call it repeatedly
// until { remaining: 0 }. When the last pub is enriched it also awards the
// historical geo badges (backfill_geo_achievements()).
//
// Deploy:  npx supabase functions deploy backfill-geo
// Invoke:  POST with a valid Supabase JWT, e.g.
//   curl -X POST "$SUPABASE_URL/functions/v1/backfill-geo" \
//     -H "Authorization: Bearer $YOUR_JWT" -H "apikey: $ANON"
// Uses the injected SUPABASE_SERVICE_ROLE_KEY to update pubs across all groups.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const BATCH = 40;   // pubs enriched per invocation

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function reverseGeo(lat: number, lng: number): Promise<{ country: string | null; city: string | null }> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) return { country: null, city: null };
    const d = await res.json();
    return { country: d.countryCode || null, city: d.city || d.locality || d.principalSubdivision || null };
  } catch { return { country: null, city: null }; }
}

async function elevationOf(lat: number, lng: number): Promise<number | null> {
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    if (Array.isArray(d.elevation) && d.elevation.length) return Math.round(d.elevation[0]);
  } catch { /* fall through */ }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Gate on a valid session. (One-off admin task.)
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.replace(/^Bearer\s+/i, '')) return json({ error: 'Not signed in.' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const asUser = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await asUser.auth.getUser();
  if (authErr || !user) return json({ error: 'Not signed in.' }, 401);

  // Service-role client bypasses RLS to update pubs in every group.
  const admin = createClient(url, service);

  // Pending = pubs with coordinates but no elevation yet (elevation resolves for
  // any point, so it's the reliable "already processed" marker).
  const { data: pending, error: selErr } = await admin
    .from('pubs')
    .select('id,lat,lng')
    .is('elevation_m', null)
    .not('lat', 'is', null)
    .limit(BATCH);
  if (selErr) return json({ error: selErr.message }, 500);

  let processed = 0;
  for (const p of pending || []) {
    try {
      const [{ country, city }, elevation] = await Promise.all([
        reverseGeo(p.lat, p.lng),
        elevationOf(p.lat, p.lng),
      ]);
      await admin.from('pubs').update({ country, city, elevation_m: elevation }).eq('id', p.id);
      processed++;
    } catch (e) {
      console.warn(`pub ${p.id} failed: ${e}`);
    }
  }

  // How many still pending after this batch?
  const { count: remaining } = await admin
    .from('pubs')
    .select('id', { count: 'exact', head: true })
    .is('elevation_m', null)
    .not('lat', 'is', null);

  // When the last pub is enriched, award the historical geo badges.
  let backfilled = false;
  if ((remaining || 0) === 0) {
    const { error: rpcErr } = await admin.rpc('backfill_geo_achievements');
    backfilled = !rpcErr;
    if (rpcErr) console.warn('backfill_geo_achievements failed: ' + rpcErr.message);
  }

  return json({ processed, remaining: remaining || 0, backfilled });
});
