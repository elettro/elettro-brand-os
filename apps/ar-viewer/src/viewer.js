import { parsePath, resolveEntry, planeFor, sortActions, galleryIndex, withUtm, targetData } from "/viewer/logic.js";

const $ = (id) => document.getElementById(id);

// On-screen log for phones (no console): add ?debug=1 to the address. Errors always show.
const CALIBRATE = new URLSearchParams(location.search).has("calibrate");
const DEBUG = new URLSearchParams(location.search).has("debug");
function dbg(text, force) {
  if (!DEBUG && !force) return;
  let el = $("dbg");
  if (!el) { el = document.createElement("pre"); el.id = "dbg"; el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99;margin:0;padding:8px;font:11px ui-monospace,monospace;background:#000c;color:#9f9;white-space:pre-wrap;pointer-events:none;max-height:45vh;overflow:hidden"; document.body.append(el); }
  el.textContent += text + "\n";
}
window.addEventListener("error", (e) => dbg("error: " + e.message, true));
window.addEventListener("unhandledrejection", (e) => dbg("rejected: " + (e.reason && e.reason.message || e.reason), true));
const PIN_DELAY_MS = 1200; // after the cover leaves the frame, wait this long before the video moves to the screen

function say(title, msg, { note = "", brand } = {}) {
  $("title").textContent = title;
  $("msg").textContent = msg;
  $("note").textContent = note;
  if (brand !== undefined) $("brand").textContent = brand;
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const xrReady = new Promise((resolve) => (window.XR8 ? resolve() : window.addEventListener("xrloaded", () => resolve())));

async function main() {
  const { brand, slug } = parsePath(location.pathname);
  if (!brand) return say("Elettro AR", "Scan a AR code to start.");
  say(brand, "Loading…", { brand });

  let manifest;
  try { manifest = await getJson(`/${brand}/manifest.json`); }
  catch { return say(brand, "This AR code isn't active.", { brand }); }

  const entry = resolveEntry(manifest, slug);
  if (entry.kind === "inactive" || entry.kind === "unknown") return say(brand, "This AR code isn't active.", { brand });
  if (entry.kind === "redirect") return location.replace(entry.url);
  if (entry.kind === "experience") return showPlainVideo(brand, entry.action);

  const set = await getJson(entry.manifestUrl);
  await prepareScanner(brand, set);
}

function showPlainVideo(brand, action) {
  say(brand, "", { brand });
  const v = document.createElement("video");
  Object.assign(v, { src: action.url, controls: true, playsInline: true, className: "plain" });
  $("splash").append(v);
}

async function prepareScanner(brand, set) {
  await xrReady;
  const supported = XR8.XrDevice.isDeviceBrowserCompatible({ allowedDevices: XR8.XrConfig.device().MOBILE });
  if (!supported) {
    return say(brand, "Open this page on your phone to scan.", { brand, note: location.href });
  }
  XR8.XrController.configure({ imageTargetData: targetData(set.triggers) });
  say(brand, "Point your camera at the artwork.", { brand, note: "Your camera stays on your phone. Nothing is recorded." });
  const start = $("start");
  start.hidden = false;
  start.onclick = () => {
    dbg("start tapped");
    start.hidden = true; $("splash").hidden = true;
    try { startScene(set); dbg("scene added"); } catch (err) { dbg("startScene failed: " + err.message, true); }
  };
}

function startScene(set) {
  const byName = new Map(set.triggers.map((t) => [t.target.name, t]));
  const roots = new Map(); // trigger id -> entity that carries the placement nudge
  const experiences = new Map(); // trigger id -> built experience, created on first find so unseen covers cost no bandwidth

  const scene = document.createElement("a-scene");
  scene.setAttribute("xrextras-gesture-detector", "");
  scene.setAttribute("xrextras-loading", "");
  scene.setAttribute("xrextras-runtime-error", "");
  scene.setAttribute("renderer", "colorManagement: true");
  scene.setAttribute("xrweb", "disableWorldTracking: true");
  scene.innerHTML = `<a-camera position="0 4 10"></a-camera>
    <a-entity light="type: ambient; intensity: 0.85; color: #ffffff"></a-entity>
    <a-entity light="type: directional; intensity: 1.2; color: #ffe9c4" position="1 2 3"></a-entity>`;
  for (const t of set.triggers) {
    const holder = document.createElement("xrextras-named-image-target");
    holder.setAttribute("name", t.target.name);
    const root = document.createElement("a-entity");
    holder.append(root);
    scene.append(holder);
    roots.set(t.id, root);
  }
  for (const ev of ["loaded", "realityready", "camerastatuschange", "xrerror"]) scene.addEventListener(ev, (e) => dbg(ev + " " + JSON.stringify(e.detail || {}).slice(0, 120)));
  $("stage").append(scene);

  // One experience at a time. While the cover is in view it sits on the cover (ar). When the cover leaves the frame the
  // same video or gallery carries on as a card on the screen (pinned), so the viewer can lower the phone. Only the X ends it.
  let active = null; // the experience that is up
  let dismissed = null; // target name the viewer just closed; ignored until it leaves the frame
  let pinTimer = null;

  const ICON_ON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  const ICON_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6m0-6-5 6"/></svg>';

  // ?calibrate=1: arrows nudge the overlay on the cover you are pointing at; the numbers are what gets saved as that trigger's placement
  const nudges = new Map(set.triggers.map((t) => [t.id, { ...(t.placement || { x: 0, y: 0, s: 1 }) }]));
  const apply = (trigger) => {
    const root = roots.get(trigger.id), n = nudges.get(trigger.id);
    root.object3D.position.set(n.x, n.y, 0);
    root.object3D.scale.set(n.s, n.s, 1);
    const out = $("nval");
    if (out && CALIBRATE) out.textContent = trigger.name + "  x " + n.x.toFixed(3) + "  y " + n.y.toFixed(3) + "  size " + n.s.toFixed(3);
  };
  if (CALIBRATE) {
    const pad = $("nudge"); pad.hidden = false;
    pad.onclick = (e) => {
      const b = e.target.closest("button"); if (!b || !active) return;
      const n = nudges.get(active.trigger.id); const k = b.dataset.k;
      n[k] = Math.round((n[k] + Number(b.dataset.d)) * 1000) / 1000;
      apply(active.trigger);
    };
  }

  const el = (tag, attrs = {}) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  // --- parts: each one knows how to start, show on the cover, pin to the screen, and stop ---
  function videoPart(trigger, action, root) {
    const video = Object.assign(document.createElement("video"), { id: `v-${trigger.id}`, src: action.url, loop: action.loop !== false, muted: true, playsInline: true, preload: "auto" });
    video.setAttribute("webkit-playsinline", ""); video.crossOrigin = "anonymous";
    document.body.append(video);
    if (DEBUG) for (const ev of ["loadeddata", "playing", "stalled", "error", "waiting"]) video.addEventListener(ev, () => dbg(trigger.id + " video " + ev + (ev === "error" && video.error ? " code " + video.error.code : "")));
    const plane = el("a-entity", { visible: "false" }); root.append(plane);
    const place = () => {
      const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1;
      const p = planeFor(action.fit || "crop", aspect, action.scale || 1);
      plane.setAttribute("geometry", `primitive: plane; width: ${p.width}; height: ${p.height}`);
      plane.setAttribute("material", `shader: flat; src: #${video.id}; repeat: ${p.repeat[0]} ${p.repeat[1]}; offset: ${p.offset[0]} ${p.offset[1]}`);
      plane.object3D.position.set(0, 0, p.z);
    };
    return {
      video,
      start(exp) {
        const go = () => {
          place();
          video.play().then(() => { if (exp.mode === "ar") plane.setAttribute("visible", "true"); }, (err) => {
            dbg("play refused: " + err.message);
            const snd = $("bar").querySelector("button");
            if (snd) { snd.textContent = "Tap to play"; snd.onclick = () => video.play().then(() => { plane.setAttribute("visible", "true"); renderBar(exp); }); }
          });
        };
        // Show the plane only once frames are really playing, so a slow or refused video never leaves a black box.
        if (video.readyState >= 1) go(); else video.addEventListener("loadedmetadata", go, { once: true });
      },
      pin() { plane.setAttribute("visible", "false"); video.classList.add("pinned"); },
      unpin() { video.classList.remove("pinned"); },
      stop() { video.pause(); video.classList.remove("pinned"); plane.setAttribute("visible", "false"); }
    };
  }

  function galleryPart(trigger, action, root) {
    const imgs = action.images.map((src, i) => {
      const im = Object.assign(new Image(), { id: `g-${trigger.id}-${i}`, src, crossOrigin: "anonymous" });
      im.className = "gal"; document.body.append(im); return im;
    });
    const plane = el("a-entity", { visible: "false", geometry: `primitive: plane; width: ${action.scale || 1}; height: ${action.scale || 1}` });
    plane.object3D.position.z = 0.01;
    root.append(plane);
    let t0 = 0, timer = null, shown = -1, pinned = false;
    const tick = () => {
      const i = galleryIndex(imgs.length, action.seconds || 3, (performance.now() - t0) / 1000);
      if (i === shown) return;
      shown = i;
      plane.setAttribute("material", `shader: flat; src: #${imgs[i].id}`);
      imgs.forEach((im, k) => im.classList.toggle("pinned", pinned && k === i));
    };
    return {
      start(exp) { t0 = performance.now(); shown = -1; clearInterval(timer); timer = setInterval(tick, 200); tick(); if (exp.mode === "ar") plane.setAttribute("visible", "true"); },
      pin() { pinned = true; shown = -1; plane.setAttribute("visible", "false"); tick(); },
      unpin() { pinned = false; shown = -1; imgs.forEach((im) => im.classList.remove("pinned")); plane.setAttribute("visible", "true"); tick(); },
      stop() { clearInterval(timer); pinned = false; imgs.forEach((im) => im.classList.remove("pinned")); plane.setAttribute("visible", "false"); }
    };
  }

  // A record built from shapes, floating just above the cover and turning slowly. (Uploaded 3D models come later.)
  function modelPart(trigger, action, root) {
    const k = action.scale || 1;
    const group = el("a-entity", { visible: "false", position: "0 0 0.3", rotation: "-14 0 0", scale: `${k} ${k} ${k}` });
    const face = el("a-entity", { rotation: "90 0 0" });
    const spin = el("a-entity");
    const part = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };
    spin.append(
      part('<a-cylinder radius="0.44" height="0.03" segments-radial="64" material="color: #0b0b0d; metalness: 0.6; roughness: 0.3"></a-cylinder>'),
      ...[0.2, 0.26, 0.32, 0.38].map((r) => part(`<a-ring radius-inner="${r}" radius-outer="${r + 0.006}" segments-theta="64" position="0 0.0165 0" rotation="-90 0 0" material="shader: flat; color: #26262c; side: double"></a-ring>`)),
      part('<a-cylinder radius="0.15" height="0.036" segments-radial="48" material="color: #c8322a; roughness: 0.5"></a-cylinder>'),
      part('<a-ring radius-inner="0.06" radius-outer="0.1" segments-theta="48" position="0 0.0195 0" rotation="-90 0 0" material="shader: flat; color: #ffd21f; side: double"></a-ring>'),
      part('<a-cylinder radius="0.014" height="0.045" material="shader: flat; color: #050507"></a-cylinder>')
    );
    face.append(spin); group.append(face); root.append(group);
    let raf = 0, last = 0;
    const loop = (now) => { spin.object3D.rotation.y += ((now - (last || now)) / 1000) * 1.1; last = now; raf = requestAnimationFrame(loop); };
    return {
      start() { group.setAttribute("visible", "true"); cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(loop); },
      pin() { group.setAttribute("visible", "false"); cancelAnimationFrame(raf); },
      unpin() { this.start(); },
      stop() { group.setAttribute("visible", "false"); cancelAnimationFrame(raf); }
    };
  }

  const build = (trigger) => {
    const s = sortActions(trigger.actions), root = roots.get(trigger.id);
    const exp = { trigger, s, mode: "ar", parts: [], video: null };
    if (s.video) { const p = videoPart(trigger, s.video, root); exp.parts.push(p); exp.video = p.video; }
    if (s.gallery) exp.parts.push(galleryPart(trigger, s.gallery, root));
    if (s.model) exp.parts.push(modelPart(trigger, s.model, root));
    return exp;
  };

  // --- screen UI: buttons, X, and the card sheet ---
  const renderBar = (exp) => {
    const bar = $("bar");
    bar.replaceChildren();
    for (const b of exp.s.links) {
      const a = document.createElement("a");
      a.className = "btn primary"; a.textContent = b.label; a.href = b.url; a.target = "_blank"; a.rel = "noopener";
      bar.append(a);
    }
    const video = exp.video;
    if (video) {
      const snd = document.createElement("button");
      snd.className = "btn ghost";
      const label = () => { snd.innerHTML = (video.muted ? ICON_OFF : ICON_ON) + "<span>" + (video.muted ? "Sound on" : "Mute") + "</span>"; };
      snd.onclick = () => { video.muted = !video.muted; if (video.paused) video.play().catch(() => {}); label(); };
      label();
      bar.append(snd);
    }
    bar.hidden = !bar.children.length || !!exp.s.card;
    $("close").hidden = false;
  };

  const renderSheet = (exp) => {
    const sheet = $("sheet");
    const card = exp.s.card;
    if (!card) { sheet.classList.remove("open"); return; }
    sheet.replaceChildren();
    const h = el("h2"); h.textContent = card.title; sheet.append(h);
    if (card.subtitle) { const p = el("p", { class: "sub" }); p.textContent = card.subtitle; sheet.append(p); }
    for (const it of card.items) {
      const a = el("a", { class: "item " + it.kind, href: withUtm(it.url), target: "_blank", rel: "noopener" });
      if (it.kind === "product") {
        const th = el("span", { class: "thumb" }); if (it.image) th.style.backgroundImage = `url(${it.image})`;
        const tx = el("span", { class: "txt" }); const nm = el("b"); nm.textContent = it.label; tx.append(nm);
        if (it.price) { const pr = el("small"); pr.textContent = it.price; tx.append(pr); }
        const go = el("span", { class: "go" }); go.textContent = it.cta || "Buy now";
        a.append(th, tx, go);
      } else {
        const tx = el("span", { class: "txt" }); const nm = el("b"); nm.textContent = it.label; tx.append(nm);
        const go = el("span", { class: "arrow" }); go.textContent = "→";
        a.append(tx, go);
      }
      sheet.append(a);
    }
    sheet.classList.add("open");
  };

  const stop = (exp, { keepUi = false } = {}) => {
    for (const p of exp.parts) p.stop();
    exp.mode = "ar";
    if (!keepUi) { $("bar").hidden = true; $("close").hidden = true; $("sheet").classList.remove("open"); }
  };
  $("close").onclick = () => {
    if (!active) return;
    clearTimeout(pinTimer);
    dismissed = active.trigger.target.name;
    stop(active); active = null;
  };

  scene.addEventListener("xrimagefound", (e) => {
    const trigger = byName.get(e.detail.name);
    if (!trigger || dismissed === trigger.target.name) return;
    clearTimeout(pinTimer);
    if (active && active.trigger !== trigger) stop(active, { keepUi: true });
    let exp = experiences.get(trigger.id);
    if (!exp) { exp = build(trigger); experiences.set(trigger.id, exp); }
    active = exp;
    if (exp.mode === "pinned") for (const p of exp.parts) p.unpin();
    exp.mode = "ar";
    apply(trigger);
    renderBar(exp);
    renderSheet(exp);
    for (const p of exp.parts) p.start(exp);
  });

  scene.addEventListener("xrimagelost", (e) => {
    if (dismissed === e.detail.name) dismissed = null;
    if (!active || active.trigger.target.name !== e.detail.name) return;
    clearTimeout(pinTimer);
    pinTimer = setTimeout(() => { if (!active) return; active.mode = "pinned"; for (const p of active.parts) p.pin(); }, PIN_DELAY_MS);
  });
}

main().catch((err) => { console.error(err); say("Something went wrong", "Please reload this page.", { note: String(err.message || err) }); });
