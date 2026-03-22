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
let wildPinMarker = null;        // draggable indigo pin placed by user (Direction Mode location D)
let userLocationMarker = null;   // person marker at user's GPS location (shown during searches)
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
let _popupClosedByXButton = false; // true when popup was dismissed via the Leaflet close button (full deselect)
let _closedByPinTap = false;       // true when closeSidebar was triggered by tapping a pin (reopen popup after fly)
let isPinchZoom = false;          // true while the user is in continuous pinch/wheel zoom
let _buttonZoomPending = false;   // transient flag set by +/- button handlers before setZoom
let isFitZoom = false;
let _isAtMyLocation = false;       // true after My Location fly completes
let _myLocationCenter = null;      // stored center for drift detection
let _myLocEpoch = 0;              // epoch counter — bumped on each My Location fly, invalidates orphaned moveend handlers
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
    return isMobileView() ? 1 : 2;
}

// Direction Mode — fallback origin for simple direction URLs
let drawSearchOrigin = null; // [lat, lng] captured at draw-search time
let directionModeEnabled = false;
let directionSubMode = 'pre-game'; // 'pre-game' | 'post-game'
let useAdvancedOrder = false;       // true when user saves custom order via Advanced panel

// Direction Mode Advanced — four-location model
// A = auto-detected current location (GPS/IP)
// B = selected location (clicked place from search results; set at click-time)
// C = searched location (address typed in the search box)
// D = wild pin (draggable indigo pin placed by user; null when not on map)
const directionLocations = { A: null, B: null, C: null, D: null };
let directionOrder = ['A', 'B', 'C']; // default stop order (pre-game), persisted to localStorage

/**
 * Return the effective direction order based on sub-mode or advanced override.
 * Pre-game:  A → B → C  (current location → selected place → searched location)
 * Post-game: A → C → B  (current location → searched location → selected place)
 */
function getEffectiveDirectionOrder() {
    if (useAdvancedOrder && directionOrder.length >= 2) {
        return directionOrder;
    }
    return directionSubMode === 'post-game' ? ['A', 'C', 'B'] : ['A', 'B', 'C'];
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
    'places.businessStatus',
    'places.currentOpeningHours'
].join(',');

