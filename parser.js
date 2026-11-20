// Normalises Google Timeline exports (Android "semanticSegments" and iOS array format)
const NUM = /-?\d+(?:\.\d+)?/g;

function ll(x) {
  if (x == null) return null;
  if (typeof x === 'string') {
    const m = x.match(NUM);
    if (!m || m.length < 2) return null;
    const a = +m[0], b = +m[1];
    return Math.abs(a) <= 90 && Math.abs(b) <= 180 ? [a, b] : null;
  }
  if (typeof x === 'object') {
    if (x.latLng) return ll(x.latLng);
    if (x.point) return ll(x.point);
    if ('latitudeE7' in x) return [x.latitudeE7 / 1e7, x.longitudeE7 / 1e7];
    if ('latitude' in x) return [x.latitude, x.longitude];
  }
  return null;
}

const norm = t => String(t || 'unknown').toLowerCase().replace(/\s+/g, '_');

function pretty(t) {
  const s = String(t || 'UNKNOWN').toUpperCase();
  if (s.includes('HOME')) return 'Home';
  if (s.includes('WORK')) return 'Work';
  if (s === 'UNKNOWN') return 'Place';
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

function parse(data) {
  const segs = Array.isArray(data) ? data : data && data.semanticSegments;
  if (!segs) throw new Error('Unrecognised format — expected Timeline.json with "semanticSegments" (or the iOS array export).');
  const items = [];
  for (const s of segs) {
    if (!s || !s.startTime) continue;
    const base = { start: s.startTime, end: s.endTime || s.startTime, t0: Date.parse(s.startTime), t1: Date.parse(s.endTime || s.startTime) };
    if (s.visit) {
      const tc = s.visit.topCandidate || {};
      const p = ll(tc.placeLocation);
      if (p) items.push({ ...base, kind: 'visit', lat: p[0], lng: p[1], label: pretty(tc.semanticType), placeId: tc.placeId || null });
    } else if (s.activity) {
      const a = s.activity, tc = a.topCandidate || {};
      items.push({ ...base, kind: 'move', type: norm(tc.type), dist: Number(a.distanceMeters) || 0, from: ll(a.start), to: ll(a.end) });
    } else if (Array.isArray(s.timelinePath)) {
      const pts = s.timelinePath.map(p => ll(p.point)).filter(Boolean);
      if (pts.length > 1) items.push({ ...base, kind: 'path', pts });
    }
  }
  return items;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parse };
else window.TLParser = { parse };
