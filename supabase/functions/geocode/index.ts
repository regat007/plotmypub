// supabase/functions/geocode/index.ts
//
// Ports the old Apps Script lookup_() to a Supabase Edge Function.
// Keeps the Google Places key SERVER-SIDE — the browser never sees it.
//
// Flow: Places Text Search (bar, GB) first; on miss, fall back to the
// Geocoding API (the Deno equivalent of Maps.newGeocoder()). Returns
// { lat, lng, placeId } or { error }.
//
// Deploy:  npx supabase functions deploy geocode
// Secret:  npx supabase secrets set GOOGLE_PLACES_KEY=<your places key>
//          (this is the SERVER key — the one Apps Script called PLACES_API_KEY,
//           NOT the referrer-restricted browser Maps key)
//
// Called from the browser with the user's Supabase JWT in the Authorization
// header, so only signed-in users can spend geocoding quota.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // --- gate on a valid Supabase session: no anonymous quota burning ---
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Not signed in.' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return json({ error: 'Not signed in.' }, 401);

  // --- parse input ---
  let pub = '', area = '';
  try {
    const body = await req.json();
    pub = String(body.pub || '').trim();
    area = String(body.area || '').trim();
  } catch {
    return json({ error: 'Bad request body.' }, 400);
  }
  if (!pub) return json({ error: 'Pub name is required.' }, 400);

  const key = Deno.env.get('GOOGLE_PLACES_KEY');
  if (!key) return json({ error: 'GOOGLE_PLACES_KEY not configured.' }, 500);

  const query = [pub, area, 'UK'].filter(Boolean).join(', ');

  // --- 1) Places Text Search (mirrors the old primary path) ---
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.location,places.displayName',
      },
      body: JSON.stringify({
        textQuery: query,
        includedType: 'bar',
        regionCode: 'GB',
        maxResultCount: 1,
      }),
    });

    if (res.status === 403) {
      return json({ error: 'Places API rejected the key (403) — check GOOGLE_PLACES_KEY restrictions.' }, 502);
    }
    if (res.ok) {
      const data = await res.json();
      if (data.places && data.places.length) {
        const p = data.places[0];
        return json({
          lat: p.location.latitude,
          lng: p.location.longitude,
          placeId: p.id,
        });
      }
    } else {
      console.warn(`Places error ${res.status}: ${await res.text()}`);
    }
  } catch (e) {
    console.warn('Places lookup threw: ' + e);
  }

  // --- 2) Geocoding API fallback (mirrors Maps.newGeocoder().setRegion('uk')) ---
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json'
      + `?address=${encodeURIComponent(query)}&region=uk&key=${key}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'OK' && data.results.length) {
        const r = data.results[0];
        return json({
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          placeId: r.place_id,
        });
      }
    }
  } catch (e) {
    console.warn('Geocoder fallback threw: ' + e);
  }

  return json({ error: `Could not find "${pub}" — check the name and area.` }, 404);
});
