/**
 * LASO Search - Main Application JavaScript
 * Leaflet map + Google Places API (New) for business search & ratings
 * Requires Google Places API key in config.js
 */

// =============================================================================
// Global Variables
// =============================================================================

let map;
let drawingPoints = [];
let currentPolygon = null;
let tempPolyline = null;
let markers = [];
let selectedPlaceIndex = null;   // index of the currently selected/highlighted place
let _highlightedMarkerIndex = null; // index of marker shown as enlarged green pin (overlay minimized)
let isDrawingMode = false;
let isDrawing = false; // true while mouse is held down
let isMouseDown = false; // track mouse button state

// Monotonic epoch counter — incremented by clearAll().  Deferred callbacks
// (moveend, transitionend, etc.) capture the epoch at registration time and
// bail out if it has changed, preventing stale marker/popup resurrection.
let _clearEpoch = 0;

// Zoom behavior flags
let isAutoFittingPolygon = false;
let _isChangingSelection = false;  // guards popupclose from clearing .active during programmatic popup switches
let isPinchZoom = false;          // true while the user is in continuous pinch/wheel zoom
let _buttonZoomPending = false;   // transient flag set by +/- button handlers before setZoom
let isFitZoom = false;
let isLocationSearchZoom = false;  // true during location/search zoom animations
let fitZoomValue = null;   // absolute fractional zoom for current polygon fit
let drawingZoom = null;    // integer zoom at which the polygon was drawn

// Mobile toaster polygon fit states (computed once per LASO search)
const TOASTER_LIP_HEIGHT = 52;       // px visible in peeked state (CSS: 100% - 52px)
let fitStateResultsOpen = null;       // { center, zoom } — toaster half-open
let fitStateLipPeeked = null;         // { center, zoom } — toaster lip only
let activeFitState = null;            // reference to whichever fit state is currently applied

// Zoom level tracking (relative to initial zoom)
let initialZoom = 14;
let currentZoomLevel = 0;
const MIN_ZOOM_LEVEL_TO_DRAW = 2;

function getMinZoomLevelToDraw() {
    return isMobileView() ? 2 : 3;
}

// Search results
let searchResults = [];

// Filtering / sorting
let unfilteredSearchResults = [];
let activePlaceFilters = [];
let activeSortMode = 'distance';
let lastPriorityCenter = null;

const COMMON_PLACE_TYPES = [
    'restaurant',
    'cafe',
    'bar',
    'fast food',
    'pub',
    'place of worship',
    'church',
    'bicycle parking',
    'bench',
    'waste basket',
    'parking',
    'school',
    'hospital',
    'clinic',
    'pharmacy',
    'supermarket',
    'bank',
    'atm',
    'fuel'
];

// OpenStreetMap tile URLs (completely free, no API key needed)
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Nominatim geocoding endpoint (OpenStreetMap's free geocoding service)
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

// Photon geocoding endpoint (alternative free OSM geocoder, less rate-limited)
const PHOTON_URL = 'https://photon.komoot.io/api';

// Google Nearby Search field mask (Enterprise tier — includes rating, phone, website)
const GOOGLE_FIELD_MASK = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.location',
    'places.rating',
    'places.userRatingCount',
    'places.googleMapsUri',
    'places.primaryType',
    'places.primaryTypeDisplayName',
    'places.internationalPhoneNumber',
    'places.websiteUri',
    'places.businessStatus'
].join(',');

// Place type groups for parallel Nearby Search calls.
// Each group = 1 API call; results are combined and deduplicated.
const GOOGLE_TYPE_GROUPS = [
    // Food & Drink
    ['restaurant', 'cafe', 'bar', 'bakery', 'meal_delivery', 'meal_takeaway'],
    // Shopping & Retail
    ['store', 'supermarket', 'shopping_mall', 'convenience_store', 'clothing_store',
     'electronics_store', 'furniture_store', 'hardware_store', 'home_goods_store',
     'jewelry_store', 'shoe_store', 'pet_store', 'book_store', 'liquor_store'],
    // Services & Health
    ['bank', 'post_office', 'gas_station', 'car_repair', 'car_wash', 'laundry',
     'pharmacy', 'hospital', 'doctor', 'dentist', 'veterinary_care',
     'beauty_salon', 'hair_care'],
    // Education, Entertainment, Lodging, Religious
    ['school', 'university', 'library', 'gym', 'movie_theater', 'night_club',
     'spa', 'hotel', 'lodging', 'church', 'mosque', 'synagogue']
];

// Deep-freeze type groups — prevents GOOGLE_TYPE_GROUPS.push([...]) from console
GOOGLE_TYPE_GROUPS.forEach(Object.freeze);
Object.freeze(GOOGLE_TYPE_GROUPS);

// =============================================================================
// Search Area Limits — Tamper-Resistant Validation
// =============================================================================
//
// Defence-in-depth for a client-only static site:
//
//   Layer 1 (unbypassable) — Google Cloud Console:
//     • HTTP referrer restriction on the API key (only your domain)
//     • Per-day quota  (e.g. 150 SearchNearby requests/day)
//     • Per-minute quota (e.g. 10 requests/minute)
//     • Billing budget cap ($300 lifetime)
//     → Configure these in IAM & Admin → Quotas.  No client JS can override them.
//
//   Layer 2 (this code) — client-side hardening:
//     • Max search radius & polygon area are captured in an IIFE closure.
//     • All geodesic math is private to the closure — cannot be monkey-patched.
//     • The returned interface is Object.freeze'd — properties can't be replaced.
//     • The binding is `const` — the variable itself can't be reassigned.
//     • Validation runs at TWO separate points (search entry + each API call).
//     → A determined attacker can still call fetch() directly, but that's where
//       Layer 1 stops them.  This layer catches casual console tampering.
//
const _searchGuard = (() => {
    // ── Private limits — invisible to and unreachable from the console ──
    const _maxRadiusM    = 5000;        // 5 km max bounding-circle radius
    const _maxAreaSqM    = 25_000_000;  // 25 km² max polygon area
    const _maxTypeGroups = 4;           // max parallel API call groups
    const _R  = 6371e3;                 // Earth radius (m)
    const _dr = Math.PI / 180;         // degrees → radians

    // Private Haversine distance — immune to monkey-patching
    function _dist(p1, p2) {
        const lat1 = p1[0] * _dr, lat2 = p2[0] * _dr;
        const dLat = (p2[0] - p1[0]) * _dr;
        const dLng = (p2[1] - p1[1]) * _dr;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return _R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Private spherical-excess polygon area (sq m)
    function _area(pts) {
        const n = pts.length;
        if (n < 3) return 0;
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            sum += (pts[j][1] - pts[i][1]) * _dr *
                   (2 + Math.sin(pts[i][0] * _dr) + Math.sin(pts[j][0] * _dr));
        }
        return Math.abs(sum * _R * _R / 2);
    }

    // Private centroid (shoelace on lng/lat, adequate for small polygons)
    function _centroid(pts) {
        let a2 = 0, cx = 0, cy = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const cross = pts[i][1] * pts[i + 1][0] - pts[i + 1][1] * pts[i][0];
            a2 += cross;
            cx += (pts[i][1] + pts[i + 1][1]) * cross;
            cy += (pts[i][0] + pts[i + 1][0]) * cross;
        }
        if (Math.abs(a2) < 1e-12) return null;
        const a6 = a2 * 3;
        return [cy / a6, cx / a6];
    }

    // Validate polygon area + bounding radius before any API calls
    function validateSearchArea(polygonPoints) {
        if (!Array.isArray(polygonPoints) || polygonPoints.length < 3) {
            return { ok: false, reason: 'Invalid polygon' };
        }
        const area = _area(polygonPoints);
        if (area > _maxAreaSqM) {
            return { ok: false, reason: 'Search area too large (' + (area / 1e6).toFixed(1) + ' km²)' };
        }
        const c = _centroid(polygonPoints);
        if (c) {
            let maxR = 0;
            for (const pt of polygonPoints) {
                const d = _dist(c, pt);
                if (d > maxR) maxR = d;
            }
            if (maxR * 1.1 > _maxRadiusM) {
                return { ok: false, reason: 'Search radius too large (' + Math.round(maxR) + ' m)' };
            }
        }
        return { ok: true };
    }

    // Validate circle radius independently (defence-in-depth at fetch boundary)
    function validateCircleRadius(radius) {
        return typeof radius === 'number' && radius <= _maxRadiusM;
    }

    function getMaxTypeGroups() {
        return _maxTypeGroups;
    }

    return Object.freeze({ validateSearchArea, validateCircleRadius, getMaxTypeGroups });
})();

// =============================================================================
// Location Persistence & IP Geolocation
// =============================================================================

const LOCATION_CHANGE_THRESHOLD = 500; // meters — ignore GPS fixes closer than this

function getSavedLocation() {
    try {
        const lat = parseFloat(localStorage.getItem('laso_last_lat'));
        const lng = parseFloat(localStorage.getItem('laso_last_lng'));
        if (!isNaN(lat) && !isNaN(lng)) return [lat, lng];
    } catch (e) { /* localStorage unavailable */ }
    return null;
}

function saveLocation(lat, lng) {
    try {
        localStorage.setItem('laso_last_lat', String(lat));
        localStorage.setItem('laso_last_lng', String(lng));
    } catch (e) { /* localStorage unavailable */ }
}

/**
 * Attempt to get an approximate location from the user's public IP address.
 * Uses free ipapi.co service (HTTPS, no key required, 1000 req/day).
 * Returns [lat, lng] or null.
 * Fails silently on private IPs, ad-blockers, or network errors.
 */
async function getIPLocation() {
    try {
        const res = await fetch('https://ipapi.co/json/', {
            signal: AbortSignal.timeout(3000)
        });
        const data = await res.json();
        if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
            return [data.latitude, data.longitude];
        }
    } catch (e) { /* timeout, network error, blocked — ignore */ }
    return null;
}

// =============================================================================
// Initialize Map
// =============================================================================

/**
 * Gifsig-style polygon fit: scan every vertex to find the four extremes
 * (closest point to each canvas edge), then compute the exact fractional zoom
 * that places those extremes at exactly `pad*` pixels from their nearest edge.
 *
 * O(n) — single pass through polygon vertices.
 *
 * @param {L.Polygon} polygon   Leaflet polygon
 * @param {L.Map}     mapObj    Leaflet map instance
 * @param {number}    padTop    Min px from canvas top edge
 * @param {number}    padRight  Min px from canvas right edge
 * @param {number}    padBottom Min px from canvas bottom edge
 * @param {number}    padLeft   Min px from canvas left edge
 * @returns {{ center: L.LatLng, zoom: number }}
 */
function calculatePolygonFit(polygon, mapObj, padTop, padRight, padBottom, padLeft) {
    const size = mapObj.getSize();               // canvas W × H in px
    const refZ = mapObj.getZoom();
    const ring = polygon.getLatLngs()[0];        // outer ring of vertices

    // --- Step 1: project every vertex at refZ & find bounding extremes ------
    // (Same idea as gifsig's getSignatureBounds scanning minX/maxX/minY/maxY)
    let minWx = Infinity, maxWx = -Infinity;
    let minWy = Infinity, maxWy = -Infinity;

    for (let i = 0; i < ring.length; i++) {
        const wp = mapObj.project(ring[i], refZ);
        if (wp.x < minWx) minWx = wp.x;
        if (wp.x > maxWx) maxWx = wp.x;
        if (wp.y < minWy) minWy = wp.y;
        if (wp.y > maxWy) maxWy = wp.y;
    }

    const contentW = maxWx - minWx;             // world-px width  at refZ
    const contentH = maxWy - minWy;             // world-px height at refZ

    if (contentW === 0 && contentH === 0) {
        return { center: polygon.getBounds().getCenter(), zoom: refZ };
    }

    // --- Step 2: available canvas area (canvas minus padding per edge) ------
    const availW = size.x - padLeft - padRight;
    const availH = size.y - padTop  - padBottom;

    if (availW <= 0 || availH <= 0) {
        return { center: polygon.getBounds().getCenter(), zoom: refZ };
    }

    // --- Step 3: scale factor to fit content into available area ------------
    // World-pixel dimensions scale with 2^z, so:
    //   scale = 2^(targetZ - refZ) = min(availW / contentW, availH / contentH)
    const scale = Math.min(
        contentW > 0 ? availW / contentW : Infinity,
        contentH > 0 ? availH / contentH : Infinity
    );
    const targetZoom = refZ + Math.log2(scale);

    // --- Step 4: center on content midpoint, offset for asymmetric padding --
    const midWx = (minWx + maxWx) / 2;
    const midWy = (minWy + maxWy) / 2;
    const contentCenter = mapObj.unproject(L.point(midWx, midWy), refZ);

    // Shift map center so the content sits in the middle of the *available* area
    // (e.g. when the toaster covers the bottom, shift the polygon upward)
    const offsetX = (padRight  - padLeft) / 2;
    const offsetY = (padBottom - padTop)  / 2;
    const ccAtTarget = mapObj.project(contentCenter, targetZoom);
    const mapCenter  = mapObj.unproject(
        L.point(ccAtTarget.x + offsetX, ccAtTarget.y + offsetY), targetZoom
    );

    return { center: mapCenter, zoom: targetZoom };
}

/**
 * Apply a previously-computed polygon fit state ({ center, zoom }).
 * Handles isAutoFittingPolygon flag for the duration of the fly animation.
 */
function applyPolygonFit(fitState) {
    if (!fitState || !currentPolygon) return;
    // Skip if we're already at this exact fit state
    if (isFitZoom && activeFitState === fitState) return;
    map.stop();                        // cancel any in-progress fly animation
    isAutoFittingPolygon = true;
    activeFitState = fitState;
    map.flyTo(fitState.center, fitState.zoom, { duration: 0.5 });
    const epoch = _clearEpoch;
    map.once('moveend', () => {
        isAutoFittingPolygon = false;
        if (_clearEpoch !== epoch) return;   // clearAll fired — all state is gone
        // After fit animation, reopen selected marker popup centered.
        if (selectedPlaceIndex !== null && markers.length > 0) {
            const selectedMarker = markers.find(m => m.placeIndex === selectedPlaceIndex);
            if (selectedMarker && map.hasLayer(selectedMarker)) {
                map.once('moveend', () => {
                    if (_clearEpoch !== epoch) return;   // stale — clearAll between pan and settle
                    if (!map.hasLayer(selectedMarker)) return;
                    _isChangingSelection = true;
                    selectedMarker.openPopup();
                    _isChangingSelection = false;
                });
                panToMarkerInView(selectedMarker);
            }
        }
    });
}

