const COL = { in_passenger_vehicle: '#0b4fb3', motorcycling: '#0b4fb3', walking: '#0f7a35', running: '#0f7a35', cycling: '#a85d00', in_bus: '#c2410c', in_train: '#6b21a8', in_subway: '#6b21a8', in_tram: '#6b21a8', flying: '#be123c' };
const ICO = { in_passenger_vehicle: '🚗', motorcycling: '🏍️', walking: '🚶', running: '🏃', cycling: '🚴', in_bus: '🚌', in_train: '🚆', in_subway: '🚇', in_tram: '🚊', flying: '✈️' };
const DEF = '#374151';
const DRIVING = ['in_passenger_vehicle', 'motorcycling'];

let days = new Map(), keys = [], cur = null, mode = 'day', rangeSel = null, lastSearch = null;
let places = [], minStop = 0, weekStart = null, weekData = [], viewToken = 0;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const map = L.map('map', { preferCanvas: true }).setView([-33.87, 151.2], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
const layer = L.layerGroup().addTo(map);

const fmtDur = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
const hhmm = s => s.slice(11, 16);
const nice = t => String(t).replace(/^in_/, '').replace(/_/g, ' ');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDay = k => { const d = new Date(k + 'T12:00:00'); return `${WD[d.getDay()]} ${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(2, 4)}`; };
const fmtShort = fmtDay;
const dayMs = k => Date.parse(k + 'T00:00:00Z');
const dayDiff = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 864e5);
const addDays = (k, n) => new Date(dayMs(k) + n * 864e5).toISOString().slice(0, 10);
const weekStartOf = k => addDays(k, -((new Date(dayMs(k)).getUTCDay() + 6) % 7)); // Monday
const dayColor = (i, n) => `hsl(${Math.round(240 - 240 * (n > 1 ? i / (n - 1) : 0))},90%,36%)`;
const pushAll = (a, b) => { for (const x of b) a.push(x); };
const lastKey = () => keys[keys.length - 1];
const coordTxt = o => `${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}`;

