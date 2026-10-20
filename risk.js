'use strict';
/* =========================================================
   MD-Fitness · Herz-Kreislauf-Risiko  ·  © 2026 Maik Daßler
   SCORE2 (ESC 2021) – 10-Jahres-Risiko für tödliche und nicht tödliche
   Herz-Kreislauf-Ereignisse (Herzinfarkt, Schlaganfall), Alter 40–69,
   Deutschland = Region „moderates Risiko“.
   Quelle: SCORE2 working group & ESC Cardiovascular risk collaboration,
   Eur Heart J 2021;42:2439–54.
   ========================================================= */

const SC2 = {
  m: { age: 0.3742, smk: 0.6012, sbp: 0.2777, tc: 0.1458, hdl: -0.2698, smkA: -0.0755, sbpA: -0.0255, tcA: -0.0281, hdlA: 0.0426, s0: 0.9605, s1: -0.1565, s2: 0.8009 },
  w: { age: 0.4648, smk: 0.7744, sbp: 0.3131, tc: 0.1002, hdl: -0.2606, smkA: -0.1088, sbpA: -0.0277, tcA: -0.0226, hdlA: 0.0613, s0: 0.9776, s1: -0.3143, s2: 0.7701 }
};
const MGDL = 38.67; // Cholesterin mg/dL → mmol/L

function score2({ sex, age, smoker, sbp, tc, hdl }) {
  const c = SC2[sex === 'w' ? 'w' : 'm'];
  const a = (age - 60) / 5, s = smoker ? 1 : 0, b = (sbp - 120) / 20, t = tc - 6, h = (hdl - 1.3) / 0.5;
  const lp = c.age * a + c.smk * s + c.sbp * b + c.tc * t + c.hdl * h + c.smkA * s * a + c.sbpA * b * a + c.tcA * t * a + c.hdlA * h * a;
  const unc = 1 - Math.pow(c.s0, Math.exp(lp));
  return 1 - Math.exp(-Math.exp(c.s1 + c.s2 * Math.log(-Math.log(1 - unc))));
}
// ESC 2021: Einstufung bei gesunden Personen
function riskClass(pct, age) {
  const [lo, hi] = age < 50 ? [2.5, 7.5] : [5, 10];
  if (pct < lo) return { n: 'Niedrig bis moderat', c: 'var(--good)', lo, hi, k: 0 };
  if (pct < hi) return { n: 'Hoch', c: 'var(--serious)', lo, hi, k: 1 };
  return { n: 'Sehr hoch', c: 'var(--crit)', lo, hi, k: 2 };
}
const toMmol = v => v == null ? null : (S.settings.labUnit || 'mg') === 'mg' ? v / MGDL : v;
const fromMmol = v => (S.settings.labUnit || 'mg') === 'mg' ? v * MGDL : v;
const labUnitTxt = () => (S.settings.labUnit || 'mg') === 'mg' ? 'mg/dl' : 'mmol/l';
const sortLabs = () => (S.labs || []).slice().sort((a, b) => a.date < b.date ? -1 : 1);

// alle Eingangswerte aus der App zusammensuchen
function riskInputs(atDate) {
  const st = S.settings, d = atDate || new Date();
  const age = st.birthYear ? d.getFullYear() - st.birthYear : null;
  let win = sortBP().filter(m => { const t = pdate(m.ts); return t <= d && t > addDays(d, -30); }), span = 30;
  if (!win.length) { win = sortBP().filter(m => { const t = pdate(m.ts); return t <= d && t > addDays(d, -90); }); span = 90; }
  const sbp = win.length ? mean(win.map(m => m.sys)) : null;
  const labs = sortLabs(), lab = labs.filter(l => l.date <= dkey(d)).pop() || (atDate ? labs[0] : null);
  const missing = [];
  if (!st.sex) missing.push('Geschlecht');
  if (!st.birthYear) missing.push('Geburtsjahr');
  if (sbp == null) missing.push('Blutdruckmessungen');
  if (st.smoker == null) missing.push('Raucher ja/nein');
  if (st.diabetes == null) missing.push('Diabetes ja/nein');
  if (!lab) missing.push('Cholesterin (Gesamt + HDL)');
  return { sex: st.sex, age, sbp, nBP: win.length, span, smoker: !!st.smoker, diabetes: st.diabetes, tc: lab ? lab.tc : null, hdl: lab ? lab.hdl : null, lab, missing };
}
function riskNow() {
  const i = riskInputs();
  if (i.missing.length) return { i, status: 'missing' };
  if (i.diabetes) return { i, status: 'diabetes' };
  if (i.age < 40) return { i, status: 'young' };
  if (i.age > 69) return { i, status: 'old' };
  const pct = score2(i) * 100;
  return { i, status: 'ok', pct, cls: riskClass(pct, i.age) };
}
function riskStatusText(r) {
  return {
    diabetes: 'Bei Diabetes gilt ein eigenes Rechenmodell (SCORE2-Diabetes). Das Risiko ist dabei deutlich erhöht – bitte mit dem Arzt besprechen.',
    young: 'Das Rechenmodell gilt ab 40 Jahren. Unter 40 ist das 10-Jahres-Risiko meist gering – entscheidend ist, die Risikofaktoren unten im Blick zu behalten.',
    old: 'Ab 70 Jahren gilt ein eigenes Rechenmodell (SCORE2-OP), das hier nicht enthalten ist. Bitte mit dem Arzt besprechen.'
  }[r.status] || '';
}

