import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  validateManifest,
  validateRules,
  downloads,
} from "../scripts/lib/catalog.mjs";
import { discover, render } from "../scripts/lib/providers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);
const version = catalog.index.packages.clouddrive2.latest;
const manifest = catalog.manifests.get("clouddrive2@" + version);
const platform = manifest.platforms["windows-x64"];

test("CloudDrive2 publishes the WinUI desktop app bundle with an explicit app-only file map", () => {
  validateManifest(manifest, "clouddrive2", version);
  assert.equal(manifest.recipes, undefined);
  assert.equal(version, "1.1.3.3");
  // The desktop app ships as a WiX Burn bundle chaining WinFsp and the
  // application MSI; only the application MSI is a manifest payload.
  assert.equal(platform.format, "burn");
  assert.equal(platform.payload, "CloudDriveApp");
  assert.equal(platform.stripPrefix, "PFiles64/CloudDrive");
  assert.match(platform.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    platform.url,
    "https://github.com/cloud-fs/cloud-fs.github.io/releases/download/app-v1.1.3-24/CloudDrive2-1.1.3-3-windows-x64.exe",
  );
  assert.equal(new URL(platform.url).search, "");
  assert.deepEqual(platform.bin, { clouddrive: "CloudDrive.exe" });
  // The app keeps its state in %LOCALAPPDATA%\CloudDrive.WinUI and
  // %USERPROFILE%\Waytech\CloudDrive2; the manifest must not invent a
  // relocated persist root, and there is no service to register any more.
  assert.equal(platform.persist, undefined);
  assert.equal(platform.configTemplates, undefined);
  assert.equal(platform.configFiles, undefined);
  assert.equal(platform.admin, undefined);
  assert.equal(platform.shell, undefined);
  assert.equal(platform.bootstrap, undefined);
});

test("CloudDrive2 extracts only the application payload and drops the bundled WinFsp MSI", () => {
  const files = platform.files,
    targets = Object.values(files);
  assert.equal(Object.keys(files).length, 752);
  for (const [source, target] of Object.entries(files)) {
    assert.equal(source, target);
    assert.equal(source.startsWith("{"), false, source);
    assert.equal(source.startsWith("$"), false, source);
    assert.equal(source.includes("\\"), false, source);
    assert.equal(source.toLowerCase().endsWith(".pdb"), false, source);
  }
  for (const required of [
    "CloudDrive.exe",
    "cloudapi.dll",
    "CloudDrive.deps.json",
    "CloudDrive.runtimeconfig.json",
  ])
    assert.ok(targets.includes(required), required);
  // The vendor bundle chains WinFsp; the manifest must not publish it.
  assert.equal(
    targets.some((t) => /(^|\/)winfsp|\.msi$/i.test(t)),
    false,
  );
  assert.equal(targets.some((t) => /^\{/.test(t)), false);
});

test("CloudDrive2 shortcut opens the GUI executable, not a service host", async () => {
  assert.equal(platform.desktop?.shortcuts?.length, 1);
  // The previous package pointed the shortcut at the core service
  // (clouddrive.exe, a console binary that serves the Web UI and has to be
  // launched in a terminal). The WinUI app is a GUI subsystem executable, so
  // the shortcut target must be it, and the declared binary must exist in the
  // explicit map.
  assert.deepEqual(platform.desktop.shortcuts[0], {
    name: "CloudDrive2",
    path: "CloudDrive.exe",
  });
  assert.ok(Object.hasOwn(platform.files, "CloudDrive.exe"));
  // No ShellExecute helper, no shawl launcher and no service script remains.
  const serialized = JSON.stringify(platform);
  assert.doesNotMatch(serialized, /shawl/i);
  assert.doesNotMatch(serialized, /piko-service\.ps1/);
});

test("CloudDrive2 discovers the separate desktop-app channel and rebuilds the exact asset URL", async () => {
  const rule = rules.packages.clouddrive2;
  assert.equal(rule.provider, "regex");
  assert.equal(rule.url, "https://www.clouddrive2.com/download.html");
  assert.equal(rule.signature, true);
  assert.equal(rule.versionTemplate, "{assetver}.{appbuild}");
  assert.deepEqual(rule.required, ["CloudDrive.exe"]);
  validateRules(catalog, rules);
  // The page carries both channels: the core-service installer (v1.1.3) and
  // the desktop app (app-v1.1.3-24 publishing 1.1.3-3-windows-x64.exe). Only
  // the app bundle is a managed application now.
  const page = [
    '<a href="https://github.com/cloud-fs/cloud-fs.github.io/releases/download/v1.1.3/CloudDrive2Setup-X64-1.1.3.exe">',
    "<span>CloudDrive2Setup-X64-1.1.3.exe</span>",
    '<a href="https://github.com/cloud-fs/cloud-fs.github.io/releases/download/app-v1.1.3-24/CloudDrive2-1.1.3-3-windows-x64.exe">',
    "<span>CloudDrive2-1.1.3-3-windows-x64.exe</span>",
  ].join("\n");
  const text = (url) => {
    assert.equal(url, rule.url);
    return page;
  };
  const candidate = await discover(rule, manifest, { text });
  assert.equal(candidate.version, "1.1.3.3");
  assert.equal(candidate.url, platform.url);
  // The service installer is only the previous, already-published version.
  assert.equal(candidate.url.includes("CloudDrive2Setup"), false);
  assert.equal(downloads(platform).length, 1);
});

test("CloudDrive2 app updates keep the tag build number in the registered version", () => {
  // 1.1.3-24 (tag) builds 1.1.3-3 (asset). A newer bundle build of the same
  // app series must look newer, otherwise discovery reports "already indexed".
  const rule = rules.packages.clouddrive2;
  const page = [
    '<a href="https://github.com/cloud-fs/cloud-fs.github.io/releases/download/app-v1.1.3-31/CloudDrive2-1.1.3-4-windows-x64.exe">',
  ].join("\n");
  const match = new RegExp(rule.versionRegex).exec(page);
  assert.ok(match);
  const groups = { ...match.groups, version: match.groups.assetver };
  assert.equal(
    render(rule.versionTemplate, groups),
    "1.1.3.4",
    "asset-only versions would collide between bundle builds",
  );
  assert.equal(
    render(rule.urlTemplate, { ...groups, version: "1.1.3.4" }),
    "https://github.com/cloud-fs/cloud-fs.github.io/releases/download/app-v1.1.3-31/CloudDrive2-1.1.3-4-windows-x64.exe",
  );
});
