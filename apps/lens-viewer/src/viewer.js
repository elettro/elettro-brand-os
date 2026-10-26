import { parsePath, resolveEntry, planeFor, pickVideo, linkButtons, targetData } from "/viewer/logic.js";

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
  if (!brand) return say("Elettro Lens", "Scan a Lens code to start.");
  say(brand, "Loading…", { brand });

  let manifest;
  try { manifest = await getJson(`/${brand}/manifest.json`); }
  catch { return say(brand, "This Lens code isn't active.", { brand }); }

  const entry = resolveEntry(manifest, slug);
  if (entry.kind === "inactive" || entry.kind === "unknown") return say(brand, "This Lens code isn't active.", { brand });
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
  const videos = new Map(); // trigger id -> <video>, created on first find so unseen covers cost no bandwidth
  const planes = new Map(); // trigger id -> plane entity

  const scene = document.createElement("a-scene");
  scene.setAttribute("xrextras-gesture-detector", "");
  scene.setAttribute("xrextras-loading", "");
  scene.setAttribute("xrextras-runtime-error", "");
  scene.setAttribute("renderer", "colorManagement: true");
  scene.setAttribute("xrweb", "disableWorldTracking: true");
  scene.innerHTML = `<a-camera position="0 4 10"></a-camera>`;
  for (const t of set.triggers) {
    const holder = document.createElement("xrextras-named-image-target");
    holder.setAttribute("name", t.target.name);
    const plane = document.createElement("a-entity");
    plane.setAttribute("visible", "false");
    holder.append(plane);
    scene.append(holder);
    planes.set(t.id, plane);
  }
  for (const ev of ["loaded", "realityready", "camerastatuschange", "xrerror"]) scene.addEventListener(ev, (e) => dbg(ev + " " + JSON.stringify(e.detail || {}).slice(0, 120)));
  $("stage").append(scene);

  // One experience at a time. While the cover is in view it sits on the cover (ar). When the cover leaves the frame the
  // same video carries on as a card on the screen (pinned), so the viewer can lower the phone. Only the X ends it.
  let current = null; // the trigger whose experience is up
  let active = null;  // { trigger, video, plane, mode: "ar" | "pinned" }
  let dismissed = null; // target name the viewer just closed; ignored until it leaves the frame
  let pinTimer = null;

  const ICON_ON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  const ICON_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6m0-6-5 6"/></svg>';

  const renderBar = (trigger, video) => {
    const bar = $("bar");
    bar.replaceChildren();
    for (const b of linkButtons(trigger.actions)) {
      const a = document.createElement("a");
      a.className = "btn primary"; a.textContent = b.label; a.href = b.url; a.target = "_blank"; a.rel = "noopener";
      bar.append(a);
    }
    const snd = document.createElement("button");
    snd.className = "btn ghost";
    const label = () => { snd.innerHTML = (video.muted ? ICON_OFF : ICON_ON) + "<span>" + (video.muted ? "Sound on" : "Mute") + "</span>"; };
    snd.onclick = () => { video.muted = !video.muted; if (video.paused) video.play().catch(() => {}); label(); };
    label();
    bar.append(snd);
    bar.hidden = false;
    $("close").hidden = false;
  };

  const unpin = (x) => { x.video.classList.remove("pinned"); x.mode = "ar"; };
  const pin = () => {
    if (!active) return;
    active.plane.setAttribute("visible", "false");
    active.video.classList.add("pinned");
    active.mode = "pinned";
  };
  const stop = (x, { keepBar = false } = {}) => {
    x.video.pause(); unpin(x);
    x.plane.setAttribute("visible", "false");
    if (!keepBar) { $("bar").hidden = true; $("close").hidden = true; }
  };
  $("close").onclick = () => {
    if (!active) return;
    clearTimeout(pinTimer);
    dismissed = active.trigger.target.name;
    stop(active); active = null; current = null;
  };

  // ?calibrate=1: arrows nudge the overlay on the cover you are pointing at; the numbers are what gets saved as that trigger's placement
  const nudges = new Map(set.triggers.map((t) => [t.id, { ...(t.placement || { x: 0, y: 0, s: 1 }) }]));
  const apply = (trigger) => {
    const plane = planes.get(trigger.id), n = nudges.get(trigger.id);
    plane.object3D.position.set(n.x, n.y, plane.object3D.position.z);
    plane.object3D.scale.set(n.s, n.s, 1);
    const out = $("nval");
    if (out) out.textContent = trigger.name + "  x " + n.x.toFixed(3) + "  y " + n.y.toFixed(3) + "  size " + n.s.toFixed(3);
  };
  if (CALIBRATE) {
    const pad = $("nudge"); pad.hidden = false;
    pad.onclick = (e) => {
      const b = e.target.closest("button"); if (!b || !current) return;
      const n = nudges.get(current.id); const k = b.dataset.k;
      n[k] = Math.round((n[k] + Number(b.dataset.d)) * 1000) / 1000;
      apply(current);
    };
  }

  const place = (trigger, plane, video) => {
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1;
    const a = trigger.actions.find((x) => x.type === "video") || {};
    const p = planeFor(a.fit || "crop", aspect, a.scale || 1);
    const n = nudges.get(trigger.id);
    plane.setAttribute("geometry", `primitive: plane; width: ${p.width}; height: ${p.height}`);
    plane.setAttribute("material", `shader: flat; src: #${video.id}; repeat: ${p.repeat[0]} ${p.repeat[1]}; offset: ${p.offset[0]} ${p.offset[1]}`);
    plane.object3D.position.set(n.x, n.y, p.z);
    plane.object3D.scale.set(n.s, n.s, 1);
    if (CALIBRATE) apply(trigger);
  };

  scene.addEventListener("xrimagefound", (e) => {
    const trigger = byName.get(e.detail.name);
    if (!trigger || dismissed === trigger.target.name) return;
    clearTimeout(pinTimer);
    if (active && active.trigger !== trigger) { stop(active, { keepBar: true }); active = null; }
    current = trigger;
    const action = pickVideo(trigger.actions);
    if (!action) { renderBar(trigger, { muted: true, paused: false, play() { return Promise.resolve(); } }); return; }
    let video = videos.get(trigger.id);
    if (!video) {
      video = document.createElement("video");
      Object.assign(video, { id: `v-${trigger.id}`, src: action.url, loop: action.loop !== false, muted: true, playsInline: true, preload: "auto" });
      video.setAttribute("webkit-playsinline", "");
      video.crossOrigin = "anonymous";
      videos.set(trigger.id, video);
      document.body.append(video);
      if (DEBUG) for (const ev of ["loadeddata", "playing", "stalled", "error", "waiting"]) video.addEventListener(ev, () => dbg(trigger.id + " video " + ev + (ev === "error" && video.error ? " code " + video.error.code : "")));
    }
    const plane = planes.get(trigger.id);
    if (!active) active = { trigger, video, plane, mode: "ar" };
    else if (active.mode === "pinned") unpin(active);
    renderBar(trigger, video);
    // Show the plane only once frames are really playing, so a slow or refused video never leaves a black box.
    const go = () => {
      place(trigger, plane, video);
      video.play().then(() => { if (active && active.mode === "ar") plane.setAttribute("visible", "true"); }, (err) => {
        dbg("play refused: " + err.message);
        const snd = $("bar").querySelector("button");
        if (snd) { snd.textContent = "Tap to play"; snd.onclick = () => video.play().then(() => { plane.setAttribute("visible", "true"); renderBar(trigger, video); }); }
      });
    };
    if (video.readyState >= 1) go(); else video.addEventListener("loadedmetadata", go, { once: true });
  });

  scene.addEventListener("xrimagelost", (e) => {
    if (dismissed === e.detail.name) dismissed = null;
    if (!active || active.trigger.target.name !== e.detail.name) return;
    clearTimeout(pinTimer);
    pinTimer = setTimeout(pin, PIN_DELAY_MS);
  });
}

main().catch((err) => { console.error(err); say("Something went wrong", "Please reload this page.", { note: String(err.message || err) }); });
