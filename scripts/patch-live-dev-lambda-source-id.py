#!/usr/bin/env python3
"""Prepare a minimal patch to the RUNNING Elettro DEV Lambda ZIP.

This script never reads repository's stale Lambda ZIP as a deploy base.
By default it only downloads the live package, verifies the AWS code hash,
produces a one-line patch and keeps the original ZIP for rollback.

Deployment is an additional, explicit --apply --confirm APPLY_DEV_SOURCE_ID_FIX
operation. The Lambda code cannot be changed from the AI Gateway Lab.
"""
import argparse
import base64
import datetime
import difflib
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

FUNCTION = "elettro-brand-os-dev-api"
REGION = "us-east-1"
CONFIRM = "APPLY_DEV_SOURCE_ID_FIX"
TARGET = "db-main.mjs"
MAX_ZIP_BYTES = 100 * 1024 * 1024


def fail(message):
    raise RuntimeError(message)


def aws(*arguments):
    cmd = ["aws", "--region", REGION, *arguments, "--output", "json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode:
        fail("AWS command failed: " + " ".join(arguments[:3]) + "\n" +
             (proc.stderr or "").strip()[:900])
    return json.loads(proc.stdout)


def lambda_get():
    data = aws("lambda", "get-function", "--function-name", FUNCTION)
    config = data.get("Configuration", {})
    if config.get("FunctionName") != FUNCTION:
        fail("Unexpected Lambda function name; refusing to patch.")
    if config.get("PackageType") != "Zip":
        fail("The live Lambda is not a ZIP deployment.")
    if config.get("Handler") != "index.handler":
        fail("Unrecognized live Lambda handler. Manual inspection required.")
    if config.get("State") != "Active" or config.get("LastUpdateStatus") == "InProgress":
        fail("Lambda is not Active or is already being updated.")
    url = data.get("Code", {}).get("Location")
    if not url:
        fail("AWS did not return the live Lambda package location.")
    return config, url


def download_live_zip(url):
    # This is the short-lived signed URL AWS returns. Never print it.
    with urllib.request.urlopen(url, timeout=45) as response:
        raw = response.read(MAX_ZIP_BYTES + 1)
    if len(raw) > MAX_ZIP_BYTES:
        fail("Live package exceeds 100MB; refusing to patch.")
    if not zipfile.is_zipfile(io.BytesIO(raw)):
        fail("Live Lambda package is not a valid ZIP.")
    return raw


def sha256_base64(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


def patch_source(original):
    text = original.decode("utf-8")
    start = text.find("if (assetId) {")
    if start == -1:
        fail("Live Lambda does not have the recognized asset-detail handler.")
    end = text.find("if (!result.rows[0])", start)
    if end == -1 or end - start > 10000:
        fail("Could not safely isolate the live asset-detail SQL query.")
    detail = text[start:end]
    if 'a."sourceFileId"' in detail:
        fail("The live asset-detail query already returns sourceFileId. "
             "Check whether that database value is NULL before patching.")
    pattern = re.compile(
        r'(?m)^(?P<indent>[ \t]+)a\."sourceType",(?P<eol>\r?\n)'
        r'(?P=indent)a\."sourcePath",'
    )
    matches = list(pattern.finditer(detail))
    if len(matches) != 1:
        fail("Expected exactly one sourceType/sourcePath selector in asset details; "
             "found " + str(len(matches)) + ". Refusing to guess.")
    match = matches[0]
    insert = ('a."sourceType",' + match.group("eol") +
              match.group("indent") + 'a."sourceFileId",' + match.group("eol") +
              match.group("indent") + 'a."sourcePath",')
    patched_detail = detail[:match.start()] + match.group("indent") + insert + detail[match.end():]
    patched = text[:start] + patched_detail + text[end:]
    diff = list(difflib.unified_diff(text.splitlines(), patched.splitlines(),
                                    fromfile="LIVE/db-main.mjs", tofile="PATCHED/db-main.mjs",
                                    lineterm=""))
    expected = [line for line in diff if line.startswith("+") and not line.startswith("+++")]
    removed = [line for line in diff if line.startswith("-") and not line.startswith("---")]
    if len(expected) != 1 or expected[0][1:].strip() != 'a."sourceFileId",' or removed:
        fail("The proposed patch changed more than one SQL column; refusing.")
    return patched.encode("utf-8"), "\n".join(diff)


def build_patch(original_zip):
    original_stream = io.BytesIO(original_zip)
    result_stream = io.BytesIO()
    with zipfile.ZipFile(original_stream) as source:
        infos = source.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            fail("Live ZIP has duplicate entry names; refusing.")
        if TARGET not in names or "index.mjs" not in names:
            fail("Live ZIP does not contain the expected handler modules.")
        before = source.read(TARGET)
        after, diff = patch_source(before)
        with zipfile.ZipFile(result_stream, "w") as output:
            for info in infos:
                data = after if info.filename == TARGET else source.read(info.filename)
                output.writestr(info, data)
    patched_zip = result_stream.getvalue()
    with zipfile.ZipFile(io.BytesIO(original_zip)) as before_zip, \
         zipfile.ZipFile(io.BytesIO(patched_zip)) as after_zip:
        changed = [name for name in names if before_zip.read(name) != after_zip.read(name)]
        if changed != [TARGET]:
            fail("Live ZIP validation failed; unexpectedly modified: " + repr(changed))
        if after_zip.testzip():
            fail("Patched ZIP failed its integrity check.")
    return patched_zip, diff


def check_node_syntax(zip_bytes, temp_dir):
    if not shutil.which("node"):
        print("Node is not installed; syntax check skipped (SQL diff still validated).")
        return
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as bundle:
        for name in ["index.mjs", TARGET]:
            path = temp_dir / name
            path.write_bytes(bundle.read(name))
            proc = subprocess.run(["node", "--check", str(path)],
                                  capture_output=True, text=True)
            if proc.returncode:
                fail("Patched module failed node --check: " + name + "\n" +
                     proc.stderr.strip()[:1100])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", type=Path, default=Path("./elettro-dev-lambda-patch"))
    parser.add_argument("--apply", action="store_true",
                        help="Explicitly deploy patched ZIP to DEV Lambda (not the default).")
    parser.add_argument("--confirm", default="",
                        help="Required with --apply: " + CONFIRM)
    args = parser.parse_args()
    if args.apply and args.confirm != CONFIRM:
        fail("--apply requires --confirm " + CONFIRM)
    config, code_location = lambda_get()
    live_zip = download_live_zip(code_location)
    expected_hash = config.get("CodeSha256")
    if not expected_hash or sha256_base64(live_zip) != expected_hash:
        fail("Downloaded ZIP does not match AWS current CodeSha256. No deployment.")
    patched_zip, diff = build_patch(live_zip)

    outdir = args.outdir.resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    short_hash = hashlib.sha256(live_zip).hexdigest()[:12]
    backup = outdir / (FUNCTION + "-LIVE-BACKUP-" + stamp + "-" + short_hash + ".zip")
    patched = outdir / (FUNCTION + "-SOURCE-ID-PATCH-" + stamp + ".zip")
    if backup.exists() or patched.exists():
        fail("An output file already exists; retry with a different directory.")
    backup.write_bytes(live_zip)
    patched.write_bytes(patched_zip)
    check_node_syntax(patched_zip, outdir)
    print("FUNCTION:", FUNCTION, "| REGION:", REGION)
    print("ORIGINAL AWS CODE SHA256:", expected_hash)
    print("BACKUP:", backup)
    print("PATCHED ZIP:", patched)
    print("PATCH CONTENT (the only module edit):\n" + diff)
    if not args.apply:
        print("PREVIEW ONLY. No AWS function was changed.")
        print("After approving this one-line change, rerun with "
              "--apply --confirm " + CONFIRM)
        return

    # Optimistic concurrency check: do not deploy if another operator edited the function.
    fresh = aws("lambda", "get-function-configuration", "--function-name", FUNCTION)
    if (fresh.get("RevisionId") != config.get("RevisionId") or
            fresh.get("CodeSha256") != expected_hash or
            fresh.get("LastUpdateStatus") == "InProgress"):
        fail("The live Lambda changed during preparation; patch not deployed.")
    update = aws("lambda", "update-function-code", "--function-name", FUNCTION,
                 "--revision-id", config["RevisionId"],
                 "--zip-file", "fileb://" + str(patched), "--publish")
    subprocess.run(["aws", "--region", REGION, "lambda", "wait",
                    "function-updated", "--function-name", FUNCTION], check=True)
    applied = aws("lambda", "get-function-configuration", "--function-name", FUNCTION)
    if applied.get("CodeSha256") != sha256_base64(patched_zip):
        fail("Deployed AWS code hash did not match patched ZIP. Keep backup for rollback.")
    print("APPLIED TO DEV LAMBDA; new version:", update.get("Version", "unknown"))
    print("Re-run Step 5 in AI Gateway Lab. If the database sourceFileId is NULL, "
          "the verification will still require a separate data-link investigation.")
    print("Keep the original backup ZIP available for rollback.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, zipfile.BadZipFile) as error:
        print("STOPPED SAFELY:", str(error), file=sys.stderr)
        sys.exit(1)
