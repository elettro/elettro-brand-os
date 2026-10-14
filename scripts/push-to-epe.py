"""Claude Code helper: actual local bytes -> Dropbox -> one EPE asset. No dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
import urllib.error

ENDPOINT = "https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp"

def token_from_config():
    token = os.environ.get("EPE_MCP_TOKEN")
    if token:
        return token.removeprefix("Bearer ")
    if os.name == "nt" and (Path(os.environ.get("LOCALAPPDATA", "")) / "ElettroMCP" / "claude_code.dpapi").is_file():
        # Read the existing Step 9 credential with the same Windows DPAPI identity.
        # Capture it in memory; never print it or write a plaintext token file.
        script = "$ErrorActionPreference='Stop'; $p=Join-Path $env:LOCALAPPDATA 'ElettroMCP/claude_code.dpapi'; " \
                 "$s=ConvertTo-SecureString ((Get-Content -Raw $p).Trim()); " \
                 "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); " \
                 "try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))} " \
                 "finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}"
        response = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                  capture_output=True, text=True, timeout=20)
        if response.returncode or not response.stdout.strip():
            raise RuntimeError("Could not read the existing protected Claude Code credential")
        return response.stdout.strip()
    candidates = [Path.cwd() / ".mcp.json", Path.home() / ".claude.json"]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        data = json.loads(candidate.read_text())
        configs = [data]
        configs.extend(data.get("projects", {}).values())
        for config in configs:
            for server in config.get("mcpServers", {}).values():
                if server.get("url", "").rstrip("/") != ENDPOINT:
                    continue
                headers = server.get("headers", {})
                value = next((v for k, v in headers.items() if k.lower() == "authorization"), "")
                value = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: os.environ.get(m[1], ""), value)
                if value.startswith("Bearer "):
                    return value[7:]
    raise RuntimeError("Existing Claude MCP token not found. Set EPE_MCP_TOKEN in this terminal; do not paste it into chat.")

def rpc(name, arguments, token):
    request = urllib.request.Request(ENDPOINT, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                         "params": {"name": name, "arguments": arguments}}).encode())
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("EPE request failed (HTTP %s); no credentials printed" % error.code) from None
    if "error" in result:
        raise RuntimeError(result["error"].get("message", "MCP request failed"))
    tool = result.get("result", {})
    structured = tool.get("structuredContent")
    if structured is None:
        raise RuntimeError("; ".join(c.get("text", "") for c in tool.get("content", [])))
    return structured

def content_hash(data):
    blocks = [hashlib.sha256(data[i:i + 4 * 1024 * 1024]).digest()
              for i in range(0, len(data), 4 * 1024 * 1024)]
    return hashlib.sha256(b"".join(blocks)).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--brand", required=True)
    parser.add_argument("--folder")
    parser.add_argument("--filename")
    parser.add_argument("--metadata", type=Path, help="JSON title/tags/topic/notes")
    parser.add_argument("--resume", type=Path, help="Retry completion from a saved receipt, without uploading")
    parser.add_argument("--confirmed", action="store_true", required=True)
    args = parser.parse_args()
    token = token_from_config()
    if args.resume:
        receipt = json.loads(args.resume.read_text())
    else:
        if not args.file or not args.folder:
            parser.error("--file and --folder are required for a new transfer")
        if args.file.stat().st_size > 20 * 1024 * 1024:
            parser.error("File exceeds 20 MiB pilot limit")
        data = args.file.read_bytes()
        receipt = rpc("elettro_prepare_file_transfer", {
            "brandSlug": args.brand, "folder": args.folder,
            "filename": args.filename or args.file.name, "size": len(data),
            "contentHash": content_hash(data),
            "metadata": json.loads(args.metadata.read_text()) if args.metadata else {},
            "confirmed": True}, token)
        if receipt.get("ok") is not True:
            raise RuntimeError(json.dumps(receipt))
        # Save the signed completion capability before transferring. It expires in 30 minutes.
        receipt_path = args.file.with_name(args.file.name + ".epe-transfer.json")
        safe_receipt = {k: v for k, v in receipt.items() if k != "uploadUrl"}
        with receipt_path.open("w", opener=lambda p, f: os.open(p, f, 0o600)) as target:
            json.dump(safe_receipt, target)
        print("Completion receipt: " + str(receipt_path))
        if receipt.get("uploadRequired"):
            upload = urllib.request.Request(receipt["uploadUrl"], method="POST", data=data,
                                             headers={"Content-Type": "application/octet-stream"})
            try:
                with urllib.request.urlopen(upload, timeout=180) as response:
                    json.load(response)
            except Exception:
                raise RuntimeError("Upload response unavailable. Retry --resume with the receipt first; do not upload again.") from None
    result = rpc("elettro_complete_file_transfer", {"brandSlug": args.brand,
                 "transferToken": receipt["transferToken"], "confirmed": True}, token)
    print(json.dumps(result, indent=2))
    if result.get("ok") is not True:
        raise SystemExit(2)

if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