function hav(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------- Saved (corrected) places ----------------
function savedFor(lat, lng, pid) {
  if (pid) { const m = places.find(p => p.pid === pid); if (m) return m; }
  let best = null, bd = Infinity;
  for (const p of places) {
    const d = hav(lat, lng, p.lat, p.lng);
    if (d <= p.r && d < bd) { best = p; bd = d; }
  }
  return best;
}

function clearNames() {
  for (const arr of days.values()) for (const it of arr) if (it.kind === 'visit') { it.addr = undefined; it.saved = false; it.p = undefined; }
}

function resolveName(v) {
  if (!v.p) {
    v.p = (async () => {
      const sp = savedFor(v.lat, v.lng, v.placeId);
      if (sp) { v.saved = true; v.addr = sp.name; return v.addr; }
      v.saved = false;
      const a = await window.api.geocode(v.lat, v.lng);
      v.addr = a || coordTxt(v);
      return v.addr;
    })();
  }
  return v.p;
}

function paint(r) {
  const t = (r.saved ? '📌 ' : '') + (r.addr || '');
  if (r.addrEl) r.addrEl.textContent = t;
  if (r.marker) r.marker.setTooltipContent(`${esc(t)}<br>${hhmm(r.start)}–${hhmm(r.end)}`);
}

async function resolveRows(rs, tok, onProg) {
  let i = 0;
  for (const r of rs) {
    if (tok !== viewToken) return false;
    await resolveName(r);
    if (tok !== viewToken) return false;
    paint(r);
    if (onProg) onProg(++i, rs.length);
  }
  return true;
}

// inline editor (prompt() doesn't exist in Electron)
function startEdit(r, host, done) {
  const sp = savedFor(r.lat, r.lng, r.placeId);
  const shown = sp ? sp.name : (r.addr && !/^-?\d/.test(r.addr) ? r.addr : '');
  const rad = sp ? sp.r : 60;
  host.innerHTML = `<input class="ed" placeholder="Correct address or name, e.g. 22 Petersham Road, Petersham" value="${esc(shown)}">
    <div class="eb"><select class="er">${[30, 60, 120, 250].map(x => `<option value="${x}"${x === rad ? ' selected' : ''}>applies within ${x} m</option>`).join('')}</select>
    <button class="sv">Save</button><button class="cn">Cancel</button>${sp ? '<button class="rm">Remove</button>' : ''}</div>`;
  host.onclick = e => e.stopPropagation();
  const inp = host.querySelector('.ed');
  const nb = document.createElement('select');
  nb.className = 'ed';
  nb.innerHTML = '<option>Looking up nearby addresses…</option>';
  inp.after(nb);
  window.api.nearby(r.lat, r.lng).then(list => {
    if (!list || !list.length) { nb.remove(); return; }
    nb.innerHTML = '<option value="">Pick a nearby address…</option>' + list.map(x => `<option value="${esc(x.text)}">${esc(x.text)} (${x.d} m)</option>`).join('');
    nb.onchange = () => { if (nb.value) { inp.value = nb.value; inp.focus(); } };
  });
  inp.focus(); inp.select();
  const save = async () => {
    const name = inp.value.trim();
    if (!name) return;
    const radius = +host.querySelector('.er').value;
    if (sp) { sp.name = name; sp.r = radius; if (r.placeId && !sp.pid) sp.pid = r.placeId; }
    else places.push({ id: Date.now().toString(36), name, lat: r.lat, lng: r.lng, r: radius, pid: r.placeId || undefined });
    await window.api.savePlaces(places);
    clearNames();
    done();
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') done(); });
  host.querySelector('.sv').onclick = save;
  host.querySelector('.cn').onclick = () => done();
  const rm = host.querySelector('.rm');
  if (rm) rm.onclick = async () => { places = places.filter(p => p !== sp); await window.api.savePlaces(places); clearNames(); done(); };
}

// ---------------- Mode / data ----------------
function setMode(m) {
  mode = m;
  $('tabDay').classList.toggle('on', m === 'day');
  $('tabWeek').classList.toggle('on', m === 'week');
  $('tabRange').classList.toggle('on', m === 'range');
  $('dayNav').hidden = m !== 'day';
  $('weekNav').hidden = m !== 'week';
  $('rangeNav').hidden = m !== 'range';
  $('dayLbl').hidden = m !== 'day';
}

function setData(res) {
  if (!res) return;
  if (res.error) { alert(res.error); return; }
  days = new Map();
  for (const it of res.items) {
    const k = it.start.slice(0, 10);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(it);
  }
  keys = [...days.keys()].sort();
  lastSearch = null; rangeSel = null;
  $('file').textContent = res.path;
  $('empty').classList.add('hide');
  if (keys.length) show(lastKey());
}

function refresh() {
  if (mode === 'day' && cur) show(cur, { keep: true });
  else if (mode === 'range' && rangeSel) showRange(rangeSel.from, rangeSel.to, { keep: true });
  else if (mode === 'week' && weekStart) renderWeek(weekStart, { keep: true });
}

function addBack(list) {
  if (!(lastSearch && lastSearch.groups)) return;
  const b = document.createElement('div');
  b.className = 'back';
  b.textContent = '← Search results';
  b.onclick = renderSearchResults;
  list.appendChild(b);
}

// ---------------- Stops / legs ----------------
function dayStats(arr) {
  let dist = 0, drive = 0;
  for (const x of arr) if (x.kind === 'move') { dist += x.dist; if (DRIVING.includes(x.type)) drive += x.dist; }
  return { dist, drive };
}

function sameSpot(a, b) {
  const sa = savedFor(a.lat, a.lng, a.placeId), sb = savedFor(b.lat, b.lng, b.placeId);
  return (sa && sb && sa === sb) || hav(a.lat, a.lng, b.lat, b.lng) <= 100;
}

// Stops (short ones hidden, neighbours at the same spot merged) with a travel "leg" between each pair.
function buildStops(arr, minMin) {
  const need = minMin * 60000;
  const vs = arr.filter(x => x.kind === 'visit' && x.t1 - x.t0 >= need);
  const moves = arr.filter(x => x.kind === 'move');
  const groups = [];
  for (const v of vs) {
    const g = groups[groups.length - 1];
    if (g && v.t0 - g[g.length - 1].t1 <= 30 * 60000 && sameSpot(g[g.length - 1], v)) g.push(v);
    else groups.push([v]);
  }
  const stops = groups.map(g => {
    if (g.length === 1) return g[0];
    const rep = g.reduce((a, b) => (b.t1 - b.t0 > a.t1 - a.t0 ? b : a));
    const f = g[0], l = g[g.length - 1];
    return { kind: 'visit', start: f.start, end: l.end, t0: f.t0, t1: l.t1, lat: rep.lat, lng: rep.lng, placeId: rep.placeId || null, label: rep.label, count: g.length, members: g };
  });
  const rows = [];
  stops.forEach((s, i) => {
    rows.push(s);
    const nx = stops[i + 1];
    if (!nx) return;
    const ms = moves.filter(m => m.t0 >= s.t1 - 60000 && m.t1 <= nx.t0 + 60000);
    if (!ms.length) return;
    const byT = {};
    let dist = 0;
    for (const m of ms) { dist += m.dist; byT[m.type] = (byT[m.type] || 0) + (m.dist || 1); }
    const type = Object.keys(byT).sort((a, b) => byT[b] - byT[a])[0];
    rows.push({ kind: 'leg', type, dist, start: s.end, end: nx.start, t0: s.t1, t1: nx.t0, ends: [[s.lat, s.lng], [nx.lat, nx.lng]] });
  });
  return rows;
}

// ---------------- Drawing ----------------
function drawPaths(arr, colorFor, step) {
  const moves = arr.filter(x => x.kind === 'move');
  const paths = arr.filter(x => x.kind === 'path');
  const pts = [];
  moves.forEach(m => { m.pts = []; });
  for (const p of paths) {
    const mid = (p.t0 + p.t1) / 2;
    const m = moves.find(m => m.t0 <= mid && mid <= m.t1);
    if (m) pushAll(m.pts, p.pts);
    let line = p.pts;
    if (step > 1) line = line.filter((_, i) => i % step === 0 || i === line.length - 1);
    L.polyline(line, { color: colorFor(m), weight: step > 1 ? 4 : 5, opacity: .9 }).addTo(layer);
    pushAll(pts, p.pts);
  }
  for (const m of moves) {
    if (!m.pts.length && m.from && m.to) {
      L.polyline([m.from, m.to], { color: colorFor(m), weight: 4, dashArray: '6 8', opacity: .9 }).addTo(layer);
      pts.push(m.from, m.to);
    }
  }
  return pts;
}

function addVisitDot(v, k, col) {
  const cm = L.circleMarker([v.lat, v.lng], { radius: 5, color: '#fff', weight: 1, fillColor: col, fillOpacity: 1 }).addTo(layer);
  const base = `<b>${fmtDay(k)}</b><br>${hhmm(v.start)}–${hhmm(v.end)} · ${fmtDur(v.t1 - v.t0)}`;
  cm.bindTooltip(`${fmtDay(k)} ${hhmm(v.start)}`);
  cm.on('click', async () => {
    cm.unbindPopup().bindPopup(base + '<br>Looking up address…').openPopup();
    const a = await resolveName(v);
    cm.setPopupContent(base + '<br>' + (v.saved ? '📌 ' : '') + esc(a));
  });
}

// routes (+ visit dots) for several days, coloured by day or by transport
function drawDays(entries, byDay) {
  let total = 0;
  for (const e of entries) for (const it of days.get(e.k)) if (it.kind === 'path') total += it.pts.length;
  const stepN = Math.max(1, Math.ceil(total / 120000));
  const all = [];
  for (const e of entries) {
    const arr = days.get(e.k).slice().sort((a, b) => a.t0 - b.t0);
    pushAll(all, drawPaths(arr, m => (byDay ? e.col : (m ? (COL[m.type] || DEF) : DEF)), stepN));
    for (const x of arr) {
      if (x.kind === 'visit' && x.t1 - x.t0 >= minStop * 60000) {
        addVisitDot(x, e.k, byDay ? e.col : '#0b4fb3');
        all.push([x.lat, x.lng]);
      }
    }
  }
  return all;
}

// ---------------- Day view ----------------
function show(k, opts = {}) {
  setMode('day');
  const tok = ++viewToken;
  cur = k;
  $('date').value = k;
  $('dayLbl').textContent = fmtDay(k);
  layer.clearLayers();
  const arr = (days.get(k) || []).slice().sort((a, b) => a.t0 - b.t0);
  const all = drawPaths(arr, m => (m ? (COL[m.type] || DEF) : DEF), 1);
  const rows = minStop ? buildStops(arr, minStop) : arr.filter(x => x.kind !== 'path');

  let n = 0;
  for (const r of rows) {
    if (r.kind !== 'visit') continue;
    r.n = ++n;
    r.marker = L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', html: `<div class="num">${n}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
      .bindTooltip(`${r.label} ${hhmm(r.start)}–${hhmm(r.end)}`).addTo(layer);
    all.push([r.lat, r.lng]);
  }
  if (all.length && !opts.keep) map.fitBounds(L.latLngBounds(all).pad(.15));

  const st = dayStats(arr);
  const moving = arr.filter(x => x.kind === 'move').reduce((a, m) => a + (m.t1 - m.t0), 0);
  $('stats').textContent = rows.length
    ? `${n} stops · ${fmtDist(st.dist)} travelled${st.drive && st.drive !== st.dist ? ` (🚗 ${fmtDist(st.drive)})` : ''} · ${fmtDur(moving)} moving${minStop ? ` · stops under ${minStop} min hidden` : ''}`
    : '';
  const list = $('list');
  list.innerHTML = '';
  addBack(list);
  if (!rows.length) list.insertAdjacentHTML('beforeend', '<div class="none">No data for this day</div>');

  rows.forEach(r => {
    const el = document.createElement('div');
    el.className = 'item';
    if (r.kind === 'visit') {
      el.style.borderLeftColor = '#0b4fb3';
      el.innerHTML = `<div class="ico">📍</div><div style="flex:1;min-width:0"><div class="t">${r.n}. ${esc(r.label)}${r.count > 1 ? ` <span class="s">(${r.count} stops merged)</span>` : ''}</div><div class="addr">Looking up address…</div><div class="s">${hhmm(r.start)}–${hhmm(r.end)} · ${fmtDur(r.t1 - r.t0)} · <a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" style="color:#6db3ff">Google Maps</a> · <span class="pen">✏️ Correct</span></div></div>`;
      r.addrEl = el.querySelector('.addr');
      if (r.addr) paint(r);
      el.querySelector('.pen').onclick = e => { e.stopPropagation(); startEdit(r, r.addrEl, refresh); };
      el.onclick = () => map.setView([r.lat, r.lng], 17);
    } else {
      el.style.borderLeftColor = COL[r.type] || DEF;
      el.innerHTML = `<div class="ico">${ICO[r.type] || '➡️'}</div><div><div class="t" style="text-transform:capitalize">${nice(r.type)}</div><div class="s">${hhmm(r.start)}–${hhmm(r.end)} · ${fmtDur(r.t1 - r.t0)}${r.dist ? ' · ' + fmtDist(r.dist) : ''}</div></div>`;
      el.onclick = () => {
        const pts = r.pts && r.pts.length ? r.pts : (r.ends || [r.from, r.to]).filter(Boolean);
        if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.2));
      };
    }
    list.appendChild(el);
  });
  resolveRows(rows.filter(r => r.kind === 'visit'), tok);
}

