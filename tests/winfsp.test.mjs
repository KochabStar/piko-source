import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  validateManifest,
  validateRules,
} from "../scripts/lib/catalog.mjs";
import { discover, render } from "../scripts/lib/upstream.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = ({ packages: Object.fromEntries(await Promise.all(Object.entries(JSON.parse(await readFile(new URL("../index.json", import.meta.url), "utf8")).packages).map(async ([name, entry]) => [name, JSON.parse(await readFile(new URL("../" + entry.versions[entry.latest], import.meta.url), "utf8")).upstream]))) });
const version = catalog.index.packages.winfsp.latest;
const manifest = catalog.manifests.get("winfsp@" + version);
const platform = manifest.platforms["windows-x64"];

test("winfsp publishes the signed vendor installer without extracting a driver", () => {
  validateManifest(manifest, "winfsp", version);
  assert.equal(version, "2.1.25156");
  // WinFsp is a kernel-mode file system driver plus the WinFsp.Launcher
  // service: there is no portable payload, and unpacking the MSI would only
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
  assert.deepEqual(platform.bin, {});
  // No fabricated user-mode service declaration: the kernel driver and
  // WinFsp.Launcher are registered by the vendor MSI, never by an SCM recipe.
  assert.equal(platform.services, undefined);
  assert.equal(platform.desktop, undefined);
  assert.equal(platform.persist, undefined);
  assert.equal(platform.shell, undefined);
  assert.equal(platform.bootstrap, undefined);
});

test("winfsp manages the vendor MSI through an explicit admin recipe", () => {
  // The driver install is `piko system winfsp --approve-admin` in an
  // Administrator terminal; Piko still never elevates or silently runs
  // msiexec. There is no interactive winfsp-setup entry: every install is
  // receipt-tracked, so uninstall always knows what it owns.
  assert.deepEqual(platform.admin, {
    required: true,
    install: { kind: "powershell", path: "piko-admin.ps1", args: ["install"] },
    remove: { kind: "powershell", path: "piko-admin.ps1", args: ["remove"] },
  });
  assert.deepEqual(Object.keys(platform.configFiles), ["piko-admin.ps1"]);
});

test("winfsp admin script only runs the vendor MSI and refuses foreign installs", () => {
  const script = platform.configFiles["piko-admin.ps1"];
  assert.equal(typeof script, "string");
  // Only an explicitly elevated terminal may run the script; Piko never
  // opens UAC itself.
  assert.match(script, /WindowsBuiltInRole\]::Administrator/);
  // Both directions go through msiexec against the saved vendor MSI.
  assert.match(script, /Invoke-Msiexec @\('\/i'/);
  assert.match(script, /Invoke-Msiexec @\('\/x'/);
  assert.match(script, /'\/qn', '\/norestart'/);
  assert.doesNotMatch(script, /REBOOT=|ADDLOCAL=/);
  // The expected version is read from the MSI's own ProductVersion property:
  // a recipe embedding the version would demand manual review on every
  // future upstream build.
  assert.doesNotMatch(script, /25156/);
  // A WinFsp registered at another version is never adopted or replaced.
  assert.match(script, /does not match the managed MSI/);
  assert.match(script, /refusing to remove it/);
  // Success and removal are verified against the system, never assumed.
  assert.match(script, /Services\\WinFsp/);
  assert.match(
    script,
    /WinFsp\.Launcher service is missing after installation/,
  );
  assert.match(script, /still present after removal/);
});

test("winfsp discovery reads the single stable installer from the release page", async () => {
  const rule = rules.packages.winfsp;
  assert.equal(rule.provider, "regex");
  assert.equal(rule.url, "https://winfsp.dev/rel/");
  assert.equal(rule.signature, true);
  assert.deepEqual(rule.required, ["piko-admin.ps1"]);
  validateRules(catalog);
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
