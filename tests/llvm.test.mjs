import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { nextManifest } from "../scripts/update.mjs";
import { validateManifest, loadCatalog } from "../scripts/lib/catalog.mjs";

const catalog = await loadCatalog(
  fileURLToPath(new URL("../", import.meta.url)),
);
const read = async (version) => catalog.manifests.get("llvm@" + version);
test("LLVM recipe revision exposes lld-link without changing the verified payload or published version", async () => {
  const old = await read("23.1.4");
  const fixed = await read("23.1.4-piko.1");
  assert.equal(old.platforms["windows-x64"].bin["lld-link"], undefined);
  assert.equal(
    fixed.platforms["windows-x64"].bin["lld-link"],
    "bin/lld-link.exe",
  );
  const expected = structuredClone(old);
  expected.version = fixed.version;
  expected.platforms["windows-x64"].bin["lld-link"] = "bin/lld-link.exe";
  assert.deepEqual(fixed, expected);
  validateManifest(fixed, "llvm", fixed.version);
  const next = nextManifest(fixed, { version: "24.0.0" }, {});
  assert.equal(
    next.platforms["windows-x64"].bin["lld-link"],
    "bin/lld-link.exe",
  );
  assert.equal(next.platforms["windows-x64"].bin.clang, "bin/clang.exe");
});
