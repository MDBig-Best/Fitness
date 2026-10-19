/* MD-Fitness – Erkennung der 7-Segment-Anzeige eines Blutdruckmessgeräts (z. B. Beurer BM 53)
   Arbeitet komplett offline im Browser auf Pixeldaten (RGBA).
   Ergebnis: { sys, dia, pul, ok, rows } – Werte werden immer zur Kontrolle angezeigt. */
(function (root) {
  'use strict';

  // Segment-Muster a b c d e f g
  const PATTERNS = {
    0: [1,1,1,1,1,1,0], 1: [0,1,1,0,0,0,0], 2: [1,1,0,1,1,0,1], 3: [1,1,1,1,0,0,1],
    4: [0,1,1,0,0,1,1], 5: [1,0,1,1,0,1,1], 6: [1,0,1,1,1,1,1], 7: [1,1,1,0,0,0,0],
    8: [1,1,1,1,1,1,1], 9: [1,1,1,1,0,1,1]
  };
  // Prüfbereiche je Segment im entzerrten Ziffernfeld (u = x 0..1, v = y 0..1)
  const ZONES = [
    [0.30, 0.70, 0.00, 0.16], // a oben
    [0.66, 1.00, 0.14, 0.44], // b oben rechts
    [0.66, 1.00, 0.56, 0.86], // c unten rechts
    [0.30, 0.70, 0.84, 1.00], // d unten
    [0.00, 0.34, 0.56, 0.86], // e unten links
    [0.00, 0.34, 0.14, 0.44], // f oben links
    [0.30, 0.70, 0.42, 0.58]  // g Mitte
  ];

  function toGray(data, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    return g;
  }

  // adaptive Schwelle: dunkel, wenn deutlich dunkler als die Umgebung
  function threshold(g, w, h, factor) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; }
    }
    const r = Math.max(8, Math.round(Math.min(w, h) / 7));
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        m[y * w + x] = g[y * w + x] < mean * factor ? 1 : 0;
      }
    }
    return m;
  }

  function dilate(m, w, h, rx, ry) {
    if (rx < 1 && ry < 1) return m;
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dx = -rx; dx <= rx; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) t[y * w + xx] = 1; }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!t[y * w + x]) continue;
      for (let dy = -ry; dy <= ry; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) o[yy * w + x] = 1; }
    }
    return o;
  }

  // zusammenhängende Flächen (8er-Nachbarschaft)
  function components(m, w, h) {
    const lab = new Int32Array(w * h).fill(-1), comps = [], stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!m[i] || lab[i] >= 0) continue;
      const c = { x0: w, y0: h, x1: 0, y1: 0, n: 0, px: [] };
      lab[i] = comps.length; stack.push(i);
      while (stack.length) {
        const k = stack.pop(), x = k % w, y = (k / w) | 0;
        c.n++; c.px.push(k);
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const kk = yy * w + xx;
          if (m[kk] && lab[kk] < 0) { lab[kk] = comps.length; stack.push(kk); }
        }
      }
      c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1;
      comps.push(c);
    }
    return comps;
  }

  // Senkrechte Segmente finden und zu Ziffernzeilen (Bändern) zusammenfassen
  function findBands(comps, W, Hh) {
    const vert = comps.filter(c => c.h >= Math.max(8, Hh * 0.015) && c.h <= Hh * 0.3 && c.h / c.w >= 1.8 && c.n / (c.w * c.h) > 0.3);
    const pairs = [];
    for (const u of vert) for (const l of vert) {
      if (u === l) continue;
      const hv = (u.h + l.h) / 2;
      if (Math.abs(u.h - l.h) > 0.18 * hv) continue;
      const gap = l.y0 - u.y1;
      if (gap < -0.06 * hv || gap > 0.3 * hv) continue;
      const cxu = (u.x0 + u.x1) / 2, cxl = (l.x0 + l.x1) / 2;
      if (cxu - cxl < -0.35 * hv || cxu - cxl > 1.25 * hv) continue; // unten darf links liegen (Kursiv bzw. Ziffer 2/5/6)
      pairs.push({ y0: u.y0, y1: l.y1, x0: Math.min(u.x0, l.x0), x1: Math.max(u.x1, l.x1), H: l.y1 - u.y0 });
    }
    // ganze Ziffern, deren Segmente zusammenhängen (kleine Anzeigen, z. B. Puls)
    for (const c of comps) {
      const ar = c.h / c.w, fill = c.n / (c.w * c.h);
      if (c.h >= Math.max(10, Hh * 0.02) && c.h <= Hh * 0.45 && ar >= 1.25 && ar <= 3.2 && fill > 0.22 && fill < 0.75)
        pairs.push({ y0: c.y0, y1: c.y1, x0: c.x0, x1: c.x1, H: c.h });
    }
    const bands = [];
    for (const p of pairs.sort((a, b) => b.H - a.H)) {
      const b = bands.find(b => Math.abs(b.y0 - p.y0) < 0.15 * b.H && Math.abs(b.H - p.H) < 0.15 * b.H && (p.x0 - b.x1) < 1.4 * b.H && (b.x0 - p.x1) < 1.4 * b.H);
      if (b) { b.x0 = Math.min(b.x0, p.x0); b.x1 = Math.max(b.x1, p.x1); b.n++; }
      else bands.push({ ...p, n: 1 });
    }
    return bands;
  }

  // Ziffern eines Bandes lesen
  function readBand(band, raw, W, Hh) {
    const H = band.H;
    const y0 = Math.max(0, Math.round(band.y0 - 0.07 * H)), y1 = Math.min(Hh - 1, Math.round(band.y1 + 0.07 * H));
    const xa = Math.max(0, Math.round(band.x0 - 0.45 * H)), xb = Math.min(W - 1, Math.round(band.x1 + 0.25 * H));
    const off = Math.round(0.5 * H) + 2, len = xb - xa + off * 2;
    const proj = s => {
      const cols = new Int32Array(len);
      for (let y = y0; y <= y1; y++) for (let x = xa; x <= xb; x++) if (raw[y * W + x]) {
        const xd = Math.round(x - xa + s * (y - y1)) + off; if (xd >= 0 && xd < len) cols[xd]++;
      }
      return cols;
    };
    let slant = 0, bestE = -1;
    for (let s = -0.05; s <= 0.36; s += 0.01) {
      const c = proj(s); let first = -1, last = -1, empty = 0;
      for (let i = 0; i < len; i++) if (c[i]) { if (first < 0) first = i; last = i; }
      for (let i = first; i <= last; i++) if (!c[i]) empty++;
      if (empty > bestE) { bestE = empty; slant = s; }
    }
    const cols = proj(slant), groups = [];
    let g = null;
    for (let i = 0; i < len; i++) {
      if (cols[i]) { if (!g) g = { u0: i, u1: i }; else g.u1 = i; }
      else if (g) { groups.push(g); g = null; }
    }
    if (g) groups.push(g);
    const X = (u, y) => Math.round(u - off + xa - slant * (y - y1));
    // Gruppen ohne ausreichende Höhe (Beschriftungen, Balken, Symbole) verwerfen
    const digitsG = groups.filter(gr => {
      let rowsOn = 0;
      for (let y = y0; y <= y1; y++) {
        let on = false;
        for (let u = gr.u0; u <= gr.u1 && !on; u++) { const x = X(u, y); if (x >= 0 && x < W && raw[y * W + x]) on = true; }
        if (on) rowsOn++;
      }
      gr.cov = rowsOn / (y1 - y0 + 1);
      return gr.cov >= 0.68 && (gr.u1 - gr.u0 + 1) <= 0.95 * H;
    });
    // nur die rechtsbündig zusammenhängenden Ziffern behalten (max. 3)
    const out = [];
    for (let i = digitsG.length - 1; i >= 0 && out.length < 3; i--) {
      const gr = digitsG[i];
      if (out.length && out[0].u0 - gr.u1 > 0.6 * H) break;
      out.unshift(gr);
    }
    const yt = band.y0 - 0.03 * H, yh = band.y1 - band.y0 + 0.06 * H;
    const digits = out.map(gr => {
      const bw = gr.u1 - gr.u0 + 1;
      if (bw < 0.3 * H) return { d: 1, score: 1 };
      const fill = ZONES.map(([a0, a1, b0, b1]) => {
        let tot = 0, dark = 0;
        for (let y = Math.round(yt + b0 * yh); y < Math.round(yt + b1 * yh); y++) {
          for (let u = Math.round(gr.u0 + a0 * bw); u < Math.round(gr.u0 + a1 * bw); u++) {
            const x = X(u, y); if (x < 0 || x >= W || y < 0 || y >= Hh) continue;
            tot++; if (raw[y * W + x]) dark++;
          }
        }
        return tot ? dark / tot : 0;
      });
      const bits = fill.map(f => f > 0.2 ? 1 : 0);
      let bestD = null, bestS = -1;
      for (const [d, p] of Object.entries(PATTERNS)) {
        if (d === '1') continue;
        let s = 0; for (let k = 0; k < 7; k++) s += p[k] === bits[k] ? 1 : 0;
        if (s > bestS) { bestS = s; bestD = +d; }
      }
      return { d: bestD, score: bestS / 7, fill: fill.map(f => +f.toFixed(2)) };
    });
    const value = digits.length ? +digits.map(d => d.d).join('') : null;
    return { value, digits, H, slant: +slant.toFixed(2), y0: band.y0, y1: band.y1, x0: band.x0, x1: band.x1 };
  }

  function pickValues(rows) {
    const big = rows.filter(r => r.value != null && r.digits.length >= 2).sort((a, b) => b.H - a.H);
    let sys = null, dia = null, pul = null;
    outer: for (const A of big) for (const B of big) {
      if (A === B || Math.abs(A.H - B.H) > 0.2 * A.H) continue;
      if (B.y0 < A.y1 - 0.1 * A.H || B.y0 - A.y1 > 0.8 * A.H) continue;
      if (Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) < -0.2 * A.H) continue;
      sys = A; dia = B; break outer;
    }
    if (sys) {
      const c = big.filter(r => r !== sys && r !== dia && r.y0 > dia.y0 + 0.5 * dia.H && r.H < 0.8 * dia.H && r.H > 0.25 * dia.H && r.y0 - dia.y1 < 1.2 * dia.H);
      c.sort((a, b) => b.H - a.H); pul = c[0] || null;
    }
    return { sys, dia, pul };
  }

  function recognize(data, w, h) {
    const g = toGray(data, w, h);
    let best = null;
    for (const factor of [0.82, 0.75, 0.88, 0.68, 0.92]) {
      const raw = threshold(g, w, h, factor);
      const comps = components(raw, w, h);
      // lange, dünne Rahmenlinien u. große Flächen entfernen
      for (const c of comps) {
        const fill = c.n / (c.w * c.h);
        if ((c.w > 0.45 * w || c.h > 0.45 * h) && fill < 0.35) for (const k of c.px) raw[k] = 0;
      }
      const bands = findBands(comps, w, h);
      const rows = bands.map(b => readBand(b, raw, w, h));
      const p = pickValues(rows);
      const v = { sys: p.sys ? p.sys.value : null, dia: p.dia ? p.dia.value : null, pul: p.pul ? p.pul.value : null };
      const conf = [p.sys, p.dia, p.pul].filter(Boolean).reduce((s, r) => s + r.digits.reduce((a, d) => a + d.score, 0) / r.digits.length, 0);
      const plaus = v.sys >= 60 && v.sys <= 260 && v.dia >= 30 && v.dia <= 160 && v.sys > v.dia && (v.pul == null || (v.pul >= 30 && v.pul <= 220));
      const score = conf + (plaus ? 3 : 0) + (v.pul != null ? 0.5 : 0);
      if (!best || score > best.score) best = { ...v, ok: plaus, score: +score.toFixed(2), rows };
      if (plaus && v.pul != null && conf > 2.85) break;
    }
    return best;
  }

  // Bild (HTMLImageElement/Canvas) in mehreren Arbeitsgrößen erkennen
  function recognizeImage(img, crop) {
    const sw = crop ? crop.w : (img.naturalWidth || img.width), sh = crop ? crop.h : (img.naturalHeight || img.height);
    const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0;
    let best = null;
    for (const target of [800, 1200, 550]) {
      const scale = Math.min(target / Math.max(sw, sh), 3);
      const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      const r = recognize(ctx.getImageData(0, 0, w, h).data, w, h);
      if (!best || (r && r.score > best.score)) best = r;
      if (r && r.ok && r.pul != null) break;
    }
    return best;
  }

  const api = { recognize, recognizeImage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BPOCR = api;
})(typeof self !== 'undefined' ? self : this);
