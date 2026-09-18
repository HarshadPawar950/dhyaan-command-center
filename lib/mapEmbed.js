// =============================================================
// lib/mapEmbed.js — Google Maps helpers for the property showcase.
// PURE (no I/O), so it's unit-testable and safe to use in routes + views.
// NO API key: we embed via the public `?output=embed` endpoint and link out
// with the pasted share URL. Placeholder-tolerant — accepts any Google share
// link the team pastes, and falls back to the property's location text.
// =============================================================

// Hosts we accept as a Google Maps link. Empty is allowed (field is optional).
function validateGoogleMapsUrl(url) {
    const s = (url || '').trim();
    if (!s) return { ok: true, empty: true };
    let host;
    try {
        const u = new URL(s);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return { ok: false, reason: 'The link must start with http:// or https://.' };
        }
        host = u.hostname.toLowerCase();
    } catch (_) {
        return { ok: false, reason: 'That does not look like a valid URL.' };
    }
    const ok =
        host === 'goo.gl' ||
        host === 'maps.app.goo.gl' ||
        host.endsWith('google.com') ||
        host.endsWith('google.co.in');
    return ok
        ? { ok: true, empty: false }
        : { ok: false, reason: 'Please paste a Google Maps link (google.com/maps or maps.app.goo.gl).' };
}

// Pull lat,lng out of a full Google Maps URL if present.
function extractCoords(url) {
    const s = String(url || '');
    let m = s.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);            // .../@19.03,73.06,15z
    if (!m) m = s.match(/[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);   // ...?q=19.03,73.06
    if (!m) m = s.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);    // ...!3d19.03!4d73.06
    return m ? { lat: m[1], lng: m[2] } : null;
}

// Validate an optional lat/long pair the team types directly (Δ4).
// Both empty => ok with no coords. If either is filled, BOTH must be valid
// numbers within range. Mirrors the DB CHECK constraints in migration 017.
function validateCoords(lat, lng) {
    const a = String(lat == null ? '' : lat).trim();
    const b = String(lng == null ? '' : lng).trim();
    if (!a && !b) return { ok: true, empty: true, lat: null, lng: null };
    if (!a || !b) return { ok: false, reason: 'Enter BOTH latitude and longitude, or leave both blank.' };
    const nlat = Number(a), nlng = Number(b);
    if (!Number.isFinite(nlat) || !Number.isFinite(nlng)) {
        return { ok: false, reason: 'Latitude/longitude must be numbers.' };
    }
    if (nlat < -90 || nlat > 90) return { ok: false, reason: 'Latitude must be between -90 and 90.' };
    if (nlng < -180 || nlng > 180) return { ok: false, reason: 'Longitude must be between -180 and 180.' };
    return { ok: true, empty: false, lat: nlat, lng: nlng };
}

// Build the render model for the detail-page map block.
// Returns: { hasAny, embedSrc, openUrl } — the view stays dumb.
// Precedence: explicit lat/long (Δ4) > coords parsed from the pasted URL >
// the raw pasted URL > location text.
function buildMap(googleMapsUrl, location, lat, lng) {
    const url = (googleMapsUrl || '').trim();
    const loc = (location || '').trim();

    // Explicit coordinates win when both are present & finite.
    let explicit = null;
    if (lat != null && lat !== '' && lng != null && lng !== '') {
        const nlat = Number(lat), nlng = Number(lng);
        if (Number.isFinite(nlat) && Number.isFinite(nlng)) explicit = { lat: nlat, lng: nlng };
    }

    let embedSrc = null;
    const coords = explicit || (url ? extractCoords(url) : null);
    if (coords) {
        embedSrc = `https://maps.google.com/maps?q=${coords.lat},${coords.lng}&z=15&output=embed`;
    } else if (loc) {
        embedSrc = `https://maps.google.com/maps?q=${encodeURIComponent(loc)}&z=14&output=embed`;
    }

    let openUrl = null;
    if (explicit) openUrl = `https://www.google.com/maps/search/?api=1&query=${explicit.lat},${explicit.lng}`;
    else if (url) openUrl = url;
    else if (loc) openUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;

    return {
        hasAny: !!(embedSrc || openUrl),
        embedSrc,
        openUrl,
    };
}

module.exports = { validateGoogleMapsUrl, extractCoords, validateCoords, buildMap };
