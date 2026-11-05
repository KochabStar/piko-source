import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateManifest, validateRules } from "../scripts/lib/catalog.mjs";
import { discover } from "../scripts/lib/providers.mjs";
import { nextManifest } from "../scripts/update.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);
const version = catalog.index.packages.bun.latest;
const manifest = catalog.manifests.get("bun@" + version);
const platform = manifest.platforms["windows-x64"];

test("bun publishes the official single-binary Windows x64 ZIP without install hooks", () => {
  validateManifest(manifest, "bun", version);
  assert.equal(platform.format, "zip");
  assert.equal(platform.stripPrefix, "bun-windows-x64");
  assert.match(platform.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    platform.url,
    "https://github.com/oven-sh/bun/releases/download/bun-v" +
      version +
      "/bun-windows-x64.zip",
  );
  assert.equal(new URL(platform.url).search, "");
  assert.deepEqual(platform.bin, { bun: "bun.exe" });
  for (const key of ["shell", "bootstrap", "admin", "desktop", "depends"])
    assert.equal(platform[key], undefined, key);
});

test("bun keeps its native state model: no persist and no env redirection", () => {
  // The Piko client protects BUN_* environment variables (the manager itself
  // runs on Bun), so a manifest cannot redirect BUN_INSTALL/BUN_INSTALL_CACHE_DIR
  // into the persist root the way uv does. Global installs and the package
  // cache stay in the user's native ~/.bun, which Piko does not own; existing
  // data is never migrated or overwritten.
  assert.equal(platform.persist, undefined);
  assert.equal(platform.env, undefined);
});

test("no bunx command: Piko shims launch the target path, so argv[0] cannot carry bunx semantics", () => {
  // bun.exe dispatches bunx via argv[0]. A piko shim spawns the real
  // bun.exe path, where the first argument is treated as a script and
  // unknown packages fail with "Script not found". Users run `bun x`.
  assert.equal(Object.keys(platform.bin).includes("bunx"), false);
  assert.deepEqual(Object.keys(platform.bin), ["bun"]);
});

test("bun discovery selects the standard Windows x64 asset with its GitHub digest", async () => {
  const rule = rules.packages.bun;
  assert.equal(rule.provider, "github-release");
  assert.equal(rule.repo, "oven-sh/bun");
  validateRules(catalog, rules);
  const checksum = "b".repeat(64);
  const asset = (name, extra = {}) => ({
    name,
    browser_download_url:
      "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/" + name,
    digest: "sha256:" + (extra.digest ?? checksum),
    size: 123,
    ...extra,
  });
  const candidate = await discover(rule, manifest, {
    json: async (url) => {
      assert.equal(
        url,
        "https://api.github.com/repos/oven-sh/bun/releases/latest",
      );
      return {
        tag_name: "bun-v1.4.5",
        draft: false,
        prerelease: false,
        assets: [
          asset("bun-darwin-aarch64.zip"),
          asset("bun-linux-x64.zip"),
          asset("bun-linux-x64-baseline.zip"),
          asset("bun-windows-x64-baseline.zip"),
          asset("bun-windows-x64-profile.zip"),
          asset("bun-windows-x64.zip", { size: 54731706 }),
          { name: "SHASUMS256.txt" },
        ],
      };
    },
  });
  assert.equal(candidate.version, "1.4.5");
  assert.equal(
    candidate.url,
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-windows-x64.zip",
  );
  assert.equal(candidate.sha256, checksum);
  assert.equal(candidate.assetBytes, 54731706);
  assert.equal(candidate.url.includes("baseline"), false);
});

test("bun version updates keep path-bearing fields and cache/env declarations untouched", () => {
  const next = nextManifest(
    manifest,
    {
      version: "1.4.5",
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-windows-x64.zip",
      sha256: "c".repeat(64),
      provenance: "https://github.com/oven-sh/bun/releases/tag/bun-v1.4.5",
    },
    rules.packages.bun,
  );
  const p = next.platforms["windows-x64"];
  assert.equal(next.version, "1.4.5");
  // The URL itself is assigned by the updater from the verified candidate;
  // nextManifest must keep every path-bearing field valid.
  assert.equal(p.stripPrefix, "bun-windows-x64");
  assert.deepEqual(p.bin, { bun: "bun.exe" });
  assert.equal(p.env, undefined);
  validateManifest(next, "bun", "1.4.5");
});