/* ---------- Karte auf der Übersicht ---------- */
function renderRiskCard(box) {
  if (!box) return;
  const r = riskNow();
  let inner;
  if (r.status === 'ok') {
    inner = `<div class="row" style="align-items:flex-end;gap:12px"><div class="val" style="font-size:34px;font-weight:800;line-height:1">${f1(r.pct)} <small style="font-size:16px;font-weight:600;color:var(--ink2)">%</small></div><div style="padding-bottom:3px"><span class="badge"><i style="background:${r.cls.c}"></i>${r.cls.n}</span></div></div>
      <div class="small ink2" style="margin-top:6px">Wahrscheinlichkeit für Herzinfarkt oder Schlaganfall in den nächsten 10 Jahren</div>
      ${scaleBar([{ to: r.cls.lo, n: 'niedrig–moderat', c: 'var(--good)' }, { to: r.cls.hi, n: 'hoch', c: 'var(--serious)' }, { n: 'sehr hoch', c: 'var(--crit)' }], r.pct, 0, r.cls.hi * 2)}`;
  } else if (r.status === 'missing') {
    inner = `<div class="small ink2">Für die Berechnung fehlen noch: <b>${r.i.missing.join(', ')}</b>.</div><button class="btn pri block" style="margin-top:10px">Angaben ergänzen</button>`;
  } else inner = `<div class="small ink2">${riskStatusText(r)}</div>`;
  box.innerHTML = `<div class="card tile link" id="riskCard" style="padding:14px"><div class="row"><h3 class="grow" style="margin:0 0 8px">❤️ Herz-Kreislauf-Risiko</h3><span class="muted">›</span></div>${inner}</div>`;
  $('#riskCard').onclick = () => openRisk();
}

