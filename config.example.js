/**
 * LASO Search — Configuration
 *
 * Copy this file to config.js and fill in your proxy URL:
 *   cp config.example.js config.js
 *
 * The Google Places API key is stored as a secret on the Cloudflare Worker.
 * It NEVER appears in client-side code.
 *
 * Setup:
 *   1. Deploy the Cloudflare Worker (see worker/ directory):
 *        cd worker && wrangler deploy
 *   2. Add your Google API key as a Worker secret:
 *        wrangler secret put GOOGLE_PLACES_API_KEY
 *   3. Copy the Worker URL (e.g. https://laso-api-proxy.yourname.workers.dev)
 *   4. Paste it below as LASO_PROXY_URL
 *
 * Google Cloud Console (still required):
 *   1. Go to console.cloud.google.com → select or create a project
 *   2. Enable "Places API (New)" in APIs & Services → Library
 *   3. Create an API key in APIs & Services → Credentials
 *   4. NO referrer restriction needed (Worker calls from server-side)
 *   5. API restrictions → Restrict key → select "Places API (New)" only
 *   6. Set daily quota: IAM & Admin → Quotas → 150 SearchNearby/day, 10/min
 *   7. Set billing budget: Billing → Budgets & alerts → $300 lifetime cap
 *   8. Add the key as a Worker secret (step 2 above)
 *
 * Cost at Enterprise tier (~$0.04/call):
 *   - Each LASO search uses ~4 API calls (one per type group)
 *   - 150 calls/day = ~37 searches/day
 *   - $200/month free credit covers ~5,000 calls/month
 */

// ─── Cloudflare Worker Proxy URL ────────────────────────────────────────────
// Production worker URL (REQUIRED) — e.g. 'https://laso-api-proxy.yourname.workers.dev'
const _PROD_PROXY = '';

// Local development: when serving from localhost/127.0.0.1, route API calls
// to a local wrangler dev instance instead of the production worker.
// Start it with:  cd worker && wrangler dev --env dev
const _LOCAL_PROXY = 'http://localhost:8787';

const _h = typeof window !== 'undefined' && window.location && window.location.hostname;
const LASO_PROXY_URL = (_h === 'localhost' || _h === '127.0.0.1')
    ? _LOCAL_PROXY
    : _PROD_PROXY;

// Client-side daily call budget (per device — secondary safety net).
// The real hard cap is the Google Cloud quota you set in step 6.
const GOOGLE_PLACES_DAILY_LIMIT = 150;

// Warn in console when this percentage of the daily limit is reached
const GOOGLE_PLACES_WARN_THRESHOLD = 0.8;
