'use strict';
/* =========================================================
   MD-Fitness · Aktivitäten mit GPS  ·  © 2026 Maik Daßler
   Zusammenfassungen liegen in S.activities (localStorage),
   die GPS-Strecken in IndexedDB (Store „tracks“).
   Punktformat: [lat, lon, höhe|null, zeit ms, abschnitt]
   ========================================================= */

const SPORTS = {
  run: { n: 'Laufen / Joggen', ic: '🏃', foot: true, kf: 1.0, vmax: 8, c: 'var(--s2)' },
  walk: { n: 'Gehen', ic: '🚶', foot: true, kf: 0.55, vmax: 6, c: 'var(--s3)' },
  hike: { n: 'Wandern', ic: '🥾', foot: true, kf: 0.75, vmax: 6, c: 'var(--s4)' },
  bike: { n: 'Radfahren', ic: '🚴', foot: false, vmax: 25, c: 'var(--s1)' },
  mtb: { n: 'Mountainbike', ic: '🚵', foot: false, vmax: 20, c: 'var(--s6)' },
  other: { n: 'Sonstiges', ic: '⏱️', foot: false, vmax: 45, c: 'var(--s5)' }
};
const SP = k => SPORTS[k] || SPORTS.other;

/* ---------- Formatierung ---------- */
const fDur = sec => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; };
const fPace = secKm => !secKm || !isFinite(secKm) || secKm > 3600 ? '–' : `${Math.floor(secKm / 60)}:${pad(Math.round(secKm % 60) === 60 ? 59 : Math.round(secKm % 60))}`;
const fKm = m => f1((m || 0) / 1000, 2);
const kmh = (m, sec) => sec ? m / sec * 3.6 : null;
const tempoTxt = (a) => SP(a.sport).foot ? `${fPace(a.dur / (a.dist / 1000))} /km` : `${f1(kmh(a.dist, a.dur))} km/h`;
function parseDur(t) { // „1:05:30“, „45:10“, „50“ (Minuten)
  const p = String(t || '').trim().split(':').map(x => parseFloat(x.replace(',', '.')));
  if (p.some(x => !isFinite(x))) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] * 60;
}

