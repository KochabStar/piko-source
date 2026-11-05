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

test("CloudDrive2 publishes the signed Inno Setup core-service installer with an explicit app-only file map", () => {
  validateManifest(manifest, "clouddrive2", version);
  assert.equal(manifest.recipes, undefined);
  assert.equal(platform.format, "inno");
  assert.match(platform.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    platform.url,
    "https://github.com/cloud-fs/cloud-fs.github.io/releases/download/v" +
      version +
      "/CloudDrive2Setup-X64-" +
      version +
      ".exe",
  );
  assert.equal(new URL(platform.url).search, "");
  assert.deepEqual(platform.bin, { clouddrive: "clouddrive.exe" });
  // CloudDrive2 stores its state (config.toml, sqlite databases, logs,
  // copy_tasks, webhooks) in its own %USERPROFILE%\Waytech\CloudDrive2 tree
  // and resolves ./wwwroot from its working directory, so the manifest must
  // not invent a relocated persist root.
  assert.equal(platform.persist, undefined);
  assert.equal(platform.configTemplates, undefined);
  assert.equal(platform.shell, undefined);
  assert.equal(platform.bootstrap, undefined);
});

test("CloudDrive2 extracts only explicit {app} payload entries and drops the bundled WinFsp MSI", () => {
  const files = platform.files,
    targets = Object.values(files);
  assert.equal(Object.keys(files).length, 67);
  for (const [source, target] of Object.entries(files)) {
    assert.equal(source, target);
    assert.equal(source.startsWith("{"), false, source);
    assert.equal(source.startsWith("$"), false, source);
  }
  for (const required of [
    "clouddrive.exe",
    "shawl.exe",
    "arm64/shawl.exe",
    "wwwroot/index.html",
    "wwwroot/clouddrive_web_bg.wasm",
    "wwwroot/public/reader/foliate/view.js",
    "CloudDrive.ico",
  ])
    assert.ok(targets.includes(required), required);
  // The vendor installer runs msiexec on a WinFsp driver MSI from {tmp}; the
  // manifest must not publish it as application payload.
  assert.equal(
    targets.some((t) => /(^|\/)winfsp|\.msi$/i.test(t)),
    false,
  );
  assert.equal(targets.some((t) => /^\{/.test(t)), false);
  assert.equal(targets.some((t) => /uninstall|uninst\.exe/i.test(t)), false);
});

test("CloudDrive2 owns its service registration but never its WinFsp driver or Program Files copy", async () => {
  const script = platform.configFiles["piko-service.ps1"];
  assert.equal(typeof script, "string");
  assert.deepEqual(platform.admin?.install, {
    kind: "powershell",
    path: "piko-service.ps1",
    args: ["install", "{root}", "{persist}/.piko-system"],
  });
  assert.deepEqual(platform.admin?.remove, {
    kind: "powershell",
    path: "piko-service.ps1",
    args: ["remove", "{root}", "{persist}/.piko-system"],
  });
  // Anchored at the managed version directory, journalled and reversible.
  assert.match(script, /piko-clouddrive2-service\.json/);
  assert.match(script, /Test-UnderRoot/);
  assert.match(script, /sc\.exe create CloudDrive2/);
  assert.match(script, /sc\.exe delete CloudDrive2/);
  // The registered command line must stay exactly the vendor one: the core
  // service resolves its own user data directory and executable-relative
  // wwwroot, so no --cwd/--env relocation may be injected.
  assert.match(script, /run --no-log -- "'\+\$target/);
  assert.doesNotMatch(script, /--cwd|--env CLOUDDRIVE/);
  // The vendor installer's driver, Program Files and process-kill actions are
  // deliberately out of scope: an extracting package must not install WinFsp.
  assert.doesNotMatch(script, /msiexec/i);
  assert.doesNotMatch(script, /winfsp-[0-9]|\.msi/i);
  assert.doesNotMatch(script, /Stop-Process[^\n]*clouddrive/i);
  assert.doesNotMatch(script, /sc\.exe create [^C]|sc\.exe create CloudDrive2[^\n]*\{root\}/i);
  assert.doesNotMatch(script, /ProgramFiles|%ProgramFiles%|autopf/i);
  assert.equal(platform.desktop?.shortcuts?.length, 1);
  assert.deepEqual(platform.desktop.shortcuts[0], {
    name: "CloudDrive2",
    path: "clouddrive.exe",
  });
});

test("CloudDrive2 discovers the core-service installer from the official download page and rebuilds the version-bound release URL", async () => {
  const rule = rules.packages.clouddrive2;
  assert.equal(rule.provider, "regex");
  assert.equal(rule.url, "https://www.clouddrive2.com/download.html");
  assert.equal(rule.signature, true);
  assert.deepEqual(rule.required, [
    "wwwroot/index.html",
    "wwwroot/clouddrive_web_bg.wasm",
    "shawl.exe",
    "CloudDrive.ico",
  ]);
  validateRules(catalog, rules);
  const page = [
    '<a data-asset="win-x64" href="https://github.com/cloud-fs/cloud-fs.github.io/releases/download/v1.1.3/CloudDrive2Setup-X64-1.1.3.exe">',
    "<span data-asset-name>CloudDrive2Setup-X64-1.1.3.exe</span>",
    '<a href="https://github.com/cloud-fs/cloud-fs.github.io/releases/download/app-v1.1.3-24/CloudDrive2-1.1.3-3-windows-x64.exe">',
    "<span>CloudDrive2-1.1.3-3-windows-x64.exe</span>",
  ].join("\n");
  const text = (url) => {
    assert.equal(url, rule.url);
    return page;
  };
  const candidate = await discover(rule, manifest, { text });
  // The separate app-v1.1.3-24 package is rejected: only the signed Inno
  // Setup core service (which owns clouddrive.exe) is a managed application.
  assert.equal(candidate.version, "1.1.3");
  assert.equal(candidate.url, platform.url);
  assert.equal(candidate.url.includes("app-v"), false);
  assert.equal(downloads(platform).length, 1);
});
