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
const version = catalog.index.packages["epic-games-launcher"].latest;
const manifest = catalog.manifests.get("epic-games-launcher@" + version);
const platform = manifest.platforms["windows-x64"];
const CDN =
  "https://epicgames-download1.akamaized.net/Builds/UnrealEngineLauncher/Installers/Windows";

test("epic-games-launcher unpacks the official WiX MSI without install actions", () => {
  validateManifest(manifest, "epic-games-launcher", version);
  assert.equal(platform.format, "msi");
  assert.equal(platform.url, CDN + "/EpicInstaller-" + version + ".msi");
  assert.match(
    platform.sha256,
    /^[a-f0-9]{64}$/,
  );
  assert.deepEqual(platform.bin, {
    epic: "Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe",
  });
  assert.equal(platform.maxExpandedBytes, 1073741824);
  assert.deepEqual(platform.desktop, {
    shortcuts: [
      {
        name: "Epic Games Launcher",
        path: "Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe",
      },
    ],
  });
  for (const key of [
    "shell",
    "bootstrap",
    "admin",
    "depends",
    "env",
    "configFiles",
    "configTemplates",
    "persist",
  ])
    assert.equal(platform[key], undefined, key);
});

test("epic-games-launcher maps exactly the launcher payload, excluding runtime installers and system files", () => {
  const files = platform.files;
  assert.equal(Object.keys(files).length, 4450);
  for (const [from, to] of Object.entries(files))
    if (from !== to) assert.fail("mapping must stay identity: " + from);
  for (const excluded of [
    "Epic Games/DirectXRedist/DXSETUP.exe",
    "Epic Games/GameInputRedist/GameInputRedist.msi",
    "Epic/EpicGamesLauncher/Data/EMS/EpicGamesLauncher/Engine.ini",
    "Win/System/msvcr100.dll",
    "Win/System64/msvcr100.dll",
    "System/msvcr120.dll",
    "System64/msvcr120.dll",
  ])
    assert.equal(files[excluded], undefined, excluded);
  assert.ok(files["Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe"]);
});

test("epic-games-launcher discovery follows the official stable redirect to the versioned MSI", async () => {
  const rule = rules.packages["epic-games-launcher"];
  assert.equal(rule.provider, "redirect");
  assert.equal(
    rule.url,
    "https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.exe",
  );
  validateRules(catalog, rules);
  const candidate = await discover(rule, manifest, {
    redirect: async (url) => {
      assert.equal(url, rule.url);
      return (
        CDN + "/EpicInstaller-21.0.0.exe?launcherfilename=EpicInstaller-21.0.0.exe"
      );
    },
  });
  assert.equal(candidate.version, "21.0.0");
  assert.equal(candidate.url, CDN + "/EpicInstaller-21.0.0.msi");
  assert.equal(new URL(candidate.url).search, "");
  assert.equal(candidate.provenance, rule.url);
});

test("epic-games-launcher discovery rejects redirects without a pinned MSI build", async () => {
  await assert.rejects(
    discover(rules.packages["epic-games-launcher"], manifest, {
      redirect: async () =>
        CDN + "/EpicInstaller-21.0.0-beta.exe?launcherfilename=x.exe",
    }),
    /does not identify an exact release/,
  );
});

test("epic-games-launcher version updates keep entries, shortcuts and quotas untouched", () => {
  const next = nextManifest(
    manifest,
    {
      version: "21.0.0",
      url: CDN + "/EpicInstaller-21.0.0.msi",
      sha256: "a".repeat(64),
      provenance: rules.packages["epic-games-launcher"].url,
    },
    rules.packages["epic-games-launcher"],
  );
  const p = next.platforms["windows-x64"];
  assert.equal(next.version, "21.0.0");
  // The URL itself is assigned by the updater from the verified candidate;
  // nextManifest must keep every path-bearing field valid.
  assert.equal(Object.keys(p.files).length, 4450);
  assert.deepEqual(p.bin, {
    epic: "Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe",
  });
  assert.equal(p.maxExpandedBytes, 1073741824);
  validateManifest(next, "epic-games-launcher", "21.0.0");
});
