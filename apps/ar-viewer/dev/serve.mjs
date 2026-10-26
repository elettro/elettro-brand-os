// Local stand-in for ar.elettro.com: serves dist/ plus a fixture "bucket" with CloudFront's bare-path rewrite.
//   node dev/serve.mjs <cert.pem> <key.pem> [port]
// Phones only allow the camera over https, so a (self-signed) cert is required.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [path.join(here, "..", "dist"), path.join(here, "..", ".fixture")];
const [certFile, keyFile, port = "8443"] = process.argv.slice(2);
if (!certFile || !keyFile) { console.error("usage: node dev/serve.mjs <cert.pem> <key.pem> [port]"); process.exit(1); }
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".glb": "model/gltf-binary" };

https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (q, r) => {
  let u = decodeURIComponent(q.url.split("?")[0]);
  if (!u.includes(".")) u = "/viewer/index.html"; // same rule as the CloudFront function
  const f = roots.map((root) => path.join(root, u)).find((p) => roots.some((root) => p.startsWith(root)) && fs.existsSync(p) && fs.statSync(p).isFile());
  if (!f) { r.statusCode = 404; return r.end("not found"); }
  const size = fs.statSync(f).size;
  const h = { "content-type": types[path.extname(f)] || "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store" };
  const m = /bytes=(\d*)-(\d*)/.exec(q.headers.range || "");
  if (m) {
    const s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1;
    r.writeHead(206, { ...h, "content-range": `bytes ${s}-${e}/${size}`, "content-length": e - s + 1 });
    return fs.createReadStream(f, { start: s, end: e }).pipe(r);
  }
  r.writeHead(200, { ...h, "content-length": size });
  fs.createReadStream(f).pipe(r);
}).listen(+port, "0.0.0.0", () => console.log(`serving on port ${port}`));
