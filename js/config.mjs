// PlotMyPub — static configuration and shared constants.

// ================= Supabase =================
export const SUPABASE_URL = 'https://bgjcfhbrrggdubgnbvaj.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_hFPb_xrfHrPm3Ub1yisa5A_TYg80y3n';

// Reuse the existing MAPS_BROWSER_KEY from the old Apps Script project.
// Referrer-restricted; add http://localhost:3000/* now and the CDN origin at Phase 7.
// Needs the "Maps JavaScript API" enabled. Places is NOT called from the
// browser (geocoding goes through the Edge Function), so Places need not be
// allowed on THIS key.
export const MAPS_BROWSER_KEY = 'AIzaSyDLQKoBZQpJ9mxOvr6fCpmnoa1zK6NwXDw';

// Rating categories — shared by the map view (breakdowns) and the add-a-pub form.
export const CATS = [
  { key: 'location',   label: 'Location' },
  { key: 'beer',       label: 'Beer Selection' },
  { key: 'value',      label: 'Value' },
  { key: 'facilities', label: 'Facilities' },
  { key: 'vibe',       label: 'Vibe' }
];
