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
const version = catalog.index.packages.blender.latest;
const manifest = catalog.manifests.get("blender@" + version);
const platform = manifest.platforms["windows-x64"];

test("blender publishes the official portable Windows x64 ZIP without install hooks", () => {
  validateManifest(manifest, "blender", version);
  assert.equal(platform.format, "zip");
  assert.equal(platform.stripPrefix, "blender-" + version + "-windows-x64");
  assert.match(platform.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    platform.url,
    "https://download.blender.org/release/Blender" +
      version.split(".").slice(0, 2).join(".") +
      "/blender-" +
      version +
      "-windows-x64.zip",
  );
  assert.equal(new URL(platform.url).search, "");
  assert.deepEqual(platform.bin, { blender: "blender.exe" });
  // 405,839,452-byte archive / ~901 MiB expanded tree; explicit quotas
  // document the size class of this distribution.
  assert.equal(platform.maxBytes, 414396416);
  assert.equal(platform.maxExpandedBytes, 2147483648);
  for (const key of ["shell", "bootstrap", "admin", "desktop", "depends"])
    assert.equal(platform[key], undefined, key);
});

test("blender keeps its native state model: no persist and no env redirection", () => {
  // User preferences, startup files and installed addons live in
  // %APPDATA%\Blender Foundation\Blender\ and are written by the application
  // itself. Piko does not own or migrate that tree, and the portable build
  // needs no environment redirection to find its bundled Python.
  assert.equal(platform.persist, undefined);
  assert.equal(platform.env, undefined);
});

test("only blender is a command: the launcher and debug .cmd helpers stay payload files", () => {
  // blender-launcher.exe (update-aware launcher, semantics not verified here)
  // and the blender_debug_*.cmd / blender_system_info.cmd helpers ship in the
  // archive but are deliberately not exposed as commands; blender.exe itself
  // is a CONSOLE-subsystem binary, so `blender --version` prints under a shim
  // with no wrapper needed.
  assert.deepEqual(Object.keys(platform.bin), ["blender"]);
});

test("blender discovery picks the newest x64 portable ZIP in the official release listing", async () => {
  const rule = rules.packages.blender;
  assert.equal(rule.provider, "regex");
  validateRules(catalog, rules);
  // blender.exe only stamps major.minor in its PE FileVersion (5.2), so the
  // package version is anchored to the official directory listing and its
  // published .sha256 file, not verifyPEVersion.
  assert.equal(rule.verifyPEVersion, undefined);
  const listing = [
    '<a href="blender-5.2.2-windows-x64.msi">blender-5.2.2-windows-x64.msi</a>',
    '<a href="blender-5.2.2-windows-x64.msix">blender-5.2.2-windows-x64.msix</a>',
    '<a href="blender-5.2.2-windows-x64.zip">blender-5.2.2-windows-x64.zip</a>',
    '<a href="blender-5.2.2.sha256">blender-5.2.2.sha256</a>',
    '<a href="blender-5.2.3-windows-arm64.zip">blender-5.2.3-windows-arm64.zip</a>',
    '<a href="blender-5.2.3-windows-x64.msi">blender-5.2.3-windows-x64.msi</a>',
    '<a href="blender-5.2.3-windows-x64.msix">blender-5.2.3-windows-x64.msix</a>',
    '<a href="blender-5.2.3-windows-x64.zip">blender-5.2.3-windows-x64.zip</a>',
    '<a href="blender-5.2.3.sha256">blender-5.2.3.sha256</a>',
  ].join("\n");
  const candidate = await discover(rule, manifest, {
    text: async (url) => {
      assert.equal(url, "https://download.blender.org/release/Blender5.2/");
      return listing;
    },
  });
  assert.equal(candidate.version, "5.2.3");
  assert.equal(
    candidate.url,
    "https://download.blender.org/release/Blender5.2/blender-5.2.3-windows-x64.zip",
  );
  // The regex provider carries no publisher digest; the updater independently
  // downloads, re-hashes and layout-checks the artifact before publishing.
  assert.equal(candidate.sha256, undefined);
});

test("blender version updates retarget the versioned strip prefix only", () => {
  const next = nextManifest(
    manifest,
    {
      version: "5.2.4",
      url: "https://download.blender.org/release/Blender5.2/blender-5.2.4-windows-x64.zip",
      sha256: "c".repeat(64),
      provenance: "https://download.blender.org/release/Blender5.2/",
    },
    rules.packages.blender,
  );
  const p = next.platforms["windows-x64"];
  assert.equal(next.version, "5.2.4");
  // Only the outer archive folder is versioned; blender.exe and the rest of
  // the portable tree keep their names across releases.
  assert.equal(p.stripPrefix, "blender-5.2.4-windows-x64");
  assert.deepEqual(p.bin, { blender: "blender.exe" });
  assert.equal(p.persist, undefined);
  validateManifest(next, "blender", "5.2.4");
});
