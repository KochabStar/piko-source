import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  validateManifest,
  validateRules,
} from "../scripts/lib/catalog.mjs";
import { discover, render } from "../scripts/lib/providers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);
const version = catalog.index.packages.winfsp.latest;
const manifest = catalog.manifests.get("winfsp@" + version);
const platform = manifest.platforms["windows-x64"];

test("winfsp publishes the signed vendor installer without extracting a driver", () => {
  validateManifest(manifest, "winfsp", version);
  assert.equal(version, "2.1.25156");
  // WinFsp is a kernel-mode file system driver plus the WinFsp.Launcher
  // service: there is no portable payload, and unpacking an MSI would only
  // scatter driver files that cannot be installed by being copied.
  assert.equal(platform.format, "file");
  assert.equal(platform.file, "winfsp.msi");
  assert.equal(
    platform.url,
    "https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi",
  );
  assert.equal(
    platform.sha256,
    "073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a",
  );
  // The official release-asset digest for the same file.
  assert.deepEqual(platform.bin, {
    "winfsp-setup": { path: "winfsp-setup.ps1", kind: "powershell" },
  });
  // No admin recipe: Piko never elevates on its own and never runs msiexec.
  assert.equal(platform.admin, undefined);
  assert.equal(platform.desktop, undefined);
  assert.equal(platform.persist, undefined);
  assert.equal(platform.shell, undefined);
  assert.equal(platform.bootstrap, undefined);
});

test("winfsp entry point only opens the interactive installer", () => {
  const script = platform.configFiles["winfsp-setup.ps1"];
  assert.equal(typeof script, "string");
  assert.match(script, /'winfsp\.msi'/);
  // The MSI is launched, never executed headlessly by the package.
  assert.match(script, /Start-Process/);
  assert.match(script, /msiexec\.exe/);
  assert.match(script, /'\/i'/);
  // Refuse arguments so the entry point cannot be repurposed as an unattended
  // installer switch that silently elevates.
  assert.match(script, /\$args\.Count/);
  assert.match(script, /interactive installer only/);
  assert.doesNotMatch(script, /\/quiet|\/qn|REBOOT=|ADDLOCAL=/);
});

test("winfsp discovery reads the single stable installer from the release page", async () => {
  const rule = rules.packages.winfsp;
  assert.equal(rule.provider, "regex");
  assert.equal(rule.url, "https://winfsp.dev/rel/");
  assert.equal(rule.signature, true);
  assert.deepEqual(rule.required, ["winfsp-setup.ps1"]);
  validateRules(catalog, rules);
  // The page links the stable installer alongside unrelated companion
  // projects (nfs-win, sshfs-win); only the winfsp asset may match.
  const page = [
    '<a href="https://github.com/winfsp/nfs-win/releases/download/v1.0.17083/nfs-win-1.0.17083.msi">',
    '<a href="https://github.com/winfsp/sshfs-win/releases/download/v3.5.20357/sshfs-win-3.5.20357-x64.msi">',
    '<a href="https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi">',
  ].join("\n");
  const text = (url) => {
    assert.equal(url, rule.url);
    return page;
  };
  const candidate = await discover(rule, manifest, { text });
  assert.equal(candidate.version, "2.1.25156");
  assert.equal(candidate.url, platform.url);
});

test("winfsp keeps the series tag stable while only the build moves", () => {
  const rule = rules.packages.winfsp;
  // The download button is served from a series tag (v2.1) that does not
  // change until upstream starts a new series, while the asset and the MSI
  // ProductVersion carry the build. A future build must rewrite the asset
  // name without inventing a new tag.
  const page =
    '<a href="https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.26001.msi">';
  const match = new RegExp(rule.versionRegex).exec(page);
  assert.ok(match);
  assert.equal(match.groups.version, "2.1.26001");
  assert.equal(
    render(rule.urlTemplate, { version: "2.1.26001" }),
    "https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.26001.msi",
  );
});
