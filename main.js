const { app, BrowserWindow, ipcMain, dialog, shell, session, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');

let win;
const UA = 'TimelineViewer/1.0 (personal desktop app)';
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; } };
const writeCfg = c => { try { fs.writeFileSync(cfgPath(), JSON.stringify(c)); } catch {} };

async function loadFile(p) {
  try {
    const txt = await fs.promises.readFile(p, 'utf8');
    const items = parse(JSON.parse(txt));
    writeCfg({ ...readCfg(), lastFile: p });
    return { path: p, items };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#1b1d21', title: 'Timeline Viewer',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

ipcMain.handle('open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return loadFile(r.filePaths[0]);
});
ipcMain.handle('load', (e, p) => loadFile(p));
ipcMain.handle('last', () => {
  const p = readCfg().lastFile;
  return p && fs.existsSync(p) ? loadFile(p) : null;
});

// ---- corrected places database, CSV export, clipboard ----
const plPath = () => path.join(app.getPath('userData'), 'places.json');
ipcMain.handle('places-get', () => { try { return JSON.parse(fs.readFileSync(plPath(), 'utf8')); } catch { return []; } });
ipcMain.handle('places-set', (e, arr) => { try { fs.writeFileSync(plPath(), JSON.stringify(arr, null, 1)); return true; } catch { return false; } });
ipcMain.handle('save-csv', async (e, name, text) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, '\ufeff' + text, 'utf8');
  return r.filePath;
});
ipcMain.handle('copy', (e, t) => { clipboard.writeText(String(t)); return true; });

// ---- Nominatim (OpenStreetMap): 1 request/sec, shared queue ----
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
const HDR = { headers: { 'User-Agent': UA, 'Accept-Language': 'en-AU,en' } };

// reverse geocode (cached on disk)
const gcPath = () => path.join(app.getPath('userData'), 'geocache.json');
let gc = null;
const gcLoad = () => { if (!gc) { try { gc = JSON.parse(fs.readFileSync(gcPath(), 'utf8')); } catch { gc = {}; } } return gc; };

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

// ---- NSW Spatial Services address points (official, house numbers) ----
const NSW = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/MapServer/1/query';
function hav(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function tidy(s) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  if (s && s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s\-'\/])([a-z])/g, (m0, p, c) => p + c.toUpperCase()).replace(/\bNsw\b/, 'NSW');
  }
  return s;
}
async function nswPoints(lat, lng, dist) {
  const q = new URLSearchParams({
    f: 'json', where: '1=1', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', distance: String(dist), units: 'esriSRUnit_Meter',
    outFields: '*', returnGeometry: 'true', outSR: '4326', resultRecordCount: '30'
  });
  const r = await fetch(NSW + '?' + q, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !Array.isArray(j.features)) return null;
  return j.features.map(f => {
    const g = f.geometry || {};
    return { at: f.attributes || {}, d: g.x != null && g.y != null ? hav(lat, lng, g.y, g.x) : 999 };
  }).sort((p, q2) => p.d - q2.d);
}
async function nomReverse(lat, lng) {
  return queued(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`, HDR);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  });
}
// Turn one address point into text. If the point's own address text has no street name, borrow street/suburb from OSM.
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

ipcMain.handle('nearby', async (e, lat, lng) => {
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
});

ipcMain.handle('geocode', async (e, lat, lng) => {
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  const k2 = 'n2:' + key;
  if (gcLoad()[k2]) return gcLoad()[k2];
  const save = (k, v) => { gcLoad()[k] = v; try { fs.writeFileSync(gcPath(), JSON.stringify(gc)); } catch {} };
  try {
    const pts = await nswPoints(lat, lng, 60);
    if (pts && pts.length && pts[0].d <= 40) {
      const t = await fmtNsw(pts[0], lat, lng, {});
      if (t) { const s = stripUnit(t); save(k2, s); return s; }
    }
  } catch {}
  // fallback: OpenStreetMap
  if (gcLoad()[key]) return gcLoad()[key];
  const a = fmtAddr(await nomReverse(lat, lng));
  if (a) save(key, a);
  return a;
});

// forward search: place name -> bounding box(es)
ipcMain.handle('search', (e, q) => queued(async () => {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, HDR);
    if (!r.ok) return { error: 'Search failed (HTTP ' + r.status + ')' };
    const j = await r.json();
    return { results: j.filter(x => x.boundingbox).map(x => ({ name: x.display_name, bbox: x.boundingbox.map(Number), lat: +x.lat, lon: +x.lon })) };
  } catch (err) {
    return { error: 'Search failed: ' + String(err.message || err) };
  }
}));

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://*.openstreetmap.org/*'] }, (d, cb) => {
    d.requestHeaders['User-Agent'] = UA;
    d.requestHeaders['Referer'] = 'https://timeline-viewer.local/';
    cb({ requestHeaders: d.requestHeaders });
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
