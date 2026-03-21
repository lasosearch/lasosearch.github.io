/**
 * LASO Search — Configuration
 *
 * Copy this file to config.js and fill in your API key:
 *   cp config.example.js config.js
 *
 * Google Places API (New) is the PRIMARY search backend.
 * Without a valid key, LASO Search will not return results.
 *
 * Setup:
 *   1. Go to console.cloud.google.com → select or create a project
 *   2. Enable "Places API (New)" in APIs & Services → Library
 *   3. Create an API key in APIs & Services → Credentials
 *   4. Restrict the key:
 *        - Application restrictions → HTTP referrers → add your domain
 *        - API restrictions → Restrict key → select "Places API (New)" only
 *   5. Set daily quota (hard server-side cap):
 *        - Go to IAM & Admin → Quotas
 *        - Filter: "SearchNearbyRequest per day"
 *        - Check the box → Edit Quotas → set to 150
 *        - Also set "SearchNearbyRequest per minute" → 10
 *   6. Set billing budget: Billing → Budgets & alerts → $300 lifetime cap
 *   7. Paste your key below
 *
 * Cost at Enterprise tier (~$0.04/call):
 *   - Each LASO search uses ~4 API calls (one per type group)
 *   - 150 calls/day = ~37 searches/day
 *   - $200/month free credit covers ~5,000 calls/month
 */


// Client-side daily call budget (per device — secondary safety net).
// The real hard cap is the Google Cloud quota you set in step 5.
const GOOGLE_PLACES_DAILY_LIMIT = 150;

// Warn in console when this percentage of the daily limit is reached
const GOOGLE_PLACES_WARN_THRESHOLD = 0.8;
const _PROD_PROXY = 'https://laso-api-proxy.corywboris.workers.dev';
const _h = typeof window !== 'undefined' && window.location && window.location.hostname;
const _isLocal = (_h === 'localhost' || _h === '127.0.0.1' || _h === '192.168.1.127');
// Local dev: proxy through the Flask server on the same origin (/api/* → localhost:8787)
// so mobile devices on the LAN never need to reach a second port.
const _LOCAL_PROXY = window.location.origin + '/api';
const LASO_PROXY_URL = _isLocal ? _LOCAL_PROXY : _PROD_PROXY;