// Place type groups for parallel Nearby Search calls.
// Each group = 1 API call; results are combined and deduplicated.
const GOOGLE_TYPE_GROUPS = [
    // Food & Drink
    ['restaurant', 'cafe', 'bar', 'bakery', 'meal_delivery', 'meal_takeaway'],
    // Shopping & Retail
    ['supermarket', 'grocery_store', 'shopping_mall', 'convenience_store',
     'clothing_store', 'electronics_store', 'furniture_store', 'hardware_store',
     'home_goods_store', 'jewelry_store', 'shoe_store', 'pet_store', 'book_store',
     'liquor_store'],
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
// Location Persistence & Permissions
// =============================================================================

const LOCATION_CHANGE_THRESHOLD = 500; // meters — ignore GPS fixes closer than this
const DEFAULT_LOCATION = [40.7813, -73.9740]; // Museum of Natural History
const LOCATION_PERMISSION_KEY = 'laso_location_permission';

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

function getLocationPermission() {
    try { return localStorage.getItem(LOCATION_PERMISSION_KEY); }
    catch (e) { return null; }
}

function setLocationPermission(value) {
    try { localStorage.setItem(LOCATION_PERMISSION_KEY, value); }
    catch (e) { /* localStorage unavailable */ }
}

/**
 * Start GPS watchPosition — only called when permission is 'granted'.
 * On the first fix, fly to the user's location if it differs significantly
 * from the current map center.  Subsequent fixes update silently.
 */
function startLocationTracking() {
    if (!navigator.geolocation) return;

    let firstFix = true;
    navigator.geolocation.watchPosition(
        (position) => {
            const loc = [position.coords.latitude, position.coords.longitude];
            window._userLatLng = loc;
            directionLocations.A = { lat: loc[0], lng: loc[1], label: 'Your location' };
            saveLocation(loc[0], loc[1]);

            // Ensure person dot is always on the map (idle or active)
            _ensureUserMarkerOnMap();

            // Update compass heading if available in the position
            if (typeof position.coords.heading === 'number' && !isNaN(position.coords.heading)) {
                _updateUserHeading(position.coords.heading);
            }

            if (firstFix) {
                firstFix = false;
                const mapCenter = map.getCenter();
                const dist = calculateDistance(loc, [mapCenter.lat, mapCenter.lng]);
                if (dist > LOCATION_CHANGE_THRESHOLD) {
                    // Far away — fly with zoom change + header offset
                    const targetZoom = initialZoom + (isMobileView() ? 2 : 3);
                    isLocationSearchZoom = true;
                    const flyTarget = _pinCenterForOverlay(loc, targetZoom);
                    map.flyTo(flyTarget, targetZoom, { duration: 1.0 });
                    map.once('moveend', () => {
                        isLocationSearchZoom = false;
                        currentZoomLevel = map.getZoom() - initialZoom;
                        updateZoomLevelIndicator();
                        updateDrawButtonState();
                        updateStatus('Location found — Ready');
                    });
                } else {
                    // Close (subsequent refresh) — still apply header-offset
                    // centering since initMap used the raw saved lat/lng.
                    _gracefulPanToUser();
                    updateStatus('Location found — Ready');
                }
                updateMyLocationButtonState();
            }
        },
        (error) => {
            // Browser revoked permission after our modal grant — sync localStorage
            if (error.code === error.PERMISSION_DENIED) {
                setLocationPermission('denied');
                updateMyLocationButtonState();
            }
            updateStatus('Ready');
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    );
    updateMyLocationButtonState();
}

/**
 * Show the location permission modal (dark overlay + card).
 * "Share Location" triggers the browser prompt; "No Thank You" declines.
 */
function showLocationModal() {
    const modal = document.getElementById('location-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const shareBtn = document.getElementById('location-share-btn');
    const declineBtn = document.getElementById('location-decline-btn');

    const close = () => { modal.classList.add('hidden'); };

    shareBtn.addEventListener('click', () => {
        if (!navigator.geolocation) { close(); return; }
        navigator.geolocation.getCurrentPosition(
            () => {
                // Browser granted permission
                setLocationPermission('granted');
                close();
                startLocationTracking();
            },
            () => {
                // Browser denied permission
                setLocationPermission('denied');
                close();
                updateMyLocationButtonState();
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }, { once: true });

    declineBtn.addEventListener('click', () => {
        setLocationPermission('denied');
        close();
        updateMyLocationButtonState();
    }, { once: true });
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
 * Returns the px height of the fixed mobile header that overlaps the map canvas.
 * On desktop (or when the header isn't fixed) returns 0 — the header is in
 * normal flow so map.getSize() already excludes it.
 */
function getMobileHeaderPad() {
    if (!isMobileView()) return 0;
    const header = document.querySelector('.header');
    if (!header) return 0;
    return header.getBoundingClientRect().bottom;
}

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
 * Compute fit state for category search results, treating result coords
 * like polygon vertices but anchored on the search-time center.
 *
 * The search center stays at the visual center of the available canvas
 * (viewport minus padding for header/overlay on each edge).  Zoom is
 * the maximum level where every result pin fits inside that canvas with
 * equal margin from the center to the nearest edge.
 *
 * @param {L.LatLng[]} points        All pins to fit (result pins + user location)
 * @param {L.Map}      mapObj        Leaflet map instance
 * @param {number}     padTop        Px reserved at top (header)
 * @param {number}     padRight      Px reserved at right
 * @param {number}     padBottom     Px reserved at bottom (overlay)
 * @param {number}     padLeft       Px reserved at left
 * @returns {{ center: L.LatLng, zoom: number }}
 */
function calculateCategoryFit(points, mapObj, padTop, padRight, padBottom, padLeft) {
    const size = mapObj.getSize();
    const refZ = mapObj.getZoom();

    if (points.length === 0) {
        return { center: mapObj.getCenter(), zoom: refZ };
    }

    // --- Step 1: project every point at refZ & find bounding extremes ---
    let minWx = Infinity, maxWx = -Infinity;
    let minWy = Infinity, maxWy = -Infinity;

    for (const pt of points) {
        const wp = mapObj.project(pt, refZ);
        if (wp.x < minWx) minWx = wp.x;
        if (wp.x > maxWx) maxWx = wp.x;
        if (wp.y < minWy) minWy = wp.y;
        if (wp.y > maxWy) maxWy = wp.y;
    }

    const contentW = maxWx - minWx;
    const contentH = maxWy - minWy;

    // --- Step 2: available canvas area ---
    const availW = size.x - padLeft - padRight;
    const availH = size.y - padTop  - padBottom;

    if (availW <= 0 || availH <= 0) {
        const mid = mapObj.unproject(L.point((minWx + maxWx) / 2, (minWy + maxWy) / 2), refZ);
        return { center: mid, zoom: refZ };
    }

    if (contentW === 0 && contentH === 0) {
        // All points coincide — center on them, keep current zoom
        return { center: points[0], zoom: refZ };
    }

    // --- Step 3: scale factor to fit content into available area ---
    const scale = Math.min(
        contentW > 0 ? availW / contentW : Infinity,
        contentH > 0 ? availH / contentH : Infinity
    );
    const targetZoom = refZ + Math.log2(scale);

    // --- Step 4: center on content midpoint, offset for asymmetric padding ---
    const midWx = (minWx + maxWx) / 2;
    const midWy = (minWy + maxWy) / 2;
    const contentCenter = mapObj.unproject(L.point(midWx, midWy), refZ);

    const offsetX = (padRight  - padLeft) / 2;
    const offsetY = (padBottom - padTop)  / 2;
    const ccAtTarget = mapObj.project(contentCenter, targetZoom);
    const mapCenter  = mapObj.unproject(
        L.point(ccAtTarget.x + offsetX, ccAtTarget.y + offsetY), targetZoom
    );

    return { center: mapCenter, zoom: Math.round(targetZoom * 100) / 100 };
}

/**
 * Apply a previously-computed polygon fit state ({ center, zoom }).
 * Handles isAutoFittingPolygon flag for the duration of the fly animation.
 */
function applyPolygonFit(fitState) {
    if (!fitState) return;
    // Skip if we're already at this exact fit state
    if (isFitZoom && activeFitState === fitState) return;
    map.stop();                        // cancel any in-progress fly animation
    // Invalidate any orphaned My Location moveend handlers
    if (isLocationSearchZoom) { _myLocEpoch++; isLocationSearchZoom = false; }
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
    // Determine start location based on permission state:
    //   • permission granted + saved GPS → resume at saved location (no jarring fly)
    //   • otherwise → Museum of Natural History (pleasant default)
    const permission = getLocationPermission();
    const savedLocation = getSavedLocation();
    const hasPermission = permission === 'granted';
    const startLocation = (hasPermission && savedLocation) ? savedLocation : DEFAULT_LOCATION;

    // Seed direction location A from saved GPS coordinates (will be
    // overwritten by a live GPS fix once watchPosition fires).
    if (hasPermission && savedLocation) {
        directionLocations.A = { lat: savedLocation[0], lng: savedLocation[1], label: 'Saved location' };
    }

    // When starting from a saved location, jump straight to the target display
    // zoom level so there is no fly animation on load.
    const baseZoom = 14;
    const startZoom = (hasPermission && savedLocation)
        ? baseZoom + (isMobileView() ? 2 : 3)
        : baseZoom;

    // Initialize Leaflet map with Canvas renderer for better polygon handling
    map = L.map('map', {
        center: startLocation,
        zoom: startZoom,
        zoomSnap: 0,           // allow fully continuous pinch/wheel zoom (buttons handle integer steps)
        doubleClickZoom: false,
        zoomControl: false,
        rotate: true,
        touchRotate: true,     // two-finger pinch rotation on mobile
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
                const hasPin = searchAddressMarker && map.hasLayer(searchAddressMarker);
                const hasPoly = !!currentPolygon;

                if (!hasPoly && !hasPin) {
                    // No polygon and no pin — flash tooltip
                    container.classList.remove('tooltip-dismissed');
                    container.classList.add('tooltip-visible');
                    setTimeout(() => container.classList.remove('tooltip-visible'), 2500);
                    return;
                }
                if (isFitZoom) {
                    // Live-validate: is the map actually still at the fit position?
                    // The flag can go stale when sidebar recenters suppress drift
                    // detection via isAutoFittingPolygon.
                    let actuallyAtFit = false;
                    if (activeFitState) {
                        const fitPx = map.latLngToContainerPoint(activeFitState.center);
                        const sz = map.getSize();
                        const drift = Math.hypot(fitPx.x - sz.x / 2, fitPx.y - sz.y / 2);
                        const zoomDrift = Math.abs(map.getZoom() - activeFitState.zoom);
                        actuallyAtFit = drift <= 20 && zoomDrift <= 0.5;
                    }
                    if (actuallyAtFit) {
                        // Truly at fit — flash tooltip
                        container.classList.remove('tooltip-dismissed');
                        container.classList.add('tooltip-visible');
                        setTimeout(() => container.classList.remove('tooltip-visible'), 2500);
                        return;
                    }
                    // Stale flag — clear it and fall through to perform the fit
                    isFitZoom = false;
                    activeFitState = null;
                    updateZoomFitButtonState();
                }

                // Decide target: whichever is closer to the current map center
                let target = 'polygon';
                if (hasPin && !hasPoly) {
                    target = 'pin';
                } else if (hasPin && hasPoly) {
                    const mapCenter = map.getCenter();
                    const pinLL = searchAddressMarker.getLatLng();
                    const polyCenter = currentPolygon.getBounds().getCenter();
                    const dPin = map.distance(mapCenter, pinLL);
                    const dPoly = map.distance(mapCenter, polyCenter);
                    target = dPin <= dPoly ? 'pin' : 'polygon';
                }

                // Pre-dismiss tooltip so mobile sticky :hover doesn't flash it
                container.classList.add('tooltip-dismissed');

                // Flying away from GPS location — re-enable My Location button
                // and invalidate any orphaned My Location moveend handlers
                if (_isAtMyLocation || isLocationSearchZoom) {
                    _myLocEpoch++;
                    _isAtMyLocation = false;
                    _myLocationCenter = null;
                    isLocationSearchZoom = false;
                    updateMyLocationButtonState();
                }

                if (target === 'pin') {
                    // Fly to searched location pin at default zoom, offset
                    // for overlay so pin lands in the available canvas area.
                    const targetZoom = initialZoom + (isMobileView() ? 2 : 3);
                    const pinLL = searchAddressMarker.getLatLng();
                    const flyTarget = _pinCenterForOverlay(pinLL, targetZoom);
                    isLocationSearchZoom = true;
                    map.flyTo(flyTarget, targetZoom, { duration: 0.5 });
                    const epoch = _clearEpoch;
                    const finalize = () => {
                        isFitZoom = true;
                        activeFitState = { center: map.getCenter(), zoom: map.getZoom() };
                        currentZoomLevel = map.getZoom() - initialZoom;
                        updateZoomLevelIndicator();
                        updateDrawButtonState();
                        if (_clearEpoch !== epoch) return;
                        if (map.hasLayer(searchAddressMarker)) searchAddressMarker.openPopup();
                    };
                    map.once('moveend', () => {
                        isLocationSearchZoom = false;
                        if (_panToAvailableCanvas(pinLL)) {
                            map.once('moveend', finalize);
                        } else {
                            finalize();
                        }
                    });
                } else {
                    // Polygon fit (existing logic)
                    const padV = 10, padH = 10;
                    const padTop = padV + getMobileHeaderPad();
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
                        currentPolygon, map, padTop, padH, padBottom, padH
                    );
                    const fitState = { center, zoom: Math.round(zoom * 100) / 100 };
                    applyPolygonFit(fitState);
                    fitZoomValue = fitState.zoom;
                }
            });

            // Mobile: touchstart fires on disabled controls (click may not)
            container.addEventListener('touchstart', () => {
                const hasPin = searchAddressMarker && map.hasLayer(searchAddressMarker);
                const noTarget = !currentPolygon && !hasPin;
                if (noTarget || isFitZoom) {
                    if (container.classList.contains('tooltip-dismissed')) {
                        container.classList.remove('tooltip-dismissed');
                    }
                }
            }, { passive: true });

            return container;
        }
    });
    new ZoomFitControl().addTo(map);

    // My-location button — separate control below zoom-fit with a gap
    const MyLocationControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const container = L.DomUtil.create('div', 'leaflet-control-my-location leaflet-bar leaflet-control');
            const btn = L.DomUtil.create('a', 'leaflet-control-my-location-btn', container);
            btn.innerHTML = '<i class="fas fa-location-arrow"></i>';
            btn.href = '#';
            btn.title = 'My location';
            btn.role = 'button';
            btn.setAttribute('aria-label', 'My location');

            L.DomEvent.disableClickPropagation(container);

            // Shared logic: fly to a known location
            const _flyToMyLocation = (loc) => {
                const epoch = ++_myLocEpoch;
                container.classList.remove('locating');
                saveLocation(loc[0], loc[1]);
                window._userLatLng = loc;
                directionLocations.A = { lat: loc[0], lng: loc[1], label: 'Your location' };
                isLocationSearchZoom = true;
                const targetZoom = 14 + (isMobileView() ? 2 : 3);
                // In standard mode, snap bearing to north BEFORE computing
                // flyTarget so the offset is calculated for the final bearing (0),
                // not the stale in-flight value.
                if (!_walkMode) {
                    if (_bearingRafId) { cancelAnimationFrame(_bearingRafId); _bearingRafId = null; }
                    if (typeof map.setBearing === 'function') {
                        map.setBearing(0);
                        _bearingCurrent = 0;
                        _bearingTarget = 0;
                    }
                    _bearingOriginDelta = 0;
                    _syncConeRotation();
                }
                // Pause bearing updates during flyTo so animation is smooth
                if (_walkMode) {
                    _bearingPaused = true;
                    if (_bearingRafId) { cancelAnimationFrame(_bearingRafId); _bearingRafId = null; }
                }
                // _pinCenterForOverlay is bearing-aware: computes the correct
                // offset at any map rotation so one flyTo lands perfectly.
                const flyTarget = _pinCenterForOverlay(loc, targetZoom);
                map.flyTo(flyTarget, targetZoom, { duration: 0.8 });
                const finalize = () => {
                    if (_myLocEpoch !== epoch) return; // interrupted by another action
                    _isAtMyLocation = true;
                    _myLocationCenter = map.getCenter();
                    updateMyLocationButtonState();
                    updateZoomLevelIndicator();
                    updateDrawButtonState();
                    updateStatus('Location found');
                };
                map.once('moveend', () => {
                    if (_myLocEpoch !== epoch) { isLocationSearchZoom = false; return; }
                    isLocationSearchZoom = false;
                    // Resume bearing updates now that flyTo is done
                    if (_walkMode) {
                        _bearingPaused = false;
                        _walkCentered = true;
                        // Catch up to latest heading
                        if (_userHeading !== null && typeof map.setBearing === 'function') {
                            map.setBearing(-_userHeading);
                            _bearingCurrent = -_userHeading;
                            _bearingTarget = -_userHeading;
                        }
                        _syncConeRotation();
                    }
                    // Fine-tune if an overlay (results panel) covers part of the map
                    if (_panToAvailableCanvas(loc)) {
                        map.once('moveend', () => {
                            if (_myLocEpoch !== epoch) return;
                            finalize();
                        });
                    } else {
                        finalize();
                    }
                });
            };

            L.DomEvent.on(btn, 'click', (e) => {
                L.DomEvent.preventDefault(e);
                // No permission — show modal to prompt sharing
                if (getLocationPermission() !== 'granted') {
                    showLocationModal();
                    return;
                }
                if (container.classList.contains('locating')) return;
                if (_isAtMyLocation) return;  // already centered on location

                // Kick off compass tracking on this user gesture (iOS requires it)
                _startCompassTracking();

                // Fast path: watchPosition already has a recent GPS fix — use it
                // instantly (no blue flash, no async delay).
                if (window._userLatLng) {
                    _flyToMyLocation(window._userLatLng);
                    return;
                }

                // Slow path: no cached GPS — request a fresh fix
                if (!navigator.geolocation) {
                    updateStatus('Geolocation not supported');
                    return;
                }
                container.classList.add('locating');
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        _flyToMyLocation([position.coords.latitude, position.coords.longitude]);
                    },
                    () => {
                        container.classList.remove('locating');
                        updateStatus('Location unavailable');
                    },
                    { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
                );
            });

            return container;
        }
    });
    new MyLocationControl().addTo(map);

    // Wild pin button — square control below my-location
    const WildPinControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const container = L.DomUtil.create('div', 'leaflet-control-wild-pin leaflet-bar leaflet-control');
            const btn = L.DomUtil.create('a', 'leaflet-control-wild-pin-btn', container);
            btn.innerHTML = '<i class="fas fa-thumb-tack"></i>';
            btn.href = '#';
            btn.title = 'Place wild pin';
            btn.role = 'button';
            btn.setAttribute('aria-label', 'Place wild pin');

            L.DomEvent.disableClickPropagation(container);

            L.DomEvent.on(btn, 'click', (e) => {
                L.DomEvent.preventDefault(e);
                toggleWildPin();
            });

            return container;
        }
    });
    new WildPinControl().addTo(map);

    // Walk View button — toggles between standard (north-up) and walk (heading-up) modes
    const WalkViewControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const container = L.DomUtil.create('div', 'leaflet-control-walk-view leaflet-bar leaflet-control');
            const btn = L.DomUtil.create('a', 'leaflet-control-walk-view-btn', container);
            btn.innerHTML = '<i class="fas fa-walking"></i>';
            btn.href = '#';
            btn.title = 'Walk view';
            btn.role = 'button';
            btn.setAttribute('aria-label', 'Walk view');

            L.DomEvent.disableClickPropagation(container);

            L.DomEvent.on(btn, 'click', (e) => {
                L.DomEvent.preventDefault(e);
                _setWalkMode(!_walkMode);
            });

            return container;
        }
    });
    new WalkViewControl().addTo(map);

    // Compass reset button — resets bearing to north-up without changing center or zoom.
    // Disabled during walk mode (walk mode controls bearing automatically).
    const CompassResetControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const container = L.DomUtil.create('div', 'leaflet-control-compass-reset leaflet-bar leaflet-control');
            const btn = L.DomUtil.create('a', 'leaflet-control-compass-reset-btn', container);
            btn.innerHTML = '<i class="fas fa-compass"></i>';
            btn.href = '#';
            btn.title = 'Reset north';
            btn.role = 'button';
            btn.setAttribute('aria-label', 'Reset north');

            L.DomEvent.disableClickPropagation(container);

            L.DomEvent.on(btn, 'click', (e) => {
                L.DomEvent.preventDefault(e);
                if (_walkMode) {
                    // Walk mode: smooth flyTo recenter (same animation as Current Location)
                    if (!window._userLatLng) return;
                    _bearingPaused = true;
                    if (_bearingRafId) { cancelAnimationFrame(_bearingRafId); _bearingRafId = null; }
                    const wz = map.getZoom();
                    const wTarget = _pinCenterForOverlay(window._userLatLng, wz);
                    map.flyTo(wTarget, wz, { animate: true, duration: 0.6, easeLinearity: 0.25 });
                    map.once('moveend', () => {
                        _bearingPaused = false;
                        _walkCentered = true;
                        if (_userHeading !== null && typeof map.setBearing === 'function') {
                            map.setBearing(-_userHeading);
                            _bearingCurrent = -_userHeading;
                            _bearingTarget = -_userHeading;
                        }
                        _syncConeRotation();
                    });
                    return;
                }
                // Standard mode: snap bearing to north, then fly to user
                // (same as Current Location but keeps current zoom)
                if (_bearingRafId) { cancelAnimationFrame(_bearingRafId); _bearingRafId = null; }
                if (typeof map.setBearing === 'function') {
                    map.setBearing(0);
                    _bearingCurrent = 0;
                    _bearingTarget = 0;
                }
                _bearingOriginDelta = 0;
                _syncConeRotation();
                const currentZoom = map.getZoom();
                const flyTarget = _pinCenterForOverlay(window._userLatLng, currentZoom);
                map.flyTo(flyTarget, currentZoom, { animate: true, duration: 0.6, easeLinearity: 0.25 });
            });

            return container;
        }
    });
    new CompassResetControl().addTo(map);

    // Sync cone rotation when map bearing changes (e.g. free pinch rotation).
    // 'rotate' is the leaflet-rotate event; 'move' is the Leaflet fallback
    // that fires during any map movement including rotation gestures.
    map.on('rotate move', _syncConeRotation);

    // Detect user drag in walk mode — stop auto-centering until recenter pressed
    map.on('dragstart', () => {
        if (_walkMode) _walkCentered = false;
    });

    // User-initiated zoom in walk mode breaks the centering lock (same as drag).
    // Guard with !_bearingPaused so our own flyTo zoom doesn't break it.
    map.on('zoomstart', () => {
        if (_walkMode && !_bearingPaused) _walkCentered = false;
    });

    // Add OpenStreetMap tile layer (completely free, no API key)
    const tileLayer = L.tileLayer(OSM_TILE_URL, {
        maxZoom: 19,
        attribution: OSM_ATTRIBUTION
    }).addTo(map);

    // Fade map in once tiles are ready (golden-tan bg → map appears)
    tileLayer.once('load', () => {
        document.body.classList.remove('map-loading');
        // After fade-in, show location modal if user hasn't been asked yet
        if (!getLocationPermission()) {
            setTimeout(showLocationModal, 900);
        }
    });

    // Add scale control
    L.control.scale().addTo(map);

    // Track zoom level relative to the base zoom (always 14)
    initialZoom = baseZoom;
    currentZoomLevel = map.getZoom() - baseZoom;
    // Wait for fonts/icons to load into memory before fading in the indicator
    document.fonts.ready.then(() => { updateZoomLevelIndicator(); });

    // Clear selection when user manually dismisses a popup (click elsewhere / close button)
    map.on('popupclose', () => {
        // Skip when we are programmatically switching popups (highlightPlace, zoomstart, etc.)
        if (_isChangingSelection) return;
        if (map._animatingZoom) return;

        if (_popupClosedByXButton) {
            // Explicit close via the popup's X button → full deselect
            _popupClosedByXButton = false;
            clearHighlightedMarker();
            selectedPlaceIndex = null;
            document.querySelectorAll('.place-card.active').forEach(c => c.classList.remove('active'));
        }
        // Tap-outside: popup closes but we keep the pin green/enlarged and
        // selectedPlaceIndex intact so the user can still see which pin was
        // last selected.  No action needed — just let the popup disappear.
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
            if (_isAtMyLocation) { _isAtMyLocation = false; _myLocationCenter = null; updateMyLocationButtonState(); }
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
        // Don't clear activeFitState during pin-fit fly — moveend callback sets it
        if (!isFitZoom && !isLocationSearchZoom) activeFitState = null;
        currentZoomLevel = z - initialZoom;
        console.log(`Zoom level: ${currentZoomLevel} (absolute: ${z})${isFitZoom ? ` [FIT ${z.toFixed(2)}]` : ''}${isPinchZoom ? ' [PINCH]' : ''}`);
        updateZoomLevelIndicator();
        updateDrawButtonState();
    });

    // Detect user dragging away from fit center — reactivate buttons immediately
    map.on('dragstart', () => {
        if (isFitZoom) {
            isFitZoom = false;
            activeFitState = null;
            updateZoomFitButtonState();
        }
        if (_isAtMyLocation) {
            _isAtMyLocation = false;
            _myLocationCenter = null;
            updateMyLocationButtonState();
        }
    });

    // Fallback drift detection for programmatic moves (e.g. panTo)
    map.on('moveend', () => {
        // Drift detection for fit-zoom
        if (isFitZoom && activeFitState && !isAutoFittingPolygon && !isLocationSearchZoom) {
            const fitPx = map.latLngToContainerPoint(activeFitState.center);
            const size = map.getSize();
            const cx = size.x / 2, cy = size.y / 2;
            const drift = Math.hypot(fitPx.x - cx, fitPx.y - cy);
            if (drift > 5) {
                isFitZoom = false;
                activeFitState = null;
                updateZoomFitButtonState();
            }
        }
        // Drift detection for my-location — catches programmatic flyTo's
        // (e.g. sidebar recenter, polygon fit) that move away from GPS
        if (_isAtMyLocation && _myLocationCenter && !isLocationSearchZoom) {
            const myPx = map.latLngToContainerPoint(_myLocationCenter);
            const sz = map.getSize();
            const driftMy = Math.hypot(myPx.x - sz.x / 2, myPx.y - sz.y / 2);
            if (driftMy > 30) {
                _isAtMyLocation = false;
                _myLocationCenter = null;
                updateMyLocationButtonState();
            }
        }
    });

    // Desktop: smooth continuous scroll-wheel / trackpad-pinch zoom (Google Maps style).
    // Leaflet's built-in scrollWheelZoom debounces 40ms then animates each step with
    // a ~250ms CSS transition, creating visible discrete jumps.  Instead, we disable
    // the built-in handler and call setZoomAround({animate:false}) on every animation
    // frame — the same technique used by the Leaflet.SmoothWheelZoom plugin.
    if (!isMobileView()) {
        map.scrollWheelZoom.disable();

        let _swzDelta = 0;            // accumulated wheel-pixel delta awaiting next rAF
        let _swzRafId = null;         // rAF handle
        let _swzLastPos = null;       // L.Point — last cursor container-point
        let _swzGestureActive = false;
        let _swzEndTimer = null;
        const SWZ_PX_PER_LEVEL = 150; // wheel-pixels per zoom level (higher = less sensitive)

        function _swzFrame() {
            _swzRafId = null;
            if (_swzDelta === 0) return;

            const dz = -_swzDelta / SWZ_PX_PER_LEVEL;
            _swzDelta = 0;

            const z = map.getZoom();
            const nz = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z + dz));
            if (nz === z) return;

            map.setZoomAround(_swzLastPos, nz, { animate: false });
        }

        map.getContainer().addEventListener('wheel', (e) => {
            e.preventDefault();
            if (isDrawingMode) return;  // no zoom during lasso drawing

            const dy = (e.deltaMode === 1) ? e.deltaY * 20
                     : (e.deltaMode === 2) ? e.deltaY * 60
                     : e.deltaY;

            _swzDelta += dy;
            _swzLastPos = map.mouseEventToContainerPoint(e);

            // Mark gesture start — update state flags once
            if (!_swzGestureActive) {
                _swzGestureActive = true;
                isPinchZoom = true;
                isFitZoom = false;
                activeFitState = null;
                if (_isAtMyLocation) {
                    _isAtMyLocation = false;
                    _myLocationCenter = null;
                    updateMyLocationButtonState();
                }
                updateZoomFitButtonState();
                updateZoomLevelIndicator();
            }

            // Batch all wheel events in this frame into one setZoomAround call
            if (_swzRafId === null) {
                _swzRafId = requestAnimationFrame(_swzFrame);
            }

            // Detect gesture end (no wheel events for 150ms)
            clearTimeout(_swzEndTimer);
            _swzEndTimer = setTimeout(() => {
                _swzGestureActive = false;
                currentZoomLevel = map.getZoom() - initialZoom;
                updateZoomLevelIndicator();
                updateDrawButtonState();
            }, 150);
        }, { passive: false });
    }

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

    // --- Permission-gated location handling ------------------------------------
    // Geolocation only runs if the user has explicitly opted in via our modal.
    // The modal is shown after map tiles fade in (see tileLayer 'load' handler).
    if (hasPermission) {
        startLocationTracking();
    } else {
        updateMyLocationButtonState();
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

    const icon  = drawBtn.querySelector('i');
    const label = drawBtn.querySelector('span');
    const minZoomToDraw = getMinZoomLevelToDraw();
    const zoomTooLow = currentZoomLevel < minZoomToDraw;
    const hasPolygon = !!currentPolygon;

    if (hasPolygon) {
        // ── "Draw Clear" mode — always enabled so the user can clear the shape
        drawBtn.disabled = false;
        drawBtn.classList.remove('is-disabled');
        if (icon)  icon.className = 'fas fa-eraser';
        if (label && !isDrawingMode) label.textContent = 'Draw Clear';

        if (wrapper) {
            wrapper.classList.remove('tooltip-enabled');
            wrapper.classList.remove('tooltip-visible');
            wrapper.classList.remove('tooltip-dismissed');
        }
        if (tooltip) {
            tooltip.innerHTML = '';
            tooltip.setAttribute('aria-hidden', 'true');
        }
    } else {
        // ── Normal "Draw" mode — disabled only when zoom is too low
        const disabled = zoomTooLow;
        drawBtn.disabled = disabled;
        drawBtn.classList.toggle('is-disabled', disabled);
        if (icon)  icon.className = 'fas fa-pencil-alt';
        if (label && !isDrawingMode) label.textContent = 'Draw';

        if (wrapper) {
            wrapper.classList.toggle('tooltip-enabled', disabled);
            if (!disabled) {
                wrapper.classList.remove('tooltip-visible');
                wrapper.classList.remove('tooltip-dismissed');
            }
        }

        if (tooltip) {
            if (disabled) {
                const needed = Math.ceil(Math.max(0, minZoomToDraw - currentZoomLevel));
                const line1 = `Zoom in ${needed} more level${needed === 1 ? '' : 's'} to draw`;
                const line2 = 'Use <b>+</b> or pinch to zoom into the map';
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

    // Shimmer the map '+' button when category results are showing but zoom
    // is too low to draw — guides the user toward the next action.
    const zoomInBtn = document.querySelector('.leaflet-control-zoom-in');
    if (zoomInBtn) {
        const needsShimmer = zoomTooLow && !hasPolygon && !!fitStateResultsOpen;
        zoomInBtn.classList.toggle('shimmer', needsShimmer);
    }
}

function updateZoomFitButtonState() {
    const container = document.querySelector('.leaflet-control-zoom-fit');
    const fitBtn = document.querySelector('.leaflet-control-zoom-fit-btn');
    if (!fitBtn || !container) return;

    const tooltip = container.querySelector('.zoomfit-tooltip');
    const hasPin = searchAddressMarker && map.hasLayer(searchAddressMarker);
    const noTarget = !currentPolygon && !hasPin;

    const atFit = isFitZoom;
    const showTooltip = noTarget || atFit;

    // No-target disabled state (keeps pointer-events for tooltip interaction)
    fitBtn.classList.toggle('no-polygon', noTarget);
    // isFitZoom disabled state (keeps pointer-events for tooltip interaction)
    fitBtn.classList.toggle('disabled', atFit);
    container.classList.toggle('tooltip-enabled', showTooltip);
    if (!showTooltip) {
        container.classList.remove('tooltip-visible');
        // Only remove tooltip-dismissed when no animation is in progress.
        // During fit/search animations the state flickers (showTooltip toggles),
        // and removing tooltip-dismissed mid-animation lets sticky mobile :hover
        // flash the "already in zoom fit" tooltip erroneously.
        if (!isLocationSearchZoom && !isAutoFittingPolygon) {
            container.classList.remove('tooltip-dismissed');
        }
    }

    if (tooltip) {
        if (noTarget) {
            tooltip.innerHTML =
                '<div class="draw-tooltip-text">' +
                    '<span>Search a location or draw a shape first</span>' +
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

function updateMyLocationButtonState() {
    const btn = document.querySelector('.leaflet-control-my-location-btn');
    if (!btn) return;
    const noPermission = getLocationPermission() !== 'granted';
    btn.classList.toggle('no-permission', noPermission);
    btn.classList.toggle('disabled', !noPermission && _isAtMyLocation);
    btn.title = noPermission
        ? 'Location sharing not enabled'
        : (_isAtMyLocation ? 'Already at your location' : 'My location');
}

// =============================================================================
// Wild Pin — draggable indigo pin (Direction Mode location D)
// =============================================================================

function toggleWildPin() {
    if (wildPinMarker) {
        removeWildPin();
    } else {
        placeWildPin();
    }
    updateWildPinButtonState();
}

function placeWildPin() {
    const center = map.getCenter();
    const lat = center.lat;
    const lng = center.lng;

    wildPinMarker = L.marker([lat, lng], {
        draggable: true,
        icon: L.divIcon({
            className: 'wild-pin-marker',
            html: '<div style="width:44px;height:44px;border-radius:50%;background:#6366f1;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.4);border:3px solid #fff;"><i class="fas fa-thumb-tack" style="color:#fff;font-size:20px;"></i></div>',
            iconSize: [44, 44],
            iconAnchor: [22, 22]
        })
    }).addTo(map);

    directionLocations.D = { lat, lng, label: 'Wild pin' };

    wildPinMarker.bindPopup(_buildWildPinPopup(lat, lng), { maxWidth: 250, minWidth: 140, autoPan: false });
    wildPinMarker.openPopup();

    wildPinMarker.on('dragend', () => {
        const pos = wildPinMarker.getLatLng();
        directionLocations.D = { lat: pos.lat, lng: pos.lng, label: 'Wild pin' };
        wildPinMarker.setPopupContent(_buildWildPinPopup(pos.lat, pos.lng));
    });

    wildPinMarker.on('click', () => {
        wildPinMarker.openPopup();
    });
}

function removeWildPin() {
    if (wildPinMarker) {
        if (map.hasLayer(wildPinMarker)) map.removeLayer(wildPinMarker);
        wildPinMarker = null;
    }
    directionLocations.D = null;
}

function updateWildPinButtonState() {
    const btn = document.querySelector('.leaflet-control-wild-pin-btn');
    if (!btn) return;
    btn.classList.toggle('active', !!wildPinMarker);
    btn.title = wildPinMarker ? 'Remove wild pin' : 'Place wild pin';
}

function _buildWildPinPopup(lat, lng) {
    const coordStr = lat.toFixed(5) + ',' + lng.toFixed(5);
    const googleUrl = 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng;
    const appleUrl = 'https://maps.apple.com/?ll=' + lat + ',' + lng + '&z=19';

    const circleStyle = 'width:36px;height:36px;border-radius:50%;background:#f8f9fa;display:flex;align-items:center;justify-content:center;text-decoration:none;border:1px solid #e0e0e0;';

    return '<div class="wild-pin-popup" style="text-align:center;">' +
        '<div style="font-size:14px;color:#202124;font-weight:600;margin-bottom:6px;">Wild Pin</div>' +
        '<div style="display:flex;justify-content:center;gap:10px;">' +
            '<a href="' + googleUrl + '" target="_blank" rel="noopener" title="Google Maps" class="directions-capable" data-dest-lat="' + lat + '" data-dest-lng="' + lng + '" data-search-term="' + coordStr + '" data-map-provider="google" data-wild-pin="true" style="' + circleStyle + 'color:#4285f4;font-size:13px;">' +
                '<i class="fab fa-google"></i></a>' +
            '<a href="' + appleUrl + '" target="_blank" rel="noopener" title="Apple Maps" class="directions-capable" data-dest-lat="' + lat + '" data-dest-lng="' + lng + '" data-dest-name="Wild Pin" data-map-provider="apple" data-wild-pin="true" style="' + circleStyle + 'color:#333;font-size:15px;">' +
                '<i class="fab fa-apple"></i></a>' +
        '</div>' +
        '<div style="font-size:10px;color:#999;margin-top:4px;">' + coordStr + '</div>' +
    '</div>';
}

// =============================================================================
// User Location Marker — always visible on map.
//   • Idle  : green dot (always present once GPS fix acquired)
//   • Active: full person icon with heading cone (during search results)
// =============================================================================

let _userHeading = null;       // degrees from true north (0–360), null = unknown
let _headingWatchActive = false;
let _userMarkerMode = 'idle';  // 'idle' | 'active'

// ── Walk View state ──
let _walkMode = false;         // true = map auto-rotates with heading
let _walkCentered = true;      // true = user dot is at true map center (rotation pivot)
let _bearingPaused = false;    // true during flyTo — suppresses bearing updates

// ── Smooth bearing animation state ──
let _bearingTarget = 0;
let _bearingCurrent = 0;
let _bearingRafId = null;
let _bearingOriginDelta = 0;  // magnitude of the rotation that started this animation

function _getMapBearing() {
    return (map && typeof map.getBearing === 'function') ? map.getBearing() : 0;
}

function _coneVisualRotation() {
    if (_userHeading === null) return 0;
    // Cone must point where the user faces ON SCREEN.
    // DivIcons stay screen-upright (leaflet-rotate default rotateWithView=false),
    // so we offset by the map's bearing.
    return _userHeading + _getMapBearing();
}

function _buildUserMarkerHtml() {
    const rot = _coneVisualRotation();
    if (_userMarkerMode === 'idle') {
        const coneHtml = _userHeading !== null
            ? '<div class="user-heading-cone user-heading-cone-sm" style="transform:rotate(' + rot + 'deg);"></div>'
            : '';
        return '<div class="user-location-dot user-location-dot-sm">'
            + coneHtml
            + '<div class="user-location-inner user-location-inner-sm"></div></div>';
    }
    // Active: full person icon with heading cone
    const coneHtml = _userHeading !== null
        ? '<div class="user-heading-cone" style="transform:rotate(' + rot + 'deg);"></div>'
        : '';
    return '<div class="user-location-dot">'
        + coneHtml
        + '<div class="user-location-inner">'
        + '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="white">'
        + '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>'
        + '</svg></div></div>';
}

function _userMarkerIconSize() {
    return _userMarkerMode === 'idle' ? [48, 48] : [60, 60];
}
function _userMarkerIconAnchor() {
    return _userMarkerMode === 'idle' ? [24, 24] : [30, 30];
}

function _refreshUserMarkerIcon() {
    if (!userLocationMarker) return;
    userLocationMarker.setIcon(L.divIcon({
        className: 'user-location-marker',
        html: _buildUserMarkerHtml(),
        iconSize: _userMarkerIconSize(),
        iconAnchor: _userMarkerIconAnchor()
    }));
}

function _syncConeRotation() {
    if (!userLocationMarker || !map.hasLayer(userLocationMarker)) return;
    if (_userHeading === null) return;
    const iconEl = userLocationMarker._icon;
    if (!iconEl) return;
    const cone = iconEl.querySelector('.user-heading-cone');
    if (cone) {
        cone.style.transform = 'rotate(' + _coneVisualRotation() + 'deg)';
    } else {
        // Cone didn't exist yet (heading arrived after marker was created) — rebuild
        _refreshUserMarkerIcon();
    }
}

function setUserMarkerMode(mode) {
    if (mode === _userMarkerMode) return;
    _userMarkerMode = mode;
    _refreshUserMarkerIcon();
}

// ── Smooth bearing interpolation (Apple Maps-like adaptive easing) ──

function _normDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

function _bearingStep() {
    if (_bearingPaused) { _bearingRafId = null; return; }
    const delta = _normDelta(_bearingCurrent, _bearingTarget);
    const absDelta = Math.abs(delta);

    if (absDelta < 0.3) {
        // Close enough — snap and stop
        _bearingCurrent = _bearingTarget;
        if (typeof map.setBearing === 'function') map.setBearing(_bearingCurrent);
        // In walk mode, keep user visually centered
        if (_walkMode && _walkCentered) _gracefulPanToUser(false);
        _syncConeRotation();
        _bearingRafId = null;
        _bearingOriginDelta = 0;
        return;
    }

    // Adaptive speed factor:
    //  < 12.5°  → micro-adjustments
    //  12.5–90° → light ease (smooth mid-range turns)
    //  > 90°    → gentle ease (graceful large rotations)
    //
    // After a large swing (origin > 45°), the micro tail uses a gentler
    // settling factor so the last few degrees ease in gracefully rather
    // than snapping — gives the "we're precisely following you" feel.
    let factor;
    if (absDelta < 12.5) {
        if (_bearingOriginDelta > 45) {
            // Settling after a big turn — gentle micro ease
            factor = 0.12;
        } else {
            // Pure micro rotation — responsive
            factor = 0.35;
        }
    } else if (absDelta < 90) {
        factor = 0.14;
    } else {
        factor = 0.07;
    }

    _bearingCurrent += delta * factor;
    // Normalize to [-180, 180]
    _bearingCurrent = ((_bearingCurrent + 540) % 360) - 180;
    if (typeof map.setBearing === 'function') map.setBearing(_bearingCurrent);
    // In walk mode, keep user visually centered
    if (_walkMode && _walkCentered) _gracefulPanToUser(false);
    _syncConeRotation();
    _bearingRafId = requestAnimationFrame(_bearingStep);
}

function _smoothSetBearing(target) {
    // Record the magnitude of this new rotation for adaptive settling
    const newDelta = Math.abs(_normDelta(_bearingCurrent, target));
    if (newDelta > _bearingOriginDelta) _bearingOriginDelta = newDelta;
    _bearingTarget = target;
    if (_bearingPaused) return; // stash target; will resume after flyTo
    if (!_bearingRafId) {
        _bearingRafId = requestAnimationFrame(_bearingStep);
    }
}

function _updateUserHeading(degrees) {
    if (degrees === null || degrees === undefined) return;
    _userHeading = degrees;

    // In walk mode, smoothly rotate the map so user's heading points "up"
    if (_walkMode && map) {
        _smoothSetBearing(-degrees);
    }

    // Update the cone visual direction
    _syncConeRotation();
}

function _startCompassTracking() {
    if (_headingWatchActive) return;
    if (!isMobileView()) return;

    const handler = (e) => {
        // iOS provides webkitCompassHeading (degrees from magnetic north)
        // Android provides e.alpha (0-360, but inverted — compass heading = 360 - alpha)
        let heading = null;
        if (typeof e.webkitCompassHeading === 'number') {
            heading = e.webkitCompassHeading;
        } else if (typeof e.alpha === 'number' && e.absolute) {
            heading = (360 - e.alpha) % 360;
        }
        if (heading !== null) _updateUserHeading(heading);
    };

    // iOS 13+ requires explicit permission
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(state => {
            if (state === 'granted') {
                window.addEventListener('deviceorientationabsolute', handler, true);
                window.addEventListener('deviceorientation', handler, true);
                _headingWatchActive = true;
            }
        }).catch(() => {});
    } else if ('DeviceOrientationEvent' in window) {
        window.addEventListener('deviceorientationabsolute', handler, true);
        window.addEventListener('deviceorientation', handler, true);
        _headingWatchActive = true;
    }
}

// ── Walk mode toggle ──
function _setWalkMode(on) {
    _walkMode = on;
    const walkBtn = document.querySelector('.leaflet-control-walk-view-btn');
    if (walkBtn) {
        walkBtn.innerHTML = on
            ? '<i class="fas fa-glasses"></i>'
            : '<i class="fas fa-walking"></i>';
        walkBtn.title = on ? 'Standard view' : 'Walk view';
        walkBtn.setAttribute('aria-label', walkBtn.title);
        walkBtn.classList.toggle('walk-active', on);
    }
    _updateCompassResetBtnState();
    if (on) {
        // Disable manual rotation — walk mode controls bearing automatically
        if (map.touchRotate && map.touchRotate.disable) map.touchRotate.disable();
        // Start compass if not already running
        _startCompassTracking();
        // Snap bearing instantly for mode transition (rAF would fight flyTo)
        if (_bearingRafId) { cancelAnimationFrame(_bearingRafId); _bearingRafId = null; }
        if (_userHeading !== null && typeof map.setBearing === 'function') {
            map.setBearing(-_userHeading);
            _bearingCurrent = -_userHeading;
            _bearingTarget = -_userHeading;
        }
        _bearingOriginDelta = 0;
        _syncConeRotation();
        // Center user in visible canvas (header-aware, bearing-aware)
        _walkCentered = true;
        _gracefulPanToUser(true);
    } else {
        // Re-enable manual rotation
        if (map.touchRotate && map.touchRotate.enable) map.touchRotate.enable();
        // Snap bearing to north for mode transition (rAF would fight flyTo)
        if (_bearingRafId) { cancelAnimationFrame(_bearingRafId); _bearingRafId = null; }
        if (typeof map.setBearing === 'function') {
            map.setBearing(0);
            _bearingCurrent = 0;
            _bearingTarget = 0;
        }
        _bearingOriginDelta = 0;
        _walkCentered = false;
        _syncConeRotation();
        // Recenter with header offset (standard mode uses visual center)
        _gracefulPanToUser();
    }
}

// ── Graceful recenter on user with header-offset compensation ──
// Uses container-point math (latLngToContainerPoint + panBy) which is
// bearing-aware — works correctly even when the map is rotated (walk mode).
// Accounts for the header and any bottom overlay in screen coordinates.
function _gracefulPanToUser(animate) {
    if (animate === undefined) animate = true;
    const loc = window._userLatLng;
    if (!loc) return;

    const mapEl = document.getElementById('map');
    if (!mapEl) { map.panTo(loc, { animate: animate }); return; }

    const headerH = getMobileHeaderPad();
    const fullH = mapEl.offsetHeight;
    const fullW = mapEl.offsetWidth;

    // Determine overlay height from current state
    let overlayH = 0;
    const sidebar = document.getElementById('results-sidebar');
    if (sidebar) {
        if (document.body.classList.contains('results-open')) {
            overlayH = fullH * 0.5;
        } else if (document.body.classList.contains('results-peeked')) {
            overlayH = TOASTER_LIP_HEIGHT;
        }
    }

    // Visible canvas center in container (screen) coordinates
    const visibleTop = headerH;
    const visibleBottom = fullH - overlayH;
    const targetX = fullW / 2;
    const targetY = (visibleTop + visibleBottom) / 2;

    // Where is the user GPS point currently on screen?
    const ll = L.latLng(loc[0], loc[1]);
    const pt = map.latLngToContainerPoint(ll);

    const dx = pt.x - targetX;
    const dy = pt.y - targetY;

    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // already centered

    if (animate) {
        map.panBy([dx, dy], { animate: true, duration: 0.6, easeLinearity: 0.25 });
    } else {
        map.panBy([dx, dy], { animate: false });
    }
}

// ── Compass / recenter button state ──
function _updateCompassResetBtnState() {
    const btn = document.querySelector('.leaflet-control-compass-reset-btn');
    if (!btn) return;
    if (_walkMode) {
        // In walk mode: becomes a recenter button
        btn.innerHTML = '<i class="fas fa-dot-circle"></i>';
        btn.title = 'Recenter';
        btn.classList.remove('compass-disabled');
    } else {
        btn.innerHTML = '<i class="fas fa-compass"></i>';
        btn.title = 'Reset north';
        btn.classList.remove('compass-disabled');
    }
    btn.setAttribute('aria-label', btn.title);
}

function _ensureUserMarkerOnMap() {
    const loc = window._userLatLng;
    if (!loc) return;

    if (userLocationMarker && map.hasLayer(userLocationMarker)) {
        // Already on map — just update position
        userLocationMarker.setLatLng(loc);
        return;
    }

    // Create marker
    if (userLocationMarker) {
        // Marker exists but not on map — re-add
        userLocationMarker.setLatLng(loc);
        userLocationMarker.addTo(map);
        return;
    }

    // First-time creation
    userLocationMarker = L.marker(loc, {
        icon: L.divIcon({
            className: 'user-location-marker',
            html: _buildUserMarkerHtml(),
            iconSize: _userMarkerIconSize(),
            iconAnchor: _userMarkerIconAnchor()
        }),
        interactive: true,
        zIndexOffset: 900
    }).addTo(map);

    const lat = loc[0];
    const lng = loc[1];
    const coordStr = lat.toFixed(5) + ', ' + lng.toFixed(5);
    userLocationMarker.bindPopup(
        '<div style="text-align:center;">'
            + '<div style="font-size:15px;font-weight:600;color:#202124;margin-bottom:4px;">You!</div>'
            + '<div style="font-size:11px;color:#888;">' + coordStr + '</div>'
        + '</div>',
        { maxWidth: 200, minWidth: 100, autoPan: false }
    );

    userLocationMarker.on('click', () => {
        userLocationMarker.openPopup();
    });

    // Start compass tracking on first marker placement (mobile only)
    _startCompassTracking();
}

function addUserLocationMarker() {
    setUserMarkerMode('active');
    _ensureUserMarkerOnMap();
}

function removeUserLocationMarker() {
    // Don't remove — downgrade to idle dot
    setUserMarkerMode('idle');
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
// Mobile Layout Setup  (only called when mobile)
// =============================================================================
function setupMobileLayout() {
    const sidebar = document.getElementById('results-sidebar');
    const sidebarContent = sidebar ? sidebar.querySelector('.sidebar-content') : null;
    const filterControls = document.querySelector('.filter-sort-controls');

    if (!filterControls || !sidebar || !sidebarContent) return;

    // Move filter controls from header into sidebar, above scrollable content
    sidebar.insertBefore(filterControls, sidebarContent);

    // Move search action buttons out of search-box into header flex flow
    // so spacing is handled by flexbox gap — no magic-number offsets needed.
    const header = document.querySelector('.header');
    const settingsBtn = document.getElementById('settings-btn');
    const searchBtn = document.getElementById('search-btn');
    const searchClearBtn = document.getElementById('search-clear-btn');

    if (header && settingsBtn) {
        if (searchClearBtn) header.insertBefore(searchClearBtn, settingsBtn);
        if (searchBtn) header.insertBefore(searchBtn, settingsBtn);
    }

    // With position:fixed the header is out of flow — Leaflet controls need
    // to know where the header ends so they sit below it, not behind it.
    const syncHeaderOffset = () => {
        if (!header) return;
        const bottom = header.getBoundingClientRect().bottom + 6; // 6px gap
        document.documentElement.style.setProperty('--header-bottom', bottom + 'px');
    };
    requestAnimationFrame(syncHeaderOffset);
    window.addEventListener('resize', syncHeaderOffset);
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
    // Remove preload class after first paint so transitions activate normally.
    // Double-rAF ensures CSS is fully applied before enabling transitions.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            document.body.classList.remove('preload');
        });
    });

    // Detect touch device and apply mobile class
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        document.body.classList.add('is-mobile');
    }

    // Rearrange DOM per platform
    if (!document.body.classList.contains('is-mobile')) {
        setupDesktopLayout();
    } else {
        setupMobileLayout();
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

    // "Draw Clear" mode — clear shape + business pins, keep location pin
    if (currentPolygon) {
        drawClear();
        if (drawBtn && typeof drawBtn.blur === 'function') drawBtn.blur();
        return;
    }

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

/**
 * Clear the draw shape and all business pins, but preserve the location
 * search pin (searchAddressMarker) and the address input text.
 */
function drawClear() {
    _clearEpoch++;

    selectedPlaceIndex = null;
    _highlightedMarkerIndex = null;
    isAutoFittingPolygon = false;

    // Reset mega-pin enrichment — the draw-search results are being wiped,
    // so the red pin's link to its draw-search counterpart must be severed.
    if (searchAddressMarker && searchAddressMarker._searchEnrichment) {
        const enr = searchAddressMarker._searchEnrichment;
        enr._megaPin = false;
        enr._megaPinPlace = null;
        enr._megaPinIndex = -1;
    }

    // Remove business markers (NOT searchAddressMarker)
    markers.forEach(marker => {
        if (map.hasLayer(marker)) map.removeLayer(marker);
    });
    markers = [];

    _isChangingSelection = true;
    map.closePopup();
    _isChangingSelection = false;
    map.stop();

    // Remove polygon
    removeCurrentPolygon();

    // Stray-layer sweep — preserve searchAddressMarker, wildPinMarker, userLocationMarker and the tile layer
    const strayLayers = [];
    map.eachLayer(layer => {
        if (layer === searchAddressMarker) return;
        if (layer === wildPinMarker) return;
        if (layer === userLocationMarker) return;
        if (layer instanceof L.Marker || layer instanceof L.Popup) {
            strayLayers.push(layer);
        }
    });
    strayLayers.forEach(layer => map.removeLayer(layer));

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

    const lasoBtnClear = document.getElementById('lasosearch-btn');
    if (lasoBtnClear) lasoBtnClear.classList.remove('shimmer');

    // Snap zoom to nearest integer
    const currentZ = map.getZoom();
    if (!Number.isInteger(currentZ)) {
        _buttonZoomPending = true;
        map.setZoom(Math.round(currentZ), { animate: true });
    } else {
        isPinchZoom = false;
        updateZoomLevelIndicator();
        updateDrawButtonState();
    }

    // Clear scroll-container constraint
    const content = document.querySelector('.sidebar-content');
    if (content) content.style.maxHeight = '';

    // Hide sidebar
    document.body.classList.remove('results-peeked');
    document.body.classList.remove('results-expanded');
    const sidebar = document.getElementById('results-sidebar');
    sidebar.classList.remove('open');
    document.body.classList.remove('results-open');

    updateStatus('Ready');

    // Re-open the location pin popup if still on the map
    if (searchAddressMarker && map.hasLayer(searchAddressMarker)) {
        searchAddressMarker.openPopup();
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

    // Close search marker popup so user can see while drawing (pin stays)
    if (searchAddressMarker) searchAddressMarker.closePopup();

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
    overlay.classList.add('hidden');
    statusIndicator.classList.remove('drawing');
    updateStatus('Ready');
    updateDrawButtonState();

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
    // Clear drawing flags BEFORE updateDrawButtonState so !isDrawingMode
    // lets the label switch to "Draw Clear" immediately.
    isDrawingMode = false;
    isDrawing = false;
    isMouseDown = false;

    updateDrawButtonState();
    updateZoomFitButtonState();

    const drawBtn = document.getElementById('drawing-toggle');
    const overlay = document.getElementById('drawing-overlay');
    const statusIndicator = document.getElementById('status-indicator');

    drawBtn.classList.remove('active');
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
        currentPolygon, map, 10 + getMobileHeaderPad(), 10, 10, 10
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

/**
 * Decide whether sidebar transitions should recenter on the location pin
 * or the polygon center.
 *
 * Rules:
 *   1. No location pin → 'polygon'
 *   2. No polygon      → 'pin'
 *   3. Pin INSIDE polygon → 'pin'
 *   4. Pin OUTSIDE polygon → whichever is closer to the current map center
 *
 * @returns {'pin'|'polygon'}
 */
function _getSidebarRecenterTarget() {
    const hasPin = searchAddressMarker && map.hasLayer(searchAddressMarker);
    const hasPoly = !!currentPolygon;

    // Category search fit states take priority over stale mega pin
    if (!hasPoly && fitStateResultsOpen) return 'polygon';

    if (!hasPin && !hasPoly) return 'polygon';
    if (!hasPin) return 'polygon';
    if (!hasPoly) return 'pin';

    // Check if pin is inside the polygon
    const pinLL = searchAddressMarker.getLatLng();
    const pinCoord = [pinLL.lat, pinLL.lng];
    if (drawingPoints.length >= 3 && pointInPolygon(pinCoord, drawingPoints)) {
        return 'pin';
    }

    // Pin is outside polygon — pick whichever is closer to current map center
    const mapCenter = map.getCenter();
    const polyCenter = currentPolygon.getBounds().getCenter();
    const dPin = map.distance(mapCenter, pinLL);
    const dPoly = map.distance(mapCenter, polyCenter);
    return dPin <= dPoly ? 'pin' : 'polygon';
}

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
        .normalize('NFD')              // decompose accents: é → e + combining accent
        .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
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

// Synonym groups: any token in a group also matches the other members.
// Normalized (lowercase, no accents/punctuation) forms only.
const FILTER_SYNONYM_GROUPS = [
    ['cafe', 'coffee shop'],
];
// Build a fast lookup: normalized token → set of synonyms (including itself)
const _filterSynonyms = (() => {
    const map = new Map();
    for (const group of FILTER_SYNONYM_GROUPS) {
        for (const word of group) {
            const existing = map.get(word) || new Set();
            for (const other of group) existing.add(other);
            map.set(word, existing);
        }
    }
    return map;
})();

function getFilterSynonyms(normalizedToken) {
    // Direct lookup
    const direct = _filterSynonyms.get(normalizedToken);
    if (direct) return direct;
    // Also check if the token is a stem/substring of a synonym key
    for (const [key, syns] of _filterSynonyms) {
        if (key.includes(normalizedToken) || normalizedToken.includes(key)) return syns;
    }
    return null;
}

/**
 * Score how well a single query token matches a field string.
 * Returns a quality number:
 *   0   – no match
 *   1.0 – exact or stem-exact substring hit
 *   0.7 – synonym match
 *   0.4 – fuzzy / typo-tolerant match
 *
 * The OLD code had `t.includes(f)` (backwards substring) which let
 * token "garden" match field "den" — removed.  Now only the field
 * is allowed to contain the token, never the reverse (unless they
 * are equal or the token is a prefix of a word in the field).
 */
function tokenMatchesField(token, field) {
    const t = normalizeFilterToken(token);
    const f = normalizeFilterToken(field);
    if (!t || !f) return 0;

    const ts = simpleStem(t);
    const fs = simpleStem(f);

    // Exact / substring: field contains the token (or stemmed equivalents)
    if (f.includes(t) || fs.includes(ts)) return 1.0;

    // Word-level exact: token matches a word in the field (prefix/stem)
    const words = f.split(' ');
    for (const w of words) {
        if (!w || w.length < 2) continue;
        const ws = simpleStem(w);
        if (ws === ts || ws.startsWith(ts) || ts.startsWith(ws)) return 1.0;
    }

    // Synonym expansion: "cafe" ↔ "coffee shop" etc.
    const syns = getFilterSynonyms(t);
    if (syns) {
        for (const syn of syns) {
            if (syn === t) continue;
            const ss = simpleStem(syn);
            if (f.includes(syn) || fs.includes(ss)) return 0.7;
        }
    }

    // Fuzzy: allow small typos for practical autocorrect-like behavior.
    // Short tokens (≤4 chars) get no typo tolerance — a single edit changes
    // the word entirely (e.g. "cafe"→"care"), producing false positives.
    const maxDist = t.length <= 4 ? 0 : (t.length <= 8 ? 1 : 2);
    if (maxDist > 0 && levenshteinDistance(ts, fs, maxDist) <= maxDist) return 0.4;

    // Word-level fuzzy matching
    for (const w of words) {
        if (!w || w.length < 2) continue;
        const ws = simpleStem(w);
        if (maxDist > 0 && levenshteinDistance(ts, ws, maxDist) <= maxDist) return 0.4;
    }

    return 0;
}

function placeMatchesAnyToken(place, tokens) {
    if (!tokens || tokens.length === 0) return true;
    const name = place?.name || '';
    const type = place?.place_type || '';

    // Require EVERY token to match either the name or type.
    // This is how Google Maps works — "madison square garden" must have
    // all three words present.  Fuzzy matches (typos) still count so
    // "maddison square garden" will still find "Madison Square Garden".
    for (const token of tokens) {
        if (tokenMatchesField(token, name) > 0 || tokenMatchesField(token, type) > 0) {
            continue;
        }
        return false;
    }
    return true;
}

/**
 * Compute a 0.0–1.0 relevance score for how well a place name matches
 * the user's filter query.  Google Maps-style tiered ranking:
 *
 *   Tier A  (0.90–1.00)  Full-phrase match (exact / prefix / contains)
 *   Tier B  (0.70–0.89)  All tokens present (order + quality bonus)
 *   Tier C  (0.01–0.30)  Partial token coverage (proportional)
 *
 * Match quality from tokenMatchesField (1.0 exact, 0.7 synonym, 0.4 fuzzy)
 * is averaged and used as a tiebreaker within each tier, so exact-character
 * matches outrank typo-corrected matches of the same name.
 *
 * When the filter is active and sort mode is 'distance', results are
 * sorted by relevance first, distance second — so an exact-name match
 * that is slightly farther always beats a partial-word match that is
 * slightly closer.
 */
function computeNameRelevance(tokens, placeName) {
    if (!tokens || tokens.length === 0) return 1; // no filter → everything is equally relevant
    const name = normalizeFilterToken(placeName);
    if (!name) return 0;

    const query = tokens.join(' ');

    // --- Tier A: full-phrase matching (contiguous substring) ---
    if (name === query)             return 1.00; // exact
    if (name.startsWith(query))     return 0.97; // prefix
    if (name.includes(query))       return 0.93; // contains

    // Also check fuzzy full-phrase: "maddison square garden" vs "madison square garden"
    // Compare the full query against every len-matched substring of the name.
    if (query.length >= 5) {
        const maxFuzzyDist = query.length <= 8 ? 1 : 2;
        // Check if the name, after normalization, is a fuzzy match to the query
        if (levenshteinDistance(name, query, maxFuzzyDist) <= maxFuzzyDist) return 0.91;
        // Check if the query is a fuzzy prefix of the name
        if (name.length >= query.length) {
            const namePrefix = name.substring(0, query.length);
            if (levenshteinDistance(namePrefix, query, maxFuzzyDist) <= maxFuzzyDist) return 0.90;
        }
    }

    // --- Tier B: token-level coverage with quality tracking ---
    const nameWords = name.split(/\s+/);
    let matchCount = 0;
    let qualitySum = 0;
    const matchPositions = []; // index into nameWords of first word-level hit

    for (const token of tokens) {
        const t = normalizeFilterToken(token);
        if (!t) { matchCount++; qualitySum += 1; continue; }
        let bestQuality = 0;
        let bestPos = -1;
        for (let i = 0; i < nameWords.length; i++) {
            const q = tokenMatchesField(t, nameWords[i]);
            if (q > bestQuality) {
                bestQuality = q;
                bestPos = i;
                if (q >= 1.0) break; // can't do better
            }
        }
        // Fall back to whole-name match (handles multi-word name fields)
        if (bestQuality === 0) {
            const q = tokenMatchesField(t, name);
            if (q > 0) {
                bestQuality = q;
                bestPos = name.indexOf(normalizeFilterToken(t));
            }
        }
        if (bestQuality > 0) {
            matchCount++;
            qualitySum += bestQuality;
            matchPositions.push(bestPos);
        }
    }

    const coverage = matchCount / tokens.length;
    const avgQuality = matchCount > 0 ? qualitySum / matchCount : 0;

    if (coverage >= 1.0) {
        // All tokens matched — check order preservation
        let inOrder = true;
        for (let i = 1; i < matchPositions.length; i++) {
            if (matchPositions[i] <= matchPositions[i - 1]) {
                inOrder = false;
                break;
            }
        }
        // Base: 0.70 (out of order) or 0.80 (in order)
        // Quality bonus: up to +0.09 based on average match quality
        const base = inOrder ? 0.80 : 0.70;
        return base + 0.09 * avgQuality;
    }

    // Partial coverage: scale linearly between 0.01 and 0.30, quality-weighted
    return (0.01 + 0.29 * coverage) * avgQuality;
}

function parsePlaceFiltersFromInput(value) {
    return tokenizeFilterQuery(value);
}

function getActivePriorityCenter() {
    // 1. Mega pin: search address marker exists AND is inside the drawn shape
    if (searchPinCoords && drawingPoints.length >= 3
        && pointInPolygon(searchPinCoords, drawingPoints)) {
        return searchPinCoords;
    }
    // 2. Current GPS location
    if (window._userLatLng) return window._userLatLng;
    // 3. Fallback: map center
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
    // Recompute distance origin each time (GPS may have updated since search)
    lastPriorityCenter = getActivePriorityCenter();
    const center = lastPriorityCenter;
    const hasFilter = activePlaceFilters.length > 0;

    let derived = unfilteredSearchResults;
    if (hasFilter) {
        const tokens = activePlaceFilters;
        derived = derived.filter(place => placeMatchesAnyToken(place, tokens));
    }

    // ── Force-include the mega-pin matched place ──
    // The searched location's draw-search counterpart must always survive
    // filtering so the red pin stays enriched and clickable.  Without this,
    // changing filters can silently remove the mega-pin place from the list,
    // causing stale-index bugs where a *different* blue marker gets suppressed.
    if (hasFilter && searchAddressMarker && map.hasLayer(searchAddressMarker)) {
        const enr = searchAddressMarker._searchEnrichment;
        if (enr && enr._megaPin && enr._megaPinPlace) {
            if (!derived.includes(enr._megaPinPlace)) {
                derived.push(enr._megaPinPlace);
                console.log(`[Mega pin] Force-included "${enr._megaPinPlace.name}" in filtered results`);
            }
        }
    }

    // When a text filter is active, stamp each result with a relevance tier
    // so we can sort by tier first, then by the user's chosen sort mode
    // within each tier.  This is the Google Maps approach: an exact name
    // match ALWAYS beats a partial match regardless of distance/rating.
    //
    // Tier 0 = phrase-level match  (relevance >= 0.90)
    // Tier 1 = all-tokens match    (relevance >= 0.60)
    // Tier 2 = partial / weak      (everything else)
    let tierMap = null;
    if (hasFilter) {
        const tokens = activePlaceFilters;
        tierMap = new Map();
        for (const place of derived) {
            const rel = computeNameRelevance(tokens, place.name);
            let tier;
            if (rel >= 0.90) tier = 0;       // Tier A – phrase match
            else if (rel >= 0.60) tier = 1;  // Tier B – all tokens
            else tier = 2;                    // Tier C – partial
            tierMap.set(place, { tier, rel });
        }
    }

    const sorted = derived.slice();
    if (activeSortMode === 'alphabetical') {
        if (tierMap) {
            sorted.sort((a, b) => {
                const ta = tierMap.get(a), tb = tierMap.get(b);
                if (ta.tier !== tb.tier) return ta.tier - tb.tier;
                return compareByAlphabetical(a, b);
            });
        } else {
            sorted.sort(compareByAlphabetical);
        }
    } else if (activeSortMode === 'rating') {
        if (tierMap) {
            sorted.sort((a, b) => {
                const ta = tierMap.get(a), tb = tierMap.get(b);
                if (ta.tier !== tb.tier) return ta.tier - tb.tier;
                return compareByRating(a, b);
            });
        } else {
            sorted.sort(compareByRating);
        }
    } else {
        // Distance mode (default)
        if (tierMap && center) {
            sorted.sort((a, b) => {
                const ta = tierMap.get(a), tb = tierMap.get(b);
                if (ta.tier !== tb.tier) return ta.tier - tb.tier;
                // Within same tier, use fine-grained relevance as secondary
                // (e.g., exact phrase > fuzzy phrase within Tier A)
                if (ta.rel !== tb.rel) return tb.rel - ta.rel;
                return compareByDistance(a, b, center);
            });
        } else if (tierMap) {
            // No center available — sort by relevance only
            sorted.sort((a, b) => {
                const ta = tierMap.get(a), tb = tierMap.get(b);
                if (ta.tier !== tb.tier) return ta.tier - tb.tier;
                return tb.rel - ta.rel;
            });
        } else if (center) {
            sorted.sort((a, b) => compareByDistance(a, b, center));
        }
    }

    allSearchResults = sorted;

    // Mega pin refresh: if the search pin exists, re-enrich it with draw search data
    _refreshMegaPin();

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
let searchAddressMarker = null; // Persistent marker for searched address
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

    // Reset mega-pin enrichment so stale matches from a prior draw search
    // don't leak into the new results via the force-include path.
    // _refreshMegaPin will re-match against the fresh results.
    if (searchAddressMarker && searchAddressMarker._searchEnrichment) {
        const enr = searchAddressMarker._searchEnrichment;
        enr._megaPin = false;
        enr._megaPinPlace = null;
        enr._megaPinIndex = -1;
    }

    // Capture map center as the origin for Direction Mode fallback URLs
    const center = map.getCenter();
    drawSearchOrigin = [center.lat, center.lng];

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
            const headerPad = getMobileHeaderPad();
            const toasterVisibleH = mapEl ? mapEl.offsetHeight * 0.5 : 0;
            const { center: openCenter, zoom: rawOpenZoom } = calculatePolygonFit(
                currentPolygon, map,
                5 + headerPad, 5, toasterVisibleH + 5, 5
            );
            fitStateResultsOpen = {
                center: openCenter,
                zoom: Math.round(rawOpenZoom * 100) / 100
            };

            // State 2: lip-peeked (only 52px lip visible at bottom)
            const { center: lipCenter, zoom: rawLipZoom } = calculatePolygonFit(
                currentPolygon, map,
                5 + headerPad, 5, TOASTER_LIP_HEIGHT + 5, 5
            );
            fitStateLipPeeked = {
                center: lipCenter,
                zoom: Math.round(rawLipZoom * 100) / 100
            };

            // Apply the results-open fit.
            applyPolygonFit(fitStateResultsOpen);
        }

        // Place person marker at user's GPS location
        addUserLocationMarker();

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
 * Minimum enclosing circle of 2D points (Welzl's algorithm, O(n) expected).
 * Input: array of [x, y] pairs.  Returns { cx, cy, r }.
 */
function _welzlMinCircle(points) {
    function dist2(a, b) {
        return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    }
    function circFrom2(a, b) {
        return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2,
                 r2: dist2(a, b) / 4 };
    }
    function circFrom3(a, b, c) {
        const D = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
        if (Math.abs(D) < 1e-14) {
            const d1 = dist2(a, b), d2 = dist2(b, c), d3 = dist2(a, c);
            if (d1 >= d2 && d1 >= d3) return circFrom2(a, b);
            if (d2 >= d3) return circFrom2(b, c);
            return circFrom2(a, c);
        }
        const A = a[0] * a[0] + a[1] * a[1];
        const B = b[0] * b[0] + b[1] * b[1];
        const C = c[0] * c[0] + c[1] * c[1];
        const cx = (A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / D;
        const cy = (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / D;
        return { cx, cy, r2: dist2([cx, cy], a) };
    }
    function contains(circ, p) {
        return dist2([circ.cx, circ.cy], p) <= circ.r2 * (1 + 1e-10) + 1e-20;
    }

    // Iterative Welzl (avoids stack overflow on large vertex sets)
    const P = [...points];
    for (let i = P.length - 1; i > 0; i--) {            // Fisher-Yates shuffle
        const j = Math.floor(Math.random() * (i + 1));
        [P[i], P[j]] = [P[j], P[i]];
    }
    let D = { cx: P[0][0], cy: P[0][1], r2: 0 };
    for (let i = 1; i < P.length; i++) {
        if (!contains(D, P[i])) {
            D = { cx: P[i][0], cy: P[i][1], r2: 0 };
            for (let j = 0; j < i; j++) {
                if (!contains(D, P[j])) {
                    D = circFrom2(P[i], P[j]);
                    for (let k = 0; k < j; k++) {
                        if (!contains(D, P[k])) {
                            D = circFrom3(P[i], P[j], P[k]);
                        }
                    }
                }
            }
        }
    }
    D.r = Math.sqrt(D.r2);
    return D;
}

/**
 * Convert a polygon (array of [lat, lng] pairs) to the smallest bounding
 * circle for Google Nearby Search's locationRestriction.
 *
 * Uses Welzl's minimum enclosing circle algorithm on an equirectangular
 * projection of the vertices, then converts back to lat/lng + meters.
 */
function polygonToBoundingCircle(polygonPoints) {
    if (!polygonPoints || polygonPoints.length < 3) return null;

    // Project to local equirectangular so circles are true circles on the ground
    const refLat = polygonPoints.reduce((s, p) => s + p[0], 0) / polygonPoints.length;
    const cosLat = Math.cos(refLat * Math.PI / 180);
    const projected = polygonPoints.map(p => [p[1] * cosLat, p[0]]);

    // Minimum enclosing circle in projected space
    const mec = _welzlMinCircle(projected);

    // Unproject center back to lat/lng
    const centerLat = mec.cy;
    const centerLng = mec.cx / cosLat;
    const center = [centerLat, centerLng];

    // Actual radius in meters via Haversine (guarantees all vertices enclosed)
    let maxRadius = 0;
    for (const point of polygonPoints) {
        const dist = calculateDistance(center, point);
        if (dist > maxRadius) maxRadius = dist;
    }

    // Cap at 50 km (Google's max).  No padding — the circle already
    // contains the entire polygon.
    const radius = Math.min(maxRadius, 50000);

    return {
        center: { latitude: center[0], longitude: center[1] },
        radius: radius
    };
}

/**
 * Find a point guaranteed to be inside the polygon.
 * Uses the geometric centroid first; if it falls outside (e.g. donut/hole),
 * searches midpoints and vertex offsets until one is found inside.
 */
function findPointInsidePolygon(polygonPoints) {
    const centroid = getPolygonCentroid(polygonPoints);
    if (!centroid) return null;

    // Fast path: centroid is inside (convex and most concave shapes)
    if (pointInPolygon(centroid, polygonPoints)) return centroid;

    // Centroid is outside (donut, C-shape, etc.)
    // Try midpoints between centroid and each vertex
    for (const v of polygonPoints) {
        const mid = [(centroid[0] + v[0]) / 2, (centroid[1] + v[1]) / 2];
        if (pointInPolygon(mid, polygonPoints)) return mid;
    }

    // Try points nudged slightly inward from each vertex toward centroid
    for (const v of polygonPoints) {
        const nudged = [
            v[0] + 0.01 * (centroid[0] - v[0]),
            v[1] + 0.01 * (centroid[1] - v[1])
        ];
        if (pointInPolygon(nudged, polygonPoints)) return nudged;
    }

    // Try midpoints of each polygon edge
    for (let i = 0; i < polygonPoints.length - 1; i++) {
        const a = polygonPoints[i];
        const b = polygonPoints[i + 1];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        // Offset slightly perpendicular to the edge
        const dx = b[1] - a[1];
        const dy = -(b[0] - a[0]);
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const offset = [(mid[0] + dy / len * 0.0001), (mid[1] + dx / len * 0.0001)];
        if (pointInPolygon(offset, polygonPoints)) return offset;
        // Try the other side
        const offset2 = [(mid[0] - dy / len * 0.0001), (mid[1] - dx / len * 0.0001)];
        if (pointInPolygon(offset2, polygonPoints)) return offset2;
    }

    // Last resort: return centroid anyway
    console.warn('[findPointInsidePolygon] Could not find interior point, using centroid');
    return centroid;
}

/**
 * Search for businesses within a polygon using Google Nearby Search (New).
 * Uses POPULARITY ranking so important/large places aren't pushed out by
 * 20 tiny shops closer to center.  Makes 4 parallel requests (one per
 * type group), combines, deduplicates, then filters to the polygon boundary.
 */
async function searchPlacesWithGoogle(polygonPoints, progressCallback) {
    // ── Search-area validation (closure-scoped limits — tamper-resistant) ──
    const guardResult = _searchGuard.validateSearchArea(polygonPoints);
    if (!guardResult.ok) {
        throw new Error('Search blocked: ' + guardResult.reason);
    }

    const circle = polygonToBoundingCircle(polygonPoints);
    if (!circle) throw new Error('Could not compute search area from polygon');

    if (progressCallback) progressCallback('Searching Google Places...');

    const typeGroups = GOOGLE_TYPE_GROUPS.slice(0, _searchGuard.getMaxTypeGroups());

    // Make parallel requests for each type group
    const promises = typeGroups.map((types, i) => {
        return fetchNearbyPlaces(types, circle);
    });

    const results = await Promise.all(promises);

    // Combine and deduplicate by Google place ID
    const placeMap = new Map();
    let totalRaw = 0;
    for (let i = 0; i < results.length; i++) {
        const batch = results[i];
        totalRaw += batch.length;
        for (const place of batch) {
            if (place.place_id && !placeMap.has(place.place_id)) {
                placeMap.set(place.place_id, place);
            }
        }
    }

    const uniquePlaces = Array.from(placeMap.values());
    console.log(`[Google Places] ${totalRaw} raw results → ${uniquePlaces.length} unique places`);

    if (progressCallback) progressCallback(`Filtering ${uniquePlaces.length} places to polygon...`);

    // Filter strictly to polygon boundary
    const filtered = uniquePlaces.filter(place => {
        if (!place.coordinates) return false;
        return pointInPolygon(place.coordinates, polygonPoints);
    });

    console.log(`[Google Places] ${filtered.length} places inside polygon (filtered from ${uniquePlaces.length})`);
    return filtered;
}

/**
 * Fetch up to 20 places from Google Nearby Search for a set of types.
 * Returns normalized place objects ready for display.
 */
async function fetchNearbyPlaces(includedTypes, circle, rankPreference = 'POPULARITY') {
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
                rankPreference: rankPreference
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

        const permClosed = data.places.filter(gp => gp.businessStatus === 'CLOSED_PERMANENTLY');

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
                    openNow: gp.currentOpeningHours?.openNow ?? null,
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
 * Search for places by free-text query using Google Places Text Search (New).
 * Used for category searches ("tacos") and business name searches ("Trader Joes").
 *
 * @param {string} textQuery  — the search term (e.g. "tacos", "Trader Joes")
 * @param {{lat: number, lng: number}} center — location bias center
 * @param {number} radiusM   — bias radius in metres (default 8000 ≈ 5 miles)
 * @param {number} maxResults — max results to return (1–20, default 5)
 * @returns {Array} normalized place objects (same shape as fetchNearbyPlaces)
 */
async function fetchTextSearchPlaces(textQuery, center, radiusM = 8000, maxResults = 5) {
    if (!canMakeGooglePlacesCall()) {
        console.warn('[Google Text Search] Daily limit reached — skipping');
        return [];
    }

    try {
        const response = await fetch(LASO_PROXY_URL + '/textsearch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-FieldMask': GOOGLE_FIELD_MASK
            },
            body: JSON.stringify({
                textQuery: textQuery,
                locationBias: {
                    circle: {
                        center: { latitude: center.lat, longitude: center.lng },
                        radius: radiusM
                    }
                },
                maxResultCount: Math.min(maxResults, 20)
            })
        });

        _recordGoogleApiCall();

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Google Text Search] Failed (${response.status}):`, errorText);
            return [];
        }

        const data = await response.json();
        if (!data.places || data.places.length === 0) return [];

        const permClosed = data.places.filter(gp => gp.businessStatus === 'CLOSED_PERMANENTLY');

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
                    openNow: gp.currentOpeningHours?.openNow ?? null,
                    google: {
                        rating: rating,
                        userRatingCount: userRatingCount,
                        googleMapsUri: googleMapsUri,
                        displayName: displayName
                    }
                };
            });
    } catch (err) {
        console.error('[Google Text Search] Fetch error:', err);
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
    const openStatusHtml = place.openNow === true
        ? '<span class="open-status is-open">Open</span>'
        : place.openNow === false
            ? '<span class="open-status is-closed">Closed</span>'
            : '';
    const ratingHtml = hasRating
        ? `<i class="fas fa-star"></i> ${place.google.rating.toFixed(1)}${place.google.userRatingCount ? ` <span class="rating-count">(${place.google.userRatingCount})</span>` : ''}${openStatusHtml}`
        : `<i class="fas fa-star"></i> <span class="unavailable">Unavailable</span>${openStatusHtml}`;

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
                    <a href="${googleHref}" target="${googleTarget}" rel="noopener" class="map-btn google directions-capable" data-card-index="${index}" data-dest-lat="${lat}" data-dest-lng="${lng}" data-search-term="${searchTerm.replace(/"/g, '&quot;')}" data-map-provider="google" title="Google Maps">
                        <i class="fab fa-google"></i> <span>Google</span>
                    </a>
                    <a href="${appleHref}" target="${appleTarget}" rel="noopener" class="map-btn apple directions-capable" data-card-index="${index}" data-dest-lat="${lat}" data-dest-lng="${lng}" data-dest-name="${name.replace(/"/g, '&quot;')}" data-map-provider="apple" title="Apple Maps">
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
                '<a href="' + googleMapsUrl + '" target="_blank" rel="noopener" title="Google Maps" class="directions-capable" data-dest-lat="' + lat + '" data-dest-lng="' + lng + '" data-search-term="' + searchTerm.replace(/"/g, '&quot;') + '" data-map-provider="google" style="width:36px;height:36px;border-radius:50%;background:#f8f9fa;display:flex;align-items:center;justify-content:center;text-decoration:none;color:#4285f4;font-size:13px;border:1px solid #e0e0e0;">' +
                    '<i class="fab fa-google"></i>' +
                '</a>' +
                '<a href="' + appleMapsUrl + '" target="_blank" rel="noopener" title="Apple Maps" class="directions-capable" data-dest-lat="' + lat + '" data-dest-lng="' + lng + '" data-dest-name="' + name.replace(/"/g, '&quot;') + '" data-map-provider="apple" style="width:36px;height:36px;border-radius:50%;background:#f8f9fa;display:flex;align-items:center;justify-content:center;text-decoration:none;color:#333;font-size:15px;border:1px solid #e0e0e0;">' +
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

    // Shared easing: ease-in → constant speed → ease-out
    const pinBezier = 'cubic-bezier(0.65, 0, 0.35, 1)';

    if (highlighted) {
        // 28 × 1.66 ≈ 46, icon font 13 × 1.66 ≈ 22
        marker.setIcon(L.divIcon({
            className: 'custom-marker',
            html: `<div style="width:46px;height:46px;border-radius:50%;background:#34a853;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.4);animation:marker-highlight-in 0.3s ${pinBezier} both;"><i class="fas ${iconClass}" style="color:#fff;font-size:22px;"></i></div>`,
            iconSize: [46, 46],
            iconAnchor: [23, 23]
        }));
        marker.setZIndexOffset(10000);
        _highlightedMarkerIndex = index;
    } else {
        if (_highlightedMarkerIndex === index) _highlightedMarkerIndex = null;

        // Animate the green pin shrinking before swapping to blue
        const iconEl = marker._icon;
        const pinDiv = iconEl && iconEl.querySelector('div');
        if (pinDiv) {
            const epoch = _clearEpoch;
            pinDiv.style.animation = `marker-highlight-out 0.3s ${pinBezier} forwards`;
            pinDiv.addEventListener('animationend', () => {
                if (_clearEpoch !== epoch) return; // stale — clearAll was called
                marker.setIcon(L.divIcon({
                    className: 'custom-marker',
                    html: `<div style="width:28px;height:28px;border-radius:50%;background:#4285f4;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);"><i class="fas ${iconClass}" style="color:#fff;font-size:13px;"></i></div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 14]
                }));
                marker.setZIndexOffset(0);
            }, { once: true });
        } else {
            // Fallback: instant swap if DOM element not available
            marker.setIcon(L.divIcon({
                className: 'custom-marker',
                html: `<div style="width:28px;height:28px;border-radius:50%;background:#4285f4;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);"><i class="fas ${iconClass}" style="color:#fff;font-size:13px;"></i></div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            }));
            marker.setZIndexOffset(0);
        }
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

/**
 * Compute a map center such that when flyTo'd, the given latLng appears
 * centered in the available canvas above the overlay — NOT at the full
 * canvas center.  Uses Leaflet projection at the target zoom so the
 * offset is accurate regardless of current vs target zoom level.
 *
 * For results-open (midway): overlay = 50% of map → offset = mapH/4
 * For results-peeked (lip):  overlay = TOASTER_LIP_HEIGHT → offset = lip/2
 *
 * Returns the original latLng unchanged when no overlay is active or
 * on desktop (where there is no bottom-sheet overlay).
 */
function _pinCenterForOverlay(latLng, targetZoom) {
    if (!isMobileView()) return latLng;
    const mapEl = document.getElementById('map');
    if (!mapEl) return latLng;

    const fullH = mapEl.offsetHeight;
    const headerH = getMobileHeaderPad();
    let overlayH = 0;

    // Determine overlay height from the current CSS state.
    // results-open = toaster at 50% (midway), lip/peeked only = TOASTER_LIP_HEIGHT
    if (document.body.classList.contains('results-open')) {
        overlayH = fullH * 0.5;
    } else if (document.body.classList.contains('results-peeked')) {
        overlayH = TOASTER_LIP_HEIGHT;
    }

    if (overlayH <= 0 && headerH <= 0) return latLng;

    // Visible canvas runs from headerH (top, behind fixed header) to
    // (fullH - overlayH) (bottom, above the toaster).
    // Its center = (headerH + fullH - overlayH) / 2.
    // flyTo centers at fullH / 2.
    // Shift = fullH/2 - (headerH + fullH - overlayH)/2 = (overlayH - headerH) / 2
    const offsetPx = (overlayH - headerH) / 2;

    const ll = latLng instanceof L.LatLng ? latLng : L.latLng(latLng[0], latLng[1]);
    const pinPx = map.project(ll, targetZoom);

    // Rotate the offset vector by the current map bearing so it always
    // shifts in the "screen-down" direction regardless of map rotation.
    // When bearing = 0 this reduces to the original pure-Y offset.
    const bearing = _getMapBearing();
    const rad = bearing * Math.PI / 180;
    const dx = offsetPx * Math.sin(rad);
    const dy = offsetPx * Math.cos(rad);

    return map.unproject(L.point(pinPx.x + dx, pinPx.y + dy), targetZoom);
}

/**
 * After a flyTo places a point at the full-canvas center, pan so it
 * sits at the center of the *available* canvas (above the results
 * overlay).  Uses getBoundingClientRect() for all overlay states —
 * no magic numbers.  Same approach as panToMarkerInView for business pins.
 * @param {L.LatLng|number[]} latLng — the point that should be centered
 * @returns {boolean} true if a panBy was initiated (caller should wait
 *   for the next moveend), false if no correction was needed.
 */
function _panToAvailableCanvas(latLng) {
    if (!isMobileView()) return false;
    const mapEl = document.getElementById('map');
    const sidebar = document.getElementById('results-sidebar');
    if (!mapEl || !sidebar) return false;

    const hasOverlay = sidebar.classList.contains('open') ||
                       document.body.classList.contains('results-peeked');
    if (!hasOverlay) return false;

    const sidebarRect = sidebar.getBoundingClientRect();
    const mapRect   = mapEl.getBoundingClientRect();
    const headerH   = getMobileHeaderPad();
    // Visible canvas: from header bottom to sidebar top (in container coords)
    const visibleTop = headerH - mapRect.top;
    const visibleBottom = sidebarRect.top - mapRect.top;
    const visibleH = visibleBottom - visibleTop;
    if (visibleH <= 50) return false;

    const pt = map.latLngToContainerPoint(
        latLng instanceof L.LatLng ? latLng : L.latLng(latLng[0], latLng[1])
    );
    const dx = pt.x - mapEl.offsetWidth / 2;
    const dy = pt.y - (visibleTop + visibleH / 2);
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return false;

    map.panBy([dx, dy], { animate: true, duration: 0.25 });
    return true;
}

function panToMarkerInView(marker) {
    const markerLatLng = marker.getLatLng();
    if (isMobileView()) {
        const sidebar = document.getElementById('results-sidebar');
        const mapEl = document.getElementById('map');
        if (sidebar && mapEl) {
            const sidebarRect = sidebar.getBoundingClientRect();
            const mapRect = mapEl.getBoundingClientRect();
            const headerH = getMobileHeaderPad();
            // Visible canvas: from header bottom to sidebar top (in container coords)
            const visibleTop = headerH - mapRect.top;
            const visibleBottom = sidebarRect.top - mapRect.top;
            const visibleH = visibleBottom - visibleTop;
            if (visibleH > 50) {
                const markerPoint = map.latLngToContainerPoint(markerLatLng);
                const desiredX = mapEl.offsetWidth / 2;
                const desiredY = visibleTop + visibleH / 2;
                map.panBy([markerPoint.x - desiredX, markerPoint.y - desiredY]);
                return;
            }
        }
    }
    map.panTo(markerLatLng);
}

function updateAllMarkers() {
    // ── 1. Close any open popup FIRST so it can't linger as a detached layer ──
    _isChangingSelection = true;
    map.closePopup();
    _isChangingSelection = false;

    // ── 2. Remove all tracked business markers ──
    markers.forEach(marker => {
        if (!marker.isDrawingPoint) {
            if (map.hasLayer(marker)) map.removeLayer(marker);
        }
    });
    markers = markers.filter(m => m.isDrawingPoint);

    // ── 3. Stray-layer sweep — catch any markers/popups that leaked outside
    //       the tracked `markers` array (e.g. from race conditions, mega-pin
    //       duplication, or async enrichment callbacks).  Preserve only the
    //       red search pin, drawing-point markers, tile layers, and controls.
    const strayLayers = [];
    map.eachLayer(layer => {
        if (layer === searchAddressMarker) return;          // keep red pin
        if (layer === wildPinMarker) return;               // keep wild pin
        if (layer === userLocationMarker) return;           // keep person marker
        if (layer instanceof L.TileLayer) return;           // keep tiles
        if (markers.includes(layer)) return;                // keep tracked drawing points
        if (layer instanceof L.Polygon || layer instanceof L.Polyline) return; // keep polygon
        if (layer instanceof L.Marker || layer instanceof L.Popup) {
            strayLayers.push(layer);
        }
    });
    if (strayLayers.length > 0) {
        console.warn(`[updateAllMarkers] Swept ${strayLayers.length} stray layer(s)`);
        strayLayers.forEach(layer => map.removeLayer(layer));
    }

    // Reset highlight state — the old highlighted marker no longer exists
    _highlightedMarkerIndex = null;

    // ── 4. Detect which draw-search place is the mega-pin duplicate ──
    // If the red search pin exists and has a mega-pin match, we suppress
    // the blue marker for that place (the red pin already shows its data).
    // Compare by object reference (immune to stale-index bugs).
    let suppressPlace = null;
    if (searchAddressMarker && map.hasLayer(searchAddressMarker)) {
        const enrichment = searchAddressMarker._searchEnrichment;
        if (enrichment && enrichment._megaPin && enrichment._megaPinPlace) {
            suppressPlace = enrichment._megaPinPlace;
            console.log(`[Mega pin] Suppressing blue marker for "${suppressPlace.name}" — red pin covers it`);
        }
    }

    // Add markers for ALL results, not just current page
    allSearchResults.forEach((place, index) => {
        if (!place.coordinates) return;

        // Skip creating blue marker if this place is already represented by the red search pin
        if (place === suppressPlace) {
            console.log(`[Mega pin] Skipped blue marker #${index}: "${place.name}" (duplicate of red search pin)`);
            return;
        }

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
        marker.bindPopup(buildPopupContent(place, index, false), { maxWidth: 250, minWidth: 180, autoPan: false });

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
                    if (_highlightedMarkerIndex !== index) {
                        clearHighlightedMarker();
                        setMarkerHighlighted(marker, true);
                    }
                    selectedPlaceIndex = index;
                    // Mark card active so it's highlighted when overlay reopens
                    document.querySelectorAll('.place-card').forEach(c => c.classList.remove('active'));
                    const card = document.getElementById(`place-card-${index}`);
                    if (card) card.classList.add('active');
                    _closedByPinTap = true;   // tell closeSidebar to reopen popup after fly
                    closeSidebar();
                } else {
                    // Overlay is peeked or hidden: normal pin tap behavior.
                    // If this marker is already highlighted (green+large), just
                    // open the popup — no shrink-then-grow animation needed.
                    if (_highlightedMarkerIndex !== index) {
                        clearHighlightedMarker();
                        setMarkerHighlighted(marker, true);
                    }
                    selectedPlaceIndex = index;
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
            // — but skip the animation if this marker is already highlighted.
            const alreadyHighlighted = (_highlightedMarkerIndex === index);
            if (!alreadyHighlighted) clearHighlightedMarker();
            let marker = markers.find(m => m.placeIndex === index);
            // If no blue marker (suppressed mega pin), use the red search pin.
            // Compare by object reference — immune to stale-index bugs.
            const megaPlace = searchAddressMarker?._searchEnrichment?._megaPinPlace;
            const isMegaPinFallback = !marker && searchAddressMarker
                && megaPlace && allSearchResults[index] === megaPlace;
            if (isMegaPinFallback) marker = searchAddressMarker;

            if (marker) {
                // Don't change the red search pin's icon — only highlight blue markers
                if (!isMegaPinFallback && !alreadyHighlighted) setMarkerHighlighted(marker, true);
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
let _lastSearchedAddress = null;  // tracks the string that produced the current pin
let _lastSearchLocation = null;   // { lat, lng } GPS coords used for that search
const _SEARCH_MOVE_THRESHOLD = 500; // meters — re-search place names if user moved this far

// ── localStorage geocode cache ──────────────────────────────────────────
const _GEO_CACHE_KEY = 'laso_geocode_cache_v2';
const _GEO_CACHE_MAX = 200;

function _loadGeoCache() {
    try {
        return JSON.parse(localStorage.getItem(_GEO_CACHE_KEY)) || {};
    } catch { return {}; }
}
function _saveGeoCache(cache) {
    // Evict oldest entries when over limit
    const keys = Object.keys(cache);
    if (keys.length > _GEO_CACHE_MAX) {
        keys.sort((a, b) => (cache[a]._ts || 0) - (cache[b]._ts || 0));
        while (keys.length > _GEO_CACHE_MAX) delete cache[keys.shift()];
    }
    try { localStorage.setItem(_GEO_CACHE_KEY, JSON.stringify(cache)); } catch {}
}
function _geoCacheKey(address) {
    return address.trim().toLowerCase().replace(/['\u2018\u2019]/g, '').replace(/\s+/g, ' ');
}

/**
 * Return the user's actual location for geocoder proximity bias.
 * Priority: live GPS → saved GPS → map center (last resort).
 * This ensures searches like "Trader Joes" find the one near the
 * user's real position, not wherever the map last flew to.
 */
function _getUserLocation() {
    // Live GPS fix from watchPosition / getCurrentPosition
    if (window._userLatLng) {
        return { lat: window._userLatLng[0], lng: window._userLatLng[1] };
    }
    // Saved GPS from previous session
    const saved = getSavedLocation();
    if (saved) {
        return { lat: saved[0], lng: saved[1] };
    }
    // Last resort: wherever the map is pointing
    return map.getCenter();
}

/**
 * Heuristic: does the query look like a street address (vs a place name)?
 *
 * Addresses are cached because "123 Main St, New York" always resolves
 * to the same place.  Place names like "Trader Joes" or "Starbucks"
 * are NOT cached because they resolve differently based on proximity.
 *
 * Signals that indicate an address:
 *   • Starts with a digit  → "123 Main St", "42 Broadway"
 *   • Contains a street-type word → St, Ave, Blvd, Dr, Rd, Ln, Way, …
 *   • Contains a 5-digit ZIP code → "10001"
 *   • Contains a US state abbreviation after a comma → ", NY"
 */
const _STREET_TYPES = /\b(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|ter|terrace|trl|trail|loop|run)\b/i;
const _ZIP_CODE = /\b\d{5}(-\d{4})?\b/;
const _STATE_ABBR = /,\s*[A-Z]{2}\b/;

function _looksLikeAddress(query) {
    const q = query.trim();
    // Starts with a house number (digit followed by space + word)
    if (/^\d+\s+\w/.test(q)) return true;
    // Contains a street-type suffix
    if (_STREET_TYPES.test(q)) return true;
    // Contains a ZIP code
    if (_ZIP_CODE.test(q)) return true;
    // Contains ", NY" style state abbreviation
    if (_STATE_ABBR.test(q)) return true;
    return false;
}

/**
 * Strip apostrophes / curly quotes and lowercase for name comparison.
 * Allows "trader joes" to match "Trader Joe's" etc.
 */
function _normalizeForMatch(str) {
    return str.replace(/['\u2018\u2019]/g, '').toLowerCase();
}

// Overpass API endpoint (free, used for category search + enrichment)
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// ── Generic category → Overpass tag mapping ─────────────────────────────
// When the user types a generic word like "sushi" or "gas station", we
// bypass Nominatim/Photon (which look for a PLACE with that name) and
// instead query Overpass for the nearest POI matching the OSM tag.
//
// Each entry: { filter: '<Overpass tag filter>', label: '<display name>' }
// The filter is injected into: node{filter}(around:R,lat,lon);
const _CATEGORY_MAP = {
    // ── Cuisine / food types ──
    'sushi':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"sushi"]', label: 'sushi restaurant' },
    'pizza':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"pizza"]', label: 'pizza place' },
    'tacos':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"mexican|taco"]', label: 'taco place' },
    'taco':         { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"mexican|taco"]', label: 'taco place' },
    'burgers':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"burger"]', label: 'burger place' },
    'burger':       { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"burger"]', label: 'burger place' },
    'chinese':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"chinese"]', label: 'Chinese restaurant' },
    'thai':         { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"thai"]', label: 'Thai restaurant' },
    'indian':       { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"indian"]', label: 'Indian restaurant' },
    'mexican':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"mexican"]', label: 'Mexican restaurant' },
    'italian':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"italian|pasta"]', label: 'Italian restaurant' },
    'ramen':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"ramen|japanese"]', label: 'ramen shop' },
    'bbq':          { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"bbq|barbecue"]', label: 'BBQ restaurant' },
    'barbecue':     { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"bbq|barbecue"]', label: 'BBQ restaurant' },
    'seafood':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"seafood|fish"]', label: 'seafood restaurant' },
    'korean':       { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"korean"]', label: 'Korean restaurant' },
    'vietnamese':   { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"vietnamese|pho"]', label: 'Vietnamese restaurant' },
    'pho':          { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"vietnamese|pho"]', label: 'pho restaurant' },
    'greek':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"greek"]', label: 'Greek restaurant' },
    'mediterranean':{ filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"mediterranean"]', label: 'Mediterranean restaurant' },
    'vegan':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"vegan"]', label: 'vegan restaurant' },
    'vegetarian':   { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"vegetarian|vegan"]', label: 'vegetarian restaurant' },
    'wings':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"wings|chicken"]', label: 'wings place' },
    'chicken':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"chicken"]', label: 'chicken restaurant' },
    'sandwich':     { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"sandwich|sub|deli"]', label: 'sandwich shop' },
    'sandwiches':   { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"sandwich|sub|deli"]', label: 'sandwich shop' },
    'deli':         { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"deli|sandwich"]', label: 'deli' },
    'ice cream':    { filter: '["amenity"~"restaurant|fast_food|ice_cream"]["cuisine"~"ice_cream"]', label: 'ice cream shop' },
    'donuts':       { filter: '["amenity"~"restaurant|fast_food|cafe"]["cuisine"~"donut"]', label: 'donut shop' },
    'doughnuts':    { filter: '["amenity"~"restaurant|fast_food|cafe"]["cuisine"~"donut"]', label: 'donut shop' },
    'bagels':       { filter: '["amenity"~"restaurant|fast_food|cafe"]["cuisine"~"bagel"]', label: 'bagel shop' },
    'breakfast':    { filter: '["amenity"~"restaurant|cafe"]["cuisine"~"breakfast|brunch"]', label: 'breakfast spot' },
    'brunch':       { filter: '["amenity"~"restaurant|cafe"]["cuisine"~"breakfast|brunch"]', label: 'brunch spot' },
    'noodles':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"noodle|ramen|pho"]', label: 'noodle shop' },
    'soup':         { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"soup"]', label: 'soup place' },
    'steak':        { filter: '["amenity"~"restaurant"]["cuisine"~"steak"]', label: 'steakhouse' },
    'steakhouse':   { filter: '["amenity"~"restaurant"]["cuisine"~"steak"]', label: 'steakhouse' },
    'wings':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"wings|chicken"]', label: 'wings place' },
    'salad':        { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"salad|healthy"]', label: 'salad place' },
    'acai':         { filter: '["amenity"~"restaurant|fast_food|cafe"]["cuisine"~"acai|juice"]', label: 'açaí bowl shop' },
    'falafel':      { filter: '["amenity"~"restaurant|fast_food"]["cuisine"~"falafel|middle_eastern"]', label: 'falafel place' },
    'crepes':       { filter: '["amenity"~"restaurant|fast_food|cafe"]["cuisine"~"crepe|french"]', label: 'crêpe place' },
    'dim sum':      { filter: '["amenity"~"restaurant"]["cuisine"~"dim_sum|chinese"]', label: 'dim sum restaurant' },
    'curry':        { filter: '["amenity"~"restaurant"]["cuisine"~"curry|indian|thai"]', label: 'curry restaurant' },
    'pasta':        { filter: '["amenity"~"restaurant"]["cuisine"~"pasta|italian"]', label: 'pasta place' },
    'tapas':        { filter: '["amenity"~"restaurant"]["cuisine"~"tapas|spanish"]', label: 'tapas bar' },
    'hibachi':      { filter: '["amenity"~"restaurant"]["cuisine"~"hibachi|japanese|teppanyaki"]', label: 'hibachi restaurant' },
    'buffet':       { filter: '["amenity"~"restaurant"]["cuisine"~"buffet"]', label: 'buffet' },

    // ── Drinks ──
    'coffee':       { filter: '["amenity"="cafe"]', label: 'coffee shop' },
    'cafe':         { filter: '["amenity"="cafe"]', label: 'café' },
    'tea':          { filter: '["amenity"~"cafe"]["cuisine"~"tea|bubble_tea"]', label: 'tea shop' },
    'boba':         { filter: '["amenity"~"cafe|fast_food"]["cuisine"~"bubble_tea"]', label: 'boba shop' },
    'bubble tea':   { filter: '["amenity"~"cafe|fast_food"]["cuisine"~"bubble_tea"]', label: 'bubble tea shop' },
    'smoothie':     { filter: '["amenity"~"cafe|fast_food"]["cuisine"~"juice|smoothie"]', label: 'smoothie shop' },
    'juice':        { filter: '["amenity"~"cafe|fast_food"]["cuisine"~"juice"]', label: 'juice bar' },
    'bar':          { filter: '["amenity"="bar"]', label: 'bar' },
    'pub':          { filter: '["amenity"~"bar|pub"]', label: 'pub' },
    'brewery':      { filter: '["craft"="brewery"]', label: 'brewery' },
    'wine bar':     { filter: '["amenity"="bar"]["cuisine"~"wine"]', label: 'wine bar' },
    'cocktails':    { filter: '["amenity"="bar"]', label: 'cocktail bar' },

    // ── Amenities ──
    'gas station':  { filter: '["amenity"="fuel"]', label: 'gas station', googleTypes: ['gas_station'] },
    'gas':          { filter: '["amenity"="fuel"]', label: 'gas station', googleTypes: ['gas_station'] },
    'fuel':         { filter: '["amenity"="fuel"]', label: 'gas station', googleTypes: ['gas_station'] },
    'pharmacy':     { filter: '["amenity"="pharmacy"]', label: 'pharmacy', googleTypes: ['pharmacy'] },
    'hospital':     { filter: '["amenity"="hospital"]', label: 'hospital', googleTypes: ['hospital'] },
    'bank':         { filter: '["amenity"="bank"]', label: 'bank', googleTypes: ['bank'] },
    'atm':          { filter: '["amenity"="atm"]', label: 'ATM' },
    'gym':          { filter: '["leisure"="fitness_centre"]', label: 'gym', googleTypes: ['gym'] },
    'park':         { filter: '["leisure"="park"]', label: 'park', googleTypes: ['park'] },
    'library':      { filter: '["amenity"="library"]', label: 'library', googleTypes: ['library'] },
    'post office':  { filter: '["amenity"="post_office"]', label: 'post office', googleTypes: ['post_office'] },
    'school':       { filter: '["amenity"~"school"]', label: 'school', googleTypes: ['school'] },
    'church':       { filter: '["amenity"="place_of_worship"]["religion"="christian"]', label: 'church' },
    'mosque':       { filter: '["amenity"="place_of_worship"]["religion"="muslim"]', label: 'mosque' },
    'synagogue':    { filter: '["amenity"="place_of_worship"]["religion"="jewish"]', label: 'synagogue' },
    'parking':      { filter: '["amenity"="parking"]', label: 'parking' },
    'ev charger':   { filter: '["amenity"="charging_station"]', label: 'EV charger' },
    'charging station': { filter: '["amenity"="charging_station"]', label: 'charging station' },
    'restroom':     { filter: '["amenity"="toilets"]', label: 'restroom' },
    'bathroom':     { filter: '["amenity"="toilets"]', label: 'restroom' },
    'playground':   { filter: '["leisure"="playground"]', label: 'playground' },

    // ── Shops ──
    'grocery':      { filter: '["shop"~"supermarket|grocery|convenience"]', label: 'grocery store', googleTypes: ['grocery_store', 'supermarket'] },
    'grocery store': { filter: '["shop"~"supermarket|grocery|convenience"]', label: 'grocery store', googleTypes: ['grocery_store', 'supermarket'] },
    'supermarket':  { filter: '["shop"="supermarket"]', label: 'supermarket', googleTypes: ['supermarket', 'grocery_store'] },
    'convenience store': { filter: '["shop"="convenience"]', label: 'convenience store', googleTypes: ['convenience_store'] },
    'hardware':     { filter: '["shop"="hardware"]', label: 'hardware store', googleTypes: ['hardware_store'] },
    'bookstore':    { filter: '["shop"="books"]', label: 'bookstore', googleTypes: ['book_store'] },
    'bakery':       { filter: '["shop"="bakery"]', label: 'bakery', googleTypes: ['bakery'] },
    'butcher':      { filter: '["shop"="butcher"]', label: 'butcher' },
    'florist':      { filter: '["shop"="florist"]', label: 'florist' },
    'pet store':    { filter: '["shop"="pet"]', label: 'pet store', googleTypes: ['pet_store'] },
    'liquor store': { filter: '["shop"="alcohol"]', label: 'liquor store', googleTypes: ['liquor_store'] },
    'thrift store': { filter: '["shop"~"second_hand|charity"]', label: 'thrift store' },
    'clothing':     { filter: '["shop"="clothes"]', label: 'clothing store' },
    'shoes':        { filter: '["shop"="shoes"]', label: 'shoe store' },
    'electronics':  { filter: '["shop"="electronics"]', label: 'electronics store' },

    // ── Services ──
    'laundromat':   { filter: '["shop"="laundry"]', label: 'laundromat' },
    'laundry':      { filter: '["shop"="laundry"]', label: 'laundromat' },
    'car wash':     { filter: '["amenity"="car_wash"]', label: 'car wash' },
    'dentist':      { filter: '["amenity"="dentist"]', label: 'dentist', googleTypes: ['dentist'] },
    'doctor':       { filter: '["amenity"~"doctors|clinic"]', label: 'doctor', googleTypes: ['doctor'] },
    'veterinarian': { filter: '["amenity"="veterinary"]', label: 'veterinarian', googleTypes: ['veterinary_care'] },
    'vet':          { filter: '["amenity"="veterinary"]', label: 'veterinarian', googleTypes: ['veterinary_care'] },
    'hair salon':   { filter: '["shop"="hairdresser"]', label: 'hair salon', googleTypes: ['hair_care'] },
    'barber':       { filter: '["shop"="hairdresser"]', label: 'barber' },
    'nail salon':   { filter: '["shop"~"beauty|nails"]', label: 'nail salon' },
    'spa':          { filter: '["leisure"~"spa|sauna"]', label: 'spa' },
    'hotel':        { filter: '["tourism"="hotel"]', label: 'hotel', googleTypes: ['hotel'] },
    'motel':        { filter: '["tourism"="motel"]', label: 'motel', googleTypes: ['hotel'] },
    'movie theater':{ filter: '["amenity"="cinema"]', label: 'movie theater', googleTypes: ['movie_theater'] },
    'cinema':       { filter: '["amenity"="cinema"]', label: 'movie theater', googleTypes: ['movie_theater'] },
    'museum':       { filter: '["tourism"="museum"]', label: 'museum' },
    'restaurant':   { filter: '["amenity"="restaurant"]', label: 'restaurant' },
    'fast food':    { filter: '["amenity"="fast_food"]', label: 'fast food' },
};

