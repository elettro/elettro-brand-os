#!/usr/bin/env python3
"""Read-only: map original brand-root Dropbox file IDs to their /brands/ copies.

Enumerates /1---elettro-brand-os/{brand} (source) and
/1---elettro-brand-os/brands/{brand} (copy) through the Dropbox API, pages
fully, and pairs files by relative path + content_hash + size. Fails closed
(exit 1) on any missing, extra, or mismatched file. Writes a JSON map consumed
by the DB migration.

Usage: python build-dropbox-brand-id-map-20261017.py <secret.json> <out.json>
"""
import json, sys, urllib.request, urllib.parse

ROOT = "/1---elettro-brand-os"
BRANDS = ["stashbox", "elettro", "solarmeister", "neckermann-strom", "weightlossdavie", "therasbox"]
EXPECTED_FILES = {"stashbox": 251, "elettro": 25}


def token(secret):
    body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": secret["refresh_token"],
                                   "client_id": secret["app_key"], "client_secret": secret["app_secret"]}).encode()
    with urllib.request.urlopen("https://api.dropboxapi.com/oauth2/token", body, timeout=30) as r:
        return json.load(r)["access_token"]


def api(tok, endpoint, payload):
    req = urllib.request.Request("https://api.dropboxapi.com/2/files/" + endpoint, json.dumps(payload).encode(),
                                 {"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def walk(tok, path):
    res = api(tok, "list_folder", {"path": path, "recursive": True, "include_deleted": False})
    entries = res["entries"]
    while res["has_more"]:
        res = api(tok, "list_folder/continue", {"cursor": res["cursor"]})
        entries += res["entries"]
    return entries


def main(secret_path, out_path):
    tok = token(json.load(open(secret_path)))
    report, mapping, failures = {}, [], []
    for brand in BRANDS:
        src_root, dst_root = f"{ROOT}/{brand}", f"{ROOT}/brands/{brand}"
        trees = {}
        for side, root in (("source", src_root), ("copy", dst_root)):
            meta = api(tok, "get_metadata", {"path": root})
            files, folders = {}, 0
            for e in walk(tok, root):
                rel = e["path_lower"][len(root.lower()):]
                if e[".tag"] == "folder":
                    folders += rel != ""
                elif e[".tag"] == "file":
                    files[rel] = e
            trees[side] = {"rootId": meta["id"], "files": files, "folders": folders}
        src, dst = trees["source"]["files"], trees["copy"]["files"]
        matched = 0
        for rel in sorted(set(src) | set(dst)):
            s, d = src.get(rel), dst.get(rel)
            if not s or not d:
                failures.append({"brand": brand, "rel": rel, "problem": "missing in copy" if s else "extra in copy"})
            elif s["content_hash"] != d["content_hash"] or s["size"] != d["size"]:
                failures.append({"brand": brand, "rel": rel, "problem": "hash/size mismatch"})
            elif s["id"] == d["id"]:
                failures.append({"brand": brand, "rel": rel, "problem": "copy shares source id"})
            else:
                matched += 1
                mapping.append({"brand": brand, "oldId": s["id"], "newId": d["id"],
                                "oldPathLower": s["path_lower"], "newPathLower": d["path_lower"],
                                "newPathDisplay": d["path_display"], "size": d["size"],
                                "contentHash": d["content_hash"], "newRev": d["rev"]})
        exp = EXPECTED_FILES.get(brand, 0)
        if matched != exp or len(src) != exp:
            failures.append({"brand": brand, "problem": f"expected {exp} files, source {len(src)}, matched {matched}"})
        report[brand] = {"sourceRootId": trees["source"]["rootId"], "copyRootId": trees["copy"]["rootId"],
                         "sourceFiles": len(src), "copyFiles": len(dst), "matched": matched,
                         "sourceFolders": trees["source"]["folders"], "copyFolders": trees["copy"]["folders"],
                         "bytes": sum(f["size"] for f in src.values())}
    # Each new ID must be unique so no two assets can collapse onto one copy.
    if len({m["newId"] for m in mapping}) != len(mapping) or len({m["oldId"] for m in mapping}) != len(mapping):
        failures.append({"problem": "non-unique id in mapping"})
    json.dump({"generatedFor": "dropbox-brand-root-migration-20261017", "brands": report,
               "failures": failures, "mapping": mapping}, open(out_path, "w"), indent=1)
    print(json.dumps({"brands": report, "mapped": len(mapping), "failures": failures[:20]}, indent=1))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main(*sys.argv[1:3])
