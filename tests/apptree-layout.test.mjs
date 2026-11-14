import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  validateManifest,
  validateRules,
} from "../scripts/lib/catalog.mjs";
import { applicationFiles } from "../scripts/lib/layout.mjs";
import { resolveManifestDocument } from "../scripts/lib/manifest-template.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);
const version = catalog.index.packages.libreoffice.latest;
const document = catalog.documents.get(
  "packages/desktop/libreoffice/package.json",
);
const current = resolveManifestDocument(document, "libreoffice", version);

// A vendor file table that repeats a target path: only the entries under the
// application tree become outputs, so the repeat never reaches the installer.
const plan = (paths) => ({
  cabinets: [{ name: "app.cab", first: 1, last: paths.length, embedded: true }],
  files: paths.map((path, n) => ({
    id: "f" + n,
    path,
    size: 1,
    cabinet: "app.cab",
  })),
});

test("applicationFiles keeps the whole application tree and drops everything outside it", () => {
  const files = applicationFiles(
    plan([
      "LibreOffice/program/soffice.exe",
      "LibreOffice/share/extensions/dict-an/README_an_ES.txt",
      "LibreOffice/program/python-core-3.13.18/bin/python.exe",
      "System64/vcruntime140.dll",
      "System64/vcruntime140.dll",
      "Win/System64/msvcp140.dll",
    ]),
    "LibreOffice",
  );
  assert.deepEqual(Object.keys(files), [
    "program/soffice.exe",
    "share/extensions/dict-an/README_an_ES.txt",
    "program/python-core-3.13.18/bin/python.exe",
  ]);
  for (const [from, to] of Object.entries(files))
    assert.equal(from, to, "mapping must stay identity: " + from);
});

test("applicationFiles refuses a payload with no application tree", () => {
  assert.throws(
    () => applicationFiles(plan(["System64/vcruntime140.dll"]), "LibreOffice"),
    /Application tree is empty/,
  );
  assert.throws(
    () => applicationFiles(plan(["LibreOffice/program/soffice.exe"])),
    /requires an explicit stripPrefix/,
  );
});

test("libreoffice derives its payload per release instead of freezing one release's paths", () => {
  assert.equal(validateRules(catalog, rules).packages.libreoffice.layout, "apptree");
  const platform = current.platforms["windows-x64"];
  assert.equal(platform.format, "msi");
  assert.equal(platform.stripPrefix, "LibreOffice");

  // A release whose embedded runtime and bundled extensions moved on is still
  // publishable: the map comes from that release's own file table, so it has
  // no entry left over from the previous one to disagree with.
  const next = structuredClone(current);
  next.version = "99.0.0";
  const download = next.platforms["windows-x64"];
  download.url = platform.url.replace(version, "99.0.0");
  download.sha256 = "a".repeat(64);
  download.files = applicationFiles(
    plan([
      "LibreOffice/program/soffice.exe",
      "LibreOffice/program/python-core-9.9.9/bin/python.exe",
      "System64/vcruntime140.dll",
      "System64/vcruntime140.dll",
    ]),
    download.stripPrefix,
  );
  validateManifest(next, "libreoffice", "99.0.0");
  assert.ok(download.files["program/python-core-9.9.9/bin/python.exe"]);
  assert.equal(download.files["System64/vcruntime140.dll"], undefined);
});