function initMap() {
    // Start at last saved geolocation, or fall back to New York City
    const savedLocation = getSavedLocation();
    const fallbackLocation = [40.7128, -74.0060];
    const startLocation = savedLocation || fallbackLocation;

    // When starting from a saved location, jump straight to the target display
    // zoom level so there is no fly animation on load.
    const baseZoom = 14;
    const startZoom = savedLocation
        ? baseZoom + (isMobileView() ? 2 : 3)
        : baseZoom;

    // Initialize Leaflet map with Canvas renderer for better polygon handling
    map = L.map('map', {
        center: startLocation,
        zoom: startZoom,
        zoomSnap: 0,           // allow fully continuous pinch/wheel zoom (buttons handle integer steps)
        doubleClickZoom: false,
        zoomControl: false,
        renderer: L.canvas()  // Use Canvas instead of SVG for better performance with large polygons
    });

    // Custom zoom control using Font Awesome icons — SVG glyphs are inherently centered
    L.control.zoom({
        zoomInText: '<i class="fas fa-plus"></i>',
        zoomOutText: '<i class="fas fa-minus"></i>'
    }).addTo(map);

    // Zoom-fit button — separate control below +/- with a gap
    const ZoomFitControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const container = L.DomUtil.create('div', 'leaflet-control-zoom-fit leaflet-bar leaflet-control');
            const btn = L.DomUtil.create('a', 'leaflet-control-zoom-fit-btn', container);
            btn.innerHTML = '<i class="fas fa-crosshairs"></i>';
            btn.href = '#';
            btn.title = 'Fit polygon';
            btn.role = 'button';
            btn.setAttribute('aria-label', 'Fit polygon');

            // Tooltip for disabled state (no polygon drawn)
            const tooltip = L.DomUtil.create('div', 'zoomfit-tooltip', container);
            tooltip.setAttribute('role', 'tooltip');
            tooltip.setAttribute('aria-hidden', 'true');

            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.on(btn, 'click', (e) => {
                L.DomEvent.preventDefault(e);
                if (!currentPolygon) {
                    // Flash the tooltip so the user sees why
                    container.classList.remove('tooltip-dismissed');
                    container.classList.add('tooltip-visible');
                    setTimeout(() => container.classList.remove('tooltip-visible'), 2500);
                    return;
                }
                if (isFitZoom) {
                    // Flash the tooltip so the user knows why
                    container.classList.remove('tooltip-dismissed');
                    container.classList.add('tooltip-visible');
                    setTimeout(() => container.classList.remove('tooltip-visible'), 2500);
                    return;
                }
                // Re-calculate fit for the current map state
                const padV = 10, padH = 10;
                let padBottom = padV;
                if (isMobileView()) {
                    const mapEl = document.getElementById('map');
                    if (document.body.classList.contains('results-open')) {
                        padBottom = mapEl ? mapEl.offsetHeight * 0.5 + padV : padV;
                    } else if (document.body.classList.contains('results-peeked')) {
                        padBottom = TOASTER_LIP_HEIGHT + padV;
                    }
                }
                const { center, zoom } = calculatePolygonFit(
                    currentPolygon, map, padV, padH, padBottom, padH
                );
                const fitState = { center, zoom: Math.round(zoom * 100) / 100 };
                // Pre-dismiss tooltip so mobile sticky :hover doesn't flash it
                // once updateZoomFitButtonState adds tooltip-enabled after the fly
                container.classList.add('tooltip-dismissed');
                applyPolygonFit(fitState);
                fitZoomValue = fitState.zoom;
            });

            // Mobile: touchstart fires on disabled controls (click may not)
            container.addEventListener('touchstart', () => {
                if (!currentPolygon || isFitZoom) {
                    if (container.classList.contains('tooltip-dismissed')) {
                        container.classList.remove('tooltip-dismissed');
                    }
                }
            }, { passive: true });

            return container;
        }
    });
    new ZoomFitControl().addTo(map);

    // Add OpenStreetMap tile layer (completely free, no API key)
    L.tileLayer(OSM_TILE_URL, {
        maxZoom: 19,
        attribution: OSM_ATTRIBUTION
    }).addTo(map);

    // Add scale control
    L.control.scale().addTo(map);

    // Track zoom level relative to the base zoom (always 14)
    initialZoom = baseZoom;
    currentZoomLevel = map.getZoom() - baseZoom;
    // Wait for fonts/icons to load into memory before fading in the indicator
    document.fonts.ready.then(() => { updateZoomLevelIndicator(); });

    // Clear selection when user manually dismisses a popup (click elsewhere)
    map.on('popupclose', () => {
        // Only clear selection on genuine user dismissal (click elsewhere / close button).
        // Skip when we are programmatically switching popups (highlightPlace, zoomstart, etc.)
        if (_isChangingSelection) return;
        if (map._animatingZoom) return;
        clearHighlightedMarker();
        selectedPlaceIndex = null;
        document.querySelectorAll('.place-card.active').forEach(c => c.classList.remove('active'));
    });

    map.on('zoomstart', () => {
        if (_buttonZoomPending) {
            // Zoom triggered by +/- button — leave pinch mode
            _buttonZoomPending = false;
            isPinchZoom = false;
        } else if (isAutoFittingPolygon) {
            // Auto-fit zoom — leave pinch mode so indicator reappears
            isPinchZoom = false;
        } else if (isLocationSearchZoom) {
            // Programmatic location/search zoom — not a pinch
            isPinchZoom = false;
            updateZoomLevelIndicator();   // hide indicator immediately during fly animation
        } else {
            // Pinch / wheel zoom — continuous, no snapping
            isPinchZoom = true;
            isFitZoom = false;             // no longer at fit — enable fit button immediately
            activeFitState = null;         // user zoomed away from fit
            updateZoomLevelIndicator();   // hide indicator immediately on pinch start
        }
        // Only close popup during auto-fit — let user zooms keep the popup in place
        if (isAutoFittingPolygon) {
            _isChangingSelection = true;
            map.closePopup();
            _isChangingSelection = false;
        }
    });
    map.on('zoomend', () => {
        const z = map.getZoom();
        // Only mark as fit-zoom when an auto-fit animation is in progress
        isFitZoom = isAutoFittingPolygon && !Number.isInteger(z);
        if (isFitZoom) fitZoomValue = z;
        if (!isFitZoom) activeFitState = null;
        currentZoomLevel = z - initialZoom;
        console.log(`Zoom level: ${currentZoomLevel} (absolute: ${z})${isFitZoom ? ` [FIT ${z.toFixed(2)}]` : ''}${isPinchZoom ? ' [PINCH]' : ''}`);
        updateZoomLevelIndicator();
        updateDrawButtonState();
    });

    // Force zoom control buttons to go to the next integer step (no manual decimal zoom).
    const zoomInEl = map.getContainer().querySelector('.leaflet-control-zoom-in');
    const zoomOutEl = map.getContainer().querySelector('.leaflet-control-zoom-out');
    if (zoomInEl) {
        zoomInEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const z = map.getZoom();
            // Next integer ceiling above z
            const nextInt = Number.isInteger(z) ? z + 1 : Math.ceil(z);
            // Treat fitZoomValue as a virtual "level" — stop there if it's between z and nextInt
            const steppingToFit = fitZoomValue !== null
                                  && fitZoomValue > z && fitZoomValue < nextInt;
            const target = steppingToFit ? fitZoomValue : nextInt;
            if (steppingToFit) {
                isAutoFittingPolygon = true;
            }
            _buttonZoomPending = true;
            map.setZoom(target, { animate: true });
            if (steppingToFit) {
                const ep = _clearEpoch;
                map.once('moveend', () => {
                    if (_clearEpoch !== ep) return;
                    isAutoFittingPolygon = false;
                });
            }
        }, true);
    }
    if (zoomOutEl) {
        zoomOutEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const z = map.getZoom();
            // Next integer floor below z
            const nextInt = Number.isInteger(z) ? z - 1 : Math.floor(z);
            // Treat fitZoomValue as a virtual "level" — stop there if it's between nextInt and z
            const steppingToFit = fitZoomValue !== null
                                  && fitZoomValue < z && fitZoomValue > nextInt;
            const target = steppingToFit ? fitZoomValue : nextInt;
            if (steppingToFit) {
                isAutoFittingPolygon = true;
            }
            _buttonZoomPending = true;
            map.setZoom(target, { animate: true });
            if (steppingToFit) {
                const ep = _clearEpoch;
                map.once('moveend', () => {
                    if (_clearEpoch !== ep) return;
                    isAutoFittingPolygon = false;
                });
            }
        }, true);
    }

    // Setup event listeners
    setupEventListeners();
    setupMobileTouchContinuity();
    setupPreventPagePinchZoom();
    updateStatus('Ready');

    // --- Smart location handling ------------------------------------------------
    // 1. Map already started at savedLocation (or NYC fallback) — see above.
    // 2. If no saved location, try IP geolocation for an approximate start.
    // 3. GPS watch: compare each fix to the current map center.  Only fly if
    //    the user has moved more than LOCATION_CHANGE_THRESHOLD meters.
    // 4. Always persist the latest GPS fix to localStorage.
    // navigator.geolocation is a free browser API — no API charges.

    let ipLocationApplied = false;   // true once we've used IP location (skip if GPS arrives first)

    // If we have no saved location, try IP geolocation for an approximate start
    // while waiting for the slower GPS fix.
    if (!savedLocation) {
        getIPLocation().then((ipLoc) => {
            if (!ipLoc || ipLocationApplied) return;
            // Only apply if GPS hasn't already provided a fix
            ipLocationApplied = true;
            const targetZoom = initialZoom + (isMobileView() ? 2 : 3);
            isLocationSearchZoom = true;
            map.flyTo(ipLoc, targetZoom, { duration: 1.0 });
            map.once('moveend', () => {
                isLocationSearchZoom = false;
                currentZoomLevel = map.getZoom() - initialZoom;
                updateZoomLevelIndicator();
                updateDrawButtonState();
                updateStatus('Approximate location - Ready');
            });
        });
    }

    if (navigator.geolocation) {
        let firstFix = true;
        navigator.geolocation.watchPosition(
            (position) => {
                const userLocation = [
                    position.coords.latitude,
                    position.coords.longitude
                ];
                // Always keep the latest coords available for distance sorting
                window._userLatLng = userLocation;
                // Persist to localStorage for next session
                saveLocation(userLocation[0], userLocation[1]);

                if (firstFix) {
                    firstFix = false;
                    ipLocationApplied = true; // prevent IP location from overriding GPS

                    // Compare GPS fix to our starting position
                    const dist = calculateDistance(userLocation, startLocation);
                    if (dist > LOCATION_CHANGE_THRESHOLD) {
                        // Significant move — fly to the new location
                        const targetZoom = initialZoom + (isMobileView() ? 2 : 3);
                        isLocationSearchZoom = true;
                        map.flyTo(userLocation, targetZoom, { duration: 1.0 });
                        map.once('moveend', () => {
                            isLocationSearchZoom = false;
                            currentZoomLevel = map.getZoom() - initialZoom;
                            updateZoomLevelIndicator();
                            updateDrawButtonState();
                            updateStatus('Location found - Ready');
                        });
                    } else {
                        // Same area — stay put, no animation
                        updateStatus('Location found - Ready');
                    }
                }
            },
            () => {
                updateStatus('Ready');
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
        );
    }

    updateDrawButtonState();
}

function setupPreventPagePinchZoom() {
    if (!isMobileView()) return;

    const shouldAllow = (target) => {
        if (!target) return false;
        return !!target.closest('#map');
    };

    const handler = (e) => {
        if (shouldAllow(e.target)) return;
        e.preventDefault();
    };

    document.addEventListener('gesturestart', handler, { passive: false });
    document.addEventListener('gesturechange', handler, { passive: false });
    document.addEventListener('gestureend', handler, { passive: false });
}

function updateDrawButtonState() {
    const drawBtn = document.getElementById('drawing-toggle');
    const wrapper = document.getElementById('draw-btn-wrapper');
    const tooltip = document.getElementById('draw-btn-tooltip');
    if (!drawBtn) return;

    const minZoomToDraw = getMinZoomLevelToDraw();
    const zoomTooLow = currentZoomLevel < minZoomToDraw;
    const hasPolygon = !!currentPolygon;
    const disabled = zoomTooLow || hasPolygon;

    drawBtn.disabled = disabled;
    drawBtn.classList.toggle('is-disabled', disabled);

    if (wrapper) {
        wrapper.classList.toggle('tooltip-enabled', disabled);
        if (!disabled) {
            wrapper.classList.remove('tooltip-visible');
            wrapper.classList.remove('tooltip-dismissed');
        }
    }

    if (tooltip) {
        if (disabled) {
            let line1 = '', line2 = '';
            if (zoomTooLow) {
                const needed = Math.ceil(Math.max(0, minZoomToDraw - currentZoomLevel));
                line1 = `Zoom in ${needed} more level${needed === 1 ? '' : 's'} to draw`;
                line2 = hasPolygon
                    ? 'Delete the existing shape to start over'
                    : 'Use + or pinch to zoom into the map';
            } else if (hasPolygon) {
                line1 = 'A shape is already on the map';
                line2 = 'Tap Clear All to remove it first';
            }
            tooltip.innerHTML =
                '<div class="draw-tooltip-text">' +
                    '<span>' + line1 + '</span>' +
                    '<span>' + line2 + '</span>' +
                '</div>' +
                '<button class="draw-tooltip-close" aria-label="Close">\u00d7</button>';

            // Attach listeners directly to the button element — inline onclick
            // and delegated handlers are unreliable on mobile Safari.
            const closeBtn = tooltip.querySelector('.draw-tooltip-close');
            if (closeBtn) {
                const dismiss = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (wrapper) {
                        wrapper.classList.remove('tooltip-visible');
                        wrapper.classList.add('tooltip-dismissed');
                    }
                };
                closeBtn.addEventListener('click', dismiss);
                closeBtn.addEventListener('touchend', dismiss);
            }
        } else {
            tooltip.innerHTML = '';
        }
        tooltip.setAttribute('aria-hidden', disabled ? 'false' : 'true');
    }
}

function updateZoomFitButtonState() {
    const container = document.querySelector('.leaflet-control-zoom-fit');
    const fitBtn = document.querySelector('.leaflet-control-zoom-fit-btn');
    if (!fitBtn || !container) return;

    const tooltip = container.querySelector('.zoomfit-tooltip');
    const noPolygon = !currentPolygon;

    const atFit = !noPolygon && isFitZoom;
    const showTooltip = noPolygon || atFit;

    // No-polygon disabled state (keeps pointer-events for tooltip interaction)
    fitBtn.classList.toggle('no-polygon', noPolygon);
    // isFitZoom disabled state (keeps pointer-events for tooltip interaction)
    fitBtn.classList.toggle('disabled', atFit);
    container.classList.toggle('tooltip-enabled', showTooltip);
    if (!showTooltip) {
        container.classList.remove('tooltip-visible');
        container.classList.remove('tooltip-dismissed');
    }

    if (tooltip) {
        if (noPolygon) {
            tooltip.innerHTML =
                '<div class="draw-tooltip-text">' +
                    '<span>Draw a shape first to zoom fit</span>' +
                '</div>' +
                '<button class="draw-tooltip-close" aria-label="Close">\u00d7</button>';
        } else if (atFit) {
            tooltip.innerHTML =
                '<div class="draw-tooltip-text">' +
                    '<span>Already in zoom fit view</span>' +
                    '<span>Pan or zoom to leave fit view</span>' +
                '</div>' +
                '<button class="draw-tooltip-close" aria-label="Close">\u00d7</button>';
        } else {
            tooltip.innerHTML = '';
        }

        if (showTooltip) {
            const closeBtn = tooltip.querySelector('.draw-tooltip-close');
            if (closeBtn) {
                const dismiss = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    container.classList.remove('tooltip-visible');
                    container.classList.add('tooltip-dismissed');
                };
                closeBtn.addEventListener('click', dismiss);
                closeBtn.addEventListener('touchend', dismiss);
            }
        }
        tooltip.setAttribute('aria-hidden', showTooltip ? 'false' : 'true');
    }
}

// =============================================================================
// Platform-specific empty state (desktop shows placeholder; mobile unchanged)
// =============================================================================
function getDefaultEmptyStateHTML() {
    if (isMobileView()) {
        return `<div class="empty-state">
            <i class="fas fa-map-marked-alt"></i>
            <p>Draw a shape on the map and click 'Draw Search' to find businesses</p>
        </div>`;
    }
    return `<div class="empty-state">
        <i class="fas fa-map-marked-alt"></i>
        <p>Results will be displayed here</p>
    </div>`;
}

// =============================================================================
// Desktop Layout Setup  (only called when NOT mobile — mobile DOM untouched)
// =============================================================================
function setupDesktopLayout() {
    const sidebar = document.getElementById('results-sidebar');
    const sidebarContent = sidebar.querySelector('.sidebar-content');
    const filterControls = document.querySelector('.filter-sort-controls');

    if (!filterControls || !sidebar || !sidebarContent) return;

    // -- Build PC filter area inside sidebar --
    const pcFilterArea = document.createElement('div');
    pcFilterArea.className = 'pc-filter-area';

    // Row 1: filter input + datalist
    const filterInput = document.getElementById('place-filter');
    const datalist = document.getElementById('place-filter-options');
    const filterRow = document.createElement('div');
    filterRow.className = 'pc-filter-row';
    if (filterInput) filterRow.appendChild(filterInput);
    if (datalist) filterRow.appendChild(datalist);

    // Row 2: sort dropdown + clear button (wider, below filter)
    const sortSelect = document.getElementById('sort-select');
    const clearFiltersBtn = document.getElementById('clear-filters-btn');
    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'pc-filter-buttons-row';
    if (sortSelect) buttonsRow.appendChild(sortSelect);
    if (clearFiltersBtn) buttonsRow.appendChild(clearFiltersBtn);

    pcFilterArea.appendChild(filterRow);
    pcFilterArea.appendChild(buttonsRow);

    // Insert filter area between sidebar-header and sidebar-content
    sidebar.insertBefore(pcFilterArea, sidebarContent);

    // Make sidebar always visible on desktop
    sidebar.classList.add('pc-always-visible');

    // Update empty state for desktop
    const resultsList = document.getElementById('results-list');
    if (resultsList) {
        resultsList.innerHTML = `<div class="empty-state">
            <i class="fas fa-map-marked-alt"></i>
            <p>Results will be displayed here</p>
        </div>`;
    }

    // Size header action buttons (draw, draw search, clear all) to match
    // draw search width and search-box height (including padding/border).
    requestAnimationFrame(() => {
        const searchBox = document.querySelector('.search-box');
        const drawSearchBtn = document.getElementById('lasosearch-btn');
        if (searchBox && drawSearchBtn) {
            const boxH = searchBox.offsetHeight;
            const btnW = drawSearchBtn.offsetWidth;
            document.documentElement.style.setProperty('--pc-btn-height', boxH + 'px');
            document.documentElement.style.setProperty('--pc-btn-width', btnW + 'px');
        }
    });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    // Detect touch device and apply mobile class
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        document.body.classList.add('is-mobile');
    }

    // Rearrange DOM for desktop only (mobile DOM stays exactly as-is)
    if (!document.body.classList.contains('is-mobile')) {
        setupDesktopLayout();
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('debugResults') === '1') {
        document.body.classList.add('debug-results');
    }
    initMap();

    // Verify Google Places API key on startup
    verifyGoogleApiKey();
});

// =============================================================================
// Drawing Mode Toggle
// =============================================================================

function toggleDrawingMode() {
    const drawBtn = document.getElementById('drawing-toggle');
    const wrapper = document.getElementById('draw-btn-wrapper');

    // If the button is disabled, briefly flash the tooltip so the user
    // sees why (works on mobile where hover doesn't apply).
    if (drawBtn && drawBtn.disabled) {
        if (wrapper) {
            wrapper.classList.remove('tooltip-dismissed');
            wrapper.classList.add('tooltip-visible');
            setTimeout(() => wrapper.classList.remove('tooltip-visible'), 2500);
        }
        if (drawBtn.blur) drawBtn.blur();
        return;
    }

    if (isDrawingMode) {
        // Cancel drawing mode
        disableDrawingMode();
    } else {
        enableDrawingMode();
    }

    // On mobile Safari, the button can remain in a focused/active visual state until focus moves.
    // Explicitly blur to force the normal (inactive) styling to re-apply immediately.
    if (drawBtn && typeof drawBtn.blur === 'function') {
        drawBtn.blur();
    }
}

function enableDrawingMode() {
    // New polygon — discard previous fit zoom
    fitZoomValue = null;
    drawingZoom = null;
    isFitZoom = false;
    updateZoomLevelIndicator();

    // Require minimum zoom level before allowing drawing
    const minZoomToDraw = getMinZoomLevelToDraw();
    if (currentZoomLevel < minZoomToDraw) {
        const needed = Math.ceil(minZoomToDraw - currentZoomLevel);
        showNotification(
            `Zoom in ${needed} more level${needed > 1 ? 's' : ''} to draw (need zoom level ${minZoomToDraw})`,
            'error'
        );
        updateStatus(`Zoom in to level ${minZoomToDraw} to search`);
        return;
    }

    isDrawingMode = true;

    const drawBtn = document.getElementById('drawing-toggle');
    const overlay = document.getElementById('drawing-overlay');
    const statusIndicator = document.getElementById('status-indicator');

    // Update UI
    drawBtn.classList.add('active');
    drawBtn.querySelector('span').textContent = 'Cancel';
    overlay.classList.remove('hidden');
    statusIndicator.classList.add('drawing');
    updateStatus('Drawing mode - Hold mouse down and drag to draw lasso');

    // Change cursor to crosshair
    map.getContainer().style.cursor = 'crosshair';

    // Disable map drag interactions while drawing
    map.dragging.disable();
    map.scrollWheelZoom.disable();

    // Setup freehand drawing
    startFreehandDrawing();
}

function disableDrawingMode() {
    isDrawingMode = false;
    isDrawing = false;
    isMouseDown = false;

    const drawBtn = document.getElementById('drawing-toggle');
    const overlay = document.getElementById('drawing-overlay');
    const statusIndicator = document.getElementById('status-indicator');

    // Update UI
    drawBtn.classList.remove('active');
    drawBtn.querySelector('span').textContent = 'Draw';
    overlay.classList.add('hidden');
    statusIndicator.classList.remove('drawing');
    updateStatus('Ready');

    // Ensure the button immediately returns to its inactive visual state on mobile browsers.
    requestAnimationFrame(() => {
        drawBtn.classList.remove('active');
        drawBtn.classList.remove('pressed');
        if (typeof drawBtn.blur === 'function') drawBtn.blur();
    });

    // Reset cursor
    map.getContainer().style.cursor = '';

    // Re-enable map interactions
    map.dragging.enable();
    map.scrollWheelZoom.enable();

    // Stop freehand drawing
    stopFreehandDrawing();
}

