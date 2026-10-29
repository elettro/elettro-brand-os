import test from "node:test";
import assert from "node:assert/strict";
import { publishRequest, publish, pdfFromImages } from "../services/linkedin-lambda/index.mjs";
import { PUBLISHING_FORMATS, formatOf, slidesOf, isPlannable } from "../services/dev-api-lambda/publishing-formats.mjs";

const ROOT = "/1---elettro-brand-os/brands/elettro/";
const PAGE = "urn:li:organization:123456";
const slide = (n) => ({ dropboxPath: ROOT + `s${n}.jpg` });
const doc = (over = {}) => ({
  id: "p1", placement: "document", caption: "Five ideas.", hashtags: [], channelId: PAGE, title: "Five ideas for your page",
  slides: [slide(1), slide(2), slide(3)], ...over
});
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });
// 1x1 images: a PNG and a JPEG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkKKKK8U/TD//Z", "base64");

test("a PDF document is a plannable LinkedIn format with an images-per-post range", () => {
  const f = formatOf("linkedin", "document");
  assert.equal(f.label, "PDF documents");
  assert.equal(isPlannable(f), true);
  assert.deepEqual(slidesOf("linkedin", "document"), { min: 3, max: 20, recommended: [5, 10] });
  assert.ok(PUBLISHING_FORMATS.filter((x) => x.destination === "linkedin").length >= 3);
});

test("a claimed document is checked before anything goes out", () => {
  const request = publishRequest(doc());
  assert.deepEqual([request.kind, request.channelId, request.title, request.slidePaths.length], ["document", PAGE, "Five ideas for your page", 3]);
  assert.throws(() => publishRequest(doc({ slides: [slide(1)] })), /document needs 2-20 images/);
  assert.throws(() => publishRequest(doc({ slides: [slide(1), { dropboxPath: ROOT + "x.gif" }] })), /\.jpg or \.png/);
  assert.throws(() => publishRequest(doc({ slides: [slide(1), { dropboxPath: "/other/x.jpg" }] })), /inside/);
  // A carousel still reads as a carousel.
  assert.equal(publishRequest(doc({ placement: "carousel" })).kind, "carousel");
});

test("images become one PDF page each, PNG and JPEG alike", async () => {
  const pdf = await pdfFromImages([PNG, JPG, PNG]);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const { PDFDocument } = await import("pdf-lib");
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 3);
});

test("a document post uploads the PDF, waits for it, and posts it with a title as the page", async () => {
  const calls = []; const puts = []; let polls = 0;
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/documents?action=initializeUpload")) return { status: 200, headers: headers({}), body: { value: { uploadUrl: "https://upload/doc", document: "urn:li:document:D1" } } };
    if (path.startsWith("/documents/")) return { status: 200, headers: headers({}), body: { status: ++polls < 2 ? "PROCESSING" : "AVAILABLE" } };
    if (path === "/posts") return { status: 201, headers: headers({ "x-restli-id": "urn:li:share:77" }), body: {} };
    throw new Error("unexpected " + path);
  };
  const out = await publish({ accessToken: "t" }, doc(), {
    call, link: async (p) => "https://dropbox/" + p, fetchBytes: async () => PNG, buildPdf: async (images) => { assert.equal(images.length, 3); return Buffer.from("%PDF-fake"); },
    putFile: async (url, init) => { puts.push([url, init.method, init.body.toString()]); return { ok: true, status: 200 }; },
    wait: async () => {}, pollMs: 1, limitMs: 100
  });
  assert.equal(out.postId, "urn:li:share:77");
  assert.deepEqual(puts, [["https://upload/doc", "PUT", "%PDF-fake"]]);
  assert.equal(calls[0].body.initializeUploadRequest.owner, PAGE);
  const post = calls.find((c) => c.path === "/posts").body;
  assert.equal(post.author, PAGE);
  assert.deepEqual(post.content, { media: { title: "Five ideas for your page", id: "urn:li:document:D1" } });
  assert.equal(polls, 2);
});

test("a document that LinkedIn cannot process, or that is too big, stops before posting", async () => {
  const base = { link: async (p) => p, fetchBytes: async () => PNG, putFile: async () => ({ ok: true }), wait: async () => {}, pollMs: 1, limitMs: 5 };
  const call = (status) => async (m, path) => {
    if (path.includes("initializeUpload")) return { status: 200, headers: headers({}), body: { value: { uploadUrl: "u", document: "urn:li:document:D" } } };
    if (path.startsWith("/documents/")) return { status: 200, headers: headers({}), body: { status } };
    throw new Error("must not post");
  };
  await assert.rejects(publish({ accessToken: "t" }, doc(), { ...base, call: call("PROCESSING_FAILED"), buildPdf: async () => Buffer.from("x") }), /could not process/);
  await assert.rejects(publish({ accessToken: "t" }, doc(), { ...base, call: call("PROCESSING"), buildPdf: async () => Buffer.from("x") }), /still processing/);
  await assert.rejects(publish({ accessToken: "t" }, doc(), { ...base, call: call("AVAILABLE"), buildPdf: async () => ({ length: 91 * 1048576 }) }), /fewer or smaller images/);
});
