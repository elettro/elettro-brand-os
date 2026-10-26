import { parsePath, resolveEntry, planeFor, pickVideo, linkButtons, targetData } from "/viewer/logic.js";

const $ = (id) => document.getElementById(id);
const LOST_PAUSE_MS = 2000; // keep playing briefly after the cover leaves the frame so a wobble never flickers

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
  const supported = XR8.XrDevice.isDeviceBrowserSupported({ allowedDevices: XR8.XrConfig.device().MOBILE });
  if (!supported.supported) {
    return say(brand, "Open this page on your phone to scan.", { brand, note: location.href });
  }
  XR8.XrController.configure({ imageTargetData: targetData(set.triggers) });
  say(brand, "Point your camera at the artwork.", { brand, note: "Your camera stays on your phone. Nothing is recorded." });
  const start = $("start");
  start.hidden = false;
  start.onclick = () => { start.hidden = true; $("splash").hidden = true; startScene(set); };
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
  $("stage").append(scene);

  let current = null;
  let lostTimer = null;

  const showButtons = (trigger) => {
    const bar = $("bar");
    bar.replaceChildren();
    for (const b of linkButtons(trigger.actions)) {
      const a = document.createElement("a");
      a.textContent = b.label; a.href = b.url; a.target = "_blank"; a.rel = "noopener";
      bar.append(a);
    }
    bar.hidden = !bar.children.length;
  };

  const place = (trigger, plane, video) => {
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1;
    const a = trigger.actions.find((x) => x.type === "video") || {};
    const p = planeFor(a.fit || "crop", aspect, a.scale || 1);
    const n = trigger.placement || { x: 0, y: 0, s: 1 };
    plane.setAttribute("geometry", `primitive: plane; width: ${p.width}; height: ${p.height}`);
    plane.setAttribute("material", `shader: flat; src: #${video.id}; repeat: ${p.repeat[0]} ${p.repeat[1]}; offset: ${p.offset[0]} ${p.offset[1]}`);
    plane.object3D.position.set(n.x, n.y, p.z);
    plane.object3D.scale.set(n.s, n.s, 1);
    plane.setAttribute("visible", "true");
  };

  scene.addEventListener("xrimagefound", (e) => {
    const trigger = byName.get(e.detail.name);
    if (!trigger) return;
    clearTimeout(lostTimer);
    current = trigger;
    const action = pickVideo(trigger.actions);
    showButtons(trigger);
    if (!action) return;
    let video = videos.get(trigger.id);
    if (!video) {
      video = document.createElement("video");
      Object.assign(video, { id: `v-${trigger.id}`, src: action.url, loop: action.loop !== false, muted: true, playsInline: true, preload: "auto" });
      video.setAttribute("webkit-playsinline", "");
      video.crossOrigin = "anonymous";
      video.style.display = "none";
      document.body.append(video);
      videos.set(trigger.id, video);
    }
    const go = () => { place(trigger, planes.get(trigger.id), video); video.play().catch(() => {}); };
    if (video.readyState >= 1) go(); else video.addEventListener("loadedmetadata", go, { once: true });
    const sound = $("sound");
    sound.hidden = false;
    sound.textContent = video.muted ? "Tap for sound" : "Mute";
    sound.onclick = () => { video.muted = !video.muted; sound.textContent = video.muted ? "Tap for sound" : "Mute"; };
  });

  scene.addEventListener("xrimagelost", () => {
    const trigger = current;
    if (!trigger) return;
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => {
      const v = videos.get(trigger.id);
      if (v) v.pause();
      planes.get(trigger.id)?.setAttribute("visible", "false");
      $("sound").hidden = true;
      $("bar").hidden = true;
    }, LOST_PAUSE_MS);
  });
}

main().catch((err) => { console.error(err); say("Something went wrong", "Please reload this page.", { note: String(err.message || err) }); });
