import test from "node:test";
import assert from "node:assert/strict";
import { relinkPost } from "../services/dev-api-lambda/product-links-backfill.mjs";

const handle = "model-bauhaus-style-trains-pint-glass-16oz-stashbox-train-designs-009";
const links = { merchStore: "https://stashbox.ai", site: "https://stashbox.com" };
const base = { destination: "linkedin", tags: ["merch", `product:${handle}`], links };

test("store root in the caption becomes the product page, sentence punctuation kept", () => {
  const r = relinkPost({ ...base, caption: "Female Model Bauhaus Style Pint Glass #9 · Now Spinning.\nNow in the Stashbox store. https://stashbox.ai", primaryLink: "https://stashbox.ai" });
  assert.match(r.caption, new RegExp(`store\. https://stashbox\.ai/products/${handle}$`));
  assert.equal(r.productUrl, `https://stashbox.ai/products/${handle}`);
  assert.ok(r.captionChanged && r.linkChanged);
  assert.equal(relinkPost({ ...base, caption: "Shop it: https://stashbox.ai.", primaryLink: null }).caption, `Shop it: https://stashbox.ai/products/${handle}.`);
});

test("already-specific links, other domains and unrelated paths are left alone", () => {
  assert.equal(relinkPost({ ...base, caption: `x https://stashbox.ai/products/${handle}`, primaryLink: `https://stashbox.ai/products/${handle}` }).skip, "already-specific-or-no-link");
  assert.equal(relinkPost({ ...base, caption: "x https://stashbox.ai/collections/merch", primaryLink: null }).skip, "already-specific-or-no-link");
  assert.equal(relinkPost({ ...base, caption: "x https://stashbox.aiwhatever.com/a", primaryLink: null }).skip, "already-specific-or-no-link");
});

test("a Pinterest post with no link in the text still gets its primaryLink moved", () => {
  const r = relinkPost({ ...base, destination: "pinterest", caption: "Pint glass keywords", primaryLink: "https://stashbox.ai" });
  assert.equal(r.captionChanged, false);
  assert.equal(r.linkChanged, true);
  assert.equal(r.caption, "Pint glass keywords");
});

test("no handle falls back (nothing changes); a Bluesky caption that would overflow 300 is skipped", () => {
  assert.equal(relinkPost({ ...base, tags: ["merch"], caption: "https://stashbox.ai", primaryLink: "https://stashbox.ai" }).skip, "no-product-handle");
  const long = "a".repeat(250) + " https://stashbox.ai";
  assert.equal(relinkPost({ ...base, destination: "bluesky", caption: long, primaryLink: "https://stashbox.ai" }).skip, "caption-too-long");
});

test("SolarMeister posts relink to the shop product", () => {
  const de = { site: "https://solarmeister-shop.de", merchStore: "https://solarmeister-shop.de" };
  const r = relinkPost({ destination: "facebook", caption: "Dein Balkonkraftwerk beginnt im SolarMeister Shop. https://solarmeister-shop.de", primaryLink: "https://solarmeister-shop.de",
    tags: ["product-link", "produkt-max-roof-1500-bifazial-biberschwanzdach"], links: de });
  assert.match(r.caption, /https:\/\/solarmeister-shop\.de\/products\/max-roof-1500-bifazial-biberschwanzdach$/);
});