// =============================================================================
// Freehand Lasso Drawing (Photoshop-style)
// =============================================================================

function startFreehandDrawing() {
    drawingPoints = [];
    isMouseDown = false;
    isDrawing = false;

    // Create temporary polyline for drawing preview
    tempPolyline = L.polyline([], {
        color: '#4285f4',
        weight: 3,
        opacity: 1,
        dashArray: '5, 5'
    }).addTo(map);

    // Add mouse event listeners to the map container
    const mapContainer = map.getContainer();

    // Prevent context menu during drawing
    mapContainer.addEventListener('contextmenu', preventContextMenu);

    // Mouse events for freehand drawing
    mapContainer.addEventListener('mousedown', handleMouseDown);
    mapContainer.addEventListener('mousemove', handleMouseMove);
    mapContainer.addEventListener('mouseup', handleMouseUp);
    // Note: NOT adding mouseleave - we want to keep drawing even if mouse leaves map

    // Touch events for mobile support
    mapContainer.addEventListener('touchstart', handleTouchStart, { passive: false });
    mapContainer.addEventListener('touchmove', handleTouchMove, { passive: false });
    mapContainer.addEventListener('touchend', handleTouchEnd, { passive: false });
}

function stopFreehandDrawing() {
    const mapContainer = map.getContainer();

    // Remove all event listeners
    mapContainer.removeEventListener('contextmenu', preventContextMenu);
    mapContainer.removeEventListener('mousedown', handleMouseDown);
    mapContainer.removeEventListener('mousemove', handleMouseMove);
    mapContainer.removeEventListener('mouseup', handleMouseUp);
    mapContainer.removeEventListener('mouseleave', handleMouseUp);
    mapContainer.removeEventListener('touchstart', handleTouchStart);
    mapContainer.removeEventListener('touchmove', handleTouchMove);
    mapContainer.removeEventListener('touchend', handleTouchEnd);

    // Clear temporary drawing
    if (tempPolyline) {
        map.removeLayer(tempPolyline);
        tempPolyline = null;
    }

    drawingPoints = [];
    isMouseDown = false;
    isDrawing = false;
}

function preventContextMenu(e) {
    if (isDrawingMode) {
        e.preventDefault();
    }
}

function handleMouseDown(e) {
    if (!isDrawingMode) return;
    if (e.button !== 0) return; // Only left mouse button

    e.preventDefault();
    e.stopPropagation();

    isMouseDown = true;
    isDrawing = true;
    drawingPoints = []; // Start fresh

    // Get initial point
    const point = getMousePoint(e);
    if (point) {
        drawingPoints.push(point);
        updatePolyline();
    }

    updateStatus('Drawing... Release mouse to close lasso');
}

function handleMouseMove(e) {
    if (!isDrawingMode || !isMouseDown || !isDrawing) return;

    e.preventDefault();

    const point = getMousePoint(e);
    if (!point) return;

    // Add point if it's far enough from the last point (smooths the line)
    if (drawingPoints.length > 0) {
        const lastPoint = drawingPoints[drawingPoints.length - 1];
        const distance = calculateDistance(point, lastPoint);

        // Only add point if moved at least 3 meters - smoother drawing
        if (distance > 3) {
            drawingPoints.push(point);
            updatePolyline();
        }
    } else {
        // First point
        drawingPoints.push(point);
        updatePolyline();
    }
}

function handleMouseUp(e) {
    if (!isDrawingMode || !isMouseDown) return;

    e.preventDefault();

    isMouseDown = false;
    isDrawing = false;

    // Auto-close the polygon when mouse is released (Photoshop-style)
    if (drawingPoints.length >= 3) {
        closeFreehandPolygon();
    } else {
        showNotification('Draw a larger area - need at least 3 points', 'error');
    }
}

function handleTouchStart(e) {
    if (!isDrawingMode) return;

    e.preventDefault();
    e.stopPropagation();

    isMouseDown = true;
    isDrawing = true;
    drawingPoints = [];

    const touch = e.touches[0];
    const point = getTouchPoint(touch);
    if (point) {
        drawingPoints.push(point);
        updatePolyline();
    }

    updateStatus('Drawing... Release to close lasso');
}

function handleTouchMove(e) {
    if (!isDrawingMode || !isMouseDown || !isDrawing) return;

    e.preventDefault();

    const touch = e.touches[0];
    const point = getTouchPoint(touch);
    if (!point) return;

    if (drawingPoints.length > 0) {
        const lastPoint = drawingPoints[drawingPoints.length - 1];
        const distance = calculateDistance(point, lastPoint);

        if (distance > 3) {
            drawingPoints.push(point);
            updatePolyline();
        }
    } else {
        // First point
        drawingPoints.push(point);
        updatePolyline();
    }
}

function handleTouchEnd(e) {
    if (!isDrawingMode) return;

    e.preventDefault();

    isMouseDown = false;
    isDrawing = false;

    // Auto-close the polygon when touch is released
    if (drawingPoints.length >= 3) {
        closeFreehandPolygon();
    } else {
        showNotification('Draw a larger area - need at least 3 points', 'error');
    }
}

function getMousePoint(e) {
    // Convert mouse coordinates to map lat/lng
    const rect = map.getContainer().getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Use Leaflet's containerPointToLatLng
    const containerPoint = L.point(x, y);
    return map.containerPointToLatLng(containerPoint);
}

function getTouchPoint(touch) {
    const rect = map.getContainer().getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    const containerPoint = L.point(x, y);
    return map.containerPointToLatLng(containerPoint);
}

function updatePolyline() {
    if (!tempPolyline) return;

    const latLngs = drawingPoints.map(p => [p.lat, p.lng]);
    tempPolyline.setLatLngs(latLngs);
}

function closeFreehandPolygon() {
    if (drawingPoints.length < 3) {
        showNotification('Need at least 3 points to create a polygon', 'error');
        return;
    }

    // Remove existing polygon if any
    removeCurrentPolygon();

    // Create latLngs array for polygon - explicitly close it by repeating first point
    const latLngs = drawingPoints.map(p => [p.lat, p.lng]);
    // Close the polygon for proper geometric calculations
    if (latLngs.length > 0) {
        latLngs.push([...latLngs[0]]);
    }

    // Create the final polygon - Canvas renderer handles large polygons better
    currentPolygon = L.polygon(latLngs, {
        color: '#4285f4',
        fillColor: '#4285f4',
        fillOpacity: 0.2,
        weight: 3
    }).addTo(map);
    updateDrawButtonState();
    updateZoomFitButtonState();

    // Store as array format [lat, lng] for compatibility with existing code
    // Also close the polygon for proper filtering
    drawingPoints = drawingPoints.map(p => [p.lat, p.lng]);
    if (drawingPoints.length > 0) {
        drawingPoints.push([...drawingPoints[0]]);
    }

    // Clear temporary drawing - BUT NOT drawingPoints (we need them for search)
    if (tempPolyline) {
        map.removeLayer(tempPolyline);
        tempPolyline = null;
    }

    // DON'T call disableDrawingMode() - it clears drawingPoints!
    // Manually set flags instead
    isDrawingMode = false;
    isDrawing = false;
    isMouseDown = false;

    const drawBtn = document.getElementById('drawing-toggle');
    const overlay = document.getElementById('drawing-overlay');
    const statusIndicator = document.getElementById('status-indicator');

    drawBtn.classList.remove('active');
    drawBtn.querySelector('span').textContent = 'Draw';
    overlay.classList.add('hidden');
    statusIndicator.classList.remove('drawing');
    map.getContainer().style.cursor = '';

    requestAnimationFrame(() => {
        drawBtn.classList.remove('active');
        drawBtn.classList.remove('pressed');
        if (typeof drawBtn.blur === 'function') drawBtn.blur();
    });
    map.dragging.enable();
    map.scrollWheelZoom.enable();

    // Record the integer zoom at which the user drew this polygon.
    drawingZoom = Math.round(map.getZoom());

    // Check if any vertex went outside the canvas while drawing.
    // If so, the polygon doesn't fit at the current zoom — drop the floor by 1.
    const canvasSize = map.getSize();
    const ring = currentPolygon.getLatLngs()[0];
    let outOfBounds = false;
    for (let i = 0; i < ring.length; i++) {
        const cp = map.latLngToContainerPoint(ring[i]);
        if (cp.x < 0 || cp.x > canvasSize.x || cp.y < 0 || cp.y > canvasSize.y) {
            outOfBounds = true;
            break;
        }
    }
    const fitFloor = outOfBounds ? drawingZoom - 1 : drawingZoom;

    // Gifsig-style auto-fit: scan every vertex, ensure ≥10 px from each canvas edge.
    const { center: fitCenter, zoom: rawFitZoom } = calculatePolygonFit(
        currentPolygon, map, 10, 10, 10, 10
    );

    // Clamp: fit zoom lives between fitFloor and fitFloor + 1
    const fitZoom = Math.max(fitFloor, Math.min(fitFloor + 0.99, rawFitZoom));

    // Smooth fly to the fit position.  isAutoFittingPolygon stays true for the
    // entire animation so the zoomend handler knows this is an auto-fit.
    isAutoFittingPolygon = true;
    map.flyTo(fitCenter, fitZoom, { duration: 0.5 });
    const epochAtDraw = _clearEpoch;
    map.once('moveend', () => {
        if (_clearEpoch !== epochAtDraw) return;
        isAutoFittingPolygon = false;
    });

    updateStatus(`Lasso created with ${drawingPoints.length} points`);
    showNotification('Shape created! Click Draw Search to find businesses');

    // First-time shimmer: highlight Draw Search button if user has never pressed it
    try {
        if (!localStorage.getItem('laso_has_used_draw_search')) {
            const lasoBtn = document.getElementById('lasosearch-btn');
            if (lasoBtn) lasoBtn.classList.add('shimmer');
        }
    } catch (e) { /* localStorage unavailable */ }
}

// Legacy functions kept for compatibility
function startManualDrawing() {
    // Replaced by startFreehandDrawing
    startFreehandDrawing();
}

function stopManualDrawing() {
    // Replaced by stopFreehandDrawing
    stopFreehandDrawing();
}

function handleMapClick(e) {
    // No longer used - freehand drawing replaces click-to-add
}

function handleDoubleClick(e) {
    // No longer needed - mouseup handles closing
}

function removeCurrentPolygon() {
    if (currentPolygon) {
        map.removeLayer(currentPolygon);
        currentPolygon = null;
    }
    updateDrawButtonState();
    updateZoomFitButtonState();
}

// =============================================================================
// Polygon Utilities
// =============================================================================

function getPolygonBounds() {
    if (!currentPolygon) return null;
    return currentPolygon.getBounds();
}

function getPolygonCenter() {
    if (!currentPolygon) return null;
    const bounds = currentPolygon.getBounds();
    return [
        (bounds.getNorth() + bounds.getSouth()) / 2,
        (bounds.getEast() + bounds.getWest()) / 2
    ];
}

function getPolygonCentroid(polygonPoints) {
    if (!Array.isArray(polygonPoints) || polygonPoints.length < 3) return null;

    // Shoelace formula on lng/lat treated as planar. Adequate for small areas.
    let area2 = 0;
    let cx = 0;
    let cy = 0;

    const n = polygonPoints.length;
    for (let i = 0; i < n - 1; i++) {
        const [y0, x0] = polygonPoints[i];
        const [y1, x1] = polygonPoints[i + 1];
        const cross = x0 * y1 - x1 * y0;
        area2 += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }

    if (!isFinite(area2) || Math.abs(area2) < 1e-12) return null;
    const area6 = area2 * 3;
    return [cy / area6, cx / area6];
}

