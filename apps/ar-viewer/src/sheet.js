// Screens that sit on the camera view. Plain DOM, no engine, so a page can preview them without a phone.
const el = (tag, attrs = {}) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// A look-only form (nothing is sent): a toggle, a few fields and one big button.
export function renderForm(sheet, f) {
  sheet.replaceChildren();
  if (f.accent) sheet.style.setProperty("--accent", f.accent); else sheet.style.removeProperty("--accent");
  const h = el("h2"); h.textContent = f.title; sheet.append(h);
  if (f.subtitle) { const p = el("p", { class: "sub" }); p.textContent = f.subtitle; sheet.append(p); }
  if (f.toggle) {
    const seg = el("div", { class: "fseg", role: "group", "aria-label": f.toggle.label || "" });
    f.toggle.options.forEach((label, i) => {
      const b = el("button", { type: "button", "aria-pressed": String(i === 0) }); b.textContent = label;
      b.onclick = () => seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      seg.append(b);
    });
    sheet.append(seg);
  }
  for (const fld of f.fields) {
    const wrap = el("label", { class: "ffld" });
    const cap = el("span"); cap.textContent = fld.label;
    const row = el("span", { class: "frow" });
    const input = el("input", { type: "text", placeholder: fld.placeholder || "", autocomplete: "off" });
    if (fld.mode === "numeric") input.setAttribute("inputmode", "numeric");
    row.append(input);
    if (fld.suffix) { const s = el("em"); s.textContent = fld.suffix; row.append(s); }
    wrap.append(cap, row); sheet.append(wrap);
  }
  const cta = el("button", { type: "button", class: "fcta" }); cta.textContent = f.cta; sheet.append(cta); // does nothing on purpose
  if (f.note) { const n = el("p", { class: "fnote" }); n.textContent = f.note; sheet.append(n); }
  sheet.classList.add("open");
}

const nf = new Intl.NumberFormat("de-DE");
const euro = (n) => nf.format(Math.round(n)) + " €";
const heading = (sheet, o) => {
  sheet.replaceChildren();
  if (o.accent) sheet.style.setProperty("--accent", o.accent); else sheet.style.removeProperty("--accent");
  const h = el("h2"); h.textContent = o.title; sheet.append(h);
  if (o.subtitle) { const p = el("p", { class: "sub" }); p.textContent = o.subtitle; sheet.append(p); }
};
const noteLine = (sheet, text) => { if (text) { const n = el("p", { class: "fnote" }); n.textContent = text; sheet.append(n); } };

// A savings estimate that runs on the phone. `savings` is passed in (from logic.js) so this file needs no imports.
export function renderCalculator(sheet, c, savings) {
  heading(sheet, c);
  const cap = el("label", { class: "ffld" });
  const head = el("span", { class: "fhead" }); const l1 = el("span"); l1.textContent = "Dein Stromverbrauch pro Jahr"; const val = el("b"); head.append(l1, val);
  const range = el("input", { type: "range", min: String(c.kwh.min), max: String(c.kwh.max), step: String(c.kwh.step), value: String(c.kwh.value), class: "frange", "aria-label": "Stromverbrauch pro Jahr in kWh" });
  cap.append(head, range); sheet.append(cap);
  const seg = el("div", { class: "fseg", role: "group", "aria-label": "System" });
  let pick = 0;
  c.systems.forEach((s, i) => {
    const b = el("button", { type: "button", "aria-pressed": String(i === 0) });
    b.append(document.createTextNode(s.label)); if (s.sub) { const sm = el("small"); sm.textContent = s.sub; b.append(el("br"), sm); }
    b.onclick = () => { pick = i; seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); update(); };
    seg.append(b);
  });
  sheet.append(seg);
  const row = (label) => { const r = el("div", { class: "fres" }); const a = el("span"); a.textContent = label; const b = el("b"); r.append(a, b); sheet.append(r); return b; };
  const outSave = row("Ersparnis pro Jahr"), outPrice = row("Das System kostet"), outYears = row("Hat sich bezahlt nach");
  outSave.classList.add("fbig");
  const go = el("a", { class: "fcta", target: "_blank", rel: "noopener" }); go.textContent = c.cta; sheet.append(go);
  noteLine(sheet, c.note);
  function update() {
    const s = c.systems[pick], use = Number(range.value);
    const r = savings({ use, kwp: s.kwp, selfUse: s.selfUse, yieldPerKwp: c.yieldPerKwp, pricePerKwh: c.pricePerKwh, price: s.price });
    val.textContent = nf.format(use) + " kWh";
    outSave.textContent = "≈ " + euro(r.perYear); outPrice.textContent = euro(s.price);
    outYears.textContent = r.years ? "ca. " + Math.max(1, Math.round(r.years)) + " Jahren" : "–";
    if (s.url) { go.href = s.url; go.hidden = false; } else go.hidden = true;
  }
  range.addEventListener("input", update); update();
  sheet.classList.add("open");
}

// A scratch card: rub the grey layer away with a finger to reveal a prize and a code. Nothing is sent anywhere.
export function renderScratch(sheet, s) {
  heading(sheet, s);
  const card = el("div", { class: "fscratch" });
  const under = el("div", { class: "funder" }); const pz = el("b"); pz.textContent = s.prize; under.append(pz);
  if (s.code) { const cd = el("small"); cd.textContent = s.code; under.append(cd); }
  const cv = el("canvas", { width: "560", height: "200", "aria-label": "Rubbellos: mit dem Finger freirubbeln" });
  card.append(under, cv); sheet.append(card);
  const hint = el("p", { class: "fnote" }); hint.textContent = s.hint || "Mit dem Finger rubbeln."; sheet.append(hint);
  let go = null;
  if (s.cta) { go = el("a", { class: "fcta", href: s.cta.url, target: "_blank", rel: "noopener" }); go.textContent = s.cta.label; go.hidden = true; sheet.append(go); }
  noteLine(sheet, s.note);
  const g = cv.getContext("2d"), grad = g.createLinearGradient(0, 0, 560, 200);
  grad.addColorStop(0, "#9aa4b5"); grad.addColorStop(1, "#d3d8e2");
  g.fillStyle = grad; g.fillRect(0, 0, 560, 200);
  g.fillStyle = "#657089"; g.font = "700 40px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("RUBBELN", 280, 114);
  let down = false, done = false;
  const rub = (e) => {
    if (!down || done) return;
    const r = cv.getBoundingClientRect(), x = ((e.clientX - r.left) * 560) / r.width, y = ((e.clientY - r.top) * 200) / r.height;
    g.globalCompositeOperation = "destination-out"; g.beginPath(); g.arc(x, y, 28, 0, 7); g.fill();
    const d = g.getImageData(0, 0, 560, 200).data; let n = 0, total = 0;
    for (let i = 3; i < d.length; i += 64) { total++; if (d[i] === 0) n++; }
    if (n / total > 0.5) { done = true; cv.style.transition = "opacity .4s"; cv.style.opacity = "0"; cv.style.pointerEvents = "none"; if (go) go.hidden = false; hint.textContent = "Geschafft!"; }
  };
  cv.addEventListener("pointerdown", (e) => { down = true; try { cv.setPointerCapture(e.pointerId); } catch {} rub(e); });
  cv.addEventListener("pointermove", rub);
  ["pointerup", "pointercancel"].forEach((ev) => cv.addEventListener(ev, () => { down = false; }));
  sheet.classList.add("open");
}