// Suffixes to strip before matching (e.g. "sushi near me" → "sushi")
const _CATEGORY_STRIP_RE = /\s+(near\s+me|nearby|close\s+by|around\s+here|restaurant|restaurants|food|foods|cuisine|place|places|shop|shops|store|stores)$/i;

/**
 * Check if a search query matches a generic category.
 * Returns the category entry { filter, label } or null.
 */
function _matchCategory(query) {
    if (_looksLikeAddress(query)) return null;
    let q = query.trim().toLowerCase();
    // Check exact match first — protects entries like "fast food" before stripping
    if (_CATEGORY_MAP[q]) return _CATEGORY_MAP[q];
    // Strip common suffixes like "near me", "restaurant", "food", etc.
    q = q.replace(_CATEGORY_STRIP_RE, '').trim();
    // Also strip a second pass (e.g. "sushi restaurant near me" → "sushi restaurant" → "sushi")
    q = q.replace(_CATEGORY_STRIP_RE, '').trim();
    if (_CATEGORY_MAP[q]) return _CATEGORY_MAP[q];
    // Handle plurals: "groceries" → "grocery", "pharmacies" → "pharmacy"
    if (q.endsWith('ies')) {
        const singular = q.slice(0, -3) + 'y';
        if (_CATEGORY_MAP[singular]) return _CATEGORY_MAP[singular];
    }
    // Handle plurals: "supermarkets" → "supermarket", "banks" → "bank"
    if (q.endsWith('s') && !q.endsWith('ss')) {
        const singular = q.slice(0, -1);
        if (_CATEGORY_MAP[singular]) return _CATEGORY_MAP[singular];
    }
    return null;
}