function normalizePlaceType(type) {
    return String(type || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ');
}

function normalizePlaceName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function normalizeFilterToken(token) {
    return String(token || '')
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ');
}

function tokenizeFilterQuery(value) {
    const raw = String(value || '')
        .replace(/[,]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return [];
    return raw
        .split(' ')
        .map(normalizeFilterToken)
        .filter(t => t.length >= 2);
}

function simpleStem(token) {
    if (!token) return '';
    if (token.length <= 3) return token;
    if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
    if (token.endsWith('s') && token.length > 3) return token.slice(0, -1);
    return token;
}

function levenshteinDistance(a, b, maxDist) {
    if (a === b) return 0;
    if (!a || !b) return Math.max(a.length, b.length);
    const al = a.length;
    const bl = b.length;
    if (Math.abs(al - bl) > maxDist) return maxDist + 1;

    const v0 = new Array(bl + 1);
    const v1 = new Array(bl + 1);
    for (let i = 0; i <= bl; i++) v0[i] = i;

    for (let i = 0; i < al; i++) {
        v1[0] = i + 1;
        let rowMin = v1[0];
        const ca = a.charCodeAt(i);
        for (let j = 0; j < bl; j++) {
            const cost = ca === b.charCodeAt(j) ? 0 : 1;
            const m = Math.min(
                v1[j] + 1,
                v0[j + 1] + 1,
                v0[j] + cost
            );
            v1[j + 1] = m;
            if (m < rowMin) rowMin = m;
        }
        if (rowMin > maxDist) return maxDist + 1;
        for (let j = 0; j <= bl; j++) v0[j] = v1[j];
    }

    return v0[bl];
}

function tokenMatchesField(token, field) {
    const t = normalizeFilterToken(token);
    const f = normalizeFilterToken(field);
    if (!t || !f) return false;

    const ts = simpleStem(t);
    const fs = simpleStem(f);

    if (f.includes(t) || t.includes(f) || fs.includes(ts) || ts.includes(fs)) return true;

    // Fuzzy: allow small typos for practical autocorrect-like behavior.
    const maxDist = t.length <= 4 ? 1 : (t.length <= 8 ? 2 : 3);
    if (levenshteinDistance(ts, fs, maxDist) <= maxDist) return true;

    // Word-level fuzzy matching (e.g., "restaurants" vs "restaurant")
    const words = f.split(' ');
    for (const w of words) {
        if (!w || w.length < 2) continue;
        const ws = simpleStem(w);
        if (ws.includes(ts) || ts.includes(ws)) return true;
        const wd = levenshteinDistance(ts, ws, maxDist);
        if (wd <= maxDist) return true;
    }

    return false;
}

function placeMatchesAnyToken(place, tokens) {
    if (!tokens || tokens.length === 0) return true;
    const name = place?.name || '';
    const type = place?.place_type || '';

    for (const token of tokens) {
        if (tokenMatchesField(token, name) || tokenMatchesField(token, type)) {
            return true;
        }
    }
    return false;
}

function parsePlaceFiltersFromInput(value) {
    return tokenizeFilterQuery(value);
}

function getActivePriorityCenter() {
    if (searchPinCoords) return searchPinCoords;
    // Use map center at time of search as distance basis
    const c = map.getCenter();
    return [c.lat, c.lng];
}

function compareByDistance(a, b, center) {
    const distA = calculateDistance(a.coordinates, center);
    const distB = calculateDistance(b.coordinates, center);
    return distA - distB;
}

function compareByAlphabetical(a, b) {
    const nameA = String(a.name || '').toLowerCase();
    const nameB = String(b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
}

function compareByRating(a, b) {
    const ra = typeof a.rating === 'number' ? a.rating : -Infinity;
    const rb = typeof b.rating === 'number' ? b.rating : -Infinity;
    if (ra !== rb) return rb - ra;
    return compareByAlphabetical(a, b);
}

function applyFiltersAndSort({ resetToFirstPage = true } = {}) {
    const center = lastPriorityCenter;
    const hasFilter = activePlaceFilters.length > 0;

    let derived = unfilteredSearchResults;
    if (hasFilter) {
        const tokens = activePlaceFilters;
        derived = derived.filter(place => placeMatchesAnyToken(place, tokens));
    }

    const sorted = derived.slice();
    if (activeSortMode === 'alphabetical') {
        sorted.sort(compareByAlphabetical);
    } else if (activeSortMode === 'rating') {
        sorted.sort(compareByRating);
    } else {
        if (center) sorted.sort((a, b) => compareByDistance(a, b, center));
    }

    allSearchResults = sorted;

    if (resetToFirstPage) {
        currentDisplayOffset = 0;
        displayResultsPage(0);
    } else {
        displayResultsPage(currentDisplayOffset);
    }
}

function syncFilterSortUIState() {
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) sortSelect.value = activeSortMode;
}

function populateTypeDatalistFromResults(places) {
    const datalist = document.getElementById('place-filter-options');
    if (!datalist) return;

    const unique = new Set();
    for (const t of COMMON_PLACE_TYPES) {
        const nt = normalizePlaceType(t);
        if (nt) unique.add(nt);
    }
    for (const p of places) {
        const name = normalizePlaceName(p?.name);
        const type = normalizePlaceType(p?.place_type);
        if (name) unique.add(name);
        if (type) unique.add(type);
    }

    const options = Array.from(unique).sort();
    datalist.innerHTML = options.map(v => `<option value="${v}"></option>`).join('');
}

function calculateDistance(point1, point2) {
    // Handle both [lat, lng] arrays and {lat, lng} objects
    const lat1 = (Array.isArray(point1) ? point1[0] : point1.lat) * Math.PI / 180;
    const lat2 = (Array.isArray(point2) ? point2[0] : point2.lat) * Math.PI / 180;
    const lng1 = Array.isArray(point1) ? point1[1] : point1.lng;
    const lng2 = Array.isArray(point2) ? point2[1] : point2.lng;
    const deltaLat = ((Array.isArray(point2) ? point2[0] : point2.lat) - (Array.isArray(point1) ? point1[0] : point1.lat)) * Math.PI / 180;
    const deltaLng = (lng2 - lng1) * Math.PI / 180;

    const R = 6371e3; // Earth radius in meters

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

function pointInPolygon(point, polygonPoints) {
    const x = point[1]; // lng
    const y = point[0]; // lat
    let inside = false;

    for (let i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
        const xi = polygonPoints[i][1], yi = polygonPoints[i][0];
        const xj = polygonPoints[j][1], yj = polygonPoints[j][0];

        const intersect = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }

    return inside;
}

function getDistanceToPolygonEdge(point, polygonPoints) {
    let minDistance = Infinity;

    for (let i = 0; i < polygonPoints.length - 1; i++) {
        const start = polygonPoints[i];
        const end = polygonPoints[i + 1];
        const distance = pointToLineDistance(point, start, end);
        minDistance = Math.min(minDistance, distance);
    }

    return minDistance;
}

function pointToLineDistance(point, lineStart, lineEnd) {
    const x = point[1];
    const y = point[0];
    const x1 = lineStart[1];
    const y1 = lineStart[0];
    const x2 = lineEnd[1];
    const y2 = lineEnd[0];

    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;

    if (lenSq !== 0) {
        param = dot / lenSq;
    }

    let xx, yy;

    if (param < 0) {
        xx = x1;
        yy = y1;
    } else if (param > 1) {
        xx = x2;
        yy = y2;
    } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
    }

    const dLng = x - xx;
    const dLat = y - yy;

    // Account for longitude compression at this latitude
    const avgLat = (y + yy) / 2;
    const cosLat = Math.cos(avgLat * Math.PI / 180);

    return Math.sqrt((dLng * cosLat) * (dLng * cosLat) + dLat * dLat) * 111000;
}

// =============================================================================
// LASO Search - Find Businesses using Google Places API (New)
// =============================================================================

// Track if search is in progress
let isSearching = false;
let currentSearchOffset = 0;
let searchPinCoords = null; // Coordinates of address search pin
let searchAbortController = null; // AbortController for cancelling timed-out searches
const SEARCH_TIMEOUT_MS = 60000; // 60 second global search timeout

// Pagination globals
let allSearchResults = [];
let currentDisplayOffset = 0;
const RESULTS_PER_PAGE = 40;

async function performLasoSearch() {
    // Dismiss first-time shimmer and remember the user has pressed Draw Search
    const lasoBtn = document.getElementById('lasosearch-btn');
    if (lasoBtn) lasoBtn.classList.remove('shimmer');
    try { localStorage.setItem('laso_has_used_draw_search', '1'); } catch (e) { /* ignore */ }

    if (isSearching) {
        showNotification('Search already in progress, please wait...', 'error');
        return;
    }

    if (!currentPolygon) {
        alert('Please draw a polygon on the map first');
        return;
    }

    // Verify proxy / daily limit before searching
    if (!canMakeGooglePlacesCall()) {
        if (typeof LASO_PROXY_URL === 'undefined' || !LASO_PROXY_URL) {
            showNotification('API proxy not configured. Check config.js', 'error');
            console.error('[Google Places] Cannot search — LASO_PROXY_URL missing. See config.js');
        } else {
            showNotification('Daily API limit reached. Try again tomorrow.', 'error');
            console.warn('[Google Places] Daily limit reached:', _getGoogleUsageCount(), '/', GOOGLE_PLACES_DAILY_LIMIT);
        }
        return;
    }

    isSearching = true;
    currentSearchOffset = 0;

    // Show loading
    showLoading(true);
    updateStatus('Searching Google Places...', true);

    try {
        const priorityCenter = getActivePriorityCenter();
        lastPriorityCenter = priorityCenter;

        // Search using Google Nearby Search (parallel calls for each type group)
        const allPlaces = await searchPlacesWithGoogle(drawingPoints, (progress) => {
            updateStatus(progress, true);
        });

        console.log(`[Google Places] Found ${allPlaces.length} total places in polygon`);

        unfilteredSearchResults = allPlaces;
        populateTypeDatalistFromResults(allPlaces);
        syncFilterSortUIState();
        applyFiltersAndSort({ resetToFirstPage: true });

        // On mobile, compute TWO polygon fit states then apply the
        // results-open fit before the toaster slides in.
        // Filter row stays in the header permanently — map canvas is constant.
        if (isMobileView() && currentPolygon) {
            const mapEl = document.getElementById('map');
            map.invalidateSize({ animate: false });

            // State 1: results-open (toaster covers bottom half of map)
            const toasterVisibleH = mapEl ? mapEl.offsetHeight * 0.5 : 0;
            const { center: openCenter, zoom: rawOpenZoom } = calculatePolygonFit(
                currentPolygon, map,
                5, 5, toasterVisibleH + 5, 5
            );
            fitStateResultsOpen = {
                center: openCenter,
                zoom: Math.round(rawOpenZoom * 100) / 100
            };

            // State 2: lip-peeked (only 52px lip visible at bottom)
            const { center: lipCenter, zoom: rawLipZoom } = calculatePolygonFit(
                currentPolygon, map,
                5, 5, TOASTER_LIP_HEIGHT + 5, 5
            );
            fitStateLipPeeked = {
                center: lipCenter,
                zoom: Math.round(rawLipZoom * 100) / 100
            };

            // Apply the results-open fit.
            applyPolygonFit(fitStateResultsOpen);
        }

        // Show sidebar (toaster on mobile) AFTER the polygon is fitted.
        openSidebar();

        updateStatus(`Found ${allSearchResults.length} businesses`);

    } catch (error) {
        console.error('[Google Places] Search error:', error);
        updateStatus('Search failed - please try again');
        showNotification('Error searching for businesses. Please try again.', 'error');
    } finally {
        searchAbortController = null;
        isSearching = false;
        showLoading(false);
    }
}

function displayResultsPage(pageNum) {
    const start = pageNum * RESULTS_PER_PAGE;
    const end = start + RESULTS_PER_PAGE;
    const pageResults = allSearchResults.slice(start, end);

    searchResults = pageResults;
    const resultsList = document.getElementById('results-list');
    const resultCount = document.getElementById('result-count');

    const showingText = allSearchResults.length > RESULTS_PER_PAGE
        ? `${start + 1}-${Math.min(end, allSearchResults.length)} of ${allSearchResults.length}`
        : `${allSearchResults.length}`;

    resultCount.textContent = showingText;

    if (pageResults.length === 0) {
        resultsList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <p>No businesses found</p>
            </div>
        `;
        return;
    }

    let html = pageResults.map((place, index) => createPlaceCard(place, start + index)).join('');

    // Add pagination controls
    const hasPrevious = start > 0;
    const hasMore = end < allSearchResults.length;

    if (hasPrevious || hasMore) {
        html += `
            <div style="display: flex; gap: 12px; margin-top: 16px;">
                ${hasPrevious ? `
                    <button id="load-previous-btn" style="flex: 1; padding: 12px; background: #f8f9fa; color: #4285f4; border: 1px solid #4285f4; border-radius: 4px; cursor: pointer; font-weight: 500;">
                        <i class="fas fa-chevron-left"></i> Previous
                    </button>
                ` : '<div style="flex: 1;"></div>'}
                ${hasMore ? `
                    <button id="load-more-btn" style="flex: 1; padding: 12px; background: #4285f4; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">
                        Next <i class="fas fa-chevron-right"></i>
                    </button>
                ` : '<div style="flex: 1;"></div>'}
            </div>
            <div style="text-align: center; margin-top: 8px; color: #666; font-size: 12px;">
                Showing ${start + 1}-${Math.min(end, allSearchResults.length)} of ${allSearchResults.length}
            </div>
        `;
    }

    resultsList.innerHTML = html;
    updateResultsSpacer();

    // Add click handlers for cards
    pageResults.forEach((place, index) => {
        const card = document.getElementById(`place-card-${start + index}`);
        if (card) {
            card.addEventListener('click', () => highlightPlace(start + index));
        }
    });

    // Add Load More handler
    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
            currentDisplayOffset++;
            displayResultsPage(currentDisplayOffset);
        });
    }

    // Add Load Previous handler
    const loadPreviousBtn = document.getElementById('load-previous-btn');
    if (loadPreviousBtn) {
        loadPreviousBtn.addEventListener('click', () => {
            currentDisplayOffset--;
            displayResultsPage(currentDisplayOffset);
        });
    }

    // Scroll to top of results list so the user sees the first card.
    // Use rAF + direct scrollTop assignment — on mobile Safari, momentum
    // scrolling from -webkit-overflow-scrolling:touch can override scrollTo().
    requestAnimationFrame(() => {
        const scrollContainer = document.querySelector('.sidebar-content');
        if (scrollContainer) scrollContainer.scrollTop = 0;
    });

    // Update ALL markers on map (not just current page)
    updateAllMarkers();
}

function formatAddress(tags) {
    const parts = [];
    if (tags['addr:street']) parts.push(tags['addr:street']);
    if (tags['addr:housenumber']) parts.unshift(tags['addr:housenumber']);
    if (tags['addr:city']) parts.push(tags['addr:city']);
    if (tags['addr:postcode']) parts.push(tags['addr:postcode']);

    return parts.length > 0 ? parts.join(', ') : 'Address not available';
}

// =============================================================================
// Google Places API (New) — Primary Search Backend
// =============================================================================

function _googleUsageKey() {
    return 'gplaces_usage_' + new Date().toISOString().split('T')[0];
}

function _getGoogleUsageCount() {
    return parseInt(localStorage.getItem(_googleUsageKey()) || '0', 10);
}

function _recordGoogleApiCall() {
    const key = _googleUsageKey();
    const count = _getGoogleUsageCount() + 1;
    localStorage.setItem(key, count);
    // Clean up stale day keys
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('gplaces_usage_') && k !== key) {
            localStorage.removeItem(k);
        }
    }
    if (typeof GOOGLE_PLACES_WARN_THRESHOLD !== 'undefined'
        && typeof GOOGLE_PLACES_DAILY_LIMIT !== 'undefined'
        && count >= Math.floor(GOOGLE_PLACES_DAILY_LIMIT * GOOGLE_PLACES_WARN_THRESHOLD)) {
        console.warn(`[Google Places] ⚠ Client-side usage: ${count}/${GOOGLE_PLACES_DAILY_LIMIT} today`);
    }
    return count;
}

function canMakeGooglePlacesCall() {
    if (typeof LASO_PROXY_URL === 'undefined' || !LASO_PROXY_URL) return false;
    if (typeof GOOGLE_PLACES_DAILY_LIMIT === 'undefined') return true;
    return _getGoogleUsageCount() < GOOGLE_PLACES_DAILY_LIMIT;
}

/**
 * Convert a polygon (array of [lat, lng] pairs) to a bounding circle
 * for Google Nearby Search's locationRestriction.
 */
function polygonToBoundingCircle(polygonPoints) {
    const centroid = getPolygonCentroid(polygonPoints);
    if (!centroid) return null;

    let maxRadius = 0;
    for (const point of polygonPoints) {
        const dist = calculateDistance(centroid, point);
        if (dist > maxRadius) maxRadius = dist;
    }

    // Add 10% padding, cap at 50 km (Google's max)
    const radius = Math.min(maxRadius * 1.1, 50000);

    return {
        center: { latitude: centroid[0], longitude: centroid[1] },
        radius: radius
    };
}

/**
 * Search for businesses within a polygon using Google Nearby Search (New).
 * Makes parallel requests for each type group, combines and deduplicates,
 * then filters to the polygon boundary.
 */
async function searchPlacesWithGoogle(polygonPoints, progressCallback) {
    // ── Search-area validation (closure-scoped limits — tamper-resistant) ──
    const guardResult = _searchGuard.validateSearchArea(polygonPoints);
    if (!guardResult.ok) {
        throw new Error('Search blocked: ' + guardResult.reason);
    }

    const circle = polygonToBoundingCircle(polygonPoints);
    if (!circle) throw new Error('Could not compute search area from polygon');

    console.log(`[Google Places] Search area: ${circle.radius.toFixed(0)}m radius around [${circle.center.latitude.toFixed(5)}, ${circle.center.longitude.toFixed(5)}]`);

    if (progressCallback) progressCallback('Searching Google Places...');

    // Limit type groups to the guard's cap (prevents abuse via expanded groups)
    const typeGroups = GOOGLE_TYPE_GROUPS.slice(0, _searchGuard.getMaxTypeGroups());

    // Make parallel requests for each type group
    const promises = typeGroups.map((types, i) => {
        console.log(`[Google Places] Querying group ${i + 1}/${typeGroups.length}: ${types.slice(0, 3).join(', ')}...`);
        return fetchNearbyPlaces(types, circle);
    });

    const results = await Promise.all(promises);

    // Combine and deduplicate by Google place ID
    const placeMap = new Map();
    let totalRaw = 0;
    for (let i = 0; i < results.length; i++) {
        const batch = results[i];
        totalRaw += batch.length;
        console.log(`[Google Places] Group ${i + 1} returned ${batch.length} places`);
        for (const place of batch) {
            if (place.place_id && !placeMap.has(place.place_id)) {
                placeMap.set(place.place_id, place);
            }
        }
    }

    const uniquePlaces = Array.from(placeMap.values());
    console.log(`[Google Places] ${totalRaw} raw results → ${uniquePlaces.length} unique places`);

    if (progressCallback) progressCallback(`Filtering ${uniquePlaces.length} places to polygon...`);

    // Filter to polygon boundary
    const filtered = uniquePlaces.filter(place => {
        if (!place.coordinates) return false;
        const inside = pointInPolygon(place.coordinates, polygonPoints);
        if (inside) return true;
        // Include places within 10m of the polygon edge
        const dist = getDistanceToPolygonEdge(place.coordinates, polygonPoints);
        return dist <= 10;
    });

    console.log(`[Google Places] ${filtered.length} places inside polygon (filtered from ${uniquePlaces.length})`);
    return filtered;
}

/**
 * Fetch up to 20 places from Google Nearby Search for a set of types.
 * Returns normalized place objects ready for display.
 */
async function fetchNearbyPlaces(includedTypes, circle) {
    // Defence-in-depth: independently validate circle radius at the fetch boundary
    if (!_searchGuard.validateCircleRadius(circle.radius)) {
        console.warn('[Google Places] Circle radius exceeds limit — blocked');
        return [];
    }

    if (!canMakeGooglePlacesCall()) {
        console.warn('[Google Places] Daily limit reached — skipping API call');
        return [];
    }

    try {
        const response = await fetch(LASO_PROXY_URL + '/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-FieldMask': GOOGLE_FIELD_MASK
            },
            body: JSON.stringify({
                includedTypes: includedTypes,
                locationRestriction: { circle: circle },
                maxResultCount: 20,
                rankPreference: 'DISTANCE'
            })
        });

        _recordGoogleApiCall();

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Google Places] Search failed (${response.status}):`, errorText);
            if (response.status === 429 || response.status === 403) {
                console.warn('[Google Places] Quota exceeded or forbidden — disabling for this session');
                localStorage.setItem(_googleUsageKey(), '99999');
            }
            return [];
        }

        const data = await response.json();
        if (!data.places || data.places.length === 0) return [];

        console.log(`[Google Places] ✓ Received ${data.places.length} places`);

        return data.places
            .filter(gp => gp.businessStatus !== 'CLOSED_PERMANENTLY')
            .map(gp => {
                const rating = gp.rating || null;
                const userRatingCount = gp.userRatingCount || 0;
                const googleMapsUri = gp.googleMapsUri || null;
                const displayName = gp.displayName ? gp.displayName.text : null;

                return {
                    place_id: gp.id || '',
                    name: displayName || 'Unnamed Place',
                    address: gp.formattedAddress || 'Address not available',
                    coordinates: gp.location
                        ? [gp.location.latitude, gp.location.longitude]
                        : null,
                    place_type: gp.primaryTypeDisplayName
                        ? gp.primaryTypeDisplayName.text
                        : (gp.primaryType || 'Business').replace(/_/g, ' '),
                    rating: rating,
                    userRatingCount: userRatingCount,
                    phone: gp.internationalPhoneNumber || null,
                    website: gp.websiteUri || null,
                    googleMapsUri: googleMapsUri,
                    // Backward-compatible google sub-object for card/popup rendering
                    google: {
                        rating: rating,
                        userRatingCount: userRatingCount,
                        googleMapsUri: googleMapsUri,
                        displayName: displayName
                    }
                };
            });
    } catch (err) {
        console.error('[Google Places] Fetch error:', err);
        return [];
    }
}

/**
 * Verify the Google Places API key is configured and reachable.
 * Logs the result to the console for debugging.
 */
async function verifyGoogleApiKey() {
    if (typeof LASO_PROXY_URL === 'undefined' || !LASO_PROXY_URL) {
        console.error('[Google Places] ✗ Proxy URL NOT configured. Add LASO_PROXY_URL to config.js');
        console.error('[Google Places]   Copy config.example.js → config.js and set your worker URL.');
        return false;
    }

    console.log('[Google Places] Proxy URL:', LASO_PROXY_URL);
    console.log('[Google Places] Daily usage so far:', _getGoogleUsageCount(), '/', GOOGLE_PLACES_DAILY_LIMIT);

    // Make a minimal test call to verify the proxy + key work
    try {
        const response = await fetch(LASO_PROXY_URL + '/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-FieldMask': 'places.id'
            },
            body: JSON.stringify({
                includedTypes: ['restaurant'],
                locationRestriction: {
                    circle: {
                        center: { latitude: 40.7128, longitude: -74.0060 },
                        radius: 100.0
                    }
                },
                maxResultCount: 1
            })
        });

        _recordGoogleApiCall();

        if (response.ok) {
            console.log('[Google Places] ✓ Proxy verified — connection successful');
            return true;
        } else {
            const errorText = await response.text();
            console.error(`[Google Places] ✗ Proxy verification failed (${response.status}):`, errorText);
            return false;
        }
    } catch (err) {
        console.error('[Google Places] ✗ Network error during verification:', err.message);
        return false;
    }
}

