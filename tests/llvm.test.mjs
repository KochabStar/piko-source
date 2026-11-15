import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { nextManifest } from "../scripts/update.mjs";
import { validateManifest, loadCatalog } from "../scripts/lib/catalog.mjs";

const catalog = await loadCatalog(
  fileURLToPath(new URL("../", import.meta.url)),
);
const read = async (version) => catalog.manifests.get("llvm@" + version);
test("LLVM exposes lld-link; revisions are folded into the upstream version", async () => {
  const fixed = await read("23.1.4");
  assert.equal(
    fixed.platforms["windows-x64"].bin["lld-link"],
    "bin/lld-link.exe",
  );
  assert.equal(fixed.version, "23.1.4");
  assert.equal(await read("23.1.4-piko.1"), undefined);
  validateManifest(fixed, "llvm", fixed.version);
  const next = nextManifest(fixed, { version: "24.0.0" }, {});
  assert.equal(
    next.platforms["windows-x64"].bin["lld-link"],
    "bin/lld-link.exe",
  );
  assert.equal(next.platforms["windows-x64"].bin.clang, "bin/clang.exe");
});