function step(dir) {
  if (!keys.length) return;
  const k = dir < 0 ? [...keys].reverse().find(x => x < cur) : keys.find(x => x > cur);
  if (k) show(k);
}

// ---------------- Week diary ----------------
function renderWeek(start, opts = {}) {
  setMode('week');
  const tok = ++viewToken;
  weekStart = start;
  $('wdate').value = start;
  layer.clearLayers();
  const list = $('list');
  list.innerHTML = '';
  addBack(list);
  weekData = [];
  const entries = [], stopRows = [];
  let wd = 0, wdr = 0;

  for (let i = 0; i < 7; i++) {
    const k = addDays(start, i);
    const arr = (days.get(k) || []).slice().sort((a, b) => a.t0 - b.t0);
    const st = dayStats(arr);
    const rows = arr.length ? buildStops(arr, minStop) : [];
    weekData.push({ k, dist: st.dist, drive: st.drive, rows });
    wd += st.dist; wdr += st.drive;
    if (arr.length) entries.push({ k, col: dayColor(i, 7) });

    const head = document.createElement('div');
    head.className = 'dayhead';
    head.innerHTML = `<span>${fmtDay(k)}</span><span>${st.dist ? fmtDist(st.dist) : ''}${st.drive && st.drive !== st.dist ? ` · 🚗 ${fmtDist(st.drive)}` : ''}</span>`;
    head.onclick = () => show(k);
    list.appendChild(head);
    if (!rows.length) {
      list.insertAdjacentHTML('beforeend', `<div class="leg" style="padding-left:12px">${arr.length ? 'No stops' : 'No data'}</div>`);
      continue;
    }
    for (const r of rows) {
      const el = document.createElement('div');
      if (r.kind === 'visit') {
        el.className = 'stop';
        el.innerHTML = `<div class="tm">${hhmm(r.start)}–${hhmm(r.end)}</div><div class="nm"><span class="name">Looking up address…</span> <span class="s">${fmtDur(r.t1 - r.t0)}</span> <span class="pen" title="Correct this place">✏️</span></div>`;
        const nm = el.querySelector('.nm');
        r.marker = null;
        r.addrEl = el.querySelector('.name');
        if (r.addr) paint(r);
        el.querySelector('.pen').onclick = () => startEdit(r, nm, refresh);
        stopRows.push(r);
      } else {
        el.className = 'leg';
        el.textContent = `↳ ${ICO[r.type] || '➡️'} ${nice(r.type)}${r.dist ? ' · ' + fmtDist(r.dist) : ''} · ${fmtDur(r.t1 - r.t0)}`;
      }
      list.appendChild(el);
    }
  }

  const all = drawDays(entries, true);
  if (all.length && !opts.keep) map.fitBounds(L.latLngBounds(all).pad(.1));
  const base = `${fmtShort(start)} – ${fmtShort(addDays(start, 6))} · ${fmtDist(wd)} total${wdr && wdr !== wd ? ` (🚗 ${fmtDist(wdr)})` : ''} · ${stopRows.length} stops`;
  $('stats').textContent = base;
  resolveRows(stopRows, tok, (i, n) => { $('stats').textContent = base + (i < n ? ` · addresses ${i}/${n}…` : ''); });
}