// Font Awesome 6 icon dictionary for OSM business/place categories
const PLACE_ICON_MAP = {
    // --- Food & Drink ---
    restaurant:        'fa-utensils',
    cafe:              'fa-mug-saucer',
    fast_food:         'fa-burger',
    bar:               'fa-martini-glass-citrus',
    pub:               'fa-beer-mug-empty',
    ice_cream:         'fa-ice-cream',
    food_court:        'fa-utensils',
    bakery:            'fa-bread-slice',
    butcher:           'fa-drumstick-bite',
    confectionery:     'fa-candy-cane',
    deli:              'fa-cheese',
    // --- Shopping ---
    supermarket:       'fa-cart-shopping',
    convenience:       'fa-basket-shopping',
    clothes:           'fa-shirt',
    shoes:             'fa-shoe-prints',
    jewelry:           'fa-gem',
    electronics:       'fa-laptop',
    mobile_phone:      'fa-mobile-screen-button',
    furniture:         'fa-couch',
    hardware:          'fa-screwdriver-wrench',
    books:             'fa-book-open',
    stationery:        'fa-pen-fancy',
    gift:              'fa-gift',
    toys:              'fa-puzzle-piece',
    beauty:            'fa-spa',
    cosmetics:         'fa-spray-can-sparkles',
    hairdresser:       'fa-scissors',
    florist:           'fa-seedling',
    pet:               'fa-paw',
    alcohol:           'fa-wine-glass',
    tobacco:           'fa-smoking',
    optician:          'fa-glasses',
    variety_store:     'fa-store',
    department_store:  'fa-building',
    mall:              'fa-bag-shopping',
    art:               'fa-palette',
    music:             'fa-music',
    bicycle:           'fa-bicycle',
    car:               'fa-car',
    car_parts:         'fa-gears',
    tyres:             'fa-circle-dot',
    laundry:           'fa-jug-detergent',
    dry_cleaning:      'fa-jug-detergent',
    // --- Health ---
    pharmacy:          'fa-prescription-bottle-medical',
    hospital:          'fa-hospital',
    clinic:            'fa-stethoscope',
    doctors:           'fa-user-doctor',
    dentist:           'fa-tooth',
    veterinary:        'fa-paw',
    // --- Finance ---
    bank:              'fa-landmark',
    atm:               'fa-money-bill-wave',
    bureau_de_change:  'fa-money-bill-transfer',
    // --- Education ---
    school:            'fa-school',
    college:           'fa-graduation-cap',
    university:        'fa-graduation-cap',
    library:           'fa-book',
    kindergarten:      'fa-children',
    // --- Services ---
    post_office:       'fa-envelope',
    police:            'fa-shield-halved',
    fire_station:      'fa-fire-extinguisher',
    fuel:              'fa-gas-pump',
    charging_station:  'fa-bolt',
    car_wash:          'fa-droplet',
    car_repair:        'fa-wrench',
    parking:           'fa-square-parking',
    taxi:              'fa-taxi',
    bus_station:       'fa-bus',
    // --- Leisure & Entertainment ---
    cinema:            'fa-film',
    theatre:           'fa-masks-theater',
    nightclub:         'fa-champagne-glasses',
    casino:            'fa-dice',
    gym:               'fa-dumbbell',
    fitness_centre:    'fa-dumbbell',
    swimming_pool:     'fa-person-swimming',
    sports_centre:     'fa-futbol',
    // --- Lodging ---
    hotel:             'fa-hotel',
    guest_house:       'fa-bed',
    hostel:            'fa-bed',
    motel:             'fa-bed',
    // --- Religious ---
    place_of_worship:  'fa-place-of-worship',
    // --- Other ---
    toilets:           'fa-restroom',
    drinking_water:    'fa-faucet-drip',
    bench:             'fa-chair',
    marketplace:       'fa-store',
    community_centre:  'fa-people-roof',
    social_facility:   'fa-hands-holding-child',
    childcare:         'fa-baby',
    townhall:          'fa-building-columns',
    courthouse:        'fa-gavel',
    embassy:           'fa-flag',
    prison:            'fa-lock',
    recycling:         'fa-recycle',
    waste_disposal:    'fa-dumpster',
    // --- Google Places API type mappings ---
    meal_delivery:     'fa-truck',
    meal_takeaway:     'fa-bag-shopping',
    convenience_store: 'fa-basket-shopping',
    clothing_store:    'fa-shirt',
    electronics_store: 'fa-laptop',
    furniture_store:   'fa-couch',
    hardware_store:    'fa-screwdriver-wrench',
    home_goods_store:  'fa-house',
    jewelry_store:     'fa-gem',
    shoe_store:        'fa-shoe-prints',
    pet_store:         'fa-paw',
    book_store:        'fa-book-open',
    liquor_store:      'fa-wine-glass',
    shopping_mall:     'fa-bag-shopping',
    beauty_salon:      'fa-spa',
    hair_care:         'fa-scissors',
    doctor:            'fa-user-doctor',
    veterinary_care:   'fa-paw',
    physiotherapist:   'fa-hands',
    gas_station:       'fa-gas-pump',
    movie_theater:     'fa-film',
    night_club:        'fa-champagne-glasses',
    spa:               'fa-spa',
    lodging:           'fa-bed',
    mosque:            'fa-mosque',
    synagogue:         'fa-star-of-david',
    hindu_temple:      'fa-om',
    store:             'fa-store',
};

function getPlaceIcon(type) {
    if (!type) return 'fa-location-dot';
    // Normalize: lowercase, strip "Shop: " prefix, replace spaces with underscores
    const key = type.replace(/^shop:\s*/i, '').toLowerCase().replace(/\s+/g, '_');
    return PLACE_ICON_MAP[key] || 'fa-location-dot';
}

function getPlaceType(tags) {
    if (tags.amenity) return tags.amenity.replace(/_/g, ' ');
    if (tags.shop) return `Shop: ${tags.shop.replace(/_/g, ' ')}`;
    return 'Business';
}

function filterPlacesInPolygon(places, polygonPoints) {
    console.log('Filtering', places.length, 'places with polygon:', polygonPoints.length, 'points');

    const kept = [];
    const excluded = [];

    places.forEach(place => {
        if (!place.coordinates) {
            excluded.push({name: place.name || 'Unnamed', reason: 'no coordinates'});
            return;
        }

        // Use proper point-in-polygon ray casting algorithm
        const isInside = pointInPolygon(place.coordinates, polygonPoints);

        // Check if place is ON the polygon boundary (within 5 meters of any edge)
        const distanceToEdge = getDistanceToPolygonEdge(place.coordinates, polygonPoints);
        const isOnBoundary = distanceToEdge <= 5; // 5 meter tolerance

        if (isInside || isOnBoundary) {
            kept.push(place);
            console.log('✓ KEEP:', place.name || 'Unnamed', 'type:', place.place_type, 'inside:', isInside, 'boundary:', isOnBoundary);
        } else {
            excluded.push({
                name: place.name || 'Unnamed',
                type: place.place_type,
                distToEdge: distanceToEdge.toFixed(1) + 'm',
                reason: 'OUTSIDE'
            });
            console.log('✗ EXCLUDE:', place.name || 'Unnamed', 'dist to edge:', distanceToEdge.toFixed(1) + 'm');
        }
    });

    console.log('Kept', kept.length, 'places, excluded', excluded.length);
    return kept;
}

// =============================================================================
// Results Display
// =============================================================================

function displayResults(places) {
    searchResults = places;
    const resultsList = document.getElementById('results-list');
    const resultCount = document.getElementById('result-count');

    resultCount.textContent = `${places.length}`;

    if (places.length === 0) {
        resultsList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <p>No businesses found in the selected area</p>
                <p style="font-size: 0.8rem; margin-top: 8px;">Try drawing a larger area or searching a different location</p>
            </div>
        `;
        return;
    }

    resultsList.innerHTML = places.map((place, index) => createPlaceCard(place, index)).join('');
    updateResultsSpacer();

    // Add click handlers
    places.forEach((place, index) => {
        const card = document.getElementById(`place-card-${index}`);
        if (card) {
            card.addEventListener('click', () => {
                highlightPlace(index);
            });
        }
    });
}

// =============================================================================
// Device Detection Helpers
// =============================================================================

function _isAppleDevice() {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod|Macintosh/.test(ua);
}

function _isIOSDevice() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return true;
    // iPad on iOS 13+ reports as Macintosh
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
}

function _isAndroidDevice() {
    return /Android/i.test(navigator.userAgent);
}

// =============================================================================
// Address Formatting
// =============================================================================

/**
 * Split an address into two lines for uniform card display.
 * Line 1: street through state   Line 2: zip code + country.
 * Falls back to a single line for non-US / unrecognised formats.
 */
function formatAddressTwoLines(address) {
    if (!address || address === 'Address not available') {
        return '<span class="address-line unavailable">Unavailable</span>';
    }
    // US-style: "Street, City, ST ZIPCODE, Country"
    const usMatch = address.match(/^(.*,\s*[A-Z]{2})\s+(\d{5}(?:-\d{4})?.*)$/);
    if (usMatch) {
        return `<span class="address-line">${usMatch[1]}</span>`
             + `<span class="address-line">${usMatch[2]}</span>`;
    }
    // Fallback: show full address on one line
    return `<span class="address-line">${address}</span>`;
}

// =============================================================================

function createPlaceCard(place, index) {
    const name = place.name || 'Unnamed Place';
    const address = place.address || 'Address not available';
    const types = place.place_type || [];
    const mainType = Array.isArray(types) ? types[0] : types || 'Business';

    const lat = place.coordinates ? place.coordinates[0] : null;
    const lng = place.coordinates ? place.coordinates[1] : null;
    const hasCoords = lat && lng;
    const hasAddress = address && address !== 'Address not available';
    const searchTerm = hasAddress ? `${name}, ${address}` : name;

    // ── Web URLs (fallback for desktop / non-app platforms) ──
    const googleWebUrl = (place.google && place.google.googleMapsUri)
        ? place.google.googleMapsUri
        : (hasCoords
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchTerm)}`
            : '#');
    const appleWebUrl = hasCoords
        ? `https://maps.apple.com/?q=${encodeURIComponent(name)}${hasAddress ? `&address=${encodeURIComponent(address)}` : ''}&ll=${lat},${lng}&z=17`
        : '#';

    // ── Compute the actual href & target per-platform ──
    // Never use custom URL schemes (comgooglemaps://, maps://) — Safari tracks a
    // per-origin frequency counter for custom-scheme navigations and shows the
    // "repeatedly trying to open another application" dialog after a few clicks.
    // Standard HTTPS links bypass that counter entirely.
    //
    // iOS:     HTTPS google.com/maps URL with _self — iOS universal links open
    //          Google Maps app if installed; falls back to web if not.
    // Android: geo: intent (standard OS-level intent, not subject to Safari).
    // Desktop: HTTPS URL in a new tab (no native Google Maps app exists).
    let googleHref, googleTarget;
    if (_isAndroidDevice() && hasCoords) {
        googleHref = `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(name)})`;
        googleTarget = '_self';
    } else if (_isIOSDevice()) {
        googleHref = googleWebUrl;
        googleTarget = '_self';
    } else {
        googleHref = googleWebUrl;
        googleTarget = '_blank';
    }

    // Apple Maps: always use the standard HTTPS maps.apple.com URL.
    // On Apple devices macOS/iOS intercepts maps.apple.com at the system level
    // and opens Apple Maps.app directly.  Using _self (not _blank) prevents a
    // blank browser tab.  Critically, HTTPS links do NOT trigger Safari's
    // "repeatedly trying to open another application" dialog — that dialog is
    // a frequency counter applied exclusively to custom URL schemes (maps://,
    // comgooglemaps://, etc.).  Standard HTTPS links bypass it entirely.
    const appleHref = appleWebUrl;
    const appleTarget = _isIOSDevice() ? '_self' : '_blank';

    // ── Card field HTML — always present for uniform height ──
    const hasRating = place.google && place.google.rating;
    const ratingHtml = hasRating
        ? `<i class="fas fa-star"></i> ${place.google.rating.toFixed(1)}${place.google.userRatingCount ? ` <span class="rating-count">(${place.google.userRatingCount})</span>` : ''}`
        : '<i class="fas fa-star"></i> <span class="unavailable">Unavailable</span>';

    const websiteHtml = place.website
        ? `<a href="${place.website}" target="_blank" rel="noopener" style="color:#4285f4;text-decoration:none;"><span><i class="fas fa-globe"></i> Website</span></a>`
        : `<span class="unavailable"><i class="fas fa-globe"></i> website unavailable</span>`;

    // Phone action button
    const phoneHref = place.phone ? `tel:${place.phone}` : '#';
    const phoneBtnClass = place.phone ? 'map-btn phone' : 'map-btn phone disabled';

    const addressHtml = formatAddressTwoLines(address);

    return `
        <div class="place-card" id="place-card-${index}" data-place-id="${place.place_id || place.osm_id || ''}">
            <div class="place-card-body">
                <div class="place-card-info">
                    <div class="place-name">${name}</div>
                    <div class="place-rating${hasRating ? ' has-rating' : ''}">${ratingHtml}</div>
                    <div class="place-type"><i class="fas ${getPlaceIcon(mainType)}"></i> ${mainType}</div>
                    <div class="place-address">${addressHtml}</div>
                    <div class="place-details">
                        ${websiteHtml}
                    </div>
                </div>
                <div class="place-card-actions">
                    <a href="${googleHref}" target="${googleTarget}" rel="noopener" class="map-btn google" data-card-index="${index}" title="Google Maps">
                        <i class="fab fa-google"></i> <span>Google</span>
                    </a>
                    <a href="${appleHref}" target="${appleTarget}" rel="noopener" class="map-btn apple" data-card-index="${index}" title="Apple Maps">
                        <i class="fab fa-apple"></i> <span>Apple</span>
                    </a>
                    <a href="${phoneHref}" class="${phoneBtnClass}" data-card-index="${index}" title="Phone"${place.phone ? '' : ' onclick="return false;"'}>
                        <i class="fas fa-phone"></i> <span>Phone</span>
                    </a>
                </div>
            </div>
        </div>
    `;
}

// =============================================================================
// Markers Management
// =============================================================================

function buildPopupContent(place, index, simplified) {
    const name = place.name || 'Unnamed Place';
    const mainType = Array.isArray(place.place_type) ? place.place_type[0] : (place.place_type || 'Business');
    const iconClass = getPlaceIcon(mainType);

    if (simplified) {
        return '<div class="marker-popup" data-place-index="' + index + '">' +
            '<div class="marker-popup-info" style="text-align:center;padding:2px 4px;">' +
                '<h3 style="margin:0;font-size:14px;color:#202124;font-weight:600;">' + name + '</h3>' +
            '</div>' +
        '</div>';
    }

    const address = place.address || 'Address not available';
    const lat = place.coordinates[0];
    const lng = place.coordinates[1];
    const hasAddress = address && address !== 'Address not available';
    const searchTerm = hasAddress ? (name + ', ' + address) : name;
    const googleMapsUrl = (place.google && place.google.googleMapsUri)
        ? place.google.googleMapsUri
        : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(searchTerm);
    const appleMapsUrl = 'https://maps.apple.com/?q=' + encodeURIComponent(name) + '&ll=' + lat + ',' + lng + '&z=19';

    const ratingHtml = (place.google && place.google.rating)
        ? '<p style="margin:2px 0 4px 0;font-size:13px;color:#f4b400;font-weight:500;"><i class="fas fa-star" style="font-size:11px;"></i> ' + place.google.rating.toFixed(1) + (place.google.userRatingCount ? ' <span style="color:#999;font-weight:400;font-size:11px;">(' + place.google.userRatingCount + ')</span>' : '') + '</p>'
        : '';

    // Website row: 1.8× base size (base icon 10px → 18px, base text 12px → 21.6px)
    const websiteRowHtml = place.website
        ? '<p style="margin:4px 0 0 0;font-size:21.6px;"><i class="fas fa-globe" style="color:#666;margin-right:4px;font-size:18px;"></i><a href="' + place.website + '" target="_blank" rel="noopener" style="color:#4285f4;text-decoration:none;">Website</a></p>'
        : '<p style="margin:4px 0 0 0;font-size:21.6px;font-style:italic;color:#80868b;">website unavailable</p>';

    // Phone circle icon: greyed-out with slash if unavailable
    const phoneIconHtml = place.phone
        ? '<a href="tel:' + place.phone + '" title="Call" style="width:36px;height:36px;border-radius:50%;background:#f8f9fa;display:flex;align-items:center;justify-content:center;text-decoration:none;color:#34a853;font-size:14px;border:1px solid #e0e0e0;">' +
              '<i class="fas fa-phone"></i>' +
          '</a>'
        : '<div title="Phone unavailable" style="width:36px;height:36px;border-radius:50%;background:#f8f9fa;display:flex;align-items:center;justify-content:center;color:#b0b0b0;font-size:14px;border:1px solid #e0e0e0;position:relative;">' +
              '<i class="fas fa-phone"></i>' +
              '<div style="position:absolute;width:28px;height:2px;background:#b0b0b0;transform:rotate(-45deg);border-radius:1px;"></div>' +
          '</div>';

    return '<div class="marker-popup" data-place-index="' + index + '">' +
        '<div style="display:flex;align-items:flex-end;gap:10px;">' +
            '<div class="marker-popup-info" style="flex:1;min-width:0;">' +
                '<h3 style="margin:0 0 4px 0;font-size:14px;color:#202124;font-weight:600;">' + name + '</h3>' +
                ratingHtml +
                '<p style="margin:0;font-size:12px;color:#666;"><i class="fas ' + iconClass + '" style="margin-right:4px;"></i>' + mainType + '</p>' +
                '<p style="margin:3px 0 0 0;font-size:12px;color:#5f6368;">' + address + '</p>' +
                websiteRowHtml +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">' +
                '<a href="' + googleMapsUrl + '" target="_blank" rel="noopener" title="Google Maps" style="width:36px;height:36px;border-radius:50%;background:#f8f9fa;display:flex;align-items:center;justify-content:center;text-decoration:none;color:#4285f4;font-size:13px;border:1px solid #e0e0e0;">' +
                    '<i class="fab fa-google"></i>' +
                '</a>' +
                '<a href="' + appleMapsUrl + '" target="_blank" rel="noopener" title="Apple Maps" style="width:36px;height:36px;border-radius:50%;background:#f8f9fa;display:flex;align-items:center;justify-content:center;text-decoration:none;color:#333;font-size:15px;border:1px solid #e0e0e0;">' +
                    '<i class="fab fa-apple"></i>' +
                '</a>' +
                phoneIconHtml +
            '</div>' +
        '</div>' +
        '<p style="margin:4px 0 0 0;font-size:11px;color:#999;text-align:center;">#' + (index + 1) + ' of ' + allSearchResults.length + '</p>' +
    '</div>';
}

/**
 * Set a marker to the enlarged green "last-selected" style (1.66× normal size).
 * Used when the overlay is minimized so the user can still see which pin was selected.
 */
