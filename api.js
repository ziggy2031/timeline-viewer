// Browser replacement for the Electron preload/main process. Everything stays on this device.
(function () {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  };

  // ---------- IndexedDB: keep the last parsed timeline so reopening is instant ----------
  const idb = () => new Promise((res, rej) => {
    const q = indexedDB.open('timeline-viewer', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  async function kvGet(k) { try { const db = await idb(); return await new Promise(r => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => r(t.result); t.onerror = () => r(undefined); }); } catch { return undefined; } }
  async function kvSet(k, v) { try { const db = await idb(); return await new Promise(r => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => r(true); t.onerror = () => r(false); t.onabort = () => r(false); }); } catch { return false; } }
  async function kvDel(k) { try { const db = await idb(); return await new Promise(r => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => r(true); t.onerror = () => r(false); }); } catch { return false; } }

  function pickFile(accept) {
    return new Promise(resolve => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = accept;
      i.onchange = () => resolve(i.files[0] || null);
      i.addEventListener('cancel', () => resolve(null));
      i.click();
    });
  }

  async function loadFile(file) {
    try {
      const items = window.TLParser.parse(JSON.parse(await file.text()));
      await kvSet('last', { name: file.name, items });
      return { path: file.name, items };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- Nominatim queue (1 request/sec) ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let chain = Promise.resolve(), lastReq = 0;
  function queued(fn) {
    const p = chain.then(async () => {
      const wait = Math.max(0, 1100 - (Date.now() - lastReq));
      if (wait) await sleep(wait);
      lastReq = Date.now();
      return fn();
    });
    chain = p.then(() => {}, () => {});
    return p;
  }
  const NOM_HDR = { headers: { 'Accept-Language': 'en-AU,en' } };

  // geocode cache (localStorage, trimmed if it ever gets huge)
  let gc = LS.get('geocache', {});
  function gcSave() {
    if (!LS.set('geocache', gc)) { gc = {}; LS.set('geocache', gc); }
  }

  function fmtAddr(j) {
    if (!j || j.error) return null;
    const a = j.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const sub = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || a.village;
    let s = [street, sub].filter(Boolean).join(', ');
    if (s && a.postcode) s += ' ' + a.postcode;
    if (j.name && j.name !== a.road && s) s = j.name + ' — ' + s;
    return s || j.display_name || null;
  }
  async function nomReverse(lat, lng) {
    return queued(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`, NOM_HDR);
        return r.ok ? await r.json() : null;
      } catch { return null; }
    });
  }

  // ---------- NSW Spatial Services address points ----------
  const NSW = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/MapServer/1/query';
  function hav(la1, lo1, la2, lo2) {
    const R = 6371000, r = Math.PI / 180;
    const x = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function tidy(s) {
    s = String(s || '').trim().replace(/\s+/g, ' ');
    if (s && s === s.toUpperCase()) s = s.toLowerCase().replace(/(^|[\s\-'\/])([a-z])/g, (m0, p, c) => p + c.toUpperCase()).replace(/\bNsw\b/, 'NSW');
    return s;
  }
  async function nswPoints(lat, lng, dist) {
    const q = new URLSearchParams({
      f: 'json', where: '1=1', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', distance: String(dist), units: 'esriSRUnit_Meter',
      outFields: '*', returnGeometry: 'true', outSR: '4326', resultRecordCount: '30'
    });
    const r = await fetch(NSW + '?' + q);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.features)) return null;
    return j.features.map(f => {
      const g = f.geometry || {};
      return { at: f.attributes || {}, d: g.x != null && g.y != null ? hav(lat, lng, g.y, g.x) : 999 };
    }).sort((p, q2) => p.d - q2.d);
  }
  async function fmtNsw(pt, lat, lng, ctx) {
    const raw = String(pt.at.address || '').trim();
    if (/[A-Za-z]{3,}/.test(raw) && /\d/.test(raw)) return tidy(raw);
    const num = String(pt.at.housenumber || '').trim();
    if (!num) return null;
    if (!ctx.nom) ctx.nom = (await nomReverse(lat, lng)) || {};
    const a = ctx.nom.address || {};
    const sub = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || a.village;
    if (!a.road) return null;
    return `${num} ${a.road}` + (sub ? `, ${sub}` : '') + (a.postcode ? ' ' + a.postcode : '');
  }
  const stripUnit = s => s.replace(/^(?:(?:unit|apt|shop|suite|lot)\s+)?[A-Za-z0-9]+\/(?=\d)/i, '');

  async function nearby(lat, lng) {
    try {
      const pts = await nswPoints(lat, lng, 80);
      if (!pts) return [];
      const ctx = {}, out = [], seen = new Set();
      for (const p of pts) {
        const t = await fmtNsw(p, lat, lng, ctx);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push({ text: t, d: Math.round(p.d) });
        if (out.length >= 8) break;
      }
      return out;
    } catch { return []; }
  }

  async function geocode(lat, lng) {
    const key = lat.toFixed(4) + ',' + lng.toFixed(4), k2 = 'n2:' + key;
    if (gc[k2]) return gc[k2];
    try {
      const pts = await nswPoints(lat, lng, 60);
      if (pts && pts.length && pts[0].d <= 40) {
        const t = await fmtNsw(pts[0], lat, lng, {});
        if (t) { const s = stripUnit(t); gc[k2] = s; gcSave(); return s; }
      }
    } catch {}
    if (gc[key]) return gc[key];
    const a = fmtAddr(await nomReverse(lat, lng));
    if (a) { gc[key] = a; gcSave(); }
    return a;
  }

  async function search(q) {
    return queued(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, NOM_HDR);
        if (!r.ok) return { error: 'Search failed (HTTP ' + r.status + ')' };
        const j = await r.json();
        return { results: j.filter(x => x.boundingbox).map(x => ({ name: x.display_name, bbox: x.boundingbox.map(Number), lat: +x.lat, lon: +x.lon })) };
      } catch (err) {
        return { error: 'Search failed: ' + String(err.message || err) };
      }
    });
  }

  window.api = {
    open: async () => { const f = await pickFile('.json,application/json'); return f ? loadFile(f) : null; },
    load: f => loadFile(f),
    last: async () => { const v = await kvGet('last'); return v && v.items ? { path: v.name + ' (saved in this browser)', items: v.items } : null; },
    forget: () => kvDel('last'),
    geocode, nearby, search,
    places: async () => LS.get('places', []),
    savePlaces: async a => LS.set('places', a),
    exportPlaces: arr => download('timeline-places.json', JSON.stringify(arr, null, 1), 'application/json'),
    importPlaces: async current => {
      const f = await pickFile('.json,application/json');
      if (!f) return null;
      try {
        const inc = JSON.parse(await f.text());
        if (!Array.isArray(inc)) throw new Error('That file is not a places list.');
        const out = current.slice();
        let added = 0;
        for (const p of inc) {
          if (!p || typeof p.name !== 'string' || !isFinite(p.lat) || !isFinite(p.lng)) continue;
          const dup = out.some(o => (p.pid && o.pid === p.pid) || (o.id && o.id === p.id) || (hav(o.lat, o.lng, p.lat, p.lng) < 3 && o.name === p.name));
          if (dup) continue;
          out.push({ id: p.id || Date.now().toString(36) + added, name: p.name, lat: +p.lat, lng: +p.lng, r: +p.r || 60, pid: p.pid || undefined });
          added++;
        }
        LS.set('places', out);
        return { places: out, added };
      } catch (e) { return { error: String(e.message || e) }; }
    },
    saveCsv: async (name, text) => { download(name, '﻿' + text, 'text/csv;charset=utf-8'); return name; },
    copy: async t => { try { await navigator.clipboard.writeText(String(t)); } catch { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); } return true; }
  };
})();