async function resolveWeek() {
  for (const d of weekData) for (const r of d.rows) if (r.kind === 'visit') { await resolveName(r); paint(r); }
}

function weekText() {
  let s = `Week ${fmtShort(weekStart)} – ${fmtShort(addDays(weekStart, 6))}\n\n`;
  for (const d of weekData) {
    s += fmtDay(d.k) + (d.dist ? ` — ${fmtDist(d.dist)}${d.drive && d.drive !== d.dist ? ` (driving ${fmtDist(d.drive)})` : ''}` : '') + '\n';
    const stops = d.rows.filter(r => r.kind === 'visit');
    if (!stops.length) s += '  (no data)\n';
    for (const r of stops) s += `  ${hhmm(r.start)}–${hhmm(r.end)}  ${r.addr || coordTxt(r)} (${fmtDur(r.t1 - r.t0)})\n`;
    s += '\n';
  }
  return s.trimEnd() + '\n';
}

const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function weekCsv() {
  const out = [['Date', 'Day', 'Type', 'Start', 'End', 'Minutes', 'Place', 'Mode', 'Km', 'Latitude', 'Longitude', 'Saved place']];
  for (const d of weekData) {
    const wd = new Date(d.k + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long' });
    for (const r of d.rows) {
      const mins = Math.round((r.t1 - r.t0) / 60000);
      if (r.kind === 'visit') out.push([d.k, wd, 'Stop', hhmm(r.start), hhmm(r.end), mins, r.addr || coordTxt(r), '', '', r.lat.toFixed(6), r.lng.toFixed(6), r.saved ? 'yes' : '']);
      else out.push([d.k, wd, 'Travel', hhmm(r.start), hhmm(r.end), mins, '', nice(r.type), (r.dist / 1000).toFixed(2), '', '', '']);
    }
    out.push([d.k, wd, 'Day total', '', '', '', '', '', (d.dist / 1000).toFixed(1), '', '', '']);
  }
  return out.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function withButton(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Working…';
  try { await resolveWeek(); await fn(); btn.textContent = label; }
  catch (e) { btn.textContent = old; alert(String(e.message || e)); }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = old; }, 1800);
}

