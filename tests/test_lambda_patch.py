"""Offline safeguards for the live DEV Lambda patcher (no AWS credentials used)."""
import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "patch-live-dev-lambda-source-id.py"
spec = importlib.util.spec_from_file_location("elettro_lambda_patch", SCRIPT)
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)

ASSET_DETAIL = """export async function handler(event) {
  if (assetId) {
    const result = await client.query(
      'SELECT'
        a."id",
        a."sourceType",
        a."sourcePath",
        a."filename",
        b."slug" AS "brandSlug"
    );
    if (!result.rows[0]) return json(404, { ok: false });
  }
}"""


def package(detail=ASSET_DETAIL):
    with io.BytesIO() as stream:
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("index.mjs", 'import {handler} from "./db-main.mjs";')
            z.writestr("db-main.mjs", detail)
            z.writestr("package.json", '{"name":"elettro-brand-os-dev-api"}')
            z.writestr("node_modules/something.js", "console.log('untouched');")
        return stream.getvalue()


class LiveLambdaPatchTests(unittest.TestCase):
    def test_adds_only_asset_detail_source_file_id(self):
        modified, diff = patch.patch_source(ASSET_DETAIL.encode())
        self.assertIn('        a."sourceFileId",', modified.decode())
        self.assertNotIn('a."sourceFileId",', ASSET_DETAIL)
        self.assertEqual(len([x for x in diff.splitlines() if x.startswith("+") and not x.startswith("+++")]), 1)

    def test_patch_refuses_double_patch(self):
        modified, _ = patch.patch_source(ASSET_DETAIL.encode())
        with self.assertRaisesRegex(RuntimeError, "already returns sourceFileId"):
            patch.patch_source(modified)

    def test_patch_refuses_ambiguous_or_unknown_layout(self):
        with self.assertRaisesRegex(RuntimeError, "recognized asset-detail"):
            patch.patch_source(b"no matching asset endpoint")
        altered = ASSET_DETAIL.replace('a."sourceType",', 'a."completelyDifferent",')
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            patch.patch_source(altered.encode())

    def test_zip_only_changes_sql_handler_without_touching_any_other_entry(self):
        original = package()
        updated, _ = patch.build_patch(original)
        with zipfile.ZipFile(io.BytesIO(original)) as before, zipfile.ZipFile(io.BytesIO(updated)) as after:
            self.assertEqual(before.namelist(), after.namelist())
            changed = [name for name in before.namelist() if before.read(name) != after.read(name)]
            self.assertEqual(changed, ["db-main.mjs"])
            self.assertEqual(after.read("index.mjs"), before.read("index.mjs"))
            self.assertEqual(after.read("node_modules/something.js"), before.read("node_modules/something.js"))
            self.assertIsNone(after.testzip())

    def test_rejects_unknown_live_zip(self):
        with io.BytesIO() as stream:
            with zipfile.ZipFile(stream, "w") as z:
                z.writestr("index.mjs", "handler()")
            with self.assertRaisesRegex(RuntimeError, "expected handler modules"):
                patch.build_patch(stream.getvalue())


if __name__ == "__main__":
    unittest.main()
