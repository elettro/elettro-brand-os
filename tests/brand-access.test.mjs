import test from "node:test";
import assert from "node:assert/strict";
import { accessFromClaims, canAccessBrand, decodeScope, encodeScope, visibleBrands } from "../apps/web/lib/brand-access.ts";

const OWNER = "dpalermo@elettro.com";
const BRANDS = ["solarmeister", "stashbox", "neckermann-strom"];

test("the owner email sees everything with no groups", () => {
  const access = accessFromClaims("DPalermo@elettro.com", undefined, OWNER, BRANDS);
  assert.equal(access.owner, true);
  assert.equal(encodeScope(access), "*");
});

test("the owner group sees everything", () => {
  assert.equal(accessFromClaims("a@b.de", ["owner"], OWNER, BRANDS).owner, true);
});

test("brand groups map to brand ids, including hyphenated ones", () => {
  const access = accessFromClaims("fs@neckermann-strom.de", ["brand-solarmeister", "brand-neckermann-strom"], OWNER, BRANDS);
  assert.deepEqual(access, { owner: false, brands: ["solarmeister", "neckermann-strom"] });
  assert.equal(encodeScope(access), "solarmeister,neckermann-strom");
});

test("unknown brands, other groups and non-array claims grant nothing", () => {
  assert.deepEqual(accessFromClaims("a@b.de", ["brand-nope", "admins", 7], OWNER, BRANDS), { owner: false, brands: [] });
  assert.deepEqual(accessFromClaims("a@b.de", "brand-stashbox", OWNER, BRANDS), { owner: false, brands: [] });
});

test("a missing owner email never makes an empty email the owner", () => {
  assert.equal(accessFromClaims("", [], "", BRANDS).owner, false);
});

test("scope round-trips and an empty scope is rejected", () => {
  assert.deepEqual(decodeScope("*", "x@y.de", OWNER), { owner: true, brands: [] });
  assert.deepEqual(decodeScope("solarmeister,stashbox", "x@y.de", OWNER), { owner: false, brands: ["solarmeister", "stashbox"] });
  assert.equal(decodeScope("", "x@y.de", OWNER), null);
});

test("an old cookie with no scope works only for the owner email", () => {
  assert.deepEqual(decodeScope(undefined, OWNER, OWNER), { owner: true, brands: [] });
  assert.equal(decodeScope(undefined, "x@y.de", OWNER), null);
});

test("brand checks and the visible list follow the access", () => {
  const user = { owner: false, brands: ["solarmeister"] };
  assert.equal(canAccessBrand(user, "solarmeister"), true);
  assert.equal(canAccessBrand(user, "stashbox"), false);
  assert.equal(canAccessBrand(null, "stashbox"), false);
  assert.equal(canAccessBrand({ owner: true, brands: [] }, "stashbox"), true);
  assert.deepEqual(visibleBrands(user, BRANDS.map((id) => ({ id }))).map((b) => b.id), ["solarmeister"]);
});