// ---------------- Date range ----------------
function showRange(from, to, opts = {}) {
  if (from > to) [from, to] = [to, from];
  setMode('range');
  ++viewToken;
  rangeSel = { from, to };
  $('from').value = from;
  $('to').value = to;
  layer.clearLayers();
  const list = $('list');
  list.innerHTML = '';
  addBack(list);
  const ks = keys.filter(k => k >= from && k <= to);
  if (!ks.length) {
    $('stats').textContent = '';
    list.insertAdjacentHTML('beforeend', '<div class="none">No data in this range</div>');
    return;
  }
  const byDay = $('colorBy').value === 'day';
  const entries = ks.map((k, i) => ({ k, col: dayColor(i, ks.length) }));
  const all = drawDays(entries, byDay);
  let dist = 0, nv = 0;
  for (const e of entries) {
    const arr = days.get(e.k);
    const st = dayStats(arr);
    const dv = arr.filter(x => x.kind === 'visit' && x.t1 - x.t0 >= minStop * 60000).length;
    dist += st.dist; nv += dv;
    const el = document.createElement('div');
    el.className = 'item';
    el.style.borderLeftColor = byDay ? e.col : 'transparent';
    el.innerHTML = `<div class="ico">📅</div><div><div class="t">${fmtDay(e.k)}</div><div class="s">${dv} stops · ${fmtDist(st.dist)}</div></div>`;
    el.onclick = () => show(e.k);
    list.appendChild(el);
  }
  $('stats').textContent = `${ks.length} days with data · ${nv} stops · ${fmtDist(dist)} travelled`;
  if (all.length && !opts.keep) map.fitBounds(L.latLngBounds(all).pad(.1));
}