/**
 * Query Overpass for the nearest POI matching an OSM tag filter.
 * Returns a Nominatim-like result object or null.
 */
async function _searchNearestPOI(category, lat, lon) {
    const radius = 10000; // 10 km search radius
    const filter = category.filter;
    const query = `[out:json][timeout:10];(node${filter}(around:${radius},${lat},${lon});way${filter}(around:${radius},${lat},${lon}););out center tags qt;`;

    try {
        const response = await fetch(OVERPASS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(query)}`
        });
        if (!response.ok) return null;
        const data = await response.json();
        const elements = data.elements;
        if (!elements || elements.length === 0) return null;

        // Pick the closest element to (lat, lon)
        let best = null, bestDist = Infinity;
        for (const el of elements) {
            const elLat = el.lat ?? el.center?.lat;
            const elLon = el.lon ?? el.center?.lon;
            if (elLat == null || elLon == null) continue;
            const d = Math.hypot(elLat - lat, elLon - lon);
            if (d < bestDist) { bestDist = d; best = el; }
        }
        if (!best) return null;

        const tags = best.tags || {};
        const elLat = best.lat ?? best.center?.lat;
        const elLon = best.lon ?? best.center?.lon;

        // Build Nominatim-like result for displayGeocodeResult
        const addrParts = [];
        if (tags['addr:housenumber']) addrParts.push(tags['addr:housenumber']);
        if (tags['addr:street']) addrParts.push(tags['addr:street']);
        if (tags['addr:city']) addrParts.push(tags['addr:city']);
        if (tags['addr:state']) addrParts.push(tags['addr:state']);

        return {
            lat: elLat,
            lon: elLon,
            name: tags.name || category.label,
            display_name: tags.name || category.label,
            osm_type: best.type,
            osm_id: best.id,
            address: {
                house_number: tags['addr:housenumber'],
                road: tags['addr:street'],
                city: tags['addr:city'],
                state: tags['addr:state'],
                postcode: tags['addr:postcode']
            },
            _categoryMatch: true,      // flag so we know this came from category search
            _categoryLabel: category.label,
            opening_hours: tags.opening_hours,
            phone: tags.phone || tags['contact:phone'],
            website: tags.website || tags['contact:website'],
        };
    } catch (e) {
        console.warn('[Overpass category search]', e);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────

async function searchAddress() {
    const input = document.getElementById('address-input');
    const address = input.value.trim();

    if (!address) return;

    // Same string already searched and pin is on the map → decide whether
    // to re-search or just recenter.
    //   • Addresses always resolve to the same place → just recenter.
    //   • Place names ("Trader Joes") depend on proximity → re-search if
    //     the user has physically moved since the last search.
    const normAddr = _geoCacheKey(address);
    if (normAddr === _lastSearchedAddress && searchAddressMarker && map.hasLayer(searchAddressMarker)) {
        let shouldReSearch = false;
        if (!_looksLikeAddress(address) && _lastSearchLocation) {
            // Place name — check if user has moved significantly
            const cur = _getUserLocation();
            const dist = calculateDistance(
                [cur.lat, cur.lng],
                [_lastSearchLocation.lat, _lastSearchLocation.lng]
            );
            if (dist > _SEARCH_MOVE_THRESHOLD) {
                shouldReSearch = true;
                console.log(`[searchAddress] Re-searching "${address}" — user moved ${dist.toFixed(0)}m since last search`);
            }
        }
        if (!shouldReSearch) {
            if (_isAtMyLocation) {
                _isAtMyLocation = false;
                _myLocationCenter = null;
                updateMyLocationButtonState();
            }
            const pinLatLng = searchAddressMarker.getLatLng();
            const targetZoom = initialZoom + (isMobileView() ? 2 : 3);
            const flyTarget = _pinCenterForOverlay(pinLatLng, targetZoom);
            isLocationSearchZoom = true;
            map.flyTo(flyTarget, targetZoom, { duration: 1.0 });
            const epoch = _clearEpoch;
            const openPopup = () => {
                if (_clearEpoch !== epoch) return;
                if (map.hasLayer(searchAddressMarker)) searchAddressMarker.openPopup();
            };
            map.once('moveend', () => {
                isLocationSearchZoom = false;
                currentZoomLevel = map.getZoom() - initialZoom;
                updateZoomLevelIndicator();
                updateDrawButtonState();
                if (_panToAvailableCanvas(pinLatLng)) {
                    map.once('moveend', openPopup);
                } else {
                    openPopup();
                }
            });
            updateStatus('Re-centering on location');
            return;
        }
    }

    // Only cache addresses (e.g. "123 Main St"), never place names
    // (e.g. "Trader Joes") which resolve differently based on proximity.
    const isAddress = _looksLikeAddress(address);
    const cache = _loadGeoCache();
    if (isAddress) {
        const cached = cache[normAddr];
        if (cached) {
            const cn = cached.name || (cached.namedetails && cached.namedetails.name) || cached.display_name || '';
            console.log(`[searchAddress] CACHE HIT for "${address}" → "${cn}" [${cached.lat}, ${cached.lon}]`);
            _lastSearchedAddress = normAddr;
            _lastSearchLocation = _getUserLocation();
            displayGeocodeResult(cached, address);
            return;
        }
    }

    // Enforce rate limiting
    const now = Date.now();
    const timeSinceLastSearch = now - lastSearchTime;
    if (timeSinceLastSearch < MIN_SEARCH_INTERVAL) {
        const waitTime = MIN_SEARCH_INTERVAL - timeSinceLastSearch;
        updateStatus(`Please wait ${Math.ceil(waitTime/1000)}s before searching again...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastSearchTime = Date.now();

    // ── Clear previous search results — new search = clean slate ──
    if (markers.length > 0 || currentPolygon || allSearchResults.length > 0 || searchAddressMarker) {
        drawClear();
        // drawClear preserves searchAddressMarker — remove it too
        if (searchAddressMarker) {
            if (map.hasLayer(searchAddressMarker)) map.removeLayer(searchAddressMarker);
            searchAddressMarker = null;
        }
    }

    // Use the user's actual GPS location for proximity ranking, not the
    // map center (which may have moved to a previous search result).
    const center = _getUserLocation();

    // ── Category search (e.g. "sushi", "gas station", "coffee near me") ──
    // Generic terms are searched via Google Text Search to get up to 5
    // nearby results with ratings.  Falls back to Overpass if Google quota
    // is exhausted.
    const categoryMatch = _matchCategory(address);
    if (categoryMatch) {
        showLoading(true, `Finding nearby ${categoryMatch.label}...`);
        updateStatus(`Searching for nearby ${categoryMatch.label}...`, true);

        // Try Google first (Nearby Search with DISTANCE for typed categories,
        // Text Search for cuisine/generic categories).  Uses 1 API call either way.
        if (canMakeGooglePlacesCall()) {
            try {
                const mapCenter = map.getCenter();
                // Use GPS location (not map center) as the origin for search
                // and distance filtering — the user wants places near THEM.
                const searchOrigin = center; // _getUserLocation() result
                let nearby;

                const MAX_CAT_DIST = 1600; // 1.3 miles hard cutoff (straight-line)

                if (categoryMatch.googleTypes) {
                    // Typed category (grocery, bank, pharmacy, etc.)
                    // → Nearby Search with DISTANCE ranking = truly closest results
                    const circle = {
                        center: { latitude: searchOrigin.lat, longitude: searchOrigin.lng },
                        radius: MAX_CAT_DIST
                    };

                    const nearbyResults = await fetchNearbyPlaces(
                        categoryMatch.googleTypes, circle, 'DISTANCE'
                    );
                    // Hard distance cutoff from user's location
                    nearby = nearbyResults.filter(r => {
                        if (!r.coordinates) return false;
                        const d = calculateDistance(
                            [searchOrigin.lat, searchOrigin.lng],
                            [r.coordinates[0], r.coordinates[1]]
                        );
                        r._distFromCenter = d;
                        return d <= MAX_CAT_DIST;
                    });
                } else {
                    // Cuisine/generic category (sushi, tacos, etc.)
                    // → Text Search with locationBias (Google picks relevance)
                    const textResults = await fetchTextSearchPlaces(
                        categoryMatch.label,
                        { lat: searchOrigin.lat, lng: searchOrigin.lng },
                        MAX_CAT_DIST,
                        20
                    );
                    // Hard distance filter from user's location
                    nearby = textResults.filter(r => {
                        if (!r.coordinates) return false;
                        const d = calculateDistance(
                            [searchOrigin.lat, searchOrigin.lng],
                            [r.coordinates[0], r.coordinates[1]]
                        );
                        r._distFromCenter = d;
                        return d <= MAX_CAT_DIST;
                    });
                }

                if (nearby.length > 0) {
                    // Sort by rating descending (highest-rated first)
                    nearby.sort((a, b) => {
                        const ra = typeof a.rating === 'number' ? a.rating : -Infinity;
                        const rb = typeof b.rating === 'number' ? b.rating : -Infinity;
                        if (ra !== rb) return rb - ra;
                        return (b.userRatingCount || 0) - (a.userRatingCount || 0);
                    });
                    // Cap to 10 results after sorting
                    nearby = nearby.slice(0, 10);



                    _lastSearchedAddress = normAddr;
                    _lastSearchLocation = { ...center };

                    // Display using the same sidebar pipeline as draw search
                    const priorityCenter = [searchOrigin.lat, searchOrigin.lng];
                    lastPriorityCenter = priorityCenter;
                    unfilteredSearchResults = nearby;
                    activeSortMode = 'rating'; // default to rating sort for categories
                    populateTypeDatalistFromResults(nearby);
                    syncFilterSortUIState();
                    applyFiltersAndSort({ resetToFirstPage: true });
                    // Compute fit states using the same vertex-projection
                    // technique as calculatePolygonFit.  Result coords are
                    // treated like polygon vertices; the search-time center
                    // stays anchored at the visual center of the available
                    // canvas for each overlay state.
                    // All pins to fit: result pins + user location pin
                    const allPoints = nearby
                        .filter(p => p.coordinates)
                        .map(p => L.latLng(p.coordinates[0], p.coordinates[1]));
                    allPoints.push(L.latLng(searchOrigin.lat, searchOrigin.lng));

                    if (isMobileView() && allPoints.length > 1) {
                        const mapEl = document.getElementById('map');
                        const fullH = mapEl ? mapEl.offsetHeight : 0;
                        const headerH = getMobileHeaderPad();
                        map.invalidateSize({ animate: false });

                        // State 1: results-open (overlay covers bottom half)
                        const openOverlayH = fullH * 0.5;
                        const openFit = calculateCategoryFit(
                            allPoints, map,
                            20 + headerH, 20, openOverlayH + 20, 20
                        );
                        fitStateResultsOpen = openFit;

                        // State 2: lip-peeked (52px lip at bottom)
                        const peekFit = calculateCategoryFit(
                            allPoints, map,
                            20 + headerH, 20, TOASTER_LIP_HEIGHT + 20, 20
                        );
                        fitStateLipPeeked = peekFit;

                        // Apply results-open fit before sidebar slides in
                        applyPolygonFit(fitStateResultsOpen);
                    } else if (allPoints.length > 1) {
                        // Desktop: no overlay padding, just edge margins
                        const fit = calculateCategoryFit(
                            allPoints, map, 20, 20, 20, 20
                        );
                        if (fit.zoom < map.getZoom()) {
                            map.setView(fit.center, fit.zoom, { animate: true });
                        }
                    }

                    // Place person marker at user's GPS location
                    addUserLocationMarker();

                    openSidebar();

                    updateStatus(`Found ${nearby.length} ${categoryMatch.label} nearby`);
                    showLoading(false);
                    return;
                }
                console.log(`[searchAddress] Category "${categoryMatch.label}" — no Google results nearby, trying Overpass`);
            } catch (e) {
                console.warn('[searchAddress] Google category search failed, trying Overpass:', e);
            }
        }

        // Fallback: Overpass (no ratings, single closest result)
        try {
            const poiResult = await _searchNearestPOI(categoryMatch, center.lat, center.lng);
            if (poiResult) {
                console.log(`[searchAddress] Category fallback "${address}" → ${categoryMatch.label}: "${poiResult.name}" [${poiResult.lat}, ${poiResult.lon}]`);
                _lastSearchedAddress = normAddr;
                _lastSearchLocation = { ...center };
                showLoading(false);
                displayGeocodeResult(poiResult, address);
                return;
            }
            console.log(`[searchAddress] Category "${categoryMatch.label}" — no Overpass results either, falling through to geocoder`);
        } catch (e) {
            console.warn('[searchAddress] Overpass category search also failed, falling through:', e);
        }
    }

    showLoading(true, 'Searching for location...');
    updateStatus('Searching for address...', true);

    try {
        // ── Business name search (e.g. "Trader Joes", "Starbucks") ──
        // For non-address queries, Google Text Search is far more reliable
        // than Nominatim/Photon at finding the nearest matching business.
        // Use the map center as the bias point so results are near where
        // the user is looking, not where GPS last fixed.
        if (!isAddress && canMakeGooglePlacesCall()) {
            try {
                const mapCenter = map.getCenter();
                const textResults = await fetchTextSearchPlaces(
                    address,
                    { lat: mapCenter.lat, lng: mapCenter.lng },
                    8000,  // 8 km ≈ 5 miles bias radius
                    5      // fetch several candidates, pick closest below
                );

                if (textResults.length > 0) {
                    // Pick the best result: prefer open + closest.
                    // Among candidates, an open place beats a closer closed one
                    // (e.g. the open McDonald's 0.5 mi away > closed one 0.2 mi).
                    // When openNow is unknown (null) treat as neutral.
                    for (const r of textResults) {
                        if (!r.coordinates) { r._dist = Infinity; continue; }
                        r._dist = calculateDistance(
                            [mapCenter.lat, mapCenter.lng],
                            [r.coordinates[0], r.coordinates[1]]
                        );
                    }
                    textResults.sort((a, b) => {
                        // Open places first (true > null > false)
                        const oa = a.openNow === true ? 0 : a.openNow === false ? 2 : 1;
                        const ob = b.openNow === true ? 0 : b.openNow === false ? 2 : 1;
                        if (oa !== ob) return oa - ob;
                        return a._dist - b._dist;
                    });
                    const best = textResults[0];
                    const bestDist = best._dist;
                    console.log(`[searchAddress] Google Text Search "${address}" → ${textResults.length} candidates, best: "${best.name}" [${best.coordinates}] (${(bestDist/1000).toFixed(1)}km, openNow=${best.openNow})`);

                    // Convert to Nominatim-like result for displayGeocodeResult
                    const geoResult = {
                        lat: best.coordinates[0],
                        lon: best.coordinates[1],
                        name: best.name,
                        display_name: `${best.name}, ${best.address}`,
                        address: { road: best.address },
                        _googleTextSearch: true, // flag so enrichment knows source
                        _googleRating: best.rating,
                        _googleRatingCount: best.userRatingCount,
                        _googleMapsUri: best.googleMapsUri,
                        _googlePhone: best.phone,
                        _googleWebsite: best.website,
                        _googlePlaceType: best.place_type
                    };

                    _lastSearchedAddress = normAddr;
                    _lastSearchLocation = { ...center };
                    showLoading(false);
                    displayGeocodeResult(geoResult, address);
                    return;
                }
                console.log(`[searchAddress] Google Text Search "${address}" — no results, falling back to geocoders`);
            } catch (e) {
                console.warn('[searchAddress] Google Text Search failed for place name, falling back:', e);
            }
        }

        // Phase 1: Fire both geocoders in parallel with strong proximity bias.
        // Photon has native lat/lon proximity; Nominatim uses bounded viewbox (±2°).
        const [nominatimResult, photonResult] = await Promise.all([
            tryNominatim(address, true),    // bounded=1, ±2° ≈ 220 km hard fence
            tryPhoton(address)              // native lat/lon proximity bias
        ]);

        let candidates = [nominatimResult, photonResult].filter(Boolean);

        // Phase 2: If both proximity-biased searches failed, try Nominatim
        // globally (bounded=0).  This covers obscure addresses with no nearby match.
        if (candidates.length === 0) {
            updateStatus('Trying wider search...');
            const globalResult = await tryNominatim(address, false);
            if (globalResult) candidates = [globalResult];
        }

        if (candidates.length > 0) {
            // Pick best candidate using composite relevance + proximity score

            const result = candidates.length === 1
                ? candidates[0]
                : _pickClosestGeoResult(candidates, center,
                    r => [parseFloat(r.lat), parseFloat(r.lon)], address);

            // Only cache addresses in localStorage — place names resolve
            // differently depending on the user's location, so caching
            // "Trader Joes" would always return the same stale result.
            if (isAddress) {
                result._ts = Date.now();
                cache[normAddr] = result;
                _saveGeoCache(cache);
            }
            _lastSearchedAddress = normAddr;
            _lastSearchLocation = { ...center }; // snapshot GPS used for this search

            displayGeocodeResult(result, address);
        } else {
            updateStatus('Address search failed');
            alert('Could not find that address. The geocoding services may be busy. Try again in a few seconds, or be more specific (e.g., "123 Main St, New York, NY").');
        }
    } finally {
        showLoading(false);
    }
}

/**
 * Score how well a geocode result's name matches the search query.
 * Delegates to computeNameRelevance which has full fuzzy/typo support,
 * tiered scoring (phrase → all-tokens → partial), and match-quality
 * tracking.  This single code path ensures the geocoder and the
 * place-filter use identical ranking logic.
 */
function _geoNameRelevance(resultName, query) {
    if (!resultName || !query) return 0;
    const tokens = tokenizeFilterQuery(query);
    if (tokens.length === 0) return 0;
    return computeNameRelevance(tokens, resultName);
}

/**
 * From an array of geocode results, return the best match using
 * tier-based ranking: relevance tier first, distance second.
 * `getLatLon` extracts [lat, lon] from a result object.
 *
 * Tier 0 = phrase-level match   (relevance >= 0.90)
 * Tier 1 = all-tokens match     (relevance >= 0.60)
 * Tier 2 = partial / weak       (everything else)
 *
 * A result in a higher tier ALWAYS beats one in a lower tier,
 * regardless of distance.  Within the same tier, closer wins.
 * This mirrors Google Maps: "Madison Square Garden" (exact match,
 * 6 km away) always beats "The Garden at Studio Square" (partial
 * match, 1 km away).
 */
function _pickClosestGeoResult(results, center, getLatLon, query) {
    if (results.length === 1) return results[0];

    const toRad = d => d * Math.PI / 180;
    const cLat = toRad(center.lat);
    const cLon = toRad(center.lng);

    // Compute raw distances and name relevance
    const entries = results.map(r => {
        const rName = r.name || (r.namedetails && r.namedetails.name) || r.display_name || '';
        const [lat, lon] = getLatLon(r);
        let dist = Infinity;
        if (!isNaN(lat) && !isNaN(lon)) {
            const rLat = toRad(lat), rLon = toRad(lon);
            const dLat = rLat - cLat, dLon = rLon - cLon;
            const a = Math.sin(dLat / 2) ** 2 +
                      Math.cos(cLat) * Math.cos(rLat) * Math.sin(dLon / 2) ** 2;
            dist = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }
        const nameRel = query ? _geoNameRelevance(rName, query) : 0;
        let tier;
        if (nameRel >= 0.90) tier = 0;       // Tier A – phrase match
        else if (nameRel >= 0.60) tier = 1;  // Tier B – all tokens
        else tier = 2;                        // Tier C – partial
        return { r, rName, lat, lon, dist, nameRel, tier };
    });

    // Sort: tier ascending (best first), then relevance desc, then distance asc
    entries.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        if (a.nameRel !== b.nameRel) return b.nameRel - a.nameRel;
        return a.dist - b.dist;
    });

    // Diagnostic logging
    if (query) {
        const R = 6371; // km
        console.log(`[GeoRank] Query: "${query}" — ${entries.length} candidates:`);
        for (const e of entries.slice(0, 8)) {
            const dKm = isFinite(e.dist) ? (e.dist * R).toFixed(1) + 'km' : '?';
            console.log(`  T${e.tier} | rel=${e.nameRel.toFixed(2)} dist=${dKm} | "${e.rName}"`);
        }
        console.log(`[GeoRank] Winner: "${entries[0].rName}" (tier=${entries[0].tier}, rel=${entries[0].nameRel.toFixed(2)})`);
    }

    return entries[0].r;
}