function setMarkerHighlighted(marker, highlighted) {
    if (!marker) return;
    const index = marker.placeIndex;
    const place = allSearchResults[index];
    const mainType = place
        ? (Array.isArray(place.place_type) ? place.place_type[0] : (place.place_type || 'Business'))
        : 'Business';
    const iconClass = getPlaceIcon(mainType);

    if (highlighted) {
        // 28 × 1.66 ≈ 46, icon font 13 × 1.66 ≈ 22
        marker.setIcon(L.divIcon({
            className: 'custom-marker',
            html: `<div style="width:46px;height:46px;border-radius:50%;background:#34a853;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.4);transition:all 0.25s ease;"><i class="fas ${iconClass}" style="color:#fff;font-size:22px;"></i></div>`,
            iconSize: [46, 46],
            iconAnchor: [23, 23]
        }));
        marker.setZIndexOffset(10000);
        _highlightedMarkerIndex = index;
    } else {
        marker.setIcon(L.divIcon({
            className: 'custom-marker',
            html: `<div style="width:28px;height:28px;border-radius:50%;background:#4285f4;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);"><i class="fas ${iconClass}" style="color:#fff;font-size:13px;"></i></div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        }));
        marker.setZIndexOffset(0);
        if (_highlightedMarkerIndex === index) _highlightedMarkerIndex = null;
    }
}

/**
 * Revert any currently-highlighted marker back to its normal blue style.
 */
function clearHighlightedMarker() {
    if (_highlightedMarkerIndex === null) return;
    const marker = markers.find(m => m.placeIndex === _highlightedMarkerIndex);
    if (marker) setMarkerHighlighted(marker, false);
    _highlightedMarkerIndex = null;
}

function panToMarkerInView(marker) {
    const markerLatLng = marker.getLatLng();
    if (isMobileView()) {
        const sidebar = document.getElementById('results-sidebar');
        const mapEl = document.getElementById('map');
        if (sidebar && sidebar.classList.contains('open') && mapEl) {
            const sidebarRect = sidebar.getBoundingClientRect();
            const mapRect = mapEl.getBoundingClientRect();
            // Exposed canvas = map area above the toaster overlay
            const availableH = sidebarRect.top - mapRect.top;
            if (availableH > 50) {
                const markerPoint = map.latLngToContainerPoint(markerLatLng);
                // Center of the exposed canvas (both axes)
                const desiredX = mapEl.offsetWidth / 2;
                const desiredY = mapRect.top + (availableH / 2) - mapRect.top;
                map.panBy([markerPoint.x - desiredX, markerPoint.y - desiredY]);
                return;
            }
        }
    }
    map.panTo(markerLatLng);
}

function updateAllMarkers() {
    // Clear existing business markers (keep drawing points if any)
    markers.forEach(marker => {
        if (!marker.isDrawingPoint) {
            map.removeLayer(marker);
        }
    });
    markers = markers.filter(m => m.isDrawingPoint);

    // Add markers for ALL results, not just current page
    allSearchResults.forEach((place, index) => {
        if (!place.coordinates) return;

        const mainType = Array.isArray(place.place_type) ? place.place_type[0] : (place.place_type || 'Business');
        const iconClass = getPlaceIcon(mainType);

        const marker = L.marker([place.coordinates[0], place.coordinates[1]], {
            icon: L.divIcon({
                className: 'custom-marker',
                html: `<div style="width:28px;height:28px;border-radius:50%;background:#4285f4;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);"><i class="fas ${iconClass}" style="color:#fff;font-size:13px;"></i></div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            })
        }).addTo(map);

        // Bind full popup initially; popupopen handler swaps to simplified when sidebar is open
        marker.bindPopup(buildPopupContent(place, index, false), { maxWidth: 250, minWidth: 180 });

        marker.placeIndex = index;
        markers.push(marker);

        marker.on('click', () => {
            if (isMobileView()) {
                const sidebar = document.getElementById('results-sidebar');
                const sidebarOpen = sidebar && sidebar.classList.contains('open');

                if (sidebarOpen) {
                    // Overlay at midway: minimize it, fit polygon, then the
                    // applyPolygonFit moveend handler will center on the pin
                    // and open the full popup once the fit animation completes.
                    clearHighlightedMarker();
                    setMarkerHighlighted(marker, true);
                    selectedPlaceIndex = index;
                    // Mark card active so it's highlighted when overlay reopens
                    document.querySelectorAll('.place-card').forEach(c => c.classList.remove('active'));
                    const card = document.getElementById(`place-card-${index}`);
                    if (card) card.classList.add('active');
                    closeSidebar();
                } else {
                    // Overlay is peeked or hidden: normal pin tap behavior
                    clearHighlightedMarker();
                    setMarkerHighlighted(marker, true);
                    _isChangingSelection = true;
                    marker.openPopup();
                    _isChangingSelection = false;
                    panToMarkerInView(marker);
                }
            } else {
                highlightPlace(index);
            }
        });
    });
}

function updateMarkers(places) {
    // Legacy function - now delegates to updateAllMarkers
    updateAllMarkers();
}

/**
 * Run a callback once the sidebar's CSS transform transition finishes.
 * Replaces magic setTimeout numbers — fires at the actual moment the
 * transition completes regardless of duration.
 */
function onSidebarTransitionEnd(callback) {
    const sidebar = document.getElementById('results-sidebar');
    if (!sidebar) return;
    const epoch = _clearEpoch;
    let fired = false;
    function handler(e) {
        if (e.propertyName !== 'transform') return;
        if (fired) return;
        fired = true;
        sidebar.removeEventListener('transitionend', handler);
        clearTimeout(fallback);
        if (_clearEpoch !== epoch) return;   // clearAll fired — skip stale callback
        callback();
    }
    sidebar.addEventListener('transitionend', handler);
    // Fallback: if transitionend never fires (e.g. transform didn't actually change,
    // or the transition was already complete before we registered).
    // Derive the timeout from the element's actual transition-duration so it always
    // fires AFTER the animation — no hardcoded magic number.
    const rawDur = getComputedStyle(sidebar).transitionDuration || '0s';
    const durMs = rawDur.split(',').reduce((max, s) => {
        const v = parseFloat(s);
        return Math.max(max, s.includes('ms') ? v : v * 1000);
    }, 0);
    const fallback = setTimeout(() => {
        if (fired) return;
        fired = true;
        sidebar.removeEventListener('transitionend', handler);
        if (_clearEpoch !== epoch) return;   // clearAll fired — skip stale callback
        callback();
    }, durMs + 50);   // +50ms buffer beyond the actual animation duration
}

function getVisibleContentViewport() {
    const content = document.querySelector('.sidebar-content');
    if (!content) return null;

    if (isMobileView()) {
        // On mobile, derive the visible area from the sidebar's screen
        // position + header height.  This avoids reading .sidebar-content's
        // bounding rect (which is affected by max-height) and eliminates the
        // need for a disruptive max-height reset before measuring.
        const sidebar = document.getElementById('results-sidebar');
        const header = document.querySelector('.sidebar-header');
        if (!sidebar || !header) return null;
        const sidebarRect = sidebar.getBoundingClientRect();
        const headerH = header.offsetHeight;
        const top = Math.max(sidebarRect.top + headerH, 0);
        const bottom = Math.min(sidebarRect.bottom, window.innerHeight);
        if (bottom <= top) return null;
        return { top, bottom, height: bottom - top, scrollEl: content };
    }

    // Desktop: content element's rect is reliable
    const rect = content.getBoundingClientRect();
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    if (bottom <= top) return null;
    return { top, bottom, height: bottom - top, scrollEl: content };
}

// Active rAF scroll animation ID — lets a new scroll cancel any in-progress one.
let _scrollAnimId = 0;

function centerCardInView(card, smooth) {
    if (!card) return;
    const vp = getVisibleContentViewport();
    if (!vp) return;

    const scrollEl = vp.scrollEl;

    // Card's position within the scroll container's content:
    //   (card screen top - scrollEl screen top) + scrollEl.scrollTop
    // This is correct regardless of the sidebar's CSS transform position
    // because both rects are measured in the same screen coordinate space,
    // so the sidebar translateY cancels out in the subtraction.
    const cardRect = card.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();
    const cardTopInContent = (cardRect.top - scrollRect.top) + scrollEl.scrollTop;
    const cardH = card.offsetHeight;

    const isExpanded = isMobileView() && document.body.classList.contains('results-expanded');

    let targetScrollTop;
    if (!isMobileView()) {
        // Desktop: align card to the top of the visible results area
        targetScrollTop = cardTopInContent;
    } else if (isExpanded) {
        // Mobile maximized: align card top to viewport top
        targetScrollTop = cardTopInContent;
    } else {
        // Mobile midway: center the card vertically in the visible area
        targetScrollTop = cardTopInContent - (vp.height / 2) + (cardH / 2);
    }

    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
    const finalTarget = Math.min(Math.max(0, targetScrollTop), maxScroll);

    console.log(`[centerCardInView] card=${card.id} smooth=${smooth} expanded=${isExpanded}`);
    console.log(`  scroll: scrollTop=${scrollEl.scrollTop.toFixed(1)} scrollHeight=${scrollEl.scrollHeight} clientHeight=${scrollEl.clientHeight} maxScroll=${maxScroll.toFixed(1)}`);
    console.log(`  card: rectTop=${cardRect.top.toFixed(1)} cardTopInContent=${cardTopInContent.toFixed(1)} cardH=${cardH}`);
    console.log(`  vp: top=${vp.top.toFixed(1)} height=${vp.height.toFixed(1)} maxHeight=${scrollEl.style.maxHeight}`);
    console.log(`  target: raw=${targetScrollTop.toFixed(1)} final=${finalTarget.toFixed(1)}`);

    if (!smooth) {
        scrollEl.scrollTop = finalTarget;
        return;
    }

    // ── rAF-based smooth scroll ──
    // Native scrollTo({ behavior:'smooth' }) is unreliable on mobile Safari
    // with -webkit-overflow-scrolling:touch — the browser's compositor can
    // cancel the animation when other layout work runs (map fly, popup DOM,
    // etc.).  A manual rAF loop gives us full control and can't be dropped.
    const startPos  = scrollEl.scrollTop;
    const distance  = finalTarget - startPos;
    if (Math.abs(distance) < 1) return;   // already there

    // Duration scales with distance: 200ms base + up to 200ms for long scrolls.
    // Max ≈ 400ms so it feels snappy, never sluggish.
    const duration = 200 + Math.min(200, Math.abs(distance) * 0.3);
    const startTime = performance.now();
    const animId = ++_scrollAnimId;         // cancel any previous animation

    function step(now) {
        if (animId !== _scrollAnimId) return;  // superseded by a newer scroll
        const elapsed  = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out cubic: fast start, gentle settle
        const eased = 1 - Math.pow(1 - progress, 3);
        scrollEl.scrollTop = startPos + distance * eased;
        if (progress < 1) {
            requestAnimationFrame(step);
        }
    }
    requestAnimationFrame(step);
}

function updateResultsSpacer() {
    const resultsList = document.getElementById('results-list');
    if (!resultsList) return;

    const content = document.querySelector('.sidebar-content');
    let spacer = resultsList.querySelector('.results-spacer-bottom');

    const vp = getVisibleContentViewport();
    const cards = resultsList.querySelectorAll('.place-card');

    if (!vp || cards.length === 0) {
        if (spacer) spacer.style.height = '0';
        return;
    }

    // On mobile, constrain the scroll container so content doesn't extend
    // below the screen fold.  In expanded mode, remove the constraint so
    // all cards are immediately available (no partial cropping).
    if (isMobileView() && content) {
        const isExp = document.body.classList.contains('results-expanded');
        content.style.maxHeight = isExp ? '' : vp.height + 'px';
    }

    if (!spacer) {
        spacer = document.createElement('div');
        spacer.className = 'results-spacer-bottom';
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.pointerEvents = 'none';
    }

    // Ensure spacer is the last child
    if (resultsList.lastElementChild !== spacer) {
        resultsList.appendChild(spacer);
    }

    // In expanded (maximized) mode the user is browsing a full-screen list
    // and selecting a card collapses to midway anyway, so only a small
    // safe-area spacer is needed.  In midway / desktop, use half the visible
    // viewport so the last card can scroll to center.
    const isExpanded = isMobileView() && document.body.classList.contains('results-expanded');
    const baseHeight = isExpanded ? 0 : Math.max(0, vp.height / 2);
    spacer.style.height = `calc(${baseHeight}px + env(safe-area-inset-bottom, 0px))`;
}

function recenterActiveCard() {
    updateResultsSpacer();
    const active = document.querySelector('.place-card.active');
    if (active) centerCardInView(active, true);
}

function highlightPlace(index) {
    console.log(`[highlightPlace] index=${index} caller=${new Error().stack.split('\n')[2]?.trim()}`);
    _isChangingSelection = true;
    selectedPlaceIndex = index;

    const collapsingFromExpanded = isMobileView()
        && document.body.classList.contains('results-expanded');

    // Calculate which page this index is on
    const targetPage = Math.floor(index / RESULTS_PER_PAGE);

    // If not on current page, switch to that page first
    if (targetPage !== currentDisplayOffset) {
        currentDisplayOffset = targetPage;
        displayResultsPage(currentDisplayOffset);
    }

    // Remove active class from all cards
    document.querySelectorAll('.place-card').forEach(card => {
        card.classList.remove('active');
    });

    // Add active class to selected card
    const selectedCard = document.getElementById(`place-card-${index}`);
    if (selectedCard) {
        selectedCard.classList.add('active');

        // Helper: open the marker popup and pan the map so the pin is centered
        // in the exposed canvas area (the part of the map not covered by the
        // toaster overlay).  Must only run when the sidebar is at its final
        // position so the exposed area can be measured correctly.
        const showMarker = () => {
            // Revert any previous green marker, then highlight the new one
            clearHighlightedMarker();
            const marker = markers.find(m => m.placeIndex === index);
            if (marker) {
                setMarkerHighlighted(marker, true);
                if (isMobileView()) {
                    const sidebar = document.getElementById('results-sidebar');
                    const isOpen = sidebar && sidebar.classList.contains('open');
                    const place = allSearchResults[index];
                    if (place) {
                        marker.setPopupContent(buildPopupContent(place, index, isOpen));
                    }
                }
                marker.openPopup();
                panToMarkerInView(marker);
            }
            _isChangingSelection = false;
        };

        if (collapsingFromExpanded) {
            // Collapse expanded → midway.  Track the card with rAF during
            // the CSS transition so it stays centered and never ducks out.
            document.body.classList.remove('results-expanded');
            if (fitStateResultsOpen) applyPolygonFit(fitStateResultsOpen);

            const card = selectedCard;
            let settled = false;

            function trackCard() {
                if (settled) return;
                centerCardInView(card, false);
                requestAnimationFrame(trackCard);
            }
            requestAnimationFrame(trackCard);

            // Wait for the sidebar to reach midway BEFORE opening the popup
            // and panning the pin.  We can't calculate the exposed canvas area
            // until the sidebar is at its final midway position.
            onSidebarTransitionEnd(() => {
                settled = true;
                updateResultsSpacer();
                centerCardInView(card, false);
                showMarker();
            });
        } else {
            updateResultsSpacer();
            centerCardInView(selectedCard, true);
            showMarker();
        }
    } else {
        _isChangingSelection = false;
    }
}
// Address Search using OpenStreetMap Nominatim
// =============================================================================

// Track last search time to enforce rate limiting
let lastSearchTime = 0;
const MIN_SEARCH_INTERVAL = 1000; // 1 second between searches

async function searchAddress() {
    const input = document.getElementById('address-input');
    const address = input.value.trim();

    if (!address) return;

    // Enforce rate limiting
    const now = Date.now();
    const timeSinceLastSearch = now - lastSearchTime;
    if (timeSinceLastSearch < MIN_SEARCH_INTERVAL) {
        const waitTime = MIN_SEARCH_INTERVAL - timeSinceLastSearch;
        updateStatus(`Please wait ${Math.ceil(waitTime/1000)}s before searching again...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastSearchTime = Date.now();

    updateStatus('Searching for address...', true);

    // Try Nominatim first
    let result = await tryNominatim(address);

    // If Nominatim fails, try Photon
    if (!result) {
        updateStatus('Trying alternative geocoder...');
        result = await tryPhoton(address);
    }

    if (result) {
        displayGeocodeResult(result, address);
    } else {
        updateStatus('Address search failed');
        alert('Could not find that address. The geocoding services may be busy. Try again in a few seconds, or be more specific (e.g., "123 Main St, New York, NY").');
    }
}

async function tryNominatim(address) {
    const params = new URLSearchParams({
        q: address,
        format: 'json',
        limit: '5',
        addressdetails: '1',
        namedetails: '1',
        'accept-language': 'en'
    });

    // Don't use viewbox bias - it causes wrong results when searching specific addresses
    // Just search globally for the exact address

    try {
        const response = await fetch(`${NOMINATIM_URL}/search?${params.toString()}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'LASO-Search-App/1.0'
            }
        });

        if (!response.ok) {
            console.warn('Nominatim failed:', response.status);
            return null;
        }

        const data = await response.json();
        return data && data.length > 0 ? data[0] : null;
    } catch (error) {
        console.warn('Nominatim error:', error);
        return null;
    }
}

