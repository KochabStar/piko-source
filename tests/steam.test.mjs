import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  validateManifest,
  validateRules,
} from "../scripts/lib/catalog.mjs";
import { discover } from "../scripts/lib/providers.mjs";
import { nextManifest } from "../scripts/update.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);
const version = catalog.index.packages.steam.latest;
const manifest = catalog.manifests.get("steam@" + version);
const platform = manifest.platforms["windows-x64"];

const HASH = "3e96965d109fc2d4cc14206b2fc4ec960a746ed3";
const SHA2 = "1369615c795b60de822876b4dc4042186cf58d0dc8f63ea1371167f667e16925";
const CDN = "https://cdn.cloudflare.steamstatic.com/client";

function bootstrapManifest({
  stamp = "1769731672",
  file = `steam_win32.zip.${HASH}`,
  sha2 = SHA2,
  rowHash = HASH,
  rowSha2 = SHA2,
  bootstrapper = "1",
  rowBootstrapper = "1",
} = {}) {
  return [
    '"win32"',
    "{",
    `\t"version"\t\t"${stamp}"`,
    '\t"bins_win32"',
    "\t{",
    `\t\t"file"\t\t"bins_win32.zip.${"a".repeat(40)}"`,
    `\t\t"sha2"\t\t"${"c".repeat(64)}"`,
    "\t}",
    '\t"steam_win32"',
    "\t{",
    '\t\t"steamrow"',
    "\t\t{",
    `\t\t\t"file"\t\t"steam_win32_steamrow.zip.${rowHash}"`,
    `\t\t\t"sha2"\t\t"${rowSha2}"`,
    `\t\t\t"IsBootstrapperPackage"\t\t"${rowBootstrapper}"`,
    "\t\t}",
    '\t\t"steamchina"',
    "\t\t{",
    `\t\t\t"file"\t\t"steam_win32_steamchina.zip.${"b".repeat(40)}"`,
    `\t\t\t"sha2"\t\t"${"d".repeat(64)}"`,
    '\t\t\t"IsBootstrapperPackage"\t\t"1"',
    "\t\t}",
    `\t\t"file"\t\t"${file}"`,
    '\t\t"size"\t\t"2307664"',
    `\t\t"sha2"\t\t"${sha2}"`,
    `\t\t"IsBootstrapperPackage"\t\t"${bootstrapper}"`,
    "\t}",
    "}",
    '"kvsignatures"',
    "{",
    `\t"win32"\t\t"${"e".repeat(128)}"`,
    "}",
  ].join("\n");
}

test("steam publishes the official CDN bootstrapper ZIP without install hooks", () => {
  validateManifest(manifest, "steam", version);
  assert.equal(platform.format, "zip");
  assert.equal(
    platform.url,
    CDN + "/steam_win32.zip." + HASH,
  );
  assert.equal(platform.sha256, SHA2);
  assert.deepEqual(platform.bin, { steam: "steam.exe" });
  for (const key of [
    "stripPrefix",
    "into",
    "nested",
    "files",
    "downloads",
    "shell",
    "bootstrap",
    "admin",
    "depends",
    "env",
    "configFiles",
    "configTemplates",
  ])
    assert.equal(platform[key], undefined, key);
});

test("steam persists only the user-owned Steam data directories", () => {
  // steamapps (game libraries), userdata and config stay preserved across
  // uninstall/reinstall; the bootstrapped client itself does not.
  assert.deepEqual(platform.persist, ["config", "steamapps", "userdata"]);
  assert.deepEqual(platform.desktop, {
    shortcuts: [{ name: "Steam", path: "steam.exe" }],
  });
});

test("steam discovery binds the international row bootstrapper with its signed manifest digest", async () => {
  const rule = rules.packages.steam;
  assert.equal(rule.provider, "steam");
  assert.equal(rule.url, CDN + "/steam_client_win32");
  validateRules(catalog, rules);
  const candidate = await discover(rule, null, {
    text: async (url) => {
      assert.equal(url, rule.url);
      return bootstrapManifest();
    },
  });
  assert.equal(candidate.version, "1769731672");
  assert.equal(candidate.url, CDN + "/steam_win32.zip." + HASH);
  assert.equal(candidate.sha256, SHA2);
  assert.equal(candidate.provenance, rule.url);
  assert.equal(candidate.versionFromPE, false);
});

test("steam discovery keeps the published version while the payload is unchanged", async () => {
  // The channel timestamp advances for any package update; a new version is
  // only reported when the bootstrapper zip content hash itself changes.
  const candidate = await discover(rules.packages.steam, manifest, {
    text: async () => bootstrapManifest(),
  });
  assert.equal(candidate.version, version);
  assert.equal(candidate.url, platform.url);
});

test("steam discovery rejects channels that diverge from the pinned row payload", async () => {
  const net = (overrides) => ({
    text: async () => bootstrapManifest(overrides),
  });
  await assert.rejects(
    discover(rules.packages.steam, null, net({ rowHash: "f".repeat(40) })),
    /pinned international row payload/,
  );
  await assert.rejects(
    discover(rules.packages.steam, null, net({ rowSha2: "0".repeat(64) })),
    /pinned international row payload/,
  );
  await assert.rejects(
    discover(rules.packages.steam, null, net({ bootstrapper: "0" })),
    /pinned international row payload/,
  );
  await assert.rejects(
    discover(rules.packages.steam, null, net({ rowBootstrapper: "0" })),
    /pinned international row payload/,
  );
  await assert.rejects(
    discover(rules.packages.steam, null, net({ stamp: "1234567890" })),
    /current timestamp/,
  );
  await assert.rejects(
    discover(rules.packages.steam, null, {
      text: async () => '"win32"\n{',
    }),
    /truncated/,
  );
});

test("steam version updates keep path-bearing fields and persist declarations untouched", () => {
  const next = nextManifest(
    manifest,
    {
      version: "1792000000",
      url: CDN + "/steam_win32.zip." + "9".repeat(40),
      sha256: "5".repeat(64),
      provenance: rules.packages.steam.url,
    },
    rules.packages.steam,
  );
  const p = next.platforms["windows-x64"];
  assert.equal(next.version, "1792000000");
  // The URL itself is assigned by the updater from the verified candidate;
  // nextManifest must keep every path-bearing field valid.
  assert.deepEqual(p.persist, ["config", "steamapps", "userdata"]);
  assert.deepEqual(p.bin, { steam: "steam.exe" });
  assert.deepEqual(p.desktop.shortcuts, [{ name: "Steam", path: "steam.exe" }]);
  validateManifest(next, "steam", "1792000000");
});
