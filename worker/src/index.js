/**
 * LASO Search — Cloudflare Worker API Proxy
 *
 * Sits between the static GitHub Pages site and external APIs.
 * API keys live here as secrets — never touch the browser.
 *
 * Routes:
 *   POST /search      — proxies to Google Places searchNearby
 *   POST /textsearch  — proxies to Google Places searchText
 *   POST /verify      — minimal searchNearby call to verify connectivity
 *   GET  /yelp        — proxies to Yelp Business Search (rate-limited 5K/day)
 *   OPTIONS *         — CORS preflight
 *
 * Secrets (set via `wrangler secret put <NAME>`):
 *   GOOGLE_PLACES_API_KEY — Google Places API key
 *   YELP_API_KEY          — Yelp Fusion API key
 *
 * KV Namespace (bind in wrangler.toml):
 *   RATE_LIMIT            — used for daily Yelp call counting
 */

const YELP_DAILY_LIMIT = 5000;

// Allowed origins — requests from any other origin are rejected.
// Production deploys only allow PROD_ORIGINS.
// Local dev (`wrangler dev`) reads .dev.vars which sets ALLOW_LOCAL_ORIGINS=true,
// adding localhost/LAN origins so the Flask dev server proxy can reach the worker.
// `wrangler deploy` never reads .dev.vars, so local origins are always blocked in production.
const PROD_ORIGINS = [
    'https://lasosearch.github.io',
    'https://idrawmap.com',
    'https://www.idrawmap.com',
];

const LOCAL_ORIGINS = [
    'http://localhost',
    'https://localhost',
    'http://127.0.0.1',
    'https://127.0.0.1',
    'http://192.168.',
    'https://192.168.',
];

function isOriginAllowed(origin, env) {
    if (!origin) return false;
    if (PROD_ORIGINS.some(a => origin === a || origin.startsWith(a + ':'))) return true;
    if (env.ALLOW_LOCAL_ORIGINS === 'true') {
        return LOCAL_ORIGINS.some(a => origin === a || origin.startsWith(a));
    }
    return false;
}

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Goog-FieldMask',
        'Access-Control-Max-Age': '86400',
    };
}

/** Get today's date key for rate limiting (UTC). */
function todayKey() {
    return `yelp_calls_${new Date().toISOString().slice(0, 10)}`;
}

/** Check and increment the Yelp daily call counter via KV. */
async function checkYelpRateLimit(env) {
    if (!env.RATE_LIMIT) return { allowed: true, count: 0 }; // No KV bound — skip limiting
    const key = todayKey();
    const raw = await env.RATE_LIMIT.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= YELP_DAILY_LIMIT) return { allowed: false, count };
    // Increment — TTL 48h so yesterday's key auto-expires
    await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 172800 });
    return { allowed: true, count: count + 1 };
}

/** Handle GET /yelp — proxy to Yelp Business Search. */
async function handleYelp(request, env, origin) {
    if (!env.YELP_API_KEY) {
        return new Response(
            JSON.stringify({ error: 'Yelp API key not configured on worker' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
        );
    }

    // Rate limit check
    const { allowed, count } = await checkYelpRateLimit(env);
    if (!allowed) {
        return new Response(
            JSON.stringify({ error: 'Daily Yelp limit reached', count }),
            { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
        );
    }

    // Parse query params
    const url = new URL(request.url);
    const term = url.searchParams.get('term');
    const latitude = url.searchParams.get('latitude');
    const longitude = url.searchParams.get('longitude');

    if (!term || !latitude || !longitude) {
        return new Response(
            JSON.stringify({ error: 'Missing required params: term, latitude, longitude' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
        );
    }

    try {
        const yelpParams = new URLSearchParams({
            term,
            latitude,
            longitude,
            limit: '1',
            sort_by: 'best_match'
        });

        const yelpResponse = await fetch(
            `https://api.yelp.com/v3/businesses/search?${yelpParams.toString()}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${env.YELP_API_KEY}`,
                    'Accept': 'application/json',
                },
            }
        );

        if (!yelpResponse.ok) {
            const errBody = await yelpResponse.text();
            console.error('[Yelp API]', yelpResponse.status, errBody);
            return new Response(
                JSON.stringify({ error: 'Yelp API error', status: yelpResponse.status }),
                { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
            );
        }

        const data = await yelpResponse.json();
        if (!data.businesses || data.businesses.length === 0) {
            return new Response(
                JSON.stringify({}),
                { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
            );
        }

        // Return slim response — only the fields the client needs
        const biz = data.businesses[0];
        const slim = {
            rating: biz.rating,
            review_count: biz.review_count,
            price: biz.price || null,
            phone: biz.display_phone || biz.phone || null,
            url: biz.url || null,
            name: biz.name,
            image_url: biz.image_url || null,
        };

        return new Response(JSON.stringify(slim), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'X-Yelp-Calls-Today': String(count),
                ...corsHeaders(origin),
            },
        });
    } catch (err) {
        return new Response(
            JSON.stringify({ error: 'Yelp proxy fetch failed', detail: err.message }),
            { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
        );
    }
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        // Block disallowed origins
        if (!isOriginAllowed(origin, env)) {
            return new Response('Forbidden', { status: 403 });
        }

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // ── Yelp route (GET) ────────────────────────────────────────────
        if (path === '/yelp') {
            if (request.method !== 'GET') {
                return new Response('Method not allowed', { status: 405 });
            }
            return handleYelp(request, env, origin);
        }

        // ── Google Places routes (POST) ─────────────────────────────────
        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
        }

        // Ensure the API key secret is configured
        if (!env.GOOGLE_PLACES_API_KEY) {
            return new Response(
                JSON.stringify({ error: 'API key not configured on worker' }),
                { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
            );
        }

        if (path !== '/search' && path !== '/verify' && path !== '/textsearch') {
            return new Response('Not found', { status: 404 });
        }

        // /verify — lightweight check: key exists, no Google API call
        if (path === '/verify') {
            return new Response(
                JSON.stringify({ status: 'ok', message: 'API key configured' }),
                { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
            );
        }

        // Read client request
        const body = await request.text();
        const fieldMask = request.headers.get('X-Goog-FieldMask') || 'places.id';

        // Pick the correct Google Places endpoint
        const googleEndpoint = path === '/textsearch'
            ? 'https://places.googleapis.com/v1/places:searchText'
            : 'https://places.googleapis.com/v1/places:searchNearby';

        // Forward to Google Places API — inject the secret key server-side
        try {
            const googleResponse = await fetch(
                googleEndpoint,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
                        'X-Goog-FieldMask': fieldMask,
                    },
                    body,
                }
            );

            const responseBody = await googleResponse.text();

            return new Response(responseBody, {
                status: googleResponse.status,
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders(origin),
                },
            });
        } catch (err) {
            return new Response(
                JSON.stringify({ error: 'Proxy fetch failed', detail: err.message }),
                { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
            );
        }
    },
};