async function tryNominatim(address, bounded = true) {
    const center = _getUserLocation();
    // bounded=true  → ±2° ≈ 220 km hard fence (forces nearby results)
    // bounded=false → ±0.5° soft hint, global fallback
    const bias = bounded ? 2.0 : 0.5;

    const params = new URLSearchParams({
        q: address,
        format: 'json',
        limit: '10',
        addressdetails: '1',
        namedetails: '1',
        'accept-language': 'en'
    });

    params.set('viewbox', `${center.lng - bias},${center.lat + bias},${center.lng + bias},${center.lat - bias}`);
    params.set('bounded', bounded ? '1' : '0');

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
        if (!data || data.length === 0) { console.log(`[Nominatim] bounded=${bounded} — 0 results`); return null; }
        console.log(`[Nominatim] bounded=${bounded} — ${data.length} raw results:`);
        for (const r of data.slice(0, 8)) {
            const n = r.name || (r.namedetails && r.namedetails.name) || '';
            console.log(`  name="${n}" display="${(r.display_name || '').slice(0, 80)}" [${r.lat}, ${r.lon}]`);
        }
        return _pickClosestGeoResult(data, center, r => [parseFloat(r.lat), parseFloat(r.lon)], address);
    } catch (error) {
        console.warn('Nominatim error:', error);
        return null;
    }
}

