// supabase/functions/geocode/index.ts
//
// Ports the old Apps Script lookup_() to a Supabase Edge Function.
// Keeps the Google Places key SERVER-SIDE — the browser never sees it.
//
// Flow: Places Text Search first; on miss, fall back to the Geocoding API to get
// lat/lng/placeId. Then enrich from the coordinates using FREE, KEYLESS services:
//   - country (ISO2) + city ← BigDataCloud reverse-geocode-client   (Jet Setter / Mr Worldwide / Drink Driver)
//   - elevation (metres)    ← Open-Meteo elevation API              (Brew with a View)
// No new Google APIs are needed beyond the Places/Geocoding you already use.
//
// INTERNATIONAL: the query is no longer forced to the UK (used to append 'UK'
// + regionCode 'GB'), so pubs abroad resolve to their real country/city. Users
// should include the town — and the country if abroad — in the Area field.
//
// Deploy:  npx supabase functions deploy geocode
// Secret:  npx supabase secrets set GOOGLE_PLACES_KEY=<your server key>
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

// Country (ISO2) + city from coordinates. Free, keyless. Fail-soft to nulls.
async function reverseGeo(lat: number, lng: number): Promise<{ country: string | null; city: string | null }> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) return { country: null, city: null };
    const d = await res.json();
    return {
      country: d.countryCode || null,                          // e.g. 'GB'
      city: d.city || d.locality || d.principalSubdivision || null,
    };
  } catch (e) {
    console.warn('reverseGeo threw: ' + e);
    return { country: null, city: null };
  }
}

// Elevation in metres from coordinates. Free, keyless. Fail-soft to null.
async function elevationOf(lat: number, lng: number): Promise<number | null> {
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    if (Array.isArray(d.elevation) && d.elevation.length) return Math.round(d.elevation[0]);
  } catch (e) {
    console.warn('elevationOf threw: ' + e);
  }
  return null;
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

  const query = [pub, area].filter(Boolean).join(', ');

  let found: { lat: number; lng: number; placeId: string } | null = null;

  // --- 1) Places Text Search (primary; now global, not GB-locked) ---
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
        found = { lat: p.location.latitude, lng: p.location.longitude, placeId: p.id };
      }
    } else {
      console.warn(`Places error ${res.status}: ${await res.text()}`);
    }
  } catch (e) {
    console.warn('Places lookup threw: ' + e);
  }

  // --- 2) Geocoding API fallback ---
  if (!found) {
    try {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json'
        + `?address=${encodeURIComponent(query)}&key=${key}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'OK' && data.results.length) {
          const r = data.results[0];
          found = { lat: r.geometry.location.lat, lng: r.geometry.location.lng, placeId: r.place_id };
        }
      }
    } catch (e) {
      console.warn('Geocoder fallback threw: ' + e);
    }
  }

  if (!found) {
    return json({ error: `Could not find "${pub}" — check the name and area.` }, 404);
  }

  // Enrich from the coordinates via the free services (parallel, fail-soft).
  const [{ country, city }, elevation] = await Promise.all([
    reverseGeo(found.lat, found.lng),
    elevationOf(found.lat, found.lng),
  ]);
  return json({ ...found, country, city, elevation });
});