/* ---------- Detailansicht ---------- */
function openRisk() {
  openSheet('<div id="riskSheet"></div>', sh => drawRisk($('#riskSheet', sh)));
}
function drawRisk(el) {
  const st = S.settings, r = riskNow(), i = r.i, u = labUnitTxt();
  const yn = (id, v) => `<div class="seg" id="${id}"><button type="button" data-v="1">Ja</button><button type="button" data-v="0">Nein</button></div>`;
  let h = `<h2>Herz-Kreislauf-Risiko</h2>`;
  if (r.status === 'ok') {
    h += `<div class="card" style="margin-top:6px"><div class="row" style="align-items:flex-end;gap:12px"><div style="font-size:44px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums">${f1(r.pct)} %</div><span class="badge" style="margin-bottom:4px"><i style="background:${r.cls.c}"></i>${r.cls.n}</span></div>
      <div class="small ink2" style="margin-top:8px">Geschätzte Wahrscheinlichkeit, in den nächsten <b>10 Jahren</b> einen Herzinfarkt oder Schlaganfall zu erleiden (tödlich oder nicht tödlich). Von 100 Menschen mit deinen Werten wären etwa <b>${f0(r.pct)}</b> betroffen.</div>
      ${scaleBar([{ to: r.cls.lo, n: `unter ${f1(r.cls.lo)} %`, c: 'var(--good)' }, { to: r.cls.hi, n: `${f1(r.cls.lo)}–${f1(r.cls.hi)} %`, c: 'var(--serious)' }, { n: `ab ${f1(r.cls.hi)} %`, c: 'var(--crit)' }], r.pct, 0, r.cls.hi * 2)}
      <div class="small muted" style="margin-top:6px">Grenzen für dein Alter (${i.age} J.) laut ESC-Leitlinie 2021.</div></div>`;
    // Hebel
    const lev = [];
    if (i.smoker) lev.push(['Rauchstopp', score2({ ...i, smoker: false }) * 100]);
    if (i.sbp > 125) lev.push(['Blutdruck auf 120 mmHg', score2({ ...i, sbp: 120 }) * 100]);
    if (i.tc - i.hdl > 3) lev.push([`Gesamtcholesterin −${(st.labUnit || 'mg') === 'mg' ? '40 mg/dl' : '1 mmol/l'}`, score2({ ...i, tc: i.tc - 1 }) * 100]);
    if (lev.length > 1) { const all = { ...i }; if (i.smoker) all.smoker = false; if (i.sbp > 125) all.sbp = 120; if (i.tc - i.hdl > 3) all.tc = i.tc - 1; lev.push(['Alles zusammen', score2(all) * 100]); }
    if (lev.length) h += `<div class="card"><h3>Was dein Risiko senken würde</h3>${lev.map(([n, p]) => `<div class="hbar" style="grid-template-columns:1fr 70px 64px"><div>${esc(n)}</div><div class="v">${f1(p)} %</div><div class="v" style="color:var(--goodtxt);font-weight:700">${sgn(p - r.pct)}</div></div>`).join('')}<div class="small muted" style="margin-top:6px">Berechnet mit demselben Modell, alle anderen Werte unverändert.</div></div>`;
    h += `<div class="card"><h3>Verlauf (Monatswerte)</h3><div class="chart" id="rkC"></div><div class="small muted" style="margin-top:4px">Aus dem Blutdruck-Monatsmittel und den jeweils gültigen Laborwerten.</div></div>`;
  } else if (r.status === 'missing') {
    h += `<div class="warnbox">Für die Berechnung fehlen noch: <b>${i.missing.join(', ')}</b>. Bitte unten ergänzen${i.missing.includes('Geschlecht') || i.missing.includes('Geburtsjahr') ? ' (Geschlecht/Geburtsjahr unter Einstellungen ⚙)' : ''}${i.missing.includes('Blutdruckmessungen') ? ', Blutdruck im Bereich „Blutdruck“ messen' : ''}.</div>`;
  } else h += `<div class="warnbox">${riskStatusText(r)}</div>`;

  // Eingangswerte
  const row = (n, v, src) => `<tr><td>${n}</td><td><b>${v}</b></td><td class="small muted" style="text-align:left">${src}</td></tr>`;
  h += `<div class="card"><h3>Berechnet aus deinen Daten</h3><table class="t">
    ${row('Alter', i.age != null ? i.age + ' J.' : '–', 'Geburtsjahr')}
    ${row('Geschlecht', i.sex === 'w' ? 'weiblich' : i.sex === 'm' ? 'männlich' : '–', 'Einstellungen')}
    ${row('Blutdruck SYS', i.sbp != null ? f0(i.sbp) + ' mmHg' : '–', i.nBP ? `Ø ${i.nBP} Messungen, ${i.span} Tage` : 'keine Messung')}
    ${row('Gesamtcholesterin', i.tc != null ? f1(fromMmol(i.tc), (st.labUnit || 'mg') === 'mg' ? 0 : 1) + ' ' + u : '–', i.lab ? 'Labor ' + fdate(i.lab.date) : 'fehlt')}
    ${row('HDL-Cholesterin', i.hdl != null ? f1(fromMmol(i.hdl), (st.labUnit || 'mg') === 'mg' ? 0 : 2) + ' ' + u : '–', i.lab ? 'Labor ' + fdate(i.lab.date) : 'fehlt')}
    ${row('Raucher', st.smoker == null ? '–' : st.smoker ? 'ja' : 'nein', 'Angabe unten')}
    </table>
    <label class="f">Rauchst du?</label>${yn('rkSm')}
    <label class="f">Diabetes (Zuckerkrankheit)?</label>${yn('rkDi')}
    <label class="f">Herzinfarkt/Schlaganfall bei Eltern oder Geschwistern vor dem 60. Lebensjahr?</label>${yn('rkFa')}
  </div>`;
  // Laborwerte
  const labs = sortLabs().reverse();
  h += `<div class="card"><h3>Cholesterin-Laborwerte</h3>
    <div class="small ink2">Stehen auf dem Laborbefund vom Hausarzt (z. B. Check-up). Einheit:</div>
    <div class="seg" id="rkU" style="margin:6px 0 4px"><button type="button" data-v="mg">mg/dl (üblich in DE)</button><button type="button" data-v="mmol">mmol/l</button></div>
    <div class="grid3"><div><label class="f">Datum</label><input type="date" class="in" id="rkD" value="${today()}"></div><div><label class="f">Gesamt</label><input class="in" id="rkT" inputmode="decimal" placeholder="${(st.labUnit || 'mg') === 'mg' ? 'z. B. 210' : 'z. B. 5,4'}"></div><div><label class="f">HDL</label><input class="in" id="rkH" inputmode="decimal" placeholder="${(st.labUnit || 'mg') === 'mg' ? 'z. B. 50' : 'z. B. 1,3'}"></div></div>
    <button class="btn pri block" id="rkAdd" style="margin-top:10px">Laborwert speichern</button>
    ${labs.length ? `<table class="t" style="margin-top:10px"><tr><th>Datum</th><th>Gesamt</th><th>HDL</th><th></th></tr>${labs.map(l => `<tr><td>${fdate(l.date)}</td><td>${f1(fromMmol(l.tc), (st.labUnit || 'mg') === 'mg' ? 0 : 1)}</td><td>${f1(fromMmol(l.hdl), (st.labUnit || 'mg') === 'mg' ? 0 : 2)}</td><td><button class="btn sm ghost" data-dl="${l.id}" aria-label="löschen">×</button></td></tr>`).join('')}</table>` : ''}
  </div>`;
  // weitere Faktoren aus der App
  const extra = [];
  const lwa = sortBody().filter(b => b.waist != null).pop();
  if (lwa && st.height) { const w = lwa.waist / st.height; extra.push([w >= 0.5 ? '⚠️' : '✅', `Bauchumfang : Größe ${f1(w, 2)}`, w >= 0.5 ? 'Bauchfett erhöht – steigert das Risiko zusätzlich' : 'im gesunden Bereich']); }
  const m4 = addDays(new Date(), -28);
  const mins = (S.workouts.filter(w => pdate(w.date) >= m4).reduce((s, w) => s + (w.dur || 0), 0) + (S.activities || []).filter(a => pdate(a.start) >= m4).reduce((s, a) => s + (a.dur || 0) / 60, 0)) / 4;
  extra.push([mins >= 150 ? '✅' : '⚠️', `Bewegung Ø ${f0(mins)} min/Woche`, mins >= 150 ? 'Empfehlung (150 min) erreicht' : 'Empfohlen sind mind. 150 min pro Woche']);
  const lf = sortBody().filter(b => b.fat != null).pop();
  if (lf && st.sex) { const sg = segOf(fatSegs(st.sex), lf.fat); extra.push([sg.n.includes('Hoch') ? '⚠️' : '✅', `Körperfett ${f1(lf.fat)} %`, sg.n.replace(/­/g, '')]); }
  if (st.famHist) extra.push(['⚠️', 'Familiäre Vorbelastung', 'erhöht das Risiko zusätzlich – im Modell nicht enthalten']);
  h += `<div class="card"><h3>Weitere Faktoren aus deinen Daten</h3><div class="small muted" style="margin-bottom:6px">Fließen nicht in die Prozentzahl ein, beeinflussen das Risiko aber laut Leitlinie.</div>${extra.map(([ic, n, t]) => `<div class="row" style="padding:7px 0;border-top:1px solid var(--line);align-items:flex-start"><span>${ic}</span><div><div style="font-weight:600">${esc(n)}</div><div class="small ink2">${esc(t)}</div></div></div>`).join('')}</div>`;
  h += det('Wie wird das berechnet?', `<div class="small ink2">Die App nutzt <b>SCORE2</b>, das Rechenmodell der Europäischen Gesellschaft für Kardiologie (ESC-Leitlinie 2021), mit den Werten für Deutschland (Region „moderates Risiko“). Es schätzt das 10-Jahres-Risiko für Herzinfarkt und Schlaganfall aus Alter, Geschlecht, Rauchen, systolischem Blutdruck, Gesamt- und HDL-Cholesterin.<br><br><b>Grenzen:</b> gilt für 40–69 Jahre und Menschen ohne bekannte Herz-Kreislauf-Erkrankung und ohne Diabetes. Die App verwendet deine Heim-Blutdruckwerte (Ø der letzten 30 Tage) statt eines Praxiswertes. Das Ergebnis ist eine statistische Schätzung und ersetzt keine ärztliche Untersuchung – bei „hoch“ oder „sehr hoch“ bitte mit dem Hausarzt besprechen.<br><br>Quelle: SCORE2 working group and ESC Cardiovascular risk collaboration, Eur Heart J 2021;42:2439–2454.</div>`);
  h += `<div class="foot"><button class="btn pri" id="rkClose">Schließen</button></div>`;
  el.innerHTML = h;

  const bindYN = (id, key) => { const sg = $('#' + id, el), set = v => { st[key] = v === '1'; seg(sg, v, set); save(); drawRisk(el); }; seg(sg, st[key] == null ? '' : st[key] ? '1' : '0', set); };
  bindYN('rkSm', 'smoker'); bindYN('rkDi', 'diabetes'); bindYN('rkFa', 'famHist');
  const su = $('#rkU', el), setU = v => { st.labUnit = v; seg(su, v, setU); save(); drawRisk(el); }; seg(su, st.labUnit || 'mg', setU);
  $('#rkAdd', el).onclick = () => {
    const t = num($('#rkT', el).value), hd = num($('#rkH', el).value), dt = $('#rkD', el).value || today();
    if (!t || !hd) { toast('Bitte Gesamt- und HDL-Cholesterin eintragen'); return; }
    const tc = toMmol(t), hdl = toMmol(hd);
    if (tc < 2 || tc > 15 || hdl < 0.3 || hdl > 4 || hdl >= tc) { toast(`Werte unplausibel – Einheit ${labUnitTxt()} richtig gewählt?`); return; }
    S.labs = (S.labs || []).filter(l => l.date !== dt).concat({ id: uid(), date: dt, tc: +tc.toFixed(3), hdl: +hdl.toFixed(3) }); save();
    toast('Laborwert gespeichert'); drawRisk(el);
  };
  $$('[data-dl]', el).forEach(b => b.onclick = () => { if (confirm('Laborwert löschen?')) { S.labs = S.labs.filter(l => l.id !== b.dataset.dl); save(); drawRisk(el); } });
  $('#rkClose', el).onclick = () => { closeSheet(); render(); };
  // Verlauf
  if (r.status === 'ok' && $('#rkC', el)) {
    const g = {}; for (const m of S.bp) (g[m.ts.slice(0, 7)] = g[m.ts.slice(0, 7)] || []).push(m.sys);
    const pts = Object.keys(g).sort().map(k => {
      const d = new Date(+k.slice(0, 4), +k.slice(5) - 1 + 1, 0), ii = riskInputs(d);
      if (!ii.tc || ii.age < 40 || ii.age > 69 || !ii.sex) return null;
      const p = score2({ ...ii, sbp: mean(g[k]) }) * 100;
      return { t: new Date(+k.slice(0, 4), +k.slice(5) - 1, 15), v: p, lbl: `${MON[+k.slice(5) - 1]} ${k.slice(0, 4)} · SYS Ø ${f0(mean(g[k]))}` };
    }).filter(Boolean);
    if (pts.length < 2) $('#rkC', el).innerHTML = '<div class="empty">Der Verlauf erscheint, sobald Blutdruckwerte aus mindestens zwei Monaten vorliegen.</div>';
    else lineChart($('#rkC', el), { h: 180, dec: 1, label: 'Risikoverlauf', refs: [{ v: r.cls.lo, l: f1(r.cls.lo) + ' %', fit: 1 }, { v: r.cls.hi, l: f1(r.cls.hi) + ' %', fit: 1 }], series: [{ name: 'Risiko', color: 'var(--s8)', unit: '%', dec: 1, pts }] });
  }
}