async function tryPhoton(address) {
    // Photon uses different parameter structure
    const params = new URLSearchParams({
        q: address,
        limit: '10',
        lang: 'en'
    });

    // Add proximity bias using the user's actual GPS location (not the map
    // center, which may have moved to a previous search result).
    const center = _getUserLocation();
    params.set('lat', center.lat.toFixed(6));
    params.set('lon', center.lng.toFixed(6));

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
            // Convert all features to Nominatim-like format, then pick closest
            const converted = data.features.map(f => {
                const p = f.properties;
                const c = f.geometry.coordinates;
                return {
                    lat: c[1],
                    lon: c[0],
                    display_name: p.name || address,
                    name: p.name,
                    osm_type: p.osm_type,   // 'N','W','R' → node/way/relation
                    osm_id: p.osm_id,
                    address: {
                        house_number: p.housenumber,
                        road: p.street,
                        city: p.city,
                        town: p.district,
                        village: p.district,
                        state: p.state,
                        postcode: p.postcode
                    }
                };
            });
            console.log(`[Photon] ${converted.length} raw results:`);
            for (const r of converted.slice(0, 8)) {
                console.log(`  name="${r.name || ''}" [${r.lat}, ${r.lon}]`);
            }
            return _pickClosestGeoResult(converted, center, r => [parseFloat(r.lat), parseFloat(r.lon)], address);
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

    // Flying to a searched address — no longer at GPS location
    if (_isAtMyLocation) {
        _isAtMyLocation = false;
        _myLocationCenter = null;
        updateMyLocationButtonState();
    }

    // Remove previous search marker if any
    if (searchAddressMarker) {
        if (map.hasLayer(searchAddressMarker)) map.removeLayer(searchAddressMarker);
        searchAddressMarker = null;
    }

    // Add a persistent marker for the searched address (4× size, tracked separately)
    const marker = L.marker([lat, lon], {
        icon: L.divIcon({
            className: 'search-marker',
            html: '<div style="width:44px;height:44px;border-radius:50%;background:#ea4335;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.4);border:3px solid #fff;"><i class="fas fa-map-pin" style="color:#fff;font-size:20px;"></i></div>',
            iconSize: [44, 44],
            iconAnchor: [22, 22]
        })
    }).addTo(map);

    marker.bindPopup(_buildSearchPinPopup(result.name || searchQuery, displayAddress, lat, lon, {}) + '<p style="margin:4px 0 0 0;font-size:11px;color:#999;text-align:center;" class="search-pin-loading">Loading details…</p>', { maxWidth: 300, minWidth: 180, autoPan: false });

    // Center map on the red pin when tapped (even if a business pin was selected)
    marker.on('click', () => {
        // Deselect any business marker so the map centers on the search pin
        if (selectedPlaceIndex !== null) {
            clearHighlightedMarker();
            selectedPlaceIndex = null;
        }
        const pinLL = marker.getLatLng();
        const currentZoom = map.getZoom();
        const flyTarget = _pinCenterForOverlay(pinLL, currentZoom);
        map.panTo(flyTarget);
    });

    searchAddressMarker = marker;
    updateZoomFitButtonState();

    // Place person marker at user's GPS location
    addUserLocationMarker();

    // Update the search textbox with the resolved name + address
    const input = document.getElementById('address-input');
    const resolvedName = result.name || searchQuery;
    if (input) {
        input.value = resolvedName !== displayAddress
            ? `${resolvedName}, ${displayAddress}`
            : displayAddress;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Fly to address at target display level (PC: 3, mobile: 2).
    // Use _pinCenterForOverlay so the pin lands centered in the available
    // canvas above the overlay (if open), not at the full canvas center.
    const targetZoom = initialZoom + (isMobileView() ? 2 : 3);
    const pinLatLng = L.latLng(lat, lon);
    const flyTarget = _pinCenterForOverlay(pinLatLng, targetZoom);
    isLocationSearchZoom = true;
    map.flyTo(flyTarget, targetZoom, { duration: 1.0 });
    const epochAtSearch = _clearEpoch;
    const openPopup = () => {
        if (_clearEpoch !== epochAtSearch) return;
        if (!map.hasLayer(marker)) return;
        marker.openPopup();
    };
    map.once('moveend', () => {
        isLocationSearchZoom = false;
        currentZoomLevel = map.getZoom() - initialZoom;
        updateZoomLevelIndicator();
        updateDrawButtonState();
        if (_panToAvailableCanvas(pinLatLng)) {
            map.once('moveend', openPopup);
        } else {
            openPopup();
        }
    });

    updateStatus(`Found: ${result.name || result.display_name.split(',')[0]}`);

    // Save search pin coordinates for priority sorting
    searchPinCoords = [lat, lon];
    directionLocations.C = { lat: lat, lng: lon, label: displayAddress || searchQuery };

    // Enrich asynchronously — updates popup when data arrives
    _enrichSearchedLocation(result, marker, searchQuery, displayAddress, epochAtSearch);
}

// ── Search-pin enrichment (Overpass + Yelp) ─────────────────────────────

/**
 * Parse an OSM opening_hours string and return a human-readable status.
 * Handles common formats; returns the raw string for exotic ones.
 */
function _parseOpenStatus(ohString) {
    if (!ohString) return null;
    try {
        const now = new Date();
        const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
        const today = dayNames[now.getDay()];
        const nowMins = now.getHours() * 60 + now.getMinutes();

        // Split rules by semicolons, find one matching today
        const rules = ohString.split(';').map(r => r.trim());
        for (const rule of rules) {
            // Match patterns like "Mo-Fr 08:00-21:00" or "Sa,Su 09:00-18:00"
            const m = rule.match(/^([A-Za-z, -]+)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
            if (!m) continue;
            const daysPart = m[1];
            const openTime = m[2].split(':').reduce((h, mi) => +h * 60 + +mi);
            const closeTime = m[3].split(':').reduce((h, mi) => +h * 60 + +mi);

            // Check if today is in the day range
            const dayRanges = daysPart.split(',').map(d => d.trim());
            let matchesToday = false;
            for (const dr of dayRanges) {
                if (dr.includes('-')) {
                    const [start, end] = dr.split('-').map(d => dayNames.indexOf(d.trim()));
                    if (start < 0 || end < 0) continue;
                    const todayIdx = dayNames.indexOf(today);
                    matchesToday = start <= end
                        ? todayIdx >= start && todayIdx <= end
                        : todayIdx >= start || todayIdx <= end;
                } else {
                    matchesToday = dr.trim() === today;
                }
                if (matchesToday) break;
            }
            if (!matchesToday) continue;

            // Format close time nicely
            const closeH = Math.floor(closeTime / 60);
            const closeM = closeTime % 60;
            const closeFmt = closeM === 0
                ? `${closeH > 12 ? closeH - 12 : closeH} ${closeH >= 12 ? 'PM' : 'AM'}`
                : `${closeH > 12 ? closeH - 12 : closeH}:${String(closeM).padStart(2, '0')} ${closeH >= 12 ? 'PM' : 'AM'}`;
            const openH = Math.floor(openTime / 60);
            const openM = openTime % 60;
            const openFmt = openM === 0
                ? `${openH > 12 ? openH - 12 : openH} ${openH >= 12 ? 'PM' : 'AM'}`
                : `${openH > 12 ? openH - 12 : openH}:${String(openM).padStart(2, '0')} ${openH >= 12 ? 'PM' : 'AM'}`;

            if (nowMins >= openTime && nowMins < closeTime) {
                return { open: true, text: `Open · Closes ${closeFmt}` };
            } else if (nowMins < openTime) {
                return { open: false, text: `Closed · Opens ${openFmt}` };
            } else {
                return { open: false, text: `Closed · Opened ${openFmt}` };
            }
        }
        // 24/7
        if (/24\s*\/\s*7/.test(ohString)) return { open: true, text: 'Open 24/7' };
    } catch { /* fall through */ }
    // Couldn't parse — return raw string
    return { open: null, text: ohString };
}

/**
 * Build the enriched popup HTML for the search pin.
 * Compact layout: action circles on top (thick black borders), info below.
 */
function _buildSearchPinPopup(name, address, lat, lon, enrichment) {
    const searchTerm = address ? `${name}, ${address}` : name;

    // Google Maps URL — IDENTICAL construction to draw-search pins (buildPopupContent).
    // Use place URI or search URL as href; the directions-capable click interceptor
    // handles direction mode when enabled.  Never hardcode direction URLs here.
    const googleHref = enrichment.googleMapsUri
        || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchTerm)}`;
    const googleTarget = '_blank';

    // Apple Maps URL — same as draw-search pins
    const appleHref = `https://maps.apple.com/?q=${encodeURIComponent(name)}&ll=${lat},${lon}&z=19`;
    const appleTarget = '_blank';

    // Shared circle style — thick black border, special location-pin look
    const circleStyle = 'width:34px;height:34px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;text-decoration:none;border:2.5px solid #222;';

    // Phone circle
    const phoneIconHtml = enrichment.phone
        ? `<a href="tel:${enrichment.phone}" title="Call ${enrichment.phone}" style="${circleStyle}color:#34a853;font-size:13px;">` +
              `<i class="fas fa-phone"></i></a>`
        : `<div title="Phone unavailable" style="${circleStyle}color:#b0b0b0;font-size:13px;position:relative;">` +
              `<i class="fas fa-phone"></i>` +
              `<div style="position:absolute;width:24px;height:2px;background:#b0b0b0;transform:rotate(-45deg);border-radius:1px;"></div>` +
          `</div>`;

    // ── Top row: three action circles ──
    const circlesHtml =
        `<div style="display:flex;justify-content:center;gap:10px;margin-bottom:8px;">` +
            `<a href="${googleHref}" target="${googleTarget}" rel="noopener" title="Google Maps" class="directions-capable" data-dest-lat="${lat}" data-dest-lng="${lon}" data-search-term="${searchTerm.replace(/"/g, '&quot;')}" data-map-provider="google" style="${circleStyle}color:#4285f4;font-size:13px;">` +
                `<i class="fab fa-google"></i></a>` +
            `<a href="${appleHref}" target="${appleTarget}" rel="noopener" title="Apple Maps" class="directions-capable" data-dest-lat="${lat}" data-dest-lng="${lon}" data-dest-name="${name.replace(/"/g, '&quot;')}" data-map-provider="apple" style="${circleStyle}color:#333;font-size:15px;">` +
                `<i class="fab fa-apple"></i></a>` +
            phoneIconHtml +
        `</div>`;

    // ── Info section below circles ──
    let infoHtml = `<div style="text-align:center;">`;
    infoHtml += `<div style="font-size:14px;color:#202124;font-weight:600;margin-bottom:2px;">${name}</div>`;
    if (enrichment.placeType) {
        infoHtml += `<div style="font-size:10px;color:#666;margin-bottom:2px;"><i class="fas ${typeof getPlaceIcon === 'function' ? getPlaceIcon(enrichment.placeType) : 'fa-store'}" style="margin-right:3px;"></i>${enrichment.placeType}</div>`;
    }
    if (address && address !== name) {
        infoHtml += `<div style="font-size:11px;color:#5f6368;margin-bottom:2px;">${address}</div>`;
    }

    // Rating (Google via mega pin, or Yelp)
    if (enrichment.rating) {
        const ratingStr = typeof enrichment.rating === 'number' ? enrichment.rating.toFixed(1) : enrichment.rating;
        infoHtml += `<div style="font-size:12px;color:#f4b400;font-weight:500;"><i class="fas fa-star" style="font-size:10px;"></i> ${ratingStr}`;
        if (enrichment.reviewCount) infoHtml += ` <span style="color:#999;font-weight:400;font-size:10px;">(${enrichment.reviewCount})</span>`;
        infoHtml += '</div>';
    }

    // Hours
    if (enrichment.hours) {
        const cls = enrichment.hours.open === true ? 'search-pin-open'
                  : enrichment.hours.open === false ? 'search-pin-closed'
                  : 'search-pin-hours';
        infoHtml += `<div style="font-size:11px;margin-top:1px;"><span class="${cls}">${enrichment.hours.text}</span></div>`;
    }

    // Website
    if (enrichment.website) {
        const domain = enrichment.website.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        infoHtml += `<div style="font-size:11px;margin-top:2px;"><i class="fas fa-globe" style="color:#666;margin-right:3px;font-size:10px;"></i><a href="${enrichment.website}" target="_blank" rel="noopener" style="color:#4285f4;text-decoration:none;">${domain}</a></div>`;
    }

    infoHtml += `</div>`;

    return circlesHtml + infoHtml;
}

/**
 * Remove the blue draw-search marker for a given allSearchResults index,
 * if it's already on the map.  Called when the red search pin absorbs that
 * place's data (mega pin) so there's no visual duplicate.
 */
function _removeDuplicateBlueMarker(placeIndex) {
    for (let i = markers.length - 1; i >= 0; i--) {
        const m = markers[i];
        if (m.isDrawingPoint) continue;
        if (m.placeIndex === placeIndex) {
            console.log(`[Mega pin] Removed duplicate blue marker for placeIndex ${placeIndex}`);
            if (map.hasLayer(m)) map.removeLayer(m);
            markers.splice(i, 1);
            return;
        }
    }
}

/**
 * Normalize a name for fuzzy comparison: lowercase, strip punctuation/whitespace.
 */
