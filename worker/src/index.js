/**
 * LASO Search — Cloudflare Worker API Proxy
 *
 * Sits between the static GitHub Pages site and Google Places API.
 * The Google API key lives here as a secret — never touches the browser.
 *
 * Routes:
 *   POST /search   — proxies to Google Places searchNearby
 *   POST /verify   — minimal searchNearby call to verify connectivity
 *   OPTIONS *      — CORS preflight
 */

// Allowed origins — requests from any other origin are rejected
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
    'https://192.168.1.127:8000',
];

function isOriginAllowed(origin, env) {
    if (!origin) return false;
    const allowed = env.ALLOW_LOCAL_ORIGINS === 'true'
        ? [...PROD_ORIGINS, ...LOCAL_ORIGINS]
        : PROD_ORIGINS;
    return allowed.some(a => origin === a || origin.startsWith(a + ':'));
}

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Goog-FieldMask',
        'Access-Control-Max-Age': '86400',
    };
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

        // Only POST allowed
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

        const url = new URL(request.url);
        const path = url.pathname;

        if (path !== '/search' && path !== '/verify') {
            return new Response('Not found', { status: 404 });
        }

        // Read client request
        const body = await request.text();
        const fieldMask = request.headers.get('X-Goog-FieldMask') || 'places.id';

        // Forward to Google Places API — inject the secret key server-side
        try {
            const googleResponse = await fetch(
                'https://places.googleapis.com/v1/places:searchNearby',
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
