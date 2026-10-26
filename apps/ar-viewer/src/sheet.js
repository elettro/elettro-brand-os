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