function _normName(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Mega pin: find a draw-search business that matches the search pin by
 * normalized NAME and/or ADDRESS.  Distance alone is unreliable because
 * different geocoding backends (Nominatim vs Google Places) can place the
 * same business hundreds of meters apart.  Name + address is the reliable
 * signal.  Stores the matched place by *object reference* — the dynamic
 * index into allSearchResults is recomputed by _refreshMegaPin on every
 * filter/sort cycle so it never goes stale.
 */
function _mergeDrawSearchMatch(lat, lon, enrichment, searchName, searchAddress) {
    // Always search the UNFILTERED results so the mega-pin match survives
    // filter changes.  The current index in allSearchResults is computed
    // dynamically by _refreshMegaPin / _getMegaPinCurrentIndex.
    const pool = unfilteredSearchResults;
    if (!pool || pool.length === 0) {
        console.log('[Mega pin] No draw-search results to match against');
        return;
    }
    const pinCoord = [lat, lon];

    // Only consider matches when pin is inside the polygon (if polygon exists)
    if (currentPolygon && drawingPoints.length >= 3 && !pointInPolygon(pinCoord, drawingPoints)) {
        console.log('[Mega pin] Search pin is outside polygon — skipping');
        return;
    }

    const normSearchName = _normName(searchName);
    const normSearchAddr = _normName(searchAddress);
    console.log(`[Mega pin] Looking for match — name="${searchName}" (norm="${normSearchName}"), addr norm="${normSearchAddr}"`);

    let bestPlace = null, bestIndex = -1, bestScore = 0;
    for (let i = 0; i < pool.length; i++) {
        const place = pool[i];
        if (!place.coordinates) continue;

        const normPlaceName = _normName(place.name);
        const normPlaceAddr = _normName(place.address);
        const d = calculateDistance(pinCoord, place.coordinates);

        // Name match: either contains the other (handles "Regal UA Kaufman Astoria" vs "Regal UA Kaufman Astoria 14")
        const nameMatch = normSearchName && normPlaceName
            ? (normPlaceName.includes(normSearchName) || normSearchName.includes(normPlaceName))
            : false;

        // Address match: normalized addresses share a substring
        const addrMatch = normSearchAddr && normPlaceAddr
            ? (normPlaceAddr.includes(normSearchAddr) || normSearchAddr.includes(normPlaceAddr))
            : false;

        // Score: name+addr=3, name-only=2, addr+close=1
        let score = 0;
        if (nameMatch && addrMatch) score = 3;
        else if (nameMatch) score = 2;
        else if (addrMatch && d < 200) score = 1;

        if (score > 0) {
            console.log(`[Mega pin] Candidate #${i}: "${place.name}" addr="${place.address}" dist=${d.toFixed(0)}m nameMatch=${nameMatch} addrMatch=${addrMatch} score=${score}`);
        }

        if (score > bestScore || (score === bestScore && d < (bestPlace ? calculateDistance(pinCoord, bestPlace.coordinates) : Infinity))) {
            bestPlace = place;
            bestIndex = i;
            bestScore = score;
        }
    }

    if (!bestPlace || bestScore === 0) {
        console.log('[Mega pin] No matching draw-search result found');
        return;
    }

    const finalDist = calculateDistance(pinCoord, bestPlace.coordinates);
    console.log(`[Mega pin] ✓ Matched "${bestPlace.name}" (index ${bestIndex}) score=${bestScore} dist=${finalDist.toFixed(0)}m`);

    enrichment._megaPin = true;
    enrichment._megaPinPlace = bestPlace;
    // Index is resolved dynamically against allSearchResults (the filtered/
    // sorted list) by _refreshMegaPin — never store a stale fixed index.
    enrichment._megaPinIndex = -1;
}

/**
 * Re-enrich an existing search pin when draw-search results arrive later.
 * Called from the sort/display pipeline after allSearchResults is populated.
 *
 * Two modes:
 *   1. Match already found (_megaPin === true) → just recompute the dynamic
 *      index into the *current* allSearchResults (which changes on every
 *      filter/sort) and refresh the popup.
 *   2. No match yet → run the full _mergeDrawSearchMatch against the
 *      unfiltered pool.
 */
function _refreshMegaPin() {
    if (!searchAddressMarker || !map.hasLayer(searchAddressMarker)) return;
    const enrichment = searchAddressMarker._searchEnrichment;
    if (!enrichment) return;

    if (enrichment._megaPin && enrichment._megaPinPlace) {
        // ── Mode 1: match already found — recompute dynamic index ──
        const idx = allSearchResults.indexOf(enrichment._megaPinPlace);
        enrichment._megaPinIndex = idx;
        if (idx >= 0) {
            const wasOpen = searchAddressMarker.isPopupOpen();
            searchAddressMarker.setPopupContent(
                buildPopupContent(enrichment._megaPinPlace, idx, false)
            );
            if (wasOpen) searchAddressMarker.openPopup();
        }
        console.log(`[Mega pin] Refreshed index → ${idx} ("${enrichment._megaPinPlace.name}")`);
        return;
    }

    // ── Mode 2: no match yet — try full matching ──
    const ll = searchAddressMarker.getLatLng();
    const name = searchAddressMarker._searchName || '';
    const address = searchAddressMarker._searchAddress || '';
    _mergeDrawSearchMatch(ll.lat, ll.lng, enrichment, name, address);
    if (enrichment._megaPin && enrichment._megaPinPlace) {
        let idx = allSearchResults.indexOf(enrichment._megaPinPlace);
        // If the matched place was filtered out (e.g. first draw search with
        // active filters), force-include it so the red pin stays enriched.
        if (idx < 0) {
            allSearchResults.push(enrichment._megaPinPlace);
            idx = allSearchResults.length - 1;
            console.log(`[Mega pin] Force-included "${enrichment._megaPinPlace.name}" (was filtered out on first match)`);
        }
        enrichment._megaPinIndex = idx;
        if (idx >= 0) {
            const wasOpen = searchAddressMarker.isPopupOpen();
            searchAddressMarker.setPopupContent(
                buildPopupContent(enrichment._megaPinPlace, idx, false)
            );
            if (wasOpen) searchAddressMarker.openPopup();
        }
        console.log(`[Mega pin] New match — index ${idx} ("${enrichment._megaPinPlace.name}")`);
    }
}

/**
 * Asynchronously enrich a searched location pin with Overpass (OSM tags)
 * and Yelp (rating/reviews).  Updates the popup content as data arrives.
 */
async function _enrichSearchedLocation(result, marker, searchQuery, displayAddress, epoch) {
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    const name = result.name || searchQuery;
    const enrichment = {};

    // Store references on the marker for later mega pin refresh
    marker._searchEnrichment = enrichment;
    marker._searchName = name;
    marker._searchAddress = displayAddress;

    // Seed with data already on the result (e.g. from category/Overpass search)
    if (result.opening_hours) enrichment.hours = _parseOpenStatus(result.opening_hours);
    if (result.phone) enrichment.phone = result.phone;
    if (result.website) enrichment.website = result.website;

    // Seed with Google Text Search data if available (richer than Overpass)
    if (result._googleTextSearch) {
        if (result._googleRating) enrichment.rating = result._googleRating;
        if (result._googleRatingCount) enrichment.reviewCount = result._googleRatingCount;
        if (result._googleMapsUri) enrichment.googleMapsUri = result._googleMapsUri;
        if (result._googlePhone) enrichment.phone = result._googlePhone;
        if (result._googleWebsite) enrichment.website = result._googleWebsite;
        if (result._googlePlaceType) enrichment.placeType = result._googlePlaceType;
    }

    // ── Mega pin: merge draw search data if a matching business is nearby ──
    _mergeDrawSearchMatch(lat, lon, enrichment, name, displayAddress);

    // If mega pin matched, use the FULL draw-search popup immediately
    // and remove the duplicate blue marker if it's already on the map.
    if (enrichment._megaPin && enrichment._megaPinPlace) {
        // Compute current index dynamically (may be -1 if not yet in allSearchResults)
        const idx = allSearchResults.indexOf(enrichment._megaPinPlace);
        enrichment._megaPinIndex = idx;
        const wasOpen = marker.isPopupOpen();
        if (idx >= 0) {
            marker.setPopupContent(buildPopupContent(enrichment._megaPinPlace, idx, false));
            if (wasOpen) marker.openPopup();
            _removeDuplicateBlueMarker(idx);
        }
    }
    // Otherwise if we have partial data, update with compact popup (removes "Loading…")
    else if (enrichment.hours || enrichment.phone || enrichment.website || enrichment.rating || enrichment.googleMapsUri) {
        const wasOpen = marker.isPopupOpen();
        marker.setPopupContent(_buildSearchPinPopup(name, displayAddress, lat, lon, enrichment));
        if (wasOpen) marker.openPopup();
    }

    // Overpass enrichment (free — hours, phone, website from OSM)
    const overpassPromise = _fetchOverpassTags(result, lat, lon);

    // Yelp enrichment (disabled for now — uncomment when worker is configured)
    // const yelpPromise = _fetchYelpRating(name, lat, lon, displayAddress);

    // Update popup as each resolves
    const updatePopup = () => {
        if (_clearEpoch !== epoch) return;
        if (!map.hasLayer(marker)) return;
        const wasOpen = marker.isPopupOpen();
        // If mega pin matched, always use the full draw-search popup
        if (enrichment._megaPin && enrichment._megaPinPlace) {
            // Recompute dynamic index — it changes on every filter/sort
            const curIdx = allSearchResults.indexOf(enrichment._megaPinPlace);
            enrichment._megaPinIndex = curIdx;
            if (curIdx >= 0) {
                marker.setPopupContent(buildPopupContent(enrichment._megaPinPlace, curIdx, false));
            }
        } else {
            marker.setPopupContent(_buildSearchPinPopup(name, displayAddress, lat, lon, enrichment));
        }
        if (wasOpen) marker.openPopup();
    };

    overpassPromise.then(tags => {
        if (tags) {
            if (tags.opening_hours) enrichment.hours = _parseOpenStatus(tags.opening_hours);
            if (tags.phone || tags['contact:phone']) enrichment.phone = tags.phone || tags['contact:phone'];
            if (tags.website || tags['contact:website']) enrichment.website = tags.website || tags['contact:website'];
            updatePopup();
        }
    }).catch(e => console.warn('[Overpass enrichment]', e));

    // ── Yelp enrichment (disabled) ──────────────────────────────────────
    // yelpPromise.then(yelp => {
    //     if (yelp) {
    //         if (yelp.rating) enrichment.rating = yelp.rating;
    //         if (yelp.review_count) enrichment.reviewCount = yelp.review_count;
    //         if (yelp.price) enrichment.price = yelp.price;
    //         if (!enrichment.phone && yelp.phone) enrichment.phone = yelp.phone;
    //         if (!enrichment.website && yelp.url) enrichment.website = yelp.url;
    //         updatePopup();
    //     }
    // }).catch(e => console.warn('[Yelp enrichment]', e));

    // Final update when Overpass settles (removes "Loading..." if nothing found)
    overpassPromise.finally(() => updatePopup());
}

/**
 * Fetch OSM tags for a geocoded location via Overpass.
 * Uses osm_type/osm_id if available (precise), otherwise spatial query.
 */
async function _fetchOverpassTags(result, lat, lon) {
    let query;
    const osmType = result.osm_type;
    const osmId = result.osm_id;

    if (osmType && osmId) {
        // Precise lookup by OSM element
        const typeMap = { node: 'node', way: 'way', relation: 'relation',
                          N: 'node', W: 'way', R: 'relation' };
        const t = typeMap[osmType] || typeMap[osmType?.charAt(0)?.toUpperCase()];
        if (t) {
            query = `[out:json][timeout:5];${t}(${osmId});out tags;`;
        }
    }
    if (!query) {
        // Spatial fallback — find nearest named POI within 100m
        query = `[out:json][timeout:5];(node(around:100,${lat},${lon})["name"];way(around:100,${lat},${lon})["name"];);out tags 1;`;
    }

    const response = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`
    });
    if (!response.ok) return null;
    const data = await response.json();
    const elements = data.elements;
    if (!elements || elements.length === 0) return null;
    return elements[0].tags || null;
}

/**
 * Fetch Yelp rating for a location via the Cloudflare Worker proxy.
 * Returns { rating, review_count, price, phone, url } or null.
 */
async function _fetchYelpRating(name, lat, lon, address) {
    if (typeof LASO_PROXY_URL === 'undefined' || !LASO_PROXY_URL) return null;
    try {
        const params = new URLSearchParams({
            term: name,
            latitude: lat.toFixed(6),
            longitude: lon.toFixed(6)
        });
        const response = await fetch(`${LASO_PROXY_URL}/yelp?${params.toString()}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) {
            if (response.status === 429) console.warn('[Yelp] Daily limit reached');
            return null;
        }
        return await response.json();
    } catch (e) {
        console.warn('[Yelp fetch]', e);
        return null;
    }
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
    document.getElementById('search-btn').addEventListener('click', () => {
        document.getElementById('address-input').blur();
        searchAddress();
    });
    document.getElementById('address-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.target.blur();
            searchAddress();
        }
    });

    // Search clear (X) button — clears input text and removes location pin
    const searchClearBtn = document.getElementById('search-clear-btn');
    const addressInput = document.getElementById('address-input');
    const searchContainer = document.querySelector('.search-container');

    const updateSearchClearVisibility = () => {
        const hasText = addressInput.value.trim().length > 0;
        searchClearBtn.classList.toggle('visible', hasText);
        searchContainer.classList.toggle('has-clear', hasText);
    };

    addressInput.addEventListener('input', updateSearchClearVisibility);

    searchClearBtn.addEventListener('click', () => {
        addressInput.value = '';
        addressInput.blur();
        searchClearBtn.classList.remove('visible');
        searchContainer.classList.remove('has-clear');

        // Clear the cached search string so a fresh search can run,
        // but keep the red pin on the map — user may still want it visible.
        _lastSearchedAddress = null;
    });

    // Initialize visibility on load (e.g. if browser auto-fills the input)
    updateSearchClearVisibility();

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
        if (e.target.closest('.leaflet-control')) return; // let control handlers handle their own clicks
        const sidebar = document.getElementById('results-sidebar');
        if (sidebar.classList.contains('open')) {
            closeSidebar();
        }
    });

    // Mobile: swap popup content (simplified vs full) based on sidebar state,
    // and attach tap-to-open-sidebar handler.  Handler is on the popup DOM
    // element (not inner content) so it survives content swaps.
    map.on('popupopen', (e) => {
        // Detect clicks on the Leaflet close button (×) so the popupclose
        // handler can distinguish "close via X" (full deselect) from
        // "tap outside" (keep pin green/enlarged).
        const popupDom = e.popup.getElement();
        if (popupDom) {
            const closeBtn = popupDom.querySelector('.leaflet-popup-close-button');
            if (closeBtn && !closeBtn._xBtnWired) {
                closeBtn._xBtnWired = true;
                closeBtn.addEventListener('pointerdown', () => { _popupClosedByXButton = true; });
            }
        }

        if (!isMobileView()) return;
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

        // Attach handler once per popup DOM element (persists through setContent).
        // _popupReadyForTap starts false each time the popup opens; a rAF sets it
        // true so that the click/touchend from the SAME touch that opened the
        // popup (pin tap) is ignored — only a SUBSEQUENT tap on the popup itself
        // triggers openSidebar / highlightPlace.
        popupDom._popupReadyForTap = false;
        requestAnimationFrame(() => { popupDom._popupReadyForTap = true; });

        if (!popupDom._popupTapHandler) {
            popupDom._popupTapHandler = true;

            const tapHandler = (evt) => {
                if (!popupDom._popupReadyForTap) return; // ignore leaked pin-tap
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
                } else if (isMobileView() && idx === selectedPlaceIndex) {
                    // Tapping the abridged popup of the already-selected pin
                    // while sidebar is midway-open: minimize to peeked and
                    // show the unabridged infobox — same as tapping the pin.
                    _closedByPinTap = true;
                    closeSidebar();
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

    const PRESSABLE_SEL = '.header-actions > .btn, .header-actions > .draw-btn-wrapper > .btn, .search-btn, .search-clear-btn, .filter-sort-controls #clear-filters-btn, .header > .settings-btn';
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
    // Invalidate any orphaned My Location moveend handlers
    _myLocEpoch++;
    _isAtMyLocation = false;
    _myLocationCenter = null;
    isLocationSearchZoom = false;

    // Remove persistent search address marker
    if (searchAddressMarker) {
        if (map.hasLayer(searchAddressMarker)) map.removeLayer(searchAddressMarker);
        searchAddressMarker = null;
    }
    _lastSearchedAddress = null;
    updateZoomFitButtonState();

    // Remove wild pin
    removeWildPin();
    updateWildPinButtonState();

    // Downgrade person marker to idle dot (don't remove — always visible)
    removeUserLocationMarker();
    // Exit walk mode if active
    if (_walkMode) _setWalkMode(false);

    // Clear address input and hide X button
    const addrInput = document.getElementById('address-input');
    if (addrInput) {
        addrInput.value = '';
        addrInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

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
        // Never remove the user location marker — it must always stay visible
        if (layer === userLocationMarker) return;
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

    // Fly to user location at default zoom (same as Current Location centering)
    const defaultZoom = 14 + (isMobileView() ? 2 : 3);
    if (window._userLatLng) {
        // Snap bearing to north first
        if (_bearingRafId) { cancelAnimationFrame(_bearingRafId); _bearingRafId = null; }
        if (typeof map.setBearing === 'function') {
            map.setBearing(0);
            _bearingCurrent = 0;
            _bearingTarget = 0;
        }
        _bearingOriginDelta = 0;
        _syncConeRotation();
        const clearTarget = _pinCenterForOverlay(window._userLatLng, defaultZoom);
        map.flyTo(clearTarget, defaultZoom, { animate: true, duration: 0.8 });
    } else {
        // No user location — just snap zoom to nearest integer
        const currentZ = map.getZoom();
        if (!Number.isInteger(currentZ)) {
            _buttonZoomPending = true;
            map.setZoom(Math.round(currentZ), { animate: true });
        } else {
            isPinchZoom = false;
            updateZoomLevelIndicator();
        }
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
        //
        // Priority (mirrors closeSidebar / peeked-state logic):
        //   1. Selected business pin  → center on it
        //   2. Search location pin    → only if no selected pin AND
        //      _getSidebarRecenterTarget() says 'pin'
        //   3. Polygon fit            → fallback
        let centeredOnSelected = false;
        if (!isAutoFittingPolygon) {
            if (pendingHighlightIdx !== null && markers.length > 0) {
                const selectedMarker = markers.find(m => m.placeIndex === pendingHighlightIdx);
                if (selectedMarker && map.hasLayer(selectedMarker)) {
                    const targetZoom = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                    const pinLatLng = selectedMarker.getLatLng();
                    const offsetCenter = _pinCenterForOverlay(pinLatLng, targetZoom);
                    map.stop();
                    isAutoFittingPolygon = true;
                    map.flyTo(offsetCenter, targetZoom, { duration: 0.5 });
                    const epoch = _clearEpoch;
                    // Highlight AFTER the flyTo completes — not on
                    // onSidebarTransitionEnd (~0.3s) which would interrupt
                    // the fly mid-animation and cancel the zoom change.
                    // The sidebar transition (~0.3s) always finishes before
                    // the flyTo (0.5s), so measurements are safe here.
                    map.once('moveend', () => {
                        isAutoFittingPolygon = false;
                        if (_clearEpoch !== epoch) return;
                        highlightPlace(pendingHighlightIdx);
                    });
                    centeredOnSelected = true;
                }
            }
            if (!centeredOnSelected) {
                if (_getSidebarRecenterTarget() === 'pin') {
                    const targetZoom = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                    const pinLatLng = searchAddressMarker.getLatLng();
                    const offsetCenter = _pinCenterForOverlay(pinLatLng, targetZoom);
                    map.stop();
                    isAutoFittingPolygon = true;
                    map.flyTo(offsetCenter, targetZoom, { duration: 0.5 });
                    const epoch = _clearEpoch;
                    map.once('moveend', () => {
                        isAutoFittingPolygon = false;
                        if (_clearEpoch !== epoch) return;
                        onSidebarTransitionEnd(() => {
                            if (_clearEpoch !== epoch) return;
                            if (searchAddressMarker && map.hasLayer(searchAddressMarker)) {
                                _panToAvailableCanvas(searchAddressMarker.getLatLng());
                            }
                        });
                    });
                } else if (fitStateResultsOpen) {
                    applyPolygonFit(fitStateResultsOpen);
                }
            }
        }

        // After the sidebar reaches midway, highlight the pending card so the
        // pin centers in the exposed canvas area with its abbreviated popup.
        // When centeredOnSelected is true the flyTo moveend already calls
        // highlightPlace — calling it here too would fire it twice.
        if (pendingHighlightIdx !== null && !centeredOnSelected) {
            onSidebarTransitionEnd(() => highlightPlace(pendingHighlightIdx));
        } else if (pendingHighlightIdx === null) {
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
        //
        // _closedByPinTap: user tapped the pin itself → reopen popup after fly.
        // Otherwise (map tap / card selection): keep pin green+large, no popup.
        const reopenPopup = _closedByPinTap;
        _closedByPinTap = false;
        if (fitStateLipPeeked && selectedPlaceIndex !== null && markers.length > 0) {
            const selectedMarker = markers.find(m => m.placeIndex === selectedPlaceIndex);
            if (selectedMarker && map.hasLayer(selectedMarker)) {
                const targetZoom = fitStateLipPeeked.zoom;
                const pinLatLng = selectedMarker.getLatLng();
                const headerH = getMobileHeaderPad();
                // Exposed canvas runs from headerH to (mapH - TOASTER_LIP_HEIGHT).
                // Its center = (headerH + mapH - TOASTER_LIP_HEIGHT) / 2.
                // Map center = mapH / 2.
                // Shift = mapH/2 - (headerH + mapH - lip)/2 = (lip - headerH) / 2
                const offsetY = (TOASTER_LIP_HEIGHT - headerH) / 2;
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
                    // Only reopen the infobox if the user tapped the pin (not map tap)
                    if (reopenPopup && map.hasLayer(selectedMarker)) {
                        _isChangingSelection = true;
                        selectedMarker.openPopup();
                        _isChangingSelection = false;
                    }
                });
                return;
            }
        }

        // Smart recenter: pin inside polygon → pin; pin outside → closer to map center
        if (_getSidebarRecenterTarget() === 'pin') {
            const targetZoom = fitStateLipPeeked ? fitStateLipPeeked.zoom : map.getZoom();
            const pinLatLng = searchAddressMarker.getLatLng();
            const headerH = getMobileHeaderPad();
            const offsetY = (TOASTER_LIP_HEIGHT - headerH) / 2;
            const pinPoint = map.project(pinLatLng, targetZoom);
            const mapCenter = map.unproject(
                L.point(pinPoint.x, pinPoint.y + offsetY),
                targetZoom
            );
            map.stop();
            isAutoFittingPolygon = true;
            map.flyTo(mapCenter, targetZoom, { duration: 0.5 });
            const epoch = _clearEpoch;
            map.once('moveend', () => {
                isAutoFittingPolygon = false;
                if (_clearEpoch !== epoch) return;
                if (map.hasLayer(searchAddressMarker)) {
                    searchAddressMarker.openPopup();
                }
            });
        } else if (fitStateLipPeeked) {
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
        // From fully expanded → go to mid-point (half-open), not close.
        // Priority: selected business pin → search location pin → polygon.
        document.body.classList.remove('results-expanded');
        let _tmsCentered = false;
        if (selectedPlaceIndex !== null && markers.length > 0) {
            const selMarker = markers.find(m => m.placeIndex === selectedPlaceIndex);
            if (selMarker && map.hasLayer(selMarker)) {
                const tz = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                const oc = _pinCenterForOverlay(selMarker.getLatLng(), tz);
                map.stop();
                isAutoFittingPolygon = true;
                map.flyTo(oc, tz, { duration: 0.5 });
                const ep = _clearEpoch;
                map.once('moveend', () => {
                    isAutoFittingPolygon = false;
                    if (ep !== _clearEpoch) return;
                });
                _tmsCentered = true;
            }
        }
        if (!_tmsCentered) {
            if (_getSidebarRecenterTarget() === 'pin') {
                const targetZoom = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                const pinLatLng = searchAddressMarker.getLatLng();
                const offsetCenter = _pinCenterForOverlay(pinLatLng, targetZoom);
                map.stop();
                isAutoFittingPolygon = true;
                map.flyTo(offsetCenter, targetZoom, { duration: 0.5 });
                const epoch = _clearEpoch;
                map.once('moveend', () => {
                    isAutoFittingPolygon = false;
                    if (_clearEpoch !== epoch) return;
                    onSidebarTransitionEnd(() => {
                        if (_clearEpoch !== epoch) return;
                        if (searchAddressMarker && map.hasLayer(searchAddressMarker)) {
                            _panToAvailableCanvas(searchAddressMarker.getLatLng());
                        }
                    });
                });
            } else if (fitStateResultsOpen) {
                applyPolygonFit(fitStateResultsOpen);
            }
        }
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
                // Priority: selected business pin → search location pin → polygon
                let _sdgCentered = false;
                if (selectedPlaceIndex !== null && markers.length > 0) {
                    const selM = markers.find(m => m.placeIndex === selectedPlaceIndex);
                    if (selM && map.hasLayer(selM)) {
                        const tz = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                        const oc = _pinCenterForOverlay(selM.getLatLng(), tz);
                        map.stop();
                        isAutoFittingPolygon = true;
                        map.flyTo(oc, tz, { duration: 0.5 });
                        const ep = _clearEpoch;
                        map.once('moveend', () => { isAutoFittingPolygon = false; if (_clearEpoch !== ep) return; });
                        _sdgCentered = true;
                    }
                }
                if (!_sdgCentered) {
                    if (_getSidebarRecenterTarget() === 'pin') {
                        const tz = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                        const offsetCenter = _pinCenterForOverlay(searchAddressMarker.getLatLng(), tz);
                        map.stop();
                        isAutoFittingPolygon = true;
                        map.flyTo(offsetCenter, tz, { duration: 0.5 });
                        const ep = _clearEpoch;
                        map.once('moveend', () => { isAutoFittingPolygon = false; if (_clearEpoch !== ep) return; });
                    } else if (fitStateResultsOpen) {
                        applyPolygonFit(fitStateResultsOpen);
                    }
                }
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
                // Priority: selected business pin → search location pin → polygon
                let _sdgOpenCentered = false;
                if (dragHighlightIdx !== null && markers.length > 0) {
                    const selM = markers.find(m => m.placeIndex === dragHighlightIdx);
                    if (selM && map.hasLayer(selM)) {
                        const tz = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                        const oc = _pinCenterForOverlay(selM.getLatLng(), tz);
                        map.stop();
                        isAutoFittingPolygon = true;
                        map.flyTo(oc, tz, { duration: 0.5 });
                        const ep = _clearEpoch;
                        // Highlight AFTER flyTo — sidebar transition (~0.3s)
                        // finishes before flyTo (0.5s) so measurements are safe.
                        map.once('moveend', () => {
                            isAutoFittingPolygon = false;
                            if (_clearEpoch !== ep) return;
                            sidebar.style.transition = '';
                            highlightPlace(dragHighlightIdx);
                        });
                        _sdgOpenCentered = true;
                    }
                }
                if (!_sdgOpenCentered) {
                    if (_getSidebarRecenterTarget() === 'pin') {
                        const tz = fitStateResultsOpen ? fitStateResultsOpen.zoom : map.getZoom();
                        const offsetCenter = _pinCenterForOverlay(searchAddressMarker.getLatLng(), tz);
                        map.stop();
                        isAutoFittingPolygon = true;
                        map.flyTo(offsetCenter, tz, { duration: 0.5 });
                        const ep = _clearEpoch;
                        map.once('moveend', () => {
                            isAutoFittingPolygon = false;
                            if (_clearEpoch !== ep) return;
                            onSidebarTransitionEnd(() => {
                                if (_clearEpoch !== ep) return;
                                if (searchAddressMarker && map.hasLayer(searchAddressMarker)) {
                                    _panToAvailableCanvas(searchAddressMarker.getLatLng());
                                }
                            });
                        });
                    } else if (fitStateResultsOpen) {
                        applyPolygonFit(fitStateResultsOpen);
                    }
                }
                // After sidebar settles, highlight the pending card.
                // When _sdgOpenCentered is true the flyTo moveend already
                // calls highlightPlace — skip here to avoid double-fire.
                if (dragHighlightIdx !== null && !_sdgOpenCentered) {
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

                // Close popup — selected pin stays green+large as visual guide
                if (selectedPlaceIndex !== null) {
                    _isChangingSelection = true;
                    map.closePopup();
                    _isChangingSelection = false;
                }

                // Priority: selected business pin → search location pin → polygon
                // (mirrors closeSidebar logic)
                let _sdgPeekedCentered = false;
                if (fitStateLipPeeked && selectedPlaceIndex !== null && markers.length > 0) {
                    const selM = markers.find(m => m.placeIndex === selectedPlaceIndex);
                    if (selM && map.hasLayer(selM)) {
                        const targetZoom = fitStateLipPeeked.zoom;
                        const pinLatLng = selM.getLatLng();
                        const offsetY = (TOASTER_LIP_HEIGHT - getMobileHeaderPad()) / 2;
                        const pinPoint = map.project(pinLatLng, targetZoom);
                        const mc = map.unproject(L.point(pinPoint.x, pinPoint.y + offsetY), targetZoom);
                        map.stop();
                        isAutoFittingPolygon = true;
                        activeFitState = fitStateLipPeeked;
                        map.flyTo(mc, targetZoom, { duration: 0.5 });
                        const epoch = _clearEpoch;
                        map.once('moveend', () => {
                            isAutoFittingPolygon = false;
                            if (_clearEpoch !== epoch) return;
                            // Drag-to-peeked: keep pin green+large but don't
                            // reopen the popup — same "remember last selected"
                            // behavior as closeSidebar when no pin tap occurred.
                        });
                        _sdgPeekedCentered = true;
                    }
                }
                if (!_sdgPeekedCentered) {
                    if (_getSidebarRecenterTarget() === 'pin') {
                        const targetZoom = fitStateLipPeeked ? fitStateLipPeeked.zoom : map.getZoom();
                        const pinLatLng = searchAddressMarker.getLatLng();
                        const offsetY = (TOASTER_LIP_HEIGHT - getMobileHeaderPad()) / 2;
                        const pinPoint = map.project(pinLatLng, targetZoom);
                        const mc = map.unproject(L.point(pinPoint.x, pinPoint.y + offsetY), targetZoom);
                        map.stop();
                        isAutoFittingPolygon = true;
                        map.flyTo(mc, targetZoom, { duration: 0.5 });
                        const epoch = _clearEpoch;
                        map.once('moveend', () => {
                            isAutoFittingPolygon = false;
                            if (_clearEpoch !== epoch) return;
                            if (map.hasLayer(searchAddressMarker)) searchAddressMarker.openPopup();
                        });
                    } else if (fitStateLipPeeked) {
                        applyPolygonFit(fitStateLipPeeked);
                    }
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

function showLoading(show, message) {
    const overlay = document.getElementById('loading-overlay');
    const textEl = document.getElementById('loading-text');
    if (show) {
        if (textEl) textEl.textContent = message || 'Searching for locations...';
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
        valueEl.textContent = (Number.isInteger(currentZoomLevel)
            ? String(currentZoomLevel)
            : currentZoomLevel.toFixed(1)) + 'x';
    }

    const minZoomToDraw = getMinZoomLevelToDraw();
    const canDraw = currentZoomLevel >= minZoomToDraw;
    indicator.classList.toggle('can-draw', canDraw);
    indicator.classList.toggle('cannot-draw', !canDraw);
    indicator.classList.toggle('fit-zoom', isFitZoom);

    // Update hint text
    if (hintEl) {
        if (isFitZoom && canDraw) {
            hintEl.textContent = '(fit)';
        } else if (isFitZoom && !canDraw) {
            // Category fit zoom is below draw threshold — tell user how many levels
            const needed = Math.ceil(minZoomToDraw - currentZoomLevel);
            hintEl.textContent = `(+${needed} to draw)`;
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

// =============================================================================
// Settings Overlay & Direction Mode
// =============================================================================

(function initSettings() {
    // ── Restore persisted state ──
    // _advancedSaved tracks whether the user has EVER saved an advanced
    // configuration.  It stays true even when switching to pre/post-game
    // so the Advanced shortcut button remains enabled.
    let _advancedSaved = false;
    try {
        directionModeEnabled = localStorage.getItem('laso_direction_mode') === 'true';
        _advancedSaved = localStorage.getItem('laso_advanced_saved') === 'true';
        const savedSubMode = localStorage.getItem('laso_direction_sub_mode');
        if (savedSubMode === 'pre-game' || savedSubMode === 'post-game' || savedSubMode === 'advanced') {
            directionSubMode = savedSubMode;
        }
        // If advanced sub-mode is active but no saved config exists, fall back
        if (directionSubMode === 'advanced' && !_advancedSaved) {
            directionSubMode = 'pre-game';
        }
        useAdvancedOrder = directionSubMode === 'advanced';
        if (useAdvancedOrder || _advancedSaved) {
            const savedOrder = localStorage.getItem('laso_direction_order');
            if (savedOrder) {
                const parsed = JSON.parse(savedOrder);
                if (Array.isArray(parsed) && parsed.every(l => ['A','B','C','D'].includes(l))) {
                    directionOrder = parsed;
                }
            }
        }
        if (!useAdvancedOrder) {
            // Runtime order follows the active preset
            directionOrder = directionSubMode === 'post-game' ? ['A', 'C', 'B'] : ['A', 'B', 'C'];
        }
    } catch (e) { /* localStorage unavailable */ }

    // ── DOM references ──
    const toggle           = document.getElementById('direction-mode-toggle');
    const settingsBtn      = document.getElementById('settings-btn');
    const overlay          = document.getElementById('settings-overlay');
    const backdrop         = document.getElementById('settings-backdrop');
    const closeBtn         = document.getElementById('settings-close');
    const mainPanel        = document.querySelector('.settings-panel');
    const advancedPanel    = document.getElementById('direction-advanced-panel');
    const advancedLink     = document.getElementById('direction-advanced-link');
    const advancedBtn      = document.getElementById('direction-advanced-btn');
    const backBtn          = document.getElementById('direction-back-btn');
    const advancedCloseBtn = document.getElementById('direction-advanced-close');
    const saveBtn          = document.getElementById('direction-save-btn');
    const pool             = document.getElementById('direction-pool');
    const track            = document.getElementById('direction-track');
    const infoBtn          = document.getElementById('direction-mode-info');
    const contentArea      = document.getElementById('direction-content-area');
    const infoTooltip      = document.getElementById('direction-info-tooltip');
    const subModeWrap      = document.getElementById('direction-sub-mode');
    const subModePreBtn    = document.getElementById('sub-mode-pre');
    const subModePostBtn   = document.getElementById('sub-mode-post');
    const subModeAdvBtn    = document.getElementById('sub-mode-advanced');
    const subModeDesc      = document.getElementById('sub-mode-desc');

    // Letter metadata for pill display
    const LETTER_META = {
        A: { label: 'Current location',  bg: '#ea4335', fg: '#fff' },
        B: { label: 'Selected location', bg: '#4285f4', fg: '#fff' },
        C: { label: 'Searched location', bg: '#fbbc04', fg: '#333' },
        D: { label: 'Wild pin',          bg: '#6366f1', fg: '#fff' }
    };

    if (toggle) toggle.checked = directionModeEnabled;

    // ── Overlay body-blocking helpers ──
    function blockBody()   { document.body.classList.add('overlay-active'); }
    function unblockBody() { document.body.classList.remove('overlay-active'); }

    // ── Crossfade between info text (OFF) and direction options (ON) ──
    function syncDirectionUIVisibility() {
        if (contentArea) {
            contentArea.classList.toggle('direction-on', directionModeEnabled);
        }
        // Hide info button when direction mode is off (text already visible)
        if (infoBtn) infoBtn.style.display = directionModeEnabled ? '' : 'none';
        // Dismiss tooltip when toggling off
        if (!directionModeEnabled && infoTooltip) {
            infoTooltip.classList.add('hidden');
            if (infoBtn) infoBtn.classList.remove('active');
        }
    }
    function _syncAdvancedBtnState() {
        if (!subModeAdvBtn) return;
        if (_advancedSaved) {
            subModeAdvBtn.disabled = false;
            subModeAdvBtn.classList.remove('disabled');
        } else {
            subModeAdvBtn.disabled = true;
            subModeAdvBtn.classList.add('disabled');
        }
    }

    function syncSubModeUI() {
        if (subModePreBtn)  subModePreBtn.classList.toggle('active', directionSubMode === 'pre-game');
        if (subModePostBtn) subModePostBtn.classList.toggle('active', directionSubMode === 'post-game');
        if (subModeAdvBtn)  subModeAdvBtn.classList.toggle('active', directionSubMode === 'advanced');
        _syncAdvancedBtnState();

        if (subModeDesc) {
            // Build stops from active mode
            let stops;
            if (directionSubMode === 'advanced' && useAdvancedOrder && directionOrder.length >= 2) {
                stops = directionOrder.map(l => LETTER_META[l]).filter(Boolean);
            } else if (directionSubMode === 'post-game') {
                stops = [LETTER_META.A, LETTER_META.C, LETTER_META.B];
            } else {
                stops = [LETTER_META.A, LETTER_META.B, LETTER_META.C];
            }

            const n = stops.length;
            let html = '';
            for (let i = 0; i < n; i++) {
                const s = stops[i];
                html += `<div class="sub-mode-row"><span class="sub-mode-pill" style="background:${s.bg};color:${s.fg};border-color:${s.bg};">${s.label}</span></div>`;
                if (i < n - 1) {
                    html += `<div class="sub-mode-arrow-row"><img src="Curved_solid_arrow.svg" alt="→"></div>`;
                }
            }
            subModeDesc.innerHTML = html;
            requestAnimationFrame(() => _layoutPillsAndArrows());
        }
    }

    const BASE_ARROW_H = 38; // minimum arrow row height (matches 4-stop advanced mode)
    let _descFixedHeight = 0;

    function _layoutPillsAndArrows() {
        if (!subModeDesc) return;
        const pills = subModeDesc.querySelectorAll('.sub-mode-pill');
        const arrowRows = subModeDesc.querySelectorAll('.sub-mode-arrow-row');
        const n = pills.length;
        if (n === 0) return;

        // 1. Equalize pill widths
        let maxW = 0;
        pills.forEach(p => { p.style.width = ''; p.style.marginLeft = ''; maxW = Math.max(maxW, p.offsetWidth); });
        if (maxW > 0) pills.forEach(p => { p.style.width = maxW + 'px'; });

        // 2. Measure and lock container height to 4-stop layout (once).
        //    This keeps the overlay the same height regardless of sub-mode.
        if (!_descFixedHeight) {
            const pillRowH = pills[0].closest('.sub-mode-row').offsetHeight;
            if (pillRowH > 0) {
                _descFixedHeight = 4 * pillRowH + 3 * BASE_ARROW_H;
            }
        }
        if (_descFixedHeight > 0) {
            subModeDesc.style.height = _descFixedHeight + 'px';
        }

        // 3. Position pills in an evenly-spaced diagonal cascade (left → right).
        if (n >= 2) {
            const row = pills[0].closest('.sub-mode-row');
            const rowW = row ? row.offsetWidth : subModeDesc.offsetWidth;
            const available = rowW - maxW;
            for (let i = 0; i < n; i++) {
                const offset = (i / (n - 1)) * available;
                pills[i].style.marginLeft = offset + 'px';
            }

            // 4. Calculate arrow row height analytically (no DOM measurement needed).
            //    With flex:1 the available vertical space distributes evenly.
            const pillRowH = pills[0].closest('.sub-mode-row').offsetHeight;
            const totalPillH = n * pillRowH;
            const arrowCount = n - 1;
            const arrowRowH = arrowCount > 0
                ? (_descFixedHeight - totalPillH) / arrowCount
                : BASE_ARROW_H;

            // 5. Size and position each arrow image.
            //    Post-rotation: CSS width → visual height, CSS height → visual width.
            //    We want the visual height ≈ 80% of the arrow row height.
            const SVG_RATIO = 140 / 250; // original SVG width / height
            for (let i = 0; i < arrowRows.length; i++) {
                const img = arrowRows[i].querySelector('img');
                if (!img) continue;

                // Horizontal position: center between adjacent pill centers
                const leftOff  = parseFloat(pills[i].style.marginLeft) || 0;
                const rightOff = parseFloat(pills[i + 1].style.marginLeft) || 0;
                const midCenter = (leftOff + rightOff) / 2 + maxW / 2;
                img.style.left = midCenter + 'px';

                // Size: post-rotation visual height = pre-rotation CSS width
                const visualH = arrowRowH * 0.8;
                img.style.width = visualH + 'px';
                img.style.height = (visualH / SVG_RATIO) + 'px';
            }
        }
    }
    syncDirectionUIVisibility();
    syncSubModeUI();

    // ── Open / close settings overlay ──
    function openSettings() {
        if (!overlay) return;
        // Always return to main panel when opening
        if (mainPanel)    { mainPanel.classList.remove('hidden', 'slide-out-left'); }
        if (advancedPanel) advancedPanel.classList.add('hidden');
        overlay.classList.remove('hidden');
        blockBody();
        // Double-rAF: first rAF lets browser process display:none → visible,
        // second rAF fires after layout is complete so pills measure correctly.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => _layoutPillsAndArrows());
        });
    }

    function closeSettings() {
        if (!overlay) return;
        overlay.classList.add('hidden');
        // Reset panel states
        if (mainPanel)    { mainPanel.classList.remove('slide-out-left'); }
        if (advancedPanel) advancedPanel.classList.add('hidden');
        // Dismiss info tooltip
        if (infoTooltip) infoTooltip.classList.add('hidden');
        if (infoBtn)     infoBtn.classList.remove('active');
        unblockBody();
    }

    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
    if (backdrop)    backdrop.addEventListener('click', closeSettings);
    if (closeBtn)    closeBtn.addEventListener('click', closeSettings);

    // ── Direction Mode toggle ──
    if (toggle) {
        toggle.addEventListener('change', () => {
            directionModeEnabled = toggle.checked;
            try { localStorage.setItem('laso_direction_mode', String(directionModeEnabled)); } catch (e) {}
            syncDirectionUIVisibility();
            // Redraw arrows after direction options fade in
            if (directionModeEnabled) {
                setTimeout(() => _layoutPillsAndArrows(), 200);
            }
        });
    }

    // ── Sub-mode toggle (3-way: pre-game / post-game / advanced) ──
    function getSubModeOrder(mode) {
        return mode === 'post-game' ? ['A', 'C', 'B'] : ['A', 'B', 'C'];
    }

    // Pre-game and Post-game buttons — switch to preset order
    [subModePreBtn, subModePostBtn].forEach(btn => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            directionSubMode = btn.dataset.mode;
            useAdvancedOrder = false;
            directionOrder = getSubModeOrder(directionSubMode);
            try {
                localStorage.setItem('laso_direction_sub_mode', directionSubMode);
                localStorage.setItem('laso_use_advanced_order', 'false');
            } catch (e) {}
            syncSubModeUI();
        });
    });

    // Advanced shortcut button — restores the saved advanced order
    if (subModeAdvBtn) {
        subModeAdvBtn.addEventListener('click', () => {
            if (!_advancedSaved) return; // disabled — no saved config yet
            directionSubMode = 'advanced';
            useAdvancedOrder = true;
            // Restore the saved advanced order from localStorage
            try {
                const savedOrder = localStorage.getItem('laso_direction_order');
                if (savedOrder) {
                    const parsed = JSON.parse(savedOrder);
                    if (Array.isArray(parsed) && parsed.every(l => ['A','B','C','D'].includes(l))) {
                        directionOrder = parsed;
                    }
                }
                localStorage.setItem('laso_direction_sub_mode', 'advanced');
                localStorage.setItem('laso_use_advanced_order', 'true');
            } catch (e) {}
            syncSubModeUI();
        });
    }

    // ── Info icon toggle (tooltip overlay when direction mode ON) ──
    function dismissTooltip() {
        if (infoTooltip) infoTooltip.classList.add('hidden');
        if (infoBtn)     infoBtn.classList.remove('active');
    }

    if (infoBtn && infoTooltip) {
        infoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!directionModeEnabled) return;
            const showing = !infoTooltip.classList.contains('hidden');
            infoTooltip.classList.toggle('hidden', showing);
            infoBtn.classList.toggle('active', !showing);
        });

        // Dismiss tooltip when tapping anywhere outside it
        document.addEventListener('click', (e) => {
            if (infoTooltip.classList.contains('hidden')) return;
            if (!infoTooltip.contains(e.target) && e.target !== infoBtn && !infoBtn.contains(e.target)) {
                dismissTooltip();
            }
        });
    }

    // ── Advanced panel navigation ──
    function openAdvancedPanel() {
        if (mainPanel)     mainPanel.classList.add('slide-out-left');
        if (advancedPanel) advancedPanel.classList.remove('hidden');
        initDragAndDrop();
    }

    function closeAdvancedPanel() {
        if (advancedPanel) advancedPanel.classList.add('hidden');
        if (mainPanel)     mainPanel.classList.remove('slide-out-left');
        // Refresh pills + arrows now that the main panel is visible again
        // (syncSubModeUI during save ran while panel was off-screen → zero rects)
        syncSubModeUI();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => _layoutPillsAndArrows());
        });
    }

    if (advancedBtn)      advancedBtn.addEventListener('click', openAdvancedPanel);
    if (backBtn)          backBtn.addEventListener('click', closeAdvancedPanel);
    if (advancedCloseBtn) advancedCloseBtn.addEventListener('click', closeSettings);

    // =====================================================================
    // Drag-and-Drop Circle Ordering
    // =====================================================================

    let _dragState = null;   // { el, letter, pointerId, offsetX, offsetY, startSlot }

    /**
     * (Re-)initialise the drag-and-drop builder every time the advanced
     * panel is opened.  Reads current directionOrder and directionLocations
     * to place circles in their saved slots or back in the pool.
     */
    function initDragAndDrop() {
        if (!pool || !track) return;

        // Build permanent pool-slots (one per letter, left-to-right: A B C D)
        pool.innerHTML = '';
        ['A', 'B', 'C', 'D'].forEach(letter => {
            const ps = document.createElement('div');
            ps.className = 'pool-slot';
            ps.dataset.letter = letter;
            pool.appendChild(ps);
        });

        const trackSlots = track.querySelectorAll('.direction-slot');
        trackSlots.forEach(slot => {
            slot.classList.remove('occupied', 'drag-over');
            const old = slot.querySelector('.direction-circle');
            if (old) old.remove();
        });

        // Place circles from saved order into track slots
        const placedSet = new Set();
        let slotIdx = 0;
        directionOrder.forEach(letter => {
            if (slotIdx >= trackSlots.length) return;
            const circle = _createCircle(letter);
            const slot = trackSlots[slotIdx++];
            slot.appendChild(circle);
            circle.classList.add('in-slot');
            slot.classList.add('occupied');
            placedSet.add(letter);
        });

        // Remaining letters stay in their permanent pool-slot
        ['A', 'B', 'C', 'D'].forEach(letter => {
            if (placedSet.has(letter)) return;
            const circle = _createCircle(letter);
            const ps = pool.querySelector(`.pool-slot[data-letter="${letter}"]`);
            if (ps) ps.appendChild(circle);
        });
    }

    function _createCircle(letter) {
        const el = document.createElement('div');
        el.className = 'direction-circle';
        el.dataset.letter = letter;
        el.textContent = letter;
        el.setAttribute('aria-label', `Location ${letter}`);

        // Attach pointer listeners for drag
        el.addEventListener('pointerdown', _onPointerDown);

        return el;
    }

    // ── Pointer-based drag (works for both mouse & touch) ──

    function _onPointerDown(e) {
        const el = e.currentTarget;

        e.preventDefault();
        el.style.transition = 'none'; // prevent lag on first pickup
        el.setPointerCapture(e.pointerId);

        const rect = el.getBoundingClientRect();
        _dragState = {
            el:       el,
            letter:   el.dataset.letter,
            pointerId: e.pointerId,
            offsetX:  e.clientX - rect.left - rect.width / 2,
            offsetY:  e.clientY - rect.top - rect.height / 2,
            startSlot: el.closest('.direction-slot') || null
        };

        // If circle was in a slot, remove it from that slot
        if (_dragState.startSlot) {
            _dragState.startSlot.classList.remove('occupied');
            el.classList.remove('in-slot');
        }

        // Move to fixed positioning for dragging
        el.classList.add('dragging');
        el.style.position = 'fixed';
        el.style.left = (e.clientX - 20) + 'px';
        el.style.top  = (e.clientY - 20) + 'px';
        el.style.margin = '0';
        // Append to overlay so it floats above everything
        overlay.appendChild(el);

        el.addEventListener('pointermove', _onPointerMove);
        el.addEventListener('pointerup',   _onPointerUp);
        el.addEventListener('pointercancel', _onPointerUp);
    }

    function _onPointerMove(e) {
        if (!_dragState || _dragState.pointerId !== e.pointerId) return;
        e.preventDefault();
        _dragState.el.style.left = (e.clientX - 20) + 'px';
        _dragState.el.style.top  = (e.clientY - 20) + 'px';

        // Highlight slot under pointer
        const slots = track.querySelectorAll('.direction-slot');
        slots.forEach(slot => {
            const sr = slot.getBoundingClientRect();
            const hit = e.clientX >= sr.left && e.clientX <= sr.right &&
                        e.clientY >= sr.top  && e.clientY <= sr.bottom;
            slot.classList.toggle('drag-over', hit && !slot.classList.contains('occupied'));
        });
    }

    function _onPointerUp(e) {
        if (!_dragState || _dragState.pointerId !== e.pointerId) return;
        e.preventDefault();
        const { el } = _dragState;

        el.removeEventListener('pointermove', _onPointerMove);
        el.removeEventListener('pointerup',   _onPointerUp);
        el.removeEventListener('pointercancel', _onPointerUp);

        // Determine target slot
        const slots = track.querySelectorAll('.direction-slot');
        let targetSlot = null;
        slots.forEach(slot => {
            slot.classList.remove('drag-over');
            const sr = slot.getBoundingClientRect();
            const hit = e.clientX >= sr.left && e.clientX <= sr.right &&
                        e.clientY >= sr.top  && e.clientY <= sr.bottom;
            if (hit && !slot.classList.contains('occupied')) {
                targetSlot = slot;
            }
        });

        // Reset inline positioning and restore transitions
        el.classList.remove('dragging');
        el.style.transition = '';
        el.style.position = '';
        el.style.left = '';
        el.style.top = '';
        el.style.margin = '';

        if (targetSlot) {
            // Place circle in the slot
            targetSlot.appendChild(el);
            el.classList.add('in-slot');
            targetSlot.classList.add('occupied');
        } else {
            // Return to its permanent pool-slot
            el.classList.remove('in-slot');
            const ps = pool.querySelector(`.pool-slot[data-letter="${el.dataset.letter}"]`);
            if (ps) ps.appendChild(el);
            else pool.appendChild(el);
        }

        _dragState = null;
    }

    // ── Save button ──
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const slots = track.querySelectorAll('.direction-slot');
            const newOrder = [];
            slots.forEach(slot => {
                const circle = slot.querySelector('.direction-circle');
                if (circle) newOrder.push(circle.dataset.letter);
            });
            directionOrder = newOrder;
            useAdvancedOrder = true;
            directionSubMode = 'advanced';
            _advancedSaved = true;
            try {
                localStorage.setItem('laso_direction_order', JSON.stringify(directionOrder));
                localStorage.setItem('laso_use_advanced_order', 'true');
                localStorage.setItem('laso_direction_sub_mode', 'advanced');
                localStorage.setItem('laso_advanced_saved', 'true');
            } catch (e) {}

            // Enable and activate the Advanced shortcut button
            syncSubModeUI();

            // Visual feedback: brief button flash
            saveBtn.style.background = '#34a853';
            saveBtn.textContent = 'Saved!';
            setTimeout(() => {
                saveBtn.style.background = '';
                saveBtn.innerHTML = '<i class="fas fa-check"></i> Save';
            }, 1200);
        });
    }
})();