// ---------------- Search ----------------
function padBox(bb) {
  let [s, n, w, e] = bb;
  const pad = 0.0015;
  s -= pad; n += pad; w -= pad; e += pad;
  if (n - s < 0.004) { const c = (n + s) / 2; s = c - 0.002; n = c + 0.002; }
  if (e - w < 0.004) { const c = (e + w) / 2; w = c - 0.002; e = c + 0.002; }
  return [s, n, w, e];
}

function findMatches(box) {
  const [s, n, w, e] = box;
  const inb = (la, lo) => la >= s && la <= n && lo >= w && lo <= e;
  const hit = [], dots = [];
  for (const k of keys) {
    let ok = false, v = 0;
    for (const it of days.get(k)) {
      if (it.kind === 'visit') {
        if (inb(it.lat, it.lng)) { ok = true; v++; if (dots.length < 3000) dots.push([it.lat, it.lng]); }
      } else if (it.kind === 'move') {
        if ((it.from && inb(it.from[0], it.from[1])) || (it.to && inb(it.to[0], it.to[1]))) ok = true;
      } else if (it.kind === 'path' && !ok) {
        for (const p of it.pts) if (inb(p[0], p[1])) { ok = true; break; }
      }
    }
    if (ok) hit.push({ k, v });
  }
  const groups = [];
  for (const h of hit) {
    const g = groups[groups.length - 1];
    if (g && dayDiff(g.to, h.k) <= 2) { g.to = h.k; g.days++; g.visits += h.v; }
    else groups.push({ from: h.k, to: h.k, days: 1, visits: h.v });
  }
  groups.reverse();
  return { groups, dots };
}

async function doSearch() {
  const q = $('q').value.trim();
  if (!q) return;
  if (!keys.length) { alert('Open a timeline file first.'); return; }
  setMode('search');
  ++viewToken;
  layer.clearLayers();
  lastSearch = null;
  $('stats').textContent = '';
  $('list').innerHTML = '<div class="none">Searching…</div>';

  const ql = q.toLowerCase();
  const local = places.filter(p => p.name.toLowerCase().includes(ql)).map(p => {
    const dLat = p.r / 111320, dLon = p.r / (111320 * Math.cos(p.lat * Math.PI / 180));
    return { name: p.name + ' (saved place)', bbox: [p.lat - dLat, p.lat + dLat, p.lng - dLon, p.lng + dLon] };
  });
  const r = await window.api.search(q);
  const cands = local.concat(r.results || []);
  if (!cands.length) { $('list').innerHTML = `<div class="none">${esc(r.error || 'No places found')}</div>`; return; }
  lastSearch = { q, cands, groups: null };
  if (cands.length === 1) pickPlace(0); else renderCands();
}