/* ---------- IndexedDB ---------- */
const IDB = (() => {
  let p;
  const db = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('mdfit', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('tracks'); r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = (st, mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(st, mode), r = fn(t.objectStore(st));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  return {
    get: (st, k) => tx(st, 'readonly', s => s.get(k)),
    put: (st, k, v) => tx(st, 'readwrite', s => s.put(v, k)),
    del: (st, k) => tx(st, 'readwrite', s => s.delete(k)),
    all: st => tx(st, 'readonly', s => s.getAll()),
    clear: st => tx(st, 'readwrite', s => s.clear())
  };
})();

/* ---------- Geometrie & Statistik ---------- */
function hav(a, b) {
  const R = 6371008.8, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function bodyWeight() { const b = sortBody().filter(x => x.weight != null).pop(); return b ? b.weight : 75; }
function kcalFor(sport, dist, dur) {
  const s = SP(sport), w = bodyWeight(), h = dur / 3600;
  if (s.foot) return Math.round(w * dist / 1000 * s.kf);
  if (sport === 'bike') { const v = kmh(dist, dur) || 0, met = v < 16 ? 4 : v < 19 ? 6 : v < 22 ? 8 : v < 25 ? 10 : 12; return Math.round(met * w * h); }
  if (sport === 'mtb') return Math.round(8.5 * w * h);
  return Math.round(5 * w * h);
}
// Kennzahlen aus einer Strecke berechnen
function trackStats(raw) {
  // leichte Glättung (Mittel aus 3 Punkten je Abschnitt) gegen GPS-Zittern
  const pts = raw.map((p, i) => {
    const a = raw[i - 1], b = raw[i + 1];
    if (!a || !b || a[4] !== p[4] || b[4] !== p[4]) return p;
    return [(a[0] + p[0] + b[0]) / 3, (a[1] + p[1] + b[1]) / 3, p[2], p[3], p[4]];
  });
  let dist = 0, dur = 0, gain = 0, loss = 0, ref = null, maxV = 0;
  const splits = [], prof = [];
  let nextKm = 1000, lastSplitT = 0, win = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[i - 1];
    if (q && q[4] === p[4]) {
      const d = hav(q, p), dt = (p[3] != null && q[3] != null) ? (p[3] - q[3]) / 1000 : 0;
      if (dt > 0 && dt < 90) dur += dt;
      const before = dist; dist += d;
      while (dist >= nextKm) { // Kilometerzeit interpoliert
        const frac = d ? (nextKm - before) / d : 1, tAt = dur - (dt > 0 && dt < 90 ? dt * (1 - frac) : 0);
        splits.push(Math.round(tAt - lastSplitT)); lastSplitT = tAt; nextKm += 1000;
      }
      if (dt > 0) { win.push([d, dt]); let sd = 0, st = 0; while (win.length > 1 && win.reduce((a, w) => a + w[1], 0) > 20) win.shift(); for (const w of win) { sd += w[0]; st += w[1]; } if (st >= 10) maxV = Math.max(maxV, sd / st); }
    } else win = [];
    if (p[2] != null && isFinite(p[2])) {
      if (ref == null) ref = p[2];
      else if (Math.abs(p[2] - ref) >= 4) { if (p[2] > ref) gain += p[2] - ref; else loss += ref - p[2]; ref = p[2]; }
    }
    prof.push([dist, p[2], dur]);
  }
  const t0 = pts.find(p => p[3] != null), t1 = [...pts].reverse().find(p => p[3] != null);
  return { dist, dur, gain: Math.round(gain), loss: Math.round(loss), splits, maxV, prof, startMs: t0 ? t0[3] : null, elapsed: t0 && t1 ? (t1[3] - t0[3]) / 1000 : 0, hasEle: pts.some(p => p[2] != null) };
}
const localTs = ms => { const d = new Date(ms); return `${dkey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* =========================================================
   Kleine Karte (OpenStreetMap-Kacheln + SVG-Strecke)
   ========================================================= */
class MiniMap {
  constructor(el, opt = {}) {
    this.el = el; this.opt = opt; this.z = 15; this.cx = 0; this.cy = 0; this.tiles = new Map(); this.track = []; this.pos = null;
    el.classList.add('mmap');
    el.innerHTML = `<div class="mm-tiles"></div><svg class="mm-svg"></svg><div class="mm-attr">© OpenStreetMap</div>${opt.controls ? '<div class="mm-ctl"><button type="button" data-z="1" aria-label="Vergrößern">+</button><button type="button" data-z="-1" aria-label="Verkleinern">−</button><button type="button" data-fit aria-label="Ganze Strecke">⤢</button></div>' : ''}`;
    this.tl = $('.mm-tiles', el); this.svg = $('.mm-svg', el);
    if (opt.controls) {
      $$('[data-z]', el).forEach(b => b.onclick = e => { e.stopPropagation(); this.zoomBy(+b.dataset.z); });
      $('[data-fit]', el).onclick = e => { e.stopPropagation(); this.follow = !!opt.followable; this.fit(); };
    }
    if (opt.pan !== false) {
      let st = null;
      el.addEventListener('pointerdown', e => { if (e.target.closest('.mm-ctl')) return; st = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy }; el.setPointerCapture(e.pointerId); });
      el.addEventListener('pointermove', e => { if (!st) return; this.cx = st.cx - (e.clientX - st.x); this.cy = st.cy - (e.clientY - st.y); this.follow = false; this.render(); });
      el.addEventListener('pointerup', () => st = null); el.addEventListener('pointercancel', () => st = null);
    }
  }
  static px(lat, lon, z) {
    const s = 256 * Math.pow(2, z), sin = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360 * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  size() { return [this.el.clientWidth || 320, this.el.clientHeight || 240]; }
  setTrack(pts) { this.track = pts || []; return this; }
  setPos(lat, lon, acc) { this.pos = [lat, lon, acc]; return this; }
  center(lat, lon, z) { if (z != null) this.z = z; [this.cx, this.cy] = MiniMap.px(lat, lon, this.z); this.render(); }
  zoomBy(d) {
    const nz = Math.max(3, Math.min(18, this.z + d)); if (nz === this.z) return;
    const f = Math.pow(2, nz - this.z); this.cx *= f; this.cy *= f; this.z = nz; this.render();
  }
  fit() {
    const pts = this.track.length ? this.track : this.pos ? [this.pos] : [];
    if (!pts.length) { this.render(); return; }
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const p of pts) { la0 = Math.min(la0, p[0]); la1 = Math.max(la1, p[0]); lo0 = Math.min(lo0, p[1]); lo1 = Math.max(lo1, p[1]); }
    const [w, h] = this.size(); let z = 17;
    while (z > 3) { const a = MiniMap.px(la1, lo0, z), b = MiniMap.px(la0, lo1, z); if (b[0] - a[0] <= w - 48 && b[1] - a[1] <= h - 48) break; z--; }
    this.z = this.opt.maxZoom ? Math.min(z, this.opt.maxZoom) : z;
    const a = MiniMap.px(la1, lo0, this.z), b = MiniMap.px(la0, lo1, this.z);
    this.cx = (a[0] + b[0]) / 2; this.cy = (a[1] + b[1]) / 2; this.render();
  }
  render() {
    const [w, h] = this.size(), z = this.z, n = Math.pow(2, z), ox = this.cx - w / 2, oy = this.cy - h / 2;
    const need = new Set();
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + w) / 256); tx++) for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + h) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n, key = `${z}/${wx}/${ty}`; need.add(key + '@' + tx);
      let img = this.tiles.get(key + '@' + tx);
      if (!img) { img = new Image(); img.className = 'mm-t'; img.alt = ''; img.draggable = false; img.onerror = () => img.style.visibility = 'hidden'; img.src = `https://tile.openstreetmap.org/${key}.png`; this.tiles.set(key + '@' + tx, img); this.tl.appendChild(img); }
      img.style.transform = `translate(${tx * 256 - ox}px,${ty * 256 - oy}px)`;
    }
    for (const [k, img] of this.tiles) if (!need.has(k)) { img.remove(); this.tiles.delete(k); }
    // Strecke
    let path = '', prevSeg = null;
    for (const p of this.track) {
      const [x, y] = MiniMap.px(p[0], p[1], z);
      path += `${prevSeg === p[4] ? 'L' : 'M'}${(x - ox).toFixed(1)},${(y - oy).toFixed(1)}`; prevSeg = p[4];
    }
    let svg = `<path d="${path}" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/><path d="${path}" fill="none" stroke="#e34948" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (this.track.length && this.opt.ends) {
      const a = MiniMap.px(this.track[0][0], this.track[0][1], z), b = MiniMap.px(this.track[this.track.length - 1][0], this.track[this.track.length - 1][1], z);
      svg += `<circle cx="${a[0] - ox}" cy="${a[1] - oy}" r="7" fill="#0ca30c" stroke="#fff" stroke-width="2.5"/><circle cx="${b[0] - ox}" cy="${b[1] - oy}" r="7" fill="#111" stroke="#fff" stroke-width="2.5"/>`;
    }
    if (this.pos) {
      const [x, y] = MiniMap.px(this.pos[0], this.pos[1], z), mpp = 40075016.7 * Math.cos(this.pos[0] * Math.PI / 180) / (256 * n), r = Math.max(8, (this.pos[2] || 0) / mpp);
      svg += `<circle cx="${x - ox}" cy="${y - oy}" r="${r}" fill="#2a78d6" opacity=".15"/><circle cx="${x - ox}" cy="${y - oy}" r="8" fill="#2a78d6" stroke="#fff" stroke-width="3"/>`;
    }
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`); this.svg.innerHTML = svg;
  }
}

/* =========================================================
   Live-Aufzeichnung
   ========================================================= */
let REC = null, recWatch = null, recTimer = null, wakeLock = null, recMap = null, lastFix = null, recSaveT = 0;
const recElapsed = () => !REC || !REC.running || !REC.startMs ? 0 : Math.max(0, ((REC.paused ? REC.pauseStart : Date.now()) - REC.startMs - REC.pausedMs) / 1000);