async function tryPhoton(address) {
    // Photon uses different parameter structure
    const params = new URLSearchParams({
        q: address,
        limit: '5',
        lang: 'en'
    });

    // DON'T add location bias - it causes wrong results
    // Just search for the exact address as typed

    try {
        const response = await fetch(`${PHOTON_URL}?${params.toString()}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            console.warn('Photon failed:', response.status);
            return null;
        }

        const data = await response.json();

        // Photon returns features array
        if (data && data.features && data.features.length > 0) {
            const feature = data.features[0];
            const props = feature.properties;
            const coords = feature.geometry.coordinates;

            // Convert Photon format to match Nominatim format
            return {
                lat: coords[1],
                lon: coords[0],
                display_name: props.name || address,
                name: props.name,
                address: {
                    house_number: props.housenumber,
                    road: props.street,
                    city: props.city,
                    town: props.district,
                    village: props.district,
                    state: props.state,
                    postcode: props.postcode
                }
            };
        }
        return null;
    } catch (error) {
        console.warn('Photon error:', error);
        return null;
    }
}

function displayGeocodeResult(result, searchQuery) {
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);

    // Build address from addressdetails if available
    let displayAddress = result.display_name;
    if (result.address) {
        const addr = result.address;
        const parts = [];
        if (addr.house_number) parts.push(addr.house_number);
        if (addr.road) parts.push(addr.road);
        if (addr.city || addr.town || addr.village) parts.push(addr.city || addr.town || addr.village);
        if (addr.state) parts.push(addr.state);
        if (parts.length > 0) {
            displayAddress = parts.join(', ');
        }
    }

    // Add a marker for the searched address
    const marker = L.marker([lat, lon], {
        icon: L.divIcon({
            className: 'search-marker',
            html: '<i class="fas fa-map-pin" style="color: #ea4335; font-size: 32px;"></i>',
            iconSize: [32, 32],
            iconAnchor: [16, 32]
        })
    }).addTo(map);

    marker.bindPopup(`<b>${result.name || searchQuery}</b><br>${displayAddress}`);
    markers.push(marker);

    // Fly to address at target display level (PC: 3, mobile: 2)
    const targetZoom = initialZoom + (isMobileView() ? 2 : 3);
    isLocationSearchZoom = true;
    map.flyTo([lat, lon], targetZoom, { duration: 1.0 });
    const epochAtSearch = _clearEpoch;
    map.once('moveend', () => {
        isLocationSearchZoom = false;
        currentZoomLevel = map.getZoom() - initialZoom;
        updateZoomLevelIndicator();
        updateDrawButtonState();
        if (_clearEpoch !== epochAtSearch) return;   // clearAll fired during fly
        if (!map.hasLayer(marker)) return;
        marker.openPopup();
    });

    updateStatus(`Found: ${result.name || result.display_name.split(',')[0]}`);

    // Save search pin coordinates for priority sorting
    searchPinCoords = [lat, lon];
}

// =============================================================================
// UI Helpers
// =============================================================================

function setupEventListeners() {
    // Drawing toggle
    document.getElementById('drawing-toggle').addEventListener('click', toggleDrawingMode);

    const drawWrapper = document.getElementById('draw-btn-wrapper');
    const drawBtn = document.getElementById('drawing-toggle');
    if (drawWrapper && drawBtn) {
        // Ensure the draw button never stays visually "stuck" after tap on mobile.
        drawBtn.addEventListener('touchend', () => {
            drawBtn.classList.remove('pressed');
            if (typeof drawBtn.blur === 'function') drawBtn.blur();
        }, { passive: true });

        drawBtn.addEventListener('pointerup', () => {
            drawBtn.classList.remove('pressed');
            if (typeof drawBtn.blur === 'function') drawBtn.blur();
        }, { passive: true });

        // Capture-phase touchstart for tooltip close button — iOS may render
        // native form controls above the tooltip despite z-index, so we check
        // touch coordinates against the close button's bounding rect directly.
        document.addEventListener('touchstart', function(e) {
            if (!drawWrapper.classList.contains('tooltip-visible')) return;
            const closeBtn = document.querySelector('.draw-tooltip-close');
            if (!closeBtn) return;
            const touch = e.touches[0];
            if (!touch) return;
            const rect = closeBtn.getBoundingClientRect();
            if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
                touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
                e.preventDefault();
                e.stopImmediatePropagation();
                drawWrapper.classList.remove('tooltip-visible');
            }
        }, true);

        // touchstart fires even on disabled buttons (unlike click on mobile
        // Safari), so use it to clear the dismissed state for the next tap.
        drawWrapper.addEventListener('touchstart', () => {
            if (!drawBtn.disabled) return;
            if (drawWrapper.classList.contains('tooltip-dismissed')) {
                drawWrapper.classList.remove('tooltip-dismissed');
            }
        }, { passive: true });

        const showIfDisabled = (e) => {
            if (!drawBtn.disabled) return;
            drawWrapper.classList.remove('tooltip-dismissed');
            drawWrapper.classList.add('tooltip-visible');
        };

        const hide = () => {
            drawWrapper.classList.remove('tooltip-visible');
        };

        // Desktop hover is handled by CSS. Mobile: tap toggles tooltip.
        // Skip clicks on the draw button itself — toggleDrawingMode handles those.
        drawWrapper.addEventListener('click', (e) => {
            if (!drawBtn.disabled) return;
            if (e.target === drawBtn || drawBtn.contains(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            if (drawWrapper.classList.contains('tooltip-visible')) hide();
            else showIfDisabled(e);
        });

        // Hide tooltip when tapping elsewhere
        document.addEventListener('click', (e) => {
            if (!drawBtn.disabled) return;
            if (e.target && (e.target === drawWrapper || drawWrapper.contains(e.target))) return;
            hide();
        });

    }

    // Cancel drawing
    document.getElementById('cancel-drawing').addEventListener('click', () => {
        disableDrawingMode();
    });

    // LASO Search
    document.getElementById('lasosearch-btn').addEventListener('click', performLasoSearch);

    // Clear
    document.getElementById('clear-btn').addEventListener('click', clearAll);

    // Address search
    document.getElementById('search-btn').addEventListener('click', searchAddress);
    document.getElementById('address-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchAddress();
        }
    });

    // Sidebar close
    document.getElementById('close-sidebar').addEventListener('click', closeSidebar);

    // Map button delegation — works for all dynamically rendered cards.
    // Clicking a map button on an unselected card: select the card first, then open the link.
    // Clicking a map button on the already-selected card: open the link immediately.
    // The <a> href is pre-set to the correct deep-link or web URL at card creation
    // time so the browser follows it as a direct user gesture.  No JS-initiated
    // window.location or window.open — this avoids Safari's "repeatedly trying to
    // open another application" dialog.
    document.getElementById('results-list').addEventListener('click', (e) => {
        const btn = e.target.closest('.map-btn');
        if (!btn) return;
        e.stopPropagation(); // don't also fire the card click handler
        const cardIndex = parseInt(btn.dataset.cardIndex, 10);
        const card = document.getElementById(`place-card-${cardIndex}`);
        const isAlreadySelected = card && card.classList.contains('active');
        if (!isAlreadySelected) {
            highlightPlace(cardIndex);
        }
        // Let the <a> tag's default navigation proceed — no preventDefault.
    }, true); // capture phase so it fires before card's own click handler

    // Mobile: tap sidebar header first row to toggle sheet open/peeked
    // Excludes clicks on filter-sort-controls (second row) so they remain interactive
    document.querySelector('.sidebar-header').addEventListener('click', (e) => {
        if (!isMobileView()) return;
        if (e.target.closest('.filter-sort-controls')) return;
        if (e.target.closest('.close-btn')) return;
        toggleMobileSheet();
    });

    // Mobile: drag gesture on sidebar header to expand/collapse bottom sheet
    setupSheetDragGesture();

    // Mobile: tap outside results sheet (on map) to collapse to peek.
    // Ignore clicks on Leaflet popups so closing a popup info box
    // doesn't also minimize the toaster.
    document.getElementById('map').addEventListener('click', (e) => {
        if (!isMobileView()) return;
        if (e.target.closest('.leaflet-popup')) return;
        const sidebar = document.getElementById('results-sidebar');
        if (sidebar.classList.contains('open')) {
            closeSidebar();
        }
    });

    // Mobile: swap popup content (simplified vs full) based on sidebar state,
    // and attach tap-to-open-sidebar handler.  Handler is on the popup DOM
    // element (not inner content) so it survives content swaps.
    map.on('popupopen', (e) => {
        if (!isMobileView()) return;
        const popupDom = e.popup.getElement();
        if (!popupDom) return;

        // Swap content based on sidebar state
        const mp = popupDom.querySelector('.marker-popup');
        if (mp) {
            const idx = parseInt(mp.dataset.placeIndex, 10);
            if (!isNaN(idx)) {
                const sidebar = document.getElementById('results-sidebar');
                const isOpen = sidebar && sidebar.classList.contains('open');
                const place = allSearchResults[idx];
                if (place) {
                    e.popup.setContent(buildPopupContent(place, idx, isOpen));
                }
            }
        }

        // Attach handler once per popup DOM element (persists through setContent)
        if (!popupDom._popupTapHandler) {
            popupDom._popupTapHandler = true;

            const tapHandler = (evt) => {
                if (evt.target.closest('a')) return; // let links work
                const content = popupDom.querySelector('.marker-popup');
                if (!content) return;
                const idx = parseInt(content.dataset.placeIndex, 10);
                if (isNaN(idx)) return;
                const sidebar = document.getElementById('results-sidebar');
                if (!sidebar.classList.contains('open')) {
                    // Open sidebar — openSidebar() detects the open popup and
                    // auto-highlights the card after the transition settles.
                    openSidebar();
                } else {
                    highlightPlace(idx);
                }
            };
            popupDom.addEventListener('click', tapHandler);
            popupDom.addEventListener('touchend', (evt) => {
                if (evt.target.closest('a')) return;
                evt.preventDefault();
                // Stop the touchend from bubbling to Leaflet's Tap handler,
                // which would generate a synthetic click ~200ms later.  That
                // click would call tapHandler a second time mid-transition,
                // causing highlightPlace to run with wrong layout measurements.
                evt.stopPropagation();
                tapHandler(evt);
            });
        }
    });

    const placeFilterInput = document.getElementById('place-filter');
    const filterControls = document.querySelector('.filter-sort-controls');
    const sortSelect = document.getElementById('sort-select');
    const clearFiltersBtn = document.getElementById('clear-filters-btn');

    // On mobile, disable the datalist dropdown UI (it shows a big list when tapping the
    // right edge of the input). Keep the datalist in DOM for desktop and future use.
    if (placeFilterInput && isMobileView()) {
        if (!placeFilterInput.dataset.listId && placeFilterInput.getAttribute('list')) {
            placeFilterInput.dataset.listId = placeFilterInput.getAttribute('list');
        }
        placeFilterInput.removeAttribute('list');
    }

    const blurIfFocused = (el) => {
        if (!el) return;
        if (document.activeElement === el) el.blur();
    };

    // Tap anywhere outside filter controls to dismiss focus.
    document.addEventListener('pointerdown', (e) => {
        const inFilters = e.target && e.target.closest && e.target.closest('.filter-sort-controls');
        if (inFilters) return;
        blurIfFocused(placeFilterInput);
    }, { passive: true });

    // On mobile, tapping the filter bar (except sort/clear) should focus the input.
    if (filterControls && placeFilterInput) {
        filterControls.addEventListener('pointerdown', (e) => {
            if (!isMobileView()) return;
            if (e.target && (e.target.closest('select') || e.target.closest('button'))) return;
            // Keep normal interactions if the user actually tapped the input.
            if (e.target === placeFilterInput) return;
            e.preventDefault();
            placeFilterInput.focus();
            // Put cursor at end for quick editing.
            const len = placeFilterInput.value.length;
            try { placeFilterInput.setSelectionRange(len, len); } catch (_) { /* ignore */ }
        }, { passive: false });
    }

    if (placeFilterInput) {
        placeFilterInput.addEventListener('input', () => {
            activePlaceFilters = parsePlaceFiltersFromInput(placeFilterInput.value);
            if (unfilteredSearchResults.length > 0) {
                applyFiltersAndSort({ resetToFirstPage: true });
            }
        });

        placeFilterInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                blurIfFocused(placeFilterInput);
            }
        });

        // Selecting from datalist commonly triggers 'change'
        placeFilterInput.addEventListener('change', () => {
            blurIfFocused(placeFilterInput);
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            activeSortMode = sortSelect.value || 'distance';
            if (unfilteredSearchResults.length > 0) {
                applyFiltersAndSort({ resetToFirstPage: true });
            }
        });
    }

    if (clearFiltersBtn) {
        clearFiltersBtn.addEventListener('click', () => {
            activePlaceFilters = [];
            if (placeFilterInput) placeFilterInput.value = '';
            if (unfilteredSearchResults.length > 0) {
                applyFiltersAndSort({ resetToFirstPage: true });
            }
        });
    }
}

// =============================================================================
// Mobile Touch Continuity (newsway-style drag-and-hold between buttons)
// =============================================================================
function setupMobileTouchContinuity() {
    if (!isMobileView()) return;

    const PRESSABLE_SEL = '.header-actions > .btn, .header-actions > .draw-btn-wrapper > .btn, .search-btn, .filter-sort-controls #clear-filters-btn';
    let pressableButtons = Array.from(document.querySelectorAll(PRESSABLE_SEL));
    let currentPressedButton = null;
    let startButton = null;
    let isDragging = false;

    const resetAllButtons = () => {
        pressableButtons.forEach(btn => btn.classList.remove('pressed'));
        currentPressedButton = null;
    };

    const pressButton = (button) => {
        resetAllButtons();
        if (button && pressableButtons.includes(button)) {
            button.classList.add('pressed');
            currentPressedButton = button;
        }
    };

    const addListenersToButtons = () => {
        pressableButtons.forEach(btn => {
            // Remove old listeners if any
            if (btn._tchStart) btn.removeEventListener('touchstart', btn._tchStart);
            if (btn._tchEnd) btn.removeEventListener('touchend', btn._tchEnd);
            if (btn._tchCancel) btn.removeEventListener('touchcancel', btn._tchCancel);

            btn._tchStart = function(e) {
                e.preventDefault();
                isDragging = true;
                startButton = this;
                pressButton(this);
            };

            btn._tchEnd = function(e) {
                e.preventDefault();

                if (isDragging && startButton) {
                    const touch = e.changedTouches[0];
                    const elementUnder = document.elementFromPoint(touch.clientX, touch.clientY);
                    const endButton = elementUnder?.closest(PRESSABLE_SEL);

                    resetAllButtons();
                    isDragging = false;

                    if (endButton && pressableButtons.includes(endButton)) {
                        setTimeout(() => {
                            endButton.click();
                            endButton.blur();
                        }, 50);
                    }

                    currentPressedButton = null;
                    startButton = null;
                }
            };

            btn._tchCancel = function(e) {
                e.preventDefault();
                resetAllButtons();
                isDragging = false;
                currentPressedButton = null;
                startButton = null;
            };

            btn.addEventListener('touchstart', btn._tchStart, { passive: false });
            btn.addEventListener('touchend', btn._tchEnd, { passive: false });
            btn.addEventListener('touchcancel', btn._tchCancel, { passive: false });
        });
    };

    addListenersToButtons();

    // Document-level touchmove for seamless button switching
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const touch = e.touches[0];
        const elUnder = document.elementFromPoint(touch.clientX, touch.clientY);
        const buttonUnder = elUnder?.closest(PRESSABLE_SEL);

        if (buttonUnder !== currentPressedButton) {
            if (buttonUnder && pressableButtons.includes(buttonUnder)) {
                pressButton(buttonUnder);
            } else {
                resetAllButtons();
            }
        }
    }, { passive: true });

    // Ensure pressed state never gets stuck (some mobile browsers can miss touchend on the button).
    const clearPressedOnDoc = () => {
        resetAllButtons();
        isDragging = false;
        startButton = null;
    };
    document.addEventListener('touchend', clearPressedOnDoc, { passive: true });
    document.addEventListener('touchcancel', clearPressedOnDoc, { passive: true });

    // Re-scan buttons after DOM changes (filters fold/unfold)
    window._refreshMobileTouchButtons = () => {
        pressableButtons = Array.from(document.querySelectorAll(PRESSABLE_SEL));
        addListenersToButtons();
    };
}

function clearAll() {
    // ── 1. Increment epoch FIRST.  Every deferred callback (moveend,
    //       transitionend, etc.) that captured the previous epoch will
    //       bail out immediately — even if map.stop() fires them synchronously.
    _clearEpoch++;
    const epoch = _clearEpoch;
    console.log(`[clearAll] epoch=${epoch} — begin`);

    const prevSelected = selectedPlaceIndex;
    const prevHighlighted = _highlightedMarkerIndex;
    selectedPlaceIndex = null;
    _highlightedMarkerIndex = null;
    searchPinCoords = null;
    isAutoFittingPolygon = false;

    // ── 2. Remove all tracked markers BEFORE map.stop() so that any
    //       synchronously-fired moveend handlers see hasLayer() === false.
    console.log(`[clearAll] Removing ${markers.length} tracked markers (prevSelected=${prevSelected}, prevHighlighted=${prevHighlighted})`);
    markers.forEach((marker, i) => {
        const ll = marker.getLatLng();
        const onMap = map.hasLayer(marker);
        const zOff = marker.options.zIndexOffset || 0;
        console.log(`  [clearAll] marker[${i}] placeIndex=${marker.placeIndex} lat=${ll.lat.toFixed(5)} lng=${ll.lng.toFixed(5)} onMap=${onMap} zIndexOffset=${zOff} isDrawingPoint=${!!marker.isDrawingPoint}`);
        if (onMap) map.removeLayer(marker);
    });
    markers = [];

    // ── 3. Close any open popup BEFORE map.stop() — prevents moveend
    //       handlers from finding an existing popup to piggyback on.
    _isChangingSelection = true;
    map.closePopup();
    _isChangingSelection = false;

    // ── 4. Cancel any in-progress fly/pan animations.  moveend handlers
    //       fire synchronously here but:
    //       (a) epoch is already bumped → deferred callbacks bail out
    //       (b) markers are already removed → hasLayer checks fail
    //       (c) popup is already closed → no popup to reopen on
    map.stop();

    // Remove polygon
    removeCurrentPolygon();

    // ── 5. Nuclear sweep: remove ANY stray Marker or Popup layers.
    //       Previous sweep missed L.Popup — that was the actual lingering artifact.
    const strayLayers = [];
    map.eachLayer((layer) => {
        if (layer instanceof L.Marker || layer instanceof L.Popup) {
            strayLayers.push(layer);
        }
    });
    if (strayLayers.length > 0) {
        console.warn(`[clearAll] Found ${strayLayers.length} STRAY layer(s) after cleanup — removing:`);
        strayLayers.forEach((layer, i) => {
            const type = layer instanceof L.Popup ? 'Popup' : 'Marker';
            if (layer instanceof L.Marker) {
                const ll = layer.getLatLng();
                console.warn(`  stray[${i}] ${type} lat=${ll.lat.toFixed(5)} lng=${ll.lng.toFixed(5)} className=${layer.options.icon?.options?.className || '?'}`);
            } else {
                console.warn(`  stray[${i}] ${type} content=${(layer.getContent?.() || '').toString().slice(0, 80)}`);
            }
            map.removeLayer(layer);
        });
    } else {
        console.log('[clearAll] No stray layers found ✓');
    }

    // Clear drawing points
    drawingPoints = [];

    // Clear results
    searchResults = [];
    unfilteredSearchResults = [];
    allSearchResults = [];
    currentDisplayOffset = 0;
    const resultsList = document.getElementById('results-list');
    resultsList.innerHTML = getDefaultEmptyStateHTML();
    document.getElementById('result-count').textContent = '0';

    const placeFilterInput = document.getElementById('place-filter');
    if (placeFilterInput) placeFilterInput.value = '';
    activePlaceFilters = [];
    activeSortMode = 'distance';
    lastPriorityCenter = null;
    syncFilterSortUIState();
    isFitZoom = false;
    fitZoomValue = null;
    drawingZoom = null;
    fitStateResultsOpen = null;
    fitStateLipPeeked = null;
    activeFitState = null;

    // Remove first-time shimmer if still showing
    const lasoBtnClear = document.getElementById('lasosearch-btn');
    if (lasoBtnClear) lasoBtnClear.classList.remove('shimmer');

    // Snap zoom to nearest integer (cleans up fractional fit-zoom)
    const currentZ = map.getZoom();
    if (!Number.isInteger(currentZ)) {
        _buttonZoomPending = true;
        map.setZoom(Math.round(currentZ), { animate: true });
    } else {
        // Zoom is already integer — ensure indicator is visible
        isPinchZoom = false;
        updateZoomLevelIndicator();
    }

    // Clear scroll-container constraint
    const content = document.querySelector('.sidebar-content');
    if (content) content.style.maxHeight = '';

    // Fully hide sidebar (not just peek)
    document.body.classList.remove('results-peeked');
    document.body.classList.remove('results-expanded');
    const sidebar = document.getElementById('results-sidebar');
    sidebar.classList.remove('open');
    document.body.classList.remove('results-open');

    // Reset status
    updateStatus('Ready');
}

function isMobileView() {
    return document.body.classList.contains('is-mobile');
}

function openSidebar() {
    const sidebar = document.getElementById('results-sidebar');
    sidebar.classList.add('open');
    document.body.classList.add('results-open');
    document.body.classList.remove('results-expanded');
    if (isMobileView()) {
        // Detect if a pin popup is currently open (user tapped a pin in peeked state)
        // or if there's a green highlighted marker from a previous minimize.
        // Capture the index BEFORE applyPolygonFit (which may close the popup via zoomstart).
        let pendingHighlightIdx = null;
        if (_highlightedMarkerIndex !== null) {
            // Green marker showing — re-select that card
            pendingHighlightIdx = _highlightedMarkerIndex;
        } else {
            // Check for an open popup on the map
            const openPopup = document.querySelector('.leaflet-popup .marker-popup');
            if (openPopup) {
                const idx = parseInt(openPopup.dataset.placeIndex, 10);
                if (!isNaN(idx)) pendingHighlightIdx = idx;
            }
        }

        map.invalidateSize({ animate: false });

        // Set sidebar height to map canvas height so translateY(50%) = exactly half the map
        const mapEl = document.getElementById('map');
        if (mapEl) {
            sidebar.style.height = mapEl.offsetHeight + 'px';
        }
        document.body.classList.add('results-peeked');

        // Apply results-open fit when re-opening from lip.  Skip if a fly
        // animation is already in progress (e.g. called right after performLasoSearch).
        if (fitStateResultsOpen && !isAutoFittingPolygon) {
            applyPolygonFit(fitStateResultsOpen);
        }

        // After the sidebar reaches midway, highlight the pending card so the
        // pin centers in the exposed canvas area with its abbreviated popup.
        if (pendingHighlightIdx !== null) {
            onSidebarTransitionEnd(() => highlightPlace(pendingHighlightIdx));
        } else {
            // Recalculate spacers after the toaster transition settles
            onSidebarTransitionEnd(updateResultsSpacer);
        }
    }
}

function closeSidebar() {
    const sidebar = document.getElementById('results-sidebar');
    document.body.classList.remove('results-expanded');
    if (isMobileView() && allSearchResults.length > 0) {
        sidebar.classList.remove('open');
        document.body.classList.remove('results-open');
        document.body.classList.add('results-peeked');
        map.invalidateSize({ animate: false });

        // Close popup — the selected pin is already green+large from selection,
        // so it stays visible as a guide without the info box cluttering the map.
        if (selectedPlaceIndex !== null) {
            _isChangingSelection = true;
            map.closePopup();
            _isChangingSelection = false;
        }

        // When a pin is selected, compute ONE flyTo that uses the lip-peeked
        // zoom level but centers the green pin in the exposed canvas (above the
        // 52px lip).  This avoids the two-step fit → pan visual jolt.
        if (fitStateLipPeeked && selectedPlaceIndex !== null && markers.length > 0) {
            const selectedMarker = markers.find(m => m.placeIndex === selectedPlaceIndex);
            if (selectedMarker && map.hasLayer(selectedMarker)) {
                const targetZoom = fitStateLipPeeked.zoom;
                const pinLatLng = selectedMarker.getLatLng();
                const mapEl = document.getElementById('map');
                const mapH = mapEl ? mapEl.offsetHeight : map.getSize().y;
                // Exposed canvas = map height minus the lip.
                // Its visual center is (mapH - TOASTER_LIP_HEIGHT) / 2 from top.
                // Map center is mapH / 2 from top.
                // Shift = mapCenter - exposedCenter = TOASTER_LIP_HEIGHT / 2
                const offsetY = TOASTER_LIP_HEIGHT / 2;
                // Project pin at target zoom, shift down so pin lands at
                // the center of the exposed canvas, then unproject.
                const pinPoint = map.project(pinLatLng, targetZoom);
                const mapCenter = map.unproject(
                    L.point(pinPoint.x, pinPoint.y + offsetY),
                    targetZoom
                );
                map.stop();
                isAutoFittingPolygon = true;
                activeFitState = fitStateLipPeeked;
                map.flyTo(mapCenter, targetZoom, { duration: 0.5 });
                const epoch = _clearEpoch;
                map.once('moveend', () => {
                    isAutoFittingPolygon = false;
                    if (_clearEpoch !== epoch) return;   // clearAll fired — don't resurrect popup
                    // Open the infobox for the selected pin after the fly completes
                    if (map.hasLayer(selectedMarker)) {
                        _isChangingSelection = true;
                        selectedMarker.openPopup();
                        _isChangingSelection = false;
                    }
                });
                return;
            }
        }

        if (fitStateLipPeeked) {
            applyPolygonFit(fitStateLipPeeked);
        }
    } else {
        sidebar.classList.remove('open');
        document.body.classList.remove('results-open');
        document.body.classList.remove('results-peeked');
    }
}

function toggleMobileSheet() {
    if (!isMobileView()) return;
    const sidebar = document.getElementById('results-sidebar');
    const isExpanded = document.body.classList.contains('results-expanded');
    if (isExpanded) {
        // From fully expanded → go to mid-point (half-open), not close
        document.body.classList.remove('results-expanded');
        if (fitStateResultsOpen) applyPolygonFit(fitStateResultsOpen);
        onSidebarTransitionEnd(updateResultsSpacer);
    } else if (sidebar.classList.contains('open')) {
        closeSidebar();
    } else {
        openSidebar();
    }
}

function setupSheetDragGesture() {
    const header = document.querySelector('.sidebar-header');
    const sidebar = document.getElementById('results-sidebar');
    if (!header || !sidebar) return;

    // Spring-like easing curve (matches the CSS on .results-sidebar)
    const SPRING_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

    let startY = 0;
    let currentY = 0;
    let dragging = false;
    let baseTranslate = 0;               // computed once on touchstart

    // Ring buffer of the last few touch samples for release-velocity calculation.
    // Using recent samples (not start-to-end) gives the *instantaneous* flick speed
    // the finger had when it lifted — this is what makes flick detection feel right.
    const SAMPLE_COUNT = 5;
    let samples = [];                     // { y, t }[]

    header.addEventListener('touchstart', (e) => {
        if (!isMobileView()) return;
        if (e.target.closest('.filter-sort-controls')) return;
        dragging = true;
        startY = e.touches[0].clientY;
        currentY = startY;
        samples = [{ y: startY, t: Date.now() }];

        // Snapshot the logical base position once so touchmove is a pure offset
        const sidebarHeight = sidebar.offsetHeight;
        const isOpen = sidebar.classList.contains('open');
        const isExpanded = document.body.classList.contains('results-expanded');
        if (isOpen && isExpanded)  baseTranslate = 0;
        else if (isOpen)           baseTranslate = sidebarHeight * 0.5;
        else                       baseTranslate = sidebarHeight - 52;

        sidebar.style.transition = 'none';
    }, { passive: true });

    header.addEventListener('touchmove', (e) => {
        if (!dragging || !isMobileView()) return;
        currentY = e.touches[0].clientY;
        samples.push({ y: currentY, t: Date.now() });
        if (samples.length > SAMPLE_COUNT) samples.shift();

        const deltaY = currentY - startY;
        const sidebarHeight = sidebar.offsetHeight;
        const raw = baseTranslate + deltaY;

        // Rubber-band: if dragged above fully-expanded (raw < 0), apply dampening
        // so it feels like pulling against resistance instead of a hard stop.
        let newTranslate;
        if (raw < 0) {
            newTranslate = -Math.pow(Math.abs(raw), 0.7);
        } else {
            newTranslate = Math.min(sidebarHeight, raw);
        }
        sidebar.style.transform = `translateY(${newTranslate}px)`;
    }, { passive: true });

    header.addEventListener('touchend', () => {
        if (!dragging || !isMobileView()) return;
        dragging = false;

        // --- Compute release velocity & acceleration from recent samples ---
        const now = Date.now();
        samples.push({ y: currentY, t: now });
        if (samples.length > SAMPLE_COUNT) samples.shift();

        let velocity = 0;     // px/ms, signed (negative = up)
        let isAccelerating = false;
        if (samples.length >= 2) {
            const first = samples[0];
            const last  = samples[samples.length - 1];
            const dt = last.t - first.t;
            if (dt > 0) velocity = (last.y - first.y) / dt;
        }
        // Acceleration: compare velocity of the first half vs second half of samples.
        // If the second half is faster in the same direction, the finger is accelerating.
        if (samples.length >= 4) {
            const mid = Math.floor(samples.length / 2);
            const dtA = samples[mid].t - samples[0].t;
            const dtB = samples[samples.length - 1].t - samples[mid].t;
            if (dtA > 0 && dtB > 0) {
                const vA = (samples[mid].y - samples[0].y) / dtA;
                const vB = (samples[samples.length - 1].y - samples[mid].y) / dtB;
                // Accelerating = second half is faster in the same direction as overall
                if (velocity < 0) isAccelerating = vB < vA;   // upward: more negative = faster
                else              isAccelerating = vB > vA;    // downward: more positive = faster
            }
        }

        const sidebarHeight = sidebar.offsetHeight;
        const deltaY = currentY - startY;

        // Three snap positions (translateY px values)
        const posExpanded = 0;
        const posHalfOpen = sidebarHeight * 0.5;
        const posPeeked   = sidebarHeight - 52;

        const isOpen     = sidebar.classList.contains('open');
        const isExpanded = document.body.classList.contains('results-expanded');

        // Where the finger currently is (clamped to valid range)
        const currentPos = Math.max(posExpanded, Math.min(posPeeked, baseTranslate + deltaY));

        const absVelocity = Math.abs(velocity);
        const isFlick       = absVelocity > 0.45;  // moderate flick — stops at center
        const isStrongFlick = absVelocity > 1.5     // very fast swipe — skips center
                           || (absVelocity > 0.7 && isAccelerating);  // fast + accelerating
        const direction = deltaY < 0 ? 'up' : deltaY > 0 ? 'down' : null;

        // Zone thresholds (wide center band around the midway at 50%):
        //   Upper 30% (pos < 30%)           → expanded
        //   30%–70%  center zone             → half-open
        //   Lower 30% (pos > 70%)           → peeked
        const expandedThreshold = sidebarHeight * 0.3;
        const peekedThreshold   = sidebarHeight * 0.7;

        // Determine which stop the user started from
        let startStopId;
        if (isOpen && isExpanded) startStopId = 'expanded';
        else if (isOpen)          startStopId = 'half-open';
        else                      startStopId = 'peeked';

        let targetId;
        if (!direction) {
            // No meaningful movement — stay put
            targetId = startStopId;
        } else if (direction === 'up') {
            if (isStrongFlick) {
                // Fast / accelerating swipe up from peeked → stop at half-open first
                // so pin-centering detection can run.  From half-open, go to expanded.
                targetId = (startStopId === 'peeked') ? 'half-open' : 'expanded';
            } else if (isFlick) {
                if (startStopId === 'half-open') {
                    targetId = 'expanded';
                } else if (currentPos < expandedThreshold) {
                    targetId = 'expanded';
                } else {
                    targetId = 'half-open';
                }
            } else {
                // Slow drag up — zone-based
                targetId = currentPos < expandedThreshold ? 'expanded' : 'half-open';
            }
        } else {
            // direction === 'down'
            if (isStrongFlick) {
                // Fast / accelerating swipe down → skip center, go to peeked
                targetId = 'peeked';
            } else if (isFlick) {
                if (startStopId === 'half-open') {
                    targetId = 'peeked';
                } else if (currentPos > peekedThreshold) {
                    targetId = 'peeked';
                } else {
                    targetId = 'half-open';
                }
            } else {
                // Slow drag down — zone-based (mirror of upward logic)
                targetId = currentPos > peekedThreshold ? 'peeked' : 'half-open';
            }
        }

        // --- Compute distance-adaptive snap duration ---
        const targetPos = targetId === 'expanded' ? posExpanded
                        : targetId === 'half-open' ? posHalfOpen
                        : posPeeked;
        const distance   = Math.abs(currentPos - targetPos);
        const maxDist    = posPeeked; // max possible travel
        // Range: 0.2s (short snap) → 0.45s (full traverse). Never too slow, never instant.
        const duration   = 0.2 + 0.25 * Math.min(1, distance / maxDist);

        // Set the snap-back transition with computed duration + spring easing
        sidebar.style.transition = `transform ${duration.toFixed(3)}s ${SPRING_EASE}`;

        // --- Apply target state ---
        // CSS classes change immediately so the toaster animates to position.
        // Map zoom/fit is also immediate (snappy).
        let snapCleanupRegistered = false;  // set true when highlight+cleanup merged
        if (targetId === 'expanded') {
            // Maximized — NO zoom change; leave map as-is.
            if (!isOpen) {
                sidebar.classList.add('open');
                document.body.classList.add('results-open');
                document.body.classList.add('results-peeked');
                const mapEl = document.getElementById('map');
                if (mapEl) sidebar.style.height = mapEl.offsetHeight + 'px';
            }
            document.body.classList.add('results-expanded');
            updateResultsSpacer();   // clear max-height immediately so cards aren't cropped
        } else if (targetId === 'half-open') {
            if (isExpanded) {
                document.body.classList.remove('results-expanded');
                if (fitStateResultsOpen) applyPolygonFit(fitStateResultsOpen);
            } else if (!isOpen) {
                // Detect open popup or green marker BEFORE applyPolygonFit closes it
                let dragHighlightIdx = null;
                if (_highlightedMarkerIndex !== null) {
                    dragHighlightIdx = _highlightedMarkerIndex;
                } else {
                    const openPopup = document.querySelector('.leaflet-popup .marker-popup');
                    if (openPopup) {
                        const pidx = parseInt(openPopup.dataset.placeIndex, 10);
                        if (!isNaN(pidx)) dragHighlightIdx = pidx;
                    }
                }
                sidebar.classList.add('open');
                document.body.classList.add('results-open');
                document.body.classList.add('results-peeked');
                const mapEl = document.getElementById('map');
                if (mapEl) sidebar.style.height = mapEl.offsetHeight + 'px';
                if (fitStateResultsOpen) applyPolygonFit(fitStateResultsOpen);
                // After sidebar settles, highlight the pending card.
                // Merge highlight + cleanup into ONE callback so the cleanup's
                // updateResultsSpacer doesn't disrupt the smooth scroll that
                // highlightPlace starts via centerCardInView.
                if (dragHighlightIdx !== null) {
                    snapCleanupRegistered = true;
                    onSidebarTransitionEnd(() => {
                        sidebar.style.transition = '';
                        highlightPlace(dragHighlightIdx);
                    });
                }
            }
        } else {
            // peeked
            if (isExpanded) document.body.classList.remove('results-expanded');
            if (isOpen) {
                sidebar.classList.remove('open');
                document.body.classList.remove('results-open');
                document.body.classList.add('results-peeked');
                if (fitStateLipPeeked) applyPolygonFit(fitStateLipPeeked);
                // Close popup — selected pin stays green+large as visual guide
                if (selectedPlaceIndex !== null) {
                    _isChangingSelection = true;
                    map.closePopup();
                    _isChangingSelection = false;
                }
            }
        }

        // Clear the inline transform so the CSS class-based transform takes over,
        // and the transition we just set animates smoothly to the target.
        sidebar.style.transform = '';

        // After the snap animation completes, clean up.
        // Skip if a combined highlight+cleanup callback was already registered above
        // (avoids a second updateResultsSpacer disrupting the smooth card scroll).
        if (!snapCleanupRegistered) {
            onSidebarTransitionEnd(() => {
                sidebar.style.transition = '';
                updateResultsSpacer();
            });
        }
    }, { passive: true });
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) {
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

function updateZoomLevelIndicator() {
    const indicator = document.getElementById('zoom-level-indicator');
    const valueEl = document.getElementById('zoom-level-value');
    const hintEl = document.getElementById('zoom-min-hint');

    if (!indicator || !valueEl) return;

    // Always update the fit-zoom button regardless of pinch state
    updateZoomFitButtonState();

    // Fade out during continuous pinch/wheel zoom or location/search zoom animation
    if (isPinchZoom || isLocationSearchZoom) {
        indicator.classList.remove('visible');
        return;
    }
    indicator.classList.add('visible');

    if (isFitZoom) {
        valueEl.innerHTML = '<i class="fas fa-crosshairs"></i>';
    } else {
        valueEl.textContent = Number.isInteger(currentZoomLevel)
            ? String(currentZoomLevel)
            : currentZoomLevel.toFixed(1);
    }

    const minZoomToDraw = getMinZoomLevelToDraw();
    const canDraw = currentZoomLevel >= minZoomToDraw;
    indicator.classList.toggle('can-draw', canDraw);
    indicator.classList.toggle('cannot-draw', !canDraw);
    indicator.classList.toggle('fit-zoom', isFitZoom);

    // Update hint text
    if (hintEl) {
        if (isFitZoom) {
            hintEl.textContent = '(fit)';
        } else if (canDraw) {
            hintEl.textContent = '(ready to draw)';
        } else {
            const needed = Math.ceil(minZoomToDraw - currentZoomLevel);
            hintEl.textContent = `(zoom in ${needed} more)`;
        }
    }
}

function updateStatus(text, isSearching = false) {
    const statusText = document.querySelector('.status-text');
    const statusIndicator = document.getElementById('status-indicator');

    if (statusText) {
        statusText.textContent = text;
    }

    if (isSearching) {
        statusIndicator.classList.add('searching');
    } else {
        statusIndicator.classList.remove('searching');
    }
}

function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    const bgColor = type === 'error' ? '#ea4335' : '#34a853';

    notification.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: ${bgColor};
        color: white;
        padding: 12px 24px;
        border-radius: 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        z-index: 9999;
        font-size: 14px;
        white-space: nowrap;
        animation: toastUp 0.3s ease;
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'toastDown 0.3s ease forwards';
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
    @keyframes toastUp {
        from { transform: translateX(-50%) translateY(100px); opacity: 0; }
        to { transform: translateX(-50%) translateY(0); opacity: 1; }
    }
    @keyframes toastDown {
        from { transform: translateX(-50%) translateY(0); opacity: 1; }
        to { transform: translateX(-50%) translateY(100px); opacity: 0; }
    }
`;
document.head.appendChild(style);

// =============================================================================
// Error Handling
// =============================================================================

window.onerror = function(message, source, lineno, colno, error) {
    console.error('Global error:', message, source, lineno, colno, error);
    return false;
};

window.addEventListener('unhandledrejection', function(event) {
    console.error('Unhandled promise rejection:', event.reason);
});
