# DEV only. Run in AWS CloudShell with Python 3 and your existing AWS session.
# Reads the latest parameter so concurrent ChatGPT setup is preserved.
# Existing tokens, hashes, brands and OAuth settings remain unchanged.
import json
import subprocess
import sys

KEY = "/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON"
REGION = "us-east-1"
TARGETS = {"claude_code", "claude_web"}
ALLOWED = {"assets:read", "assets:write", "assets:upload", "assets:register", "folders:read", "folders:write"}

def aws(*args):
    result = subprocess.run(
        ["aws", *args, "--region", REGION, "--output", "json"],
        capture_output=True, text=True
    )
    if result.returncode:
        raise RuntimeError("AWS operation failed. No credential contents will be printed.")
    return json.loads(result.stdout)

def fetch():
    return aws("ssm", "get-parameter", "--name", KEY, "--with-decryption")["Parameter"]

def update():
    original = fetch()
    config = json.loads(original["Value"])
    clients = config.get("clients")
    if not isinstance(clients, list):
        raise RuntimeError("Unexpected client configuration")
    targets = [c for c in clients if isinstance(c, dict) and c.get("id") in TARGETS]
    if len(targets) != 2 or {c["id"] for c in targets} != TARGETS:
        raise RuntimeError("Expected exactly one claude_code and one claude_web entry")
    changed = False
    for client in targets:
        permissions = client.get("permissions")
        if not isinstance(permissions, list) or not permissions or any(p not in ALLOWED for p in permissions):
            raise RuntimeError("Unexpected existing Claude permissions")
        if client.get("enabled") is False:
            raise RuntimeError("A Claude connection is disabled. Refusing to activate it.")
        for permission in ("assets:write", "folders:write", "assets:upload"):
            if permission not in permissions:
                permissions.append(permission)
                changed = True
    if not changed:
        print("Claude upload, metadata and folder permissions are already active.")
        return
    payload = json.dumps(config, separators=(",", ":"))
    if original.get("Tier", "Standard") == "Standard" and len(payload.encode()) > 4096:
        raise RuntimeError("Parameter size exceeds Standard limit")
    # SSM has no compare-and-swap API. This detects changes before writing.
    # Do not run this while another window is saving the same parameter.
    if fetch()["Version"] != original["Version"]:
        raise RuntimeError("Settings changed during preparation. Rerun after the other setup finishes.")
    result = aws("ssm", "put-parameter", "--name", KEY, "--type", "SecureString",
                 "--value", payload, "--overwrite")
    saved = fetch()
    if saved["Version"] != result["Version"] or json.loads(saved["Value"]) != config:
        raise RuntimeError("Post-update verification failed. Inspect AWS settings before proceeding.")
    print("Verified: both Claude connections now have file upload, metadata and folder write access.")
    print("Existing token hashes, brand grants and ChatGPT OAuth configuration were preserved.")
    print("Claude transfer tools require the new Amplify build. Existing credentials are unchanged.")

if __name__ == "__main__":
    try:
        update()
    except Exception as error:
        print("STOP: " + str(error), file=sys.stderr)
        sys.exit(1)