async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } } catch (e) { }
}
document.addEventListener('visibilitychange', () => {
  if (!REC && !recWatch) return;
  if (document.visibilityState === 'visible') { keepAwake(); if (REC && REC.running) { REC.hiddenAt && Date.now() - REC.hiddenAt > 20000 && toast('Willkommen zurück – Lücken im GPS werden als gerade Linie ergänzt'); REC.hiddenAt = null; } }
  else if (REC && REC.running) { REC.hiddenAt = Date.now(); persistRec(true); }
});
function speak(t) {
  try { if (!S.settings.voice || !('speechSynthesis' in window)) return; const u = new SpeechSynthesisUtterance(t); u.lang = 'de-DE'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { }
}
function persistRec(now) {
  if (!REC) return;
  if (!now && Date.now() - recSaveT < 8000) return;
  recSaveT = Date.now();
  IDB.put('kv', 'rec', { ...REC }).catch(() => { });
}

function openRecorder(sport, resume) {
  closeSheet();
  if (!('geolocation' in navigator)) { alert('Dieses Gerät/Browser stellt kein GPS bereit.'); return; }
  if (S.settings.voice == null) { S.settings.voice = true; save(); }
  REC = resume || { id: uid(), sport: sport || S.settings.lastSport || 'run', startMs: null, pausedMs: 0, paused: false, pauseStart: null, running: false, pts: [], seg: 0, kmDone: 0 };
  const ov = document.createElement('div'); ov.id = 'recView';
  ov.innerHTML = `<div class="rv-top"><div class="rv-sport" id="rvSport">${SP(REC.sport).ic} ${SP(REC.sport).n}</div><span class="gps" id="rvGps"><i></i>GPS wird gesucht …</span><button class="rv-x" id="rvVoice" aria-label="Sprachansage">${S.settings.voice ? '🔊' : '🔇'}</button></div>
    <div class="rv-map" id="rvMap"></div>
    <div class="rv-time" id="rvTime">0:00</div>
    <div class="rv-grid">
      <div><span id="rvDist">0,00</span><small>km</small></div>
      <div><span id="rvAvg">–</span><small id="rvAvgL">${SP(REC.sport).foot ? 'Ø min/km' : 'Ø km/h'}</small></div>
      <div><span id="rvCur">–</span><small>${SP(REC.sport).foot ? 'aktuell min/km' : 'aktuell km/h'}</small></div>
      <div><span id="rvGain">0</span><small>Höhenmeter ↑</small></div>
    </div>
    <div class="rv-sel" id="rvSel">${Object.entries(SPORTS).map(([k, s]) => `<button class="chip ${k === REC.sport ? 'on' : ''}" data-sp="${k}">${s.ic} ${s.n}</button>`).join('')}</div>
    <div class="rv-btns" id="rvBtns"></div>
    <div class="rv-note">Bildschirm bleibt während der Aufzeichnung an. Die App bitte nicht verlassen oder sperren – im Hintergrund liefert das Handy einer Web-App kein GPS.</div>`;
  document.body.appendChild(ov); document.body.classList.add('recording');
  history.pushState({ rec: 1 }, '');
  recMap = new MiniMap($('#rvMap'), { controls: true, followable: true, ends: true }); recMap.follow = true;
  recMap.setTrack(REC.pts);
  if (REC.pts.length) { const l = REC.pts[REC.pts.length - 1]; recMap.center(l[0], l[1], 16); } else recMap.center(49.45, 11.08, 5);
  $('#rvVoice').onclick = () => { S.settings.voice = !S.settings.voice; save(); $('#rvVoice').textContent = S.settings.voice ? '🔊' : '🔇'; };
  $$('#rvSel .chip').forEach(c => c.onclick = () => { REC.sport = c.dataset.sp; S.settings.lastSport = REC.sport; save(); $$('#rvSel .chip').forEach(x => x.classList.toggle('on', x === c)); $('#rvSport').textContent = `${SP(REC.sport).ic} ${SP(REC.sport).n}`; $('#rvAvgL').textContent = SP(REC.sport).foot ? 'Ø min/km' : 'Ø km/h'; $('#rvCur').nextElementSibling.textContent = SP(REC.sport).foot ? 'aktuell min/km' : 'aktuell km/h'; updRec(); });
  recWatch = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  keepAwake();
  recTimer = setInterval(updRec, 1000);
  drawRecBtns(); updRec();
}
function drawRecBtns() {
  const b = $('#rvBtns'); if (!b) return;
  $('#rvSel').style.display = REC.running ? 'none' : '';
  if (!REC.running) b.innerHTML = `<button class="btn ghost" id="rvCancel">Abbrechen</button><button class="btn pri rv-big" id="rvStart">▶ Start</button>`;
  else if (REC.paused) b.innerHTML = `<button class="btn danger" id="rvStop">■ Beenden</button><button class="btn pri rv-big" id="rvRes">▶ Weiter</button>`;
  else b.innerHTML = `<button class="btn rv-big" id="rvPause">❚❚ Pause</button>`;
  const on = (id, f) => { const e = $('#' + id); if (e) e.onclick = f; };
  on('rvCancel', () => closeRecorder(false));
  on('rvStart', () => {
    if (!lastFix) { if (!confirm('Noch kein GPS-Signal. Trotzdem starten? Die Strecke beginnt, sobald GPS verfügbar ist.')) return; }
    else if (lastFix.coords.accuracy > 40 && !confirm(`GPS noch ungenau (±${Math.round(lastFix.coords.accuracy)} m). Trotzdem starten?`)) return;
    REC.running = true; REC.startMs = Date.now(); S.settings.lastSport = REC.sport; save();
    if (lastFix && lastFix.coords.accuracy <= 40) addPoint(lastFix);
    speak('Aufzeichnung gestartet'); drawRecBtns(); persistRec(true);
  });
  on('rvPause', () => { REC.paused = true; REC.pauseStart = Date.now(); speak('Pause'); drawRecBtns(); persistRec(true); });
  on('rvRes', () => { REC.pausedMs += Date.now() - REC.pauseStart; REC.paused = false; REC.pauseStart = null; REC.seg++; speak('Weiter'); drawRecBtns(); persistRec(true); });
  on('rvStop', () => { if (confirm('Aufzeichnung beenden und speichern?')) finishRec(); });
  updRec();
}
function onPos(pos) {
  lastFix = pos;
  const acc = pos.coords.accuracy, g = $('#rvGps');
  if (g) { g.className = 'gps ' + (acc <= 15 ? 'ok' : acc <= 40 ? 'mid' : 'bad'); g.innerHTML = `<i></i>GPS ±${Math.round(acc)} m`; }
  if (recMap) { recMap.setPos(pos.coords.latitude, pos.coords.longitude, acc); if (recMap.follow) recMap.center(pos.coords.latitude, pos.coords.longitude, recMap.z < 14 ? 16 : recMap.z); else recMap.render(); }
  if (REC && REC.running && !REC.paused && acc <= 40) addPoint(pos);
}
function onPosErr(e) {
  const g = $('#rvGps'); if (!g) return;
  g.className = 'gps bad'; g.innerHTML = '<i></i>' + (e.code === 1 ? 'GPS-Zugriff verweigert' : 'Kein GPS-Signal');
  if (e.code === 1) alert('Bitte erlaube der App den Zugriff auf deinen Standort (Browser- bzw. Handy-Einstellungen → Standort).');
}
function addPoint(pos) {
  const c = pos.coords, t = pos.timestamp || Date.now();
  const p = [+c.latitude.toFixed(6), +c.longitude.toFixed(6), c.altitude != null ? Math.round(c.altitude * 10) / 10 : null, t, REC.seg];
  const q = REC.pts[REC.pts.length - 1];
  if (q && q[4] === p[4]) {
    const d = hav(q, p), dt = (t - q[3]) / 1000;
    if (dt <= 0) return;
    if (d < Math.max(3, Math.min(c.accuracy, 20) * 0.5)) return;            // Zittern im Stand
    if (d / dt > SP(REC.sport).vmax * 1.4 && dt < 30) {                    // Ausreißer
      REC.rej = (REC.rej || 0) + 1;
      if (REC.rej < 5) return;
      REC.seg++; p[4] = REC.seg;                                            // dauerhaft versetzt → neuer Abschnitt
    }
  }
  REC.rej = 0;
  REC.pts.push(p);
  recMap && recMap.setTrack(REC.pts);
  persistRec();
}
function updRec() {
  if (!REC || !$('#recView')) return;
  const el = recElapsed(), st = trackStats(REC.pts), foot = SP(REC.sport).foot;
  $('#rvTime').textContent = fDur(el);
  $('#rvDist').textContent = fKm(st.dist);
  $('#rvAvg').textContent = st.dist > 50 && el > 0 ? (foot ? fPace(el / (st.dist / 1000)) : f1(kmh(st.dist, el))) : '–';
  // aktuelles Tempo: letzte 30 Sekunden
  let cur = '–'; const now = Date.now(), recent = REC.pts.filter(p => p[4] === REC.seg && now - p[3] < 30000);
  if (!REC.paused && recent.length > 1) { let d = 0; for (let i = 1; i < recent.length; i++) d += hav(recent[i - 1], recent[i]); const dt = (recent[recent.length - 1][3] - recent[0][3]) / 1000; if (dt >= 5 && d > 5) cur = foot ? fPace(dt / (d / 1000)) : f1(d / dt * 3.6); }
  $('#rvCur').textContent = cur;
  $('#rvGain').textContent = f0(st.gain);
  // Kilometer-Ansage
  const km = Math.floor(st.dist / 1000);
  if (REC.running && km > REC.kmDone) {
    REC.kmDone = km;
    const tempo = foot ? (() => { const s = el / (st.dist / 1000); return `Tempo ${Math.floor(s / 60)} Minuten ${Math.round(s % 60)} pro Kilometer`; })() : `Durchschnitt ${Math.round(kmh(st.dist, el))} Kilometer pro Stunde`;
    const h = Math.floor(el / 3600), m = Math.floor(el % 3600 / 60);
    speak(`${km} Kilometer. Zeit ${h ? h + ' Stunden ' : ''}${m} Minuten. ${tempo}.`);
  }
}
function stopWatch() {
  if (recWatch != null) navigator.geolocation.clearWatch(recWatch); recWatch = null;
  clearInterval(recTimer); recTimer = null;
  try { wakeLock && wakeLock.release(); } catch (e) { } wakeLock = null;
}
function closeRecorder(keepData) {
  if (REC && REC.running && !keepData && !confirm('Aufzeichnung verwerfen?')) return;
  stopWatch();
  const ov = $('#recView'); if (ov) ov.remove(); document.body.classList.remove('recording');
  if (!keepData) { REC = null; IDB.del('kv', 'rec').catch(() => { }); }
  recMap = null; lastFix = null;
  if (history.state && history.state.rec) history.replaceState({}, '');
}
window.addEventListener('popstate', () => { if ($('#recView')) { history.pushState({ rec: 1 }, ''); if (!REC || !REC.running) closeRecorder(false); else toast('Zum Verlassen erst „Pause“ und „Beenden“ tippen'); } });
function finishRec() {
  if (REC.paused) { REC.pausedMs += Date.now() - REC.pauseStart; REC.paused = false; }
  const dur = Math.round(((REC.pauseStart || Date.now()) - REC.startMs - REC.pausedMs) / 1000);
  const r = REC; closeRecorder(true);
  const st = trackStats(r.pts);
  const a = { id: r.id, sport: r.sport, start: localTs(r.startMs), dist: Math.round(st.dist), dur, gain: st.gain, loss: st.loss, maxV: st.maxV, splits: st.splits, src: 'gps', note: '', hr: null, pts: r.pts.length };
  a.kcal = kcalFor(a.sport, a.dist, a.dur);
  activitySheet(a, r.pts, true);
}
async function checkUnfinished() {
  try {
    const r = await IDB.get('kv', 'rec');
    if (!r || !r.running) return;
    const ago = Math.round((Date.now() - (r.pts.length ? r.pts[r.pts.length - 1][3] : r.startMs)) / 60000);
    openSheet(`<h2>Unterbrochene Aufzeichnung</h2><div class="note">${SP(r.sport).ic} ${SP(r.sport).n}, gestartet ${fdate(localTs(r.startMs))} ${localTs(r.startMs).slice(11)} Uhr · ${fKm(trackStats(r.pts).dist)} km · letzter Punkt vor ${ago} min.<br>Die App wurde während der Aufzeichnung geschlossen.</div>
      <div class="foot" style="flex-direction:column"><button class="btn pri block" id="urRes">Aufzeichnung fortsetzen</button><button class="btn block" id="urSave">Beenden und speichern</button><button class="btn danger block" id="urDel">Verwerfen</button></div>`, sh => {
      $('#urRes', sh).onclick = () => { if (!r.paused) { r.paused = true; r.pauseStart = r.pts.length ? r.pts[r.pts.length - 1][3] : Date.now(); } closeSheet(); setTimeout(() => openRecorder(r.sport, r), 250); };
      $('#urSave', sh).onclick = () => { if (!r.paused) { r.paused = true; r.pauseStart = r.pts.length ? r.pts[r.pts.length - 1][3] : Date.now(); } REC = r; closeSheet(); setTimeout(finishRec, 250); };
      $('#urDel', sh).onclick = () => { if (confirm('Aufzeichnung wirklich verwerfen?')) { IDB.del('kv', 'rec'); closeSheet(); } };
    });
  } catch (e) { }
}

/* =========================================================
   Speichern / Bearbeiten / Detail
   ========================================================= */
async function saveActivity(a, pts) {
  if (pts) await IDB.put('tracks', a.id, { id: a.id, pts });
  S.activities = (S.activities || []).filter(x => x.id !== a.id).concat(a); save();
  IDB.del('kv', 'rec').catch(() => { });
}
function activitySheet(a, pts, isNewRec, isManual) {
  const isNew = isNewRec || isManual || !S.activities.some(x => x.id === a.id);
  const hasTrack = !!(pts && pts.length) || a.src === 'gps' || a.src === 'gpx';
  openSheet(`<h2>${isNewRec ? 'Aktivität speichern' : isManual ? 'Aktivität eintragen' : isNew ? 'Importierte Aktivität speichern' : 'Aktivität bearbeiten'}</h2>
    ${(isNewRec || (isNew && pts && pts.length)) && a.dur ? `<div class="tiles" style="margin-top:6px"><div class="tile"><div class="lbl">Strecke</div><div class="val">${fKm(a.dist)} <small>km</small></div></div><div class="tile"><div class="lbl">Zeit</div><div class="val">${fDur(a.dur)}</div></div><div class="tile"><div class="lbl">${SP(a.sport).foot ? 'Ø Tempo' : 'Ø Geschw.'}</div><div class="val" style="font-size:20px">${tempoTxt(a)}</div></div><div class="tile"><div class="lbl">Höhenmeter</div><div class="val">${a.gain} <small>m ↑</small></div></div></div>` : ''}
    <label class="f">Sportart</label><div class="chips" id="aSp">${Object.entries(SPORTS).map(([k, s]) => `<button type="button" class="chip ${k === a.sport ? 'on' : ''}" data-sp="${k}">${s.ic} ${s.n}</button>`).join('')}</div>
    <label class="f">Start</label><input type="datetime-local" class="in" id="aT" value="${a.start}">
    ${!hasTrack ? `<div class="grid3"><div><label class="f">Strecke km</label><input class="in" id="aD" inputmode="decimal" value="${a.dist ? f1(a.dist / 1000, 2) : ''}"></div><div><label class="f">Dauer h:mm:ss</label><input class="in" id="aDu" value="${a.dur ? fDur(a.dur) : ''}" placeholder="45:00"></div><div><label class="f">Höhenm. ↑</label><input class="in" id="aG" inputmode="numeric" value="${a.gain || ''}"></div></div>` : ''}
    ${hasTrack && !a.dur ? `<label class="f">Dauer h:mm:ss (Datei ohne Zeitangaben)</label><input class="in" id="aDu" placeholder="z. B. 1:05:00">` : ''}
    <div class="grid2"><div><label class="f">Ø Herzfrequenz (optional)</label><input class="in" id="aHr" inputmode="numeric" value="${a.hr || ''}" placeholder="Schläge/min"></div><div><label class="f">Gefühl</label><div class="seg" id="aFeel"><button type="button" data-v="1">😓</button><button type="button" data-v="2">🙂</button><button type="button" data-v="3">💪</button></div></div></div>
    <label class="f">Notiz</label><input class="in" id="aN" value="${esc(a.note || '')}" placeholder="z. B. Strecke, Wetter">
    <div class="foot">${isNewRec ? '<button class="btn danger" id="aDisc">Verwerfen</button>' : isNew ? '<button class="btn ghost" id="aCancel">Abbrechen</button>' : '<button class="btn ghost" id="aCancel">Abbrechen</button>'}<button class="btn pri" id="aSave">Speichern</button></div>`, sh => {
    let sp = a.sport, feel = String(a.feel || '');
    $$('#aSp .chip', sh).forEach(c => c.onclick = () => { sp = c.dataset.sp; $$('#aSp .chip', sh).forEach(x => x.classList.toggle('on', x === c)); });
    const fs = $('#aFeel', sh), setF = v => { feel = v; seg(fs, v, setF); }; seg(fs, feel, setF);
    if ($('#aCancel', sh)) $('#aCancel', sh).onclick = () => closeSheet();
    if ($('#aDisc', sh)) $('#aDisc', sh).onclick = () => { if (confirm('Diese Aufzeichnung wirklich verwerfen?')) { IDB.del('kv', 'rec'); REC = null; closeSheet(); } };
    $('#aSave', sh).onclick = async () => {
      a.sport = sp; a.start = $('#aT', sh).value || a.start; a.note = $('#aN', sh).value.trim(); a.hr = num($('#aHr', sh).value); a.feel = feel ? +feel : null;
      if ($('#aD', sh)) { a.dist = Math.round((num($('#aD', sh).value) || 0) * 1000); a.gain = Math.round(num($('#aG', sh).value) || 0); }
      if ($('#aDu', sh) && $('#aDu', sh).value) a.dur = Math.round(parseDur($('#aDu', sh).value) || 0);
      if (!a.dist && !a.dur) { toast('Bitte Strecke oder Dauer angeben'); return; }
      a.kcal = kcalFor(a.sport, a.dist || 0, a.dur || 0);
      await saveActivity(a, pts && pts.length ? pts : null);
      REC = null; closeSheet(); UI.actSub = 'list'; if (TAB !== 'act') go('act'); else render(); toast('Aktivität gespeichert');
      if (isNewRec) setTimeout(() => openActivity(a.id), 350);
    };
  });
}
async function openActivity(id) {
  const a = S.activities.find(x => x.id === id); if (!a) return;
  let pts = [];
  try { const t = await IDB.get('tracks', id); pts = t ? t.pts : []; } catch (e) { }
  const st = pts.length ? trackStats(pts) : null, foot = SP(a.sport).foot;
  const splits = a.splits && a.splits.length ? a.splits : st ? st.splits : [];
  const best = splits.length ? Math.min(...splits) : null;
  openSheet(`<div class="row"><h2 class="grow">${SP(a.sport).ic} ${SP(a.sport).n}</h2></div>
    <div class="small ink2" style="margin-top:-2px">${fdate(a.start)} · ${a.start.slice(11)} Uhr${a.src === 'gpx' ? ' · importiert' : a.src === 'manuell' ? ' · manuell' : ''}${a.note ? ' · ' + esc(a.note) : ''}</div>
    ${pts.length ? '<div class="mapbox" id="adMap"></div>' : ''}
    <div class="stat3">
      <div><b>${fKm(a.dist)}</b><span>km</span></div><div><b>${fDur(a.dur)}</b><span>Zeit</span></div><div><b>${foot ? fPace(a.dur / (a.dist / 1000)) : f1(kmh(a.dist, a.dur))}</b><span>${foot ? 'Ø min/km' : 'Ø km/h'}</span></div>
      <div><b>${a.gain || 0}</b><span>Höhenm. ↑</span></div><div><b>${a.kcal || '–'}</b><span>kcal (ca.)</span></div><div><b>${a.hr || (a.maxV ? (foot ? fPace(1000 / a.maxV) : f1(a.maxV * 3.6)) : '–')}</b><span>${a.hr ? 'Ø Puls' : foot ? 'schnellstes min/km' : 'max. km/h'}</span></div>
    </div>
    ${st && st.prof.length > 3 ? `<div class="seg chartsel" id="adSel"><button data-v="v">${foot ? 'Tempo' : 'Geschwindigkeit'}</button>${st.hasEle ? '<button data-v="h">Höhenprofil</button>' : ''}</div><div class="chart" id="adC"></div>` : ''}
    ${splits.length ? `<h3 style="margin-top:14px">Kilometerzeiten</h3><table class="t"><tr><th>km</th><th>Zeit</th><th>${foot ? 'min/km' : 'km/h'}</th><th></th></tr>${splits.map((s, i) => `<tr><td>${i + 1}</td><td>${fDur(s)}</td><td>${foot ? fPace(s) : f1(3600 / s)}</td><td style="width:40%"><div class="b" style="height:8px;background:var(--card2);border-radius:4px;overflow:hidden"><i style="display:block;height:100%;width:${(best / s * 100).toFixed(0)}%;background:${s === best ? 'var(--good)' : SP(a.sport).c}"></i></div></td></tr>`).join('')}</table>` : ''}
    <div class="foot" style="flex-wrap:wrap"><button class="btn danger" id="adDel">Löschen</button>${pts.length ? '<button class="btn" id="adGpx">GPX</button>' : ''}<button class="btn" id="adEdit">Bearbeiten</button><button class="btn pri" id="adClose">Schließen</button></div>`, sh => {
    if (pts.length) { const m = new MiniMap($('#adMap', sh), { controls: true, ends: true }); m.setTrack(pts); requestAnimationFrame(() => m.fit()); }
    if (st && $('#adC', sh)) {
      // Tempo/Höhe über die Strecke (ca. alle 100 m bzw. 50 Stützstellen)
      const step = Math.max(100, st.dist / 60), ser = [];
      let nx = step, lastD = 0, lastT = 0;
      for (const [d, e, t] of st.prof) if (d >= nx) { const v = (d - lastD) / Math.max(1, t - lastT); ser.push({ d, v, e, t }); lastD = d; lastT = t; nx = d + step; }
      const sm = ser.map((p, i) => { const w = ser.slice(Math.max(0, i - 1), i + 2); return { ...p, v: mean(w.map(x => x.v)) }; });
      const draw = k => {
        seg($('#adSel', sh), k, draw);
        if (k === 'h') lineChart($('#adC', sh), { xNum: 1, xFmt: v => f1(v / 1000, v < 10000 ? 1 : 0) + ' km', h: 180, dec: 0, label: 'Höhenprofil', series: [{ name: 'Höhe', color: 'var(--s3)', unit: 'm', noDots: 1, pts: st.prof.filter((p, i) => p[1] != null && i % Math.ceil(st.prof.length / 300) === 0).map(p => ({ t: p[0], v: p[1], lbl: `bei ${fKm(p[0])} km` })) }] });
        else lineChart($('#adC', sh), { xNum: 1, xFmt: v => f1(v / 1000, v < 10000 ? 1 : 0) + ' km', h: 180, dec: foot ? 0 : 1, minSpan: foot ? 60 : 4, yFmt: foot ? v => fPace(v) : null, yInvert: foot, label: 'Tempo', series: [{ name: foot ? 'Tempo' : 'Geschw.', color: SP(a.sport).c, unit: foot ? '/km' : 'km/h', noDots: 1, pts: sm.filter(p => p.v > 0.3).map(p => foot ? { t: p.d, v: 1000 / p.v, txt: fPace(1000 / p.v) + ' /km', lbl: `bei ${fKm(p.d)} km` } : { t: p.d, v: p.v * 3.6, lbl: `bei ${fKm(p.d)} km` }) }] });
      };
      draw('v');
    }
    $('#adClose', sh).onclick = () => closeSheet();
    $('#adEdit', sh).onclick = () => { closeSheet(); setTimeout(() => activitySheet({ ...a }, null), 280); };
    $('#adDel', sh).onclick = async () => { if (!confirm('Diese Aktivität löschen?')) return; S.activities = S.activities.filter(x => x.id !== id); save(); await IDB.del('tracks', id).catch(() => { }); closeSheet(); render(); toast('Gelöscht'); };
    if ($('#adGpx', sh)) $('#adGpx', sh).onclick = () => download(`${a.start.slice(0, 10)}_${SP(a.sport).n.split(' ')[0]}.gpx`, toGPX(a, pts), 'application/gpx+xml');
  });
}

/* ---------- GPX ---------- */
function toGPX(a, pts) {
  const type = { run: 'running', walk: 'walking', hike: 'hiking', bike: 'cycling', mtb: 'mountain_biking', other: 'other' }[a.sport];
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="MD-Fitness" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(SP(a.sport).n)} ${a.start.slice(0, 10)}</name></metadata>\n<trk><name>${esc(SP(a.sport).n)} ${fdate(a.start)}</name><type>${type}</type>`;
  let seg = null;
  for (const p of pts) {
    if (p[4] !== seg) { x += (seg !== null ? '</trkseg>' : '') + '\n<trkseg>'; seg = p[4]; }
    x += `\n<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}${p[3] ? `<time>${new Date(p[3]).toISOString()}</time>` : ''}</trkpt>`;
  }
  return x + (seg !== null ? '\n</trkseg>' : '') + '\n</trk>\n</gpx>\n';
}
function parseGPX(text) {
  const x = new DOMParser().parseFromString(text, 'application/xml');
  if (x.getElementsByTagName('parsererror').length) throw new Error('Keine gültige GPX-Datei');
  const pts = [], hrs = [];
  let segs = [...x.getElementsByTagName('trkseg')];
  const grab = (p, si) => {
    const t = p.getElementsByTagName('time')[0], e = p.getElementsByTagName('ele')[0];
    const hr = [...p.getElementsByTagName('*')].find(n => /(^|:)hr$/i.test(n.nodeName));
    if (hr) hrs.push(+hr.textContent);
    const lat = +p.getAttribute('lat'), lon = +p.getAttribute('lon');
    if (isFinite(lat) && isFinite(lon)) pts.push([lat, lon, e ? +(+e.textContent).toFixed(1) : null, t ? Date.parse(t.textContent) : null, si]);
  };
  if (segs.length) segs.forEach((sg, si) => [...sg.getElementsByTagName('trkpt')].forEach(p => grab(p, si)));
  else [...x.getElementsByTagName('rtept')].forEach(p => grab(p, 0));
  if (pts.length < 2) throw new Error('Die Datei enthält keine Strecke');
  const type = ((x.getElementsByTagName('type')[0] || {}).textContent || '').toLowerCase();
  return { pts, type, hr: hrs.length ? Math.round(mean(hrs)) : null };
}
function guessSport(type, st) {
  if (/mountain|mtb/.test(type)) return 'mtb';
  if (/bik|cycl|rad|ride/.test(type)) return 'bike';
  if (/hik|wander/.test(type)) return 'hike';
  if (/walk|geh/.test(type)) return 'walk';
  if (/run|lauf|jog/.test(type)) return 'run';
  const v = kmh(st.dist, st.dur) || 0;
  return v > 13 ? 'bike' : v > 7.5 ? 'run' : 'walk';
}
async function importGPXFiles(files) {
  const done = [];
  for (const f of files) {
    try {
      const g = parseGPX(await f.text()), st = trackStats(g.pts), sport = guessSport(g.type, st);
      const startMs = st.startMs || f.lastModified || Date.now();
      const a = { id: uid(), sport, start: localTs(startMs), dist: Math.round(st.dist), dur: Math.round(st.dur), gain: st.gain, loss: st.loss, maxV: st.maxV, splits: st.splits, src: 'gpx', note: f.name.replace(/\.gpx$/i, ''), hr: g.hr, pts: g.pts.length };
      a.kcal = kcalFor(a.sport, a.dist, a.dur);
      if (files.length === 1) { activitySheet(a, g.pts, false, false); return; }
      await saveActivity(a, g.pts); done.push(a);
    } catch (e) { alert(`${f.name}: ${e.message}`); }
  }
  if (done.length) { render(); toast(`${done.length} Aktivitäten importiert`); }
}

/* =========================================================
   Ansicht „Aktivität“
   ========================================================= */
function actItem(a) {
  return `<div class="it" data-edit="a:${a.id}" style="cursor:pointer"><div class="aic" style="background:color-mix(in srgb, ${SP(a.sport).c} 18%, transparent)">${SP(a.sport).ic}</div><div class="main"><div class="ttl">${SP(a.sport).n}</div><div class="meta">${fdate(a.start)} · ${a.start.slice(11)} Uhr</div></div><div class="num"><div style="font-size:17px">${fKm(a.dist)} km</div><div class="small muted">${fDur(a.dur)} · ${tempoTxt(a)}</div></div></div>`;
}
function renderAct() {
  seg($('#actNav'), UI.actSub || 'start', v => { UI.actSub = v; renderAct(); });
  const el = $('#actBody'), sub = UI.actSub || 'start';
  if (sub === 'stats') return renderActStats(el);
  if (sub === 'list') return renderActList(el);
  const last = (S.activities || []).slice().sort((a, b) => a.start < b.start ? 1 : -1).slice(0, 3);
  const ls = S.settings.lastSport || 'run';
  el.innerHTML = `<div class="card"><h3>Neue Aktivität aufzeichnen</h3>
      <div class="chips" id="stSp">${Object.entries(SPORTS).map(([k, s]) => `<button class="chip ${k === ls ? 'on' : ''}" data-sp="${k}">${s.ic} ${s.n}</button>`).join('')}</div>
      <button class="btn pri block" id="stGo" style="margin-top:12px;min-height:58px;font-size:18px">▶ GPS-Aufzeichnung öffnen</button>
      <div class="note">Während der Aufzeichnung bleibt der Bildschirm an. Wird das Handy gesperrt oder die App verlassen, pausiert das GPS – danach wird die Lücke als gerade Linie ergänzt. Für lange Touren mit gesperrtem Handy kannst du auch mit Uhr/Strava/Komoot aufzeichnen und die <b>GPX-Datei importieren</b>.</div></div>
    <div class="grid2" style="margin-bottom:12px"><button class="btn" id="stGpx">GPX importieren</button><button class="btn" id="stMan">Manuell eintragen</button></div>
    <div class="card"><h3>Letzte Aktivitäten</h3><div class="list">${last.length ? last.map(actItem).join('') : '<div class="empty">Noch keine Aktivitäten</div>'}</div></div>`;
  let sp = ls;
  $$('#stSp .chip').forEach(c => c.onclick = () => { sp = c.dataset.sp; S.settings.lastSport = sp; save(); $$('#stSp .chip').forEach(x => x.classList.toggle('on', x === c)); });
  $('#stGo').onclick = () => openRecorder(sp);
  $('#stGpx').onclick = () => $('#fileGpx').click();
  $('#stMan').onclick = () => activitySheet({ id: uid(), sport: sp, start: nowLocal(), dist: 0, dur: 0, gain: 0, src: 'manuell', note: '' }, null, false, true);
  bindItems(el);
}
function actFiltered() {
  const all = (S.activities || []).slice().sort((a, b) => a.start < b.start ? -1 : 1);
  const from = rangeFrom(UI.aRange || '3M', all[0] && all[0].start);
  const f = UI.aSport || 'all';
  return { from, all, list: all.filter(a => pdate(a.start) >= from && (f === 'all' || a.sport === f)) };
}
function renderActStats(el) {
  UI.aRange = UI.aRange || '3M';
  const { from, all, list } = actFiltered(), f = UI.aSport || 'all';
  const used = [...new Set(all.map(a => a.sport))];
  let h = `<div class="filterbar">${rangeBar(UI.aRange, 'aR')}<div class="seg" id="aSpF" style="margin-top:6px"><button data-v="all">Alle</button>${used.map(k => `<button data-v="${k}">${SP(k).ic} ${SP(k).n.split(' ')[0]}</button>`).join('')}</div></div>`;
  if (!all.length) { el.innerHTML = '<div class="card"><div class="empty">Noch keine Aktivitäten. Starte eine Aufzeichnung oder importiere eine GPX-Datei.</div></div>'; return; }
  const dist = list.reduce((s, a) => s + (a.dist || 0), 0), dur = list.reduce((s, a) => s + (a.dur || 0), 0), gain = list.reduce((s, a) => s + (a.gain || 0), 0);
  const one = f !== 'all' ? SP(f) : null;
  h += `<div class="tiles">
    <div class="tile"><div class="lbl">Strecke</div><div class="val">${f1(dist / 1000, dist < 100000 ? 1 : 0)} <small>km</small></div><div class="hint">${list.length} Aktivität${list.length === 1 ? '' : 'en'}</div></div>
    <div class="tile"><div class="lbl">Zeit</div><div class="val">${f1(dur / 3600)} <small>Std.</small></div><div class="hint">${f0(list.reduce((s, a) => s + (a.kcal || 0), 0))} kcal (ca.)</div></div>
    <div class="tile"><div class="lbl">${one ? (one.foot ? 'Ø Tempo' : 'Ø Geschwindigkeit') : 'Höhenmeter'}</div><div class="val">${one ? (one.foot ? fPace(dur / (dist / 1000)) : f1(kmh(dist, dur))) : f0(gain)} <small>${one ? (one.foot ? '/km' : 'km/h') : 'm ↑'}</small></div></div>
    <div class="tile"><div class="lbl">Ø Strecke</div><div class="val">${list.length ? f1(dist / list.length / 1000) : '–'} <small>km</small></div><div class="hint">pro Aktivität</div></div>
  </div>`;
  h += chartCard('ac', 'Verlauf', [{ k: 'w', l: 'km pro Woche' }, { k: 't', l: one && one.foot ? 'Tempo' : 'Geschwindigkeit' }, { k: 'd', l: 'Strecke je Aktivität' }]);
  // Bestleistungen
  const pb = used.filter(k => f === 'all' || k === f).map(k => {
    const l = all.filter(a => a.sport === k && a.dist > 0); if (!l.length) return '';
    const fast = l.filter(a => a.dist >= 1000 && a.dur).sort((a, b) => a.dur / a.dist - b.dur / b.dist)[0];
    const longest = l.slice().sort((a, b) => b.dist - a.dist)[0], high = l.slice().sort((a, b) => (b.gain || 0) - (a.gain || 0))[0];
    const bestKm = l.filter(a => a.splits && a.splits.length).map(a => ({ a, s: Math.min(...a.splits) })).sort((x, y) => x.s - y.s)[0];
    const row = (n, v, a) => `<tr data-edit="a:${a.id}" style="cursor:pointer"><td>${n}</td><td><b>${v}</b></td><td class="small muted">${fshort(pdate(a.start))}${pdate(a.start).getFullYear()}</td></tr>`;
    return `<div class="mhead" style="margin-top:6px">${SP(k).ic} ${SP(k).n}</div><table class="t">${row('Längste Strecke', fKm(longest.dist) + ' km', longest)}${fast ? row(SP(k).foot ? 'Schnellstes Ø-Tempo' : 'Höchster Ø-Speed', tempoTxt(fast), fast) : ''}${bestKm && SP(k).foot ? row('Schnellster Kilometer', fPace(bestKm.s) + ' /km', bestKm.a) : ''}${high && high.gain ? row('Meiste Höhenmeter', high.gain + ' m', high) : ''}</table>`;
  }).join('');
  h += det('🏆 Bestleistungen', pb || '<div class="empty">Noch keine Daten</div>', true);
  el.innerHTML = h;
  seg($('#aR'), UI.aRange, v => { UI.aRange = v; renderAct(); });
  seg($('#aSpF'), f, v => { UI.aSport = v; renderAct(); });
  bindItems(el);
  const to = new Date();
  mountChartCard('ac', [
    { k: 'w', draw: c => {
      const nW = Math.min(52, Math.max(4, Math.ceil((to - from) / 6048e5))); const bars = []; let m = addDays(monday(to), -7 * (nW - 1));
      for (let i = 0; i < nW; i++) { const e = addDays(m, 7), l = list.filter(a => { const d = pdate(a.start); return d >= m && d < e; }), km = l.reduce((s, a) => s + a.dist, 0) / 1000; bars.push({ l: 'KW' + isoWeek(m), v: km, tip: `KW ${isoWeek(m)}: <b>${f1(km)} km</b> · ${l.length} Aktivität${l.length === 1 ? '' : 'en'}` }); m = e; }
      barChart(c, { bars, color: one ? one.c : 'var(--s7)', label: 'km pro Woche' });
    } },
    { k: 't', legend: one ? '' : legend(used.map(k => ({ n: SP(k).n, c: SP(k).c, ln: 1 }))), draw: c => {
      const sports = one ? [f] : used;
      const series = sports.map(k => ({ name: SP(k).n, color: SP(k).c, unit: SP(k).foot && one ? '/km' : 'km/h', dec: 1, pts: list.filter(a => a.sport === k && a.dist > 200 && a.dur).map(a => one && one.foot ? { t: pdate(a.start), v: a.dur / (a.dist / 1000), txt: fPace(a.dur / (a.dist / 1000)) + ' /km', lbl: `${fdate(a.start)} · ${fKm(a.dist)} km` } : { t: pdate(a.start), v: kmh(a.dist, a.dur), lbl: `${fdate(a.start)} · ${fKm(a.dist)} km` }) }));
      lineChart(c, { from, to, h: 210, dec: 1, minSpan: one && one.foot ? 60 : 2, yFmt: one && one.foot ? v => fPace(v) : null, yInvert: one && one.foot, label: 'Tempo', series });
      if (one && one.foot) c.insertAdjacentHTML('beforeend', '<div class="small muted">Nach oben = schneller</div>');
    } },
    { k: 'd', draw: c => lineChart(c, { from, to, h: 210, dec: 1, label: 'Strecke', series: (one ? [f] : used).map(k => ({ name: SP(k).n, color: SP(k).c, unit: 'km', dec: 2, pts: list.filter(a => a.sport === k).map(a => ({ t: pdate(a.start), v: a.dist / 1000, lbl: `${fdate(a.start)} · ${fDur(a.dur)}` })) })) }), legend: one ? '' : legend(used.map(k => ({ n: SP(k).n, c: SP(k).c, ln: 1 }))) }
  ]);
}
function renderActList(el) {
  const all = (S.activities || []).slice().sort((a, b) => a.start < b.start ? 1 : -1);
  if (!all.length) { el.innerHTML = '<div class="card"><div class="empty">Noch keine Aktivitäten</div></div>'; return; }
  let h = '', cur = '';
  for (const a of all) {
    const d = pdate(a.start), mk = `${MON[d.getMonth()]} ${d.getFullYear()}`;
    if (mk !== cur) {
      if (cur) h += '</div></div>'; cur = mk;
      const ml = all.filter(x => { const y = pdate(x.start); return y.getMonth() === d.getMonth() && y.getFullYear() === d.getFullYear(); });
      h += `<div class="mhead">${mk} · ${f1(ml.reduce((s, x) => s + x.dist, 0) / 1000)} km · ${ml.length} Aktivität${ml.length === 1 ? '' : 'en'}</div><div class="card"><div class="list">`;
    }
    h += actItem(a);
  }
  el.innerHTML = h + '</div></div>';
  bindItems(el);
}
document.getElementById('fileGpx').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) importGPXFiles(fs); });
