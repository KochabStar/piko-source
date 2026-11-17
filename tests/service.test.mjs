import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateManifest, validateServices } from "../scripts/lib/catalog.mjs";
import { appendManifest, resolveManifestDocument } from "../scripts/lib/manifest-template.mjs";

const service = { name: "PikoFixture", displayName: "Piko Fixture", binPath: "runtime-1.0.0/fixture.exe", startType: "demand", args: ["--service", "1.0.0", "{root}"] };
function manifest(version, services) {
  return { schemaVersion: 1, name: "fixture", version, platforms: { "windows-x64": {
    url: `https://example.invalid/fixture-${version}.zip`, sha256: "a".repeat(64), format: "zip", bin: { fixture: "fixture.exe" }, ...(services === undefined ? {} : { services }),
  } } };
}

test("source validator accepts services and rejects unsafe or conflicting declarations", () => {
  assert.doesNotThrow(() => validateManifest(manifest("1.0.0", [service]), "fixture", "1.0.0"));
  for (const declarations of [
    [service, { ...service, name: "pikofixture" }],
    [{ ...service, binPath: "../fixture.exe" }],
    [{ ...service, binPath: "installer.msi" }],
    [{ ...service, startType: "disabled", startAfterInstall: true }],
    [{ ...service, depends: ["pikofixture"] }],
    [{ ...service, args: ["bad\nargument"] }],
    [{ ...service, account: "Administrator" }],
    [{ ...service, name: "one", depends: ["two"] }, { ...service, name: "two", depends: ["one"] }],
  ]) assert.throws(() => validateServices(declarations));
});

test("service recipes interpolate only binPath and preserve published recipe bytes", () => {
  const original = manifest("1.0.0");
  const first = appendManifest(undefined, original);
  const before = JSON.stringify(resolveManifestDocument(first, "fixture", "1.0.0"));
  const withServices = manifest("2.0.0", [{ ...service, binPath: "runtime-2.0.0/fixture.exe" }]);
  const document = appendManifest(first, withServices);
  assert.equal(JSON.stringify(resolveManifestDocument(document, "fixture", "1.0.0")), before);
  assert.equal(before, JSON.stringify(original));
  assert.deepEqual(resolveManifestDocument(document, "fixture", "2.0.0"), withServices);
  const recipe = Object.values(document.recipes).find((recipe) => recipe.platforms["windows-x64"].services);
  assert.equal(recipe.platforms["windows-x64"].services[0].binPath, "runtime-{version}/fixture.exe");
  assert.deepEqual(recipe.platforms["windows-x64"].services[0].args, service.args);
});

test("Lertaro keeps real Data migration admin recipe and WinFsp remains an interactive driver MSI", async () => {
  const catalog = await loadCatalog(fileURLToPath(new URL("../", import.meta.url)));
  const platform = (name) => catalog.manifests.get(`${name}@${catalog.index.packages[name].latest}`).platforms["windows-x64"];
  const lertaro = platform("lertaro"), winfsp = platform("winfsp");
  assert.equal(lertaro.services, undefined);
  assert.equal(lertaro.admin.required, true);
  assert.match(lertaro.configFiles["piko-service.ps1"], /Data|backup-/);
  assert.equal(lertaro.persist, undefined);
  assert.equal(winfsp.services, undefined);
  assert.equal(winfsp.admin, undefined);
  assert.equal(winfsp.format, "file");
  assert.equal(winfsp.file, "winfsp.msi");
  assert.match(winfsp.configFiles["winfsp-setup.ps1"], /msiexec\.exe/);
});