function renderCands() {
  setMode('search');
  layer.clearLayers();
  $('stats').textContent = `Which "${lastSearch.q}"?`;
  const list = $('list');
  list.innerHTML = '';
  lastSearch.cands.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="ico">🔎</div><div><div class="t">${esc(c.name.split(',').slice(0, 2).join(','))}</div><div class="s">${esc(c.name)}</div></div>`;
    el.onclick = () => pickPlace(i);
    list.appendChild(el);
  });
}

function pickPlace(i) {
  const c = lastSearch.cands[i];
  const box = padBox(c.bbox);
  const res = findMatches(box);
  Object.assign(lastSearch, { picked: i, box, groups: res.groups, dots: res.dots });
  renderSearchResults();
}

function renderSearchResults() {
  if (!lastSearch || !lastSearch.groups) return;
  setMode('search');
  ++viewToken;
  layer.clearLayers();
  const { cands, picked, groups, box, dots } = lastSearch;
  const [s, n, w, e] = box;
  L.rectangle([[s, w], [n, e]], { color: '#b45309', weight: 3, fill: false, dashArray: '4 4' }).addTo(layer);
  for (const d of dots) L.circleMarker(d, { radius: 4, color: '#fff', weight: 1, fillColor: '#ea580c', fillOpacity: 1 }).addTo(layer);
  map.fitBounds([[s, w], [n, e]]);

  const name = cands[picked].name.split(',').slice(0, 2).join(',');
  const totalDays = groups.reduce((a, g) => a + g.days, 0);
  $('stats').textContent = groups.length ? `${name}: ${groups.length} trip${groups.length > 1 ? 's' : ''} · ${totalDays} days` : '';
  const list = $('list');
  list.innerHTML = '';
  if (cands.length > 1) {
    const b = document.createElement('div');
    b.className = 'back';
    b.textContent = '← Other matches';
    b.onclick = renderCands;
    list.appendChild(b);
  }
  if (!groups.length) list.insertAdjacentHTML('beforeend', `<div class="none">Nothing in your timeline within ${esc(name)}</div>`);
  groups.forEach(g => {
    const el = document.createElement('div');
    el.className = 'item';
    const single = g.from === g.to;
    el.innerHTML = `<div class="ico">🗓️</div><div><div class="t">${single ? fmtShort(g.from) : fmtShort(g.from) + ' – ' + fmtShort(g.to)}</div><div class="s">${g.days} day${g.days > 1 ? 's' : ''} · ${g.visits} visit${g.visits === 1 ? '' : 's'} here</div></div>`;
    el.onclick = () => (single ? show(g.from) : showRange(g.from, g.to));
    list.appendChild(el);
  });
}

// ---------------- Wiring ----------------
$('open').onclick = async () => setData(await window.api.open());
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('date').onchange = e => { if (e.target.value) show(e.target.value); };
$('tabDay').onclick = () => { if (keys.length) show(cur || lastKey()); };
$('tabWeek').onclick = () => { if (keys.length) renderWeek(weekStart || weekStartOf(cur || lastKey())); };
$('tabRange').onclick = () => {
  if (!keys.length) return;
  if (!rangeSel) { const to = cur || lastKey(); rangeSel = { from: addDays(to, -13), to }; }
  showRange(rangeSel.from, rangeSel.to);
};
$('wprev').onclick = () => renderWeek(addDays(weekStart, -7));
$('wnext').onclick = () => renderWeek(addDays(weekStart, 7));
$('wdate').onchange = e => { if (e.target.value) renderWeek(weekStartOf(e.target.value)); };
$('wcopy').onclick = e => withButton(e.currentTarget, 'Copied ✓', async () => { await window.api.copy(weekText()); });
$('wcsv').onclick = e => withButton(e.currentTarget, 'Saved ✓', async () => { await window.api.saveCsv(`timeline-week-${weekStart}.csv`, weekCsv()); });
$('showRange').onclick = () => { if ($('from').value && $('to').value) showRange($('from').value, $('to').value); };
$('colorBy').onchange = () => { if (mode === 'range' && rangeSel) showRange(rangeSel.from, rangeSel.to); };
$('minStop').onchange = e => {
  minStop = +e.target.value;
  try { localStorage.setItem('minStop', String(minStop)); } catch {}
  refresh();
};
$('go').onclick = doSearch;
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
window.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || mode !== 'day') return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) { $('file').textContent = 'Loading…'; setData(await window.api.load(window.api.pathFor(f))); }
});

(async () => {
  try { minStop = +(localStorage.getItem('minStop') || 0); } catch {}
  $('minStop').value = String(minStop);
  places = (await window.api.places()) || [];
  $('file').textContent = 'Loading…';
  const r = await window.api.last();
  $('file').textContent = '';
  if (r) setData(r);
})();