// =============================================================================
// Direction Mode — Multi-Stop URL Generation
// =============================================================================

/**
 * Build a multi-stop directions URL for the given provider using the user's
 * saved directionOrder.
 *   A = current location (directionLocations.A)
 *   B = selected place (resolved at click-time from destLat/destLng)
 *   C = searched location (directionLocations.C)
 *   D = wild pin (directionLocations.D, null when not on map)
 *
 * The first location in order becomes the origin, the last becomes the
 * destination, and everything in between becomes intermediate waypoints.
 *
 * Falls back to a simple origin→destination URL if fewer than 2 locations
 * are available, or to a pin/search URL if direction mode is off.
 */
function buildMultiStopUrl(provider, destLat, destLng, destName, searchTerm, order) {
    const locMap = {
        A: directionLocations.A,
        B: (destLat && destLng)
            ? { lat: parseFloat(destLat), lng: parseFloat(destLng), label: destName || '' }
            : null,
        C: directionLocations.C,
        D: directionLocations.D
    };

    // Build ordered list, filtering out null locations
    const effectiveOrder = order || directionOrder;
    const ordered = effectiveOrder
        .map(letter => locMap[letter])
        .filter(loc => loc && isFinite(loc.lat) && isFinite(loc.lng));

    if (ordered.length < 2) {
        // Not enough locations for directions — fall back to simple URL
        return provider === 'google'
            ? _getGoogleFallbackUrl(destLat, destLng, searchTerm)
            : _getAppleFallbackUrl(destLat, destLng, destName);
    }

    const origin      = ordered[0];
    const destination  = ordered[ordered.length - 1];
    const waypoints    = ordered.slice(1, -1);

    if (provider === 'google') {
        let url = `https://www.google.com/maps/dir/?api=1`
            + `&origin=${origin.lat},${origin.lng}`
            + `&destination=${destination.lat},${destination.lng}`
            + `&travelmode=driving`;
        if (waypoints.length > 0) {
            url += `&waypoints=` + waypoints.map(w => `${w.lat},${w.lng}`).join('%7C');
        }
        return url;
    }

    // Apple Maps
    if (waypoints.length === 0) {
        return `https://maps.apple.com/?saddr=${origin.lat},${origin.lng}`
            + `&daddr=${destination.lat},${destination.lng}&dirflg=d`;
    }
    // Multi-stop: chain with +to: in daddr
    const allDests = [...waypoints, destination];
    const daddrStr = allDests.map(w => `${w.lat},${w.lng}`).join('+to:');
    return `https://maps.apple.com/?saddr=${origin.lat},${origin.lng}`
        + `&daddr=${daddrStr}&dirflg=d`;
}

/**
 * Build a Google Maps directions URL from drawSearchOrigin to a destination.
 * Falls back to a regular search URL if no origin is saved.
 */
function getGoogleDirectionsUrl(destLat, destLng, searchTerm) {
    if (drawSearchOrigin) {
        return `https://www.google.com/maps/dir/?api=1&origin=${drawSearchOrigin[0]},${drawSearchOrigin[1]}&destination=${destLat},${destLng}`;
    }
    return _getGoogleFallbackUrl(destLat, destLng, searchTerm);
}

function _getGoogleFallbackUrl(destLat, destLng, searchTerm) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchTerm || `${destLat},${destLng}`)}`;
}

/**
 * Build an Apple Maps directions URL from drawSearchOrigin to a destination.
 * Falls back to a regular pin URL if no origin is saved.
 */
function getAppleDirectionsUrl(destLat, destLng, name) {
    if (drawSearchOrigin) {
        return `https://maps.apple.com/?saddr=${drawSearchOrigin[0]},${drawSearchOrigin[1]}&daddr=${destLat},${destLng}&dirflg=d`;
    }
    return _getAppleFallbackUrl(destLat, destLng, name);
}

function _getAppleFallbackUrl(destLat, destLng, name) {
    return `https://maps.apple.com/?q=${encodeURIComponent(name || '')}&ll=${destLat},${destLng}&z=19`;
}

/**
 * Check whether the clicked destination is effectively the same place as
 * the red search pin (directionLocations.C).  Returns true when dest ≈ C,
 * meaning the C waypoint would be redundant in a multi-stop route.
 *
 * Also returns true if a selected green pin exists but its address matches
 * the red pin (mega-pin duplicate) — that green pin doesn't count as a
 * separate stop.
 */
function _isDestSameAsSearchPin(destLat, destLng) {
    if (!searchAddressMarker || !map.hasLayer(searchAddressMarker)) return false;
    const locC = directionLocations.C;
    if (!locC) return false;

    // Check dest against ALL known coords for the search pin:
    //   1. directionLocations.C (Nominatim)
    //   2. marker's actual position
    //   3. mega pin place's Google Places coords
    const THRESH = 0.0005; // ~50 m
    const candidates = [
        { lat: locC.lat, lng: locC.lng }
    ];
    const markerLL = searchAddressMarker.getLatLng();
    candidates.push({ lat: markerLL.lat, lng: markerLL.lng });
    const enrichment = searchAddressMarker._searchEnrichment;
    if (enrichment && enrichment._megaPinPlace && enrichment._megaPinPlace.coordinates) {
        candidates.push({ lat: enrichment._megaPinPlace.coordinates[0], lng: enrichment._megaPinPlace.coordinates[1] });
    }
    const coordMatch = candidates.some(c =>
        Math.abs(destLat - c.lat) < THRESH && Math.abs(destLng - c.lng) < THRESH
    );

    const searchAddr = _normName(searchAddressMarker._searchAddress || locC.label || '');

    if (!coordMatch && !searchAddr) return false;

    // If coords match, check whether a selected green pin is a genuinely
    // DIFFERENT place (not the mega-pin duplicate).
    if (coordMatch) {
        // Check if there's a highlighted green pin that is NOT the same place
        if (_highlightedMarkerIndex !== null && _highlightedMarkerIndex !== undefined) {
            const greenPlace = allSearchResults[_highlightedMarkerIndex];
            if (greenPlace) {
                const greenAddr = _normName(greenPlace.address || '');
                const greenName = _normName(greenPlace.name || '');
                const pinName = _normName(searchAddressMarker._searchName || '');
                // If green pin has a different name AND address, it's a real separate stop
                const sameAsPin = (greenName && pinName && (greenName.includes(pinName) || pinName.includes(greenName)))
                    || (greenAddr && searchAddr && (greenAddr.includes(searchAddr) || searchAddr.includes(greenAddr)));
                if (!sameAsPin) {
                    console.log(`[Directions] Green pin #${_highlightedMarkerIndex} "${greenPlace.name}" is a different place — allowing multi-stop`);
                    return false;
                }
                console.log(`[Directions] Green pin #${_highlightedMarkerIndex} "${greenPlace.name}" matches search pin — treating as same`);
            }
        }
        console.log(`[Directions] Destination matches search pin (C) — using simple A→dest`);
        return true;
    }

    return false;
}

// ── Direction Mode: click event delegation ──
// Intercepts clicks on .directions-capable links at click-time so the toggle
// takes effect immediately without re-rendering cards or popups.
// When advanced multi-stop order is saved, uses buildMultiStopUrl;
// otherwise falls back to the simple origin→destination URL.
document.addEventListener('click', function(e) {
    if (!directionModeEnabled) return;

    const link = e.target.closest('a.directions-capable');
    if (!link) return;

    const destLat = link.dataset.destLat;
    const destLng = link.dataset.destLng;
    if (!destLat || !destLng) return;

    e.preventDefault();

    // Set B (selected location) from the clicked link — skip for wild pin
    if (!link.dataset.wildPin) {
        directionLocations.B = {
            lat: parseFloat(destLat),
            lng: parseFloat(destLng),
            label: link.dataset.destName || ''
        };
    }

    let url;
    const provider = link.dataset.mapProvider;

    // ── Special case: red search pin ──
    // When the clicked destination ≈ C (searched address), a multi-stop
    // route through C is redundant (same place).  Use simple
    // current-location → destination instead.
    const destIsSearchPin = _isDestSameAsSearchPin(parseFloat(destLat), parseFloat(destLng));

    if (destIsSearchPin) {
        // Simple 2-stop: user's current location (A) → destination
        const userLoc = directionLocations.A || (window._userLatLng
            ? { lat: window._userLatLng[0], lng: window._userLatLng[1] }
            : null);
        if (userLoc) {
            if (provider === 'google') {
                url = `https://www.google.com/maps/dir/?api=1&origin=${userLoc.lat},${userLoc.lng}&destination=${destLat},${destLng}&travelmode=driving`;
            } else if (provider === 'apple') {
                url = `https://maps.apple.com/?saddr=${userLoc.lat},${userLoc.lng}&daddr=${destLat},${destLng}&dirflg=d`;
            }
            console.log(`[Directions] Search pin special case: simple A→dest (${provider})`);
        }
    }

    if (!url) {
        const effectiveOrder = getEffectiveDirectionOrder();
        if (effectiveOrder.length >= 2) {
            url = buildMultiStopUrl(
                provider,
                destLat, destLng,
                link.dataset.destName || '',
                link.dataset.searchTerm || '',
                effectiveOrder
            );
        } else {
            // Fallback: simple origin→destination mode
            if (provider === 'google') {
                url = getGoogleDirectionsUrl(destLat, destLng, link.dataset.searchTerm || '');
            } else if (provider === 'apple') {
                url = getAppleDirectionsUrl(destLat, destLng, link.dataset.destName || '');
            }
        }
    }

    if (url) {
        const target = _isIOSDevice() ? '_self' : '_blank';
        window.open(url, target);
    }
}, true);

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

    // Pin Safari toolbar color so the toast background doesn't bleed through
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#ffffff');

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
