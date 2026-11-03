"""Zip services/scroll-relay-lambda (no dependencies: the Lambda runtime provides the AWS SDK). Usage: scroll-relay-zip.py <service dir> <out.zip>"""
import os
import sys
import zipfile

svc, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in ("index.mjs", "relay.mjs", "package.json"):
        z.write(os.path.join(svc, name), name)
print("zipped", out)
