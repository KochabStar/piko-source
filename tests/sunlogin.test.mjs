import { embedRules } from "./policy-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate } from "../scripts/update.mjs";
import { nextManifest } from "../scripts/lib/upstream.mjs";
import {
  digest,
  loadCatalog,
  validateManifest,
} from "../scripts/lib/catalog.mjs";
import { network } from "../scripts/lib/net.mjs";
import { appendManifest } from "../scripts/lib/manifest-template.mjs";
import { fileURLToPath } from "node:url";

const catalog = await loadCatalog(
  fileURLToPath(new URL("../", import.meta.url)),
);
// Revisions (GUI entry fix, service integration) are folded into the single
// upstream version; sources never publish invented -piko.N versions.
const revision = catalog.manifests.get("sunlogin@16.8.0.33445");
const service = revision;

test("Sunlogin launches the extracted GUI, not the outer installer", async () => {
  validateManifest(revision, "sunlogin", "16.8.0.33445");
  const after = revision.platforms["windows-x64"];
  assert.deepEqual(after.bin, {
    sunlogin: "flutter/AweSun.exe",
    awesun: "flutter/AweSun.exe",
  });
  assert.deepEqual(after.desktop.shortcuts, [
    { name: "向日葵", path: "flutter/AweSun.exe" },
  ]);
  assert.equal(after.bootstrap, undefined);
  const index = JSON.parse(
    await readFile(new URL("../index.json", import.meta.url), "utf8"),
  );
  assert.equal(index.packages.sunlogin.latest, "16.8.0.33445");
  assert.equal(
    index.packages.sunlogin.versions["16.8.0.33445"],
    "packages/desktop/sunlogin/package.json",
  );
});

test("future Sunlogin updates retain the GUI command and shortcut targets", () => {
  const next = nextManifest(revision, { version: "16.9.0.40000", url: "https://vendor.example/new.exe" }, { provider: "manual", trust: "https", reason: "recipe regression" });
  assert.equal(next.version, "16.9.0.40000");
  assert.deepEqual(
    next.platforms["windows-x64"].bin,
    revision.platforms["windows-x64"].bin,
  );
  assert.deepEqual(
    next.platforms["windows-x64"].desktop,
    revision.platforms["windows-x64"].desktop,
  );
});

test("Sunlogin index latest keeps the corrected GUI entries", async () => {
  const index = JSON.parse(
    await readFile(new URL("../index.json", import.meta.url), "utf8"),
  );
  assert.equal(
    index.packages.sunlogin.versions[revision.version],
    "packages/desktop/sunlogin/package.json",
  );
  const latest = catalog.manifests.get(
    "sunlogin@" + index.packages.sunlogin.latest,
  );
  assert.deepEqual(
    latest.platforms["windows-x64"].bin,
    revision.platforms["windows-x64"].bin,
  );
  assert.deepEqual(
    latest.platforms["windows-x64"].desktop,
    revision.platforms["windows-x64"].desktop,
  );
  const rules = ({ packages: { sunlogin: catalog.documents.get(catalog.index.packages.sunlogin.versions[catalog.index.packages.sunlogin.latest]).upstream } });
  assert.deepEqual(rules.packages.sunlogin.required, [
    "flutter/flutter_windows.dll",
    "flutter/data/icudtl.dat",
    "flutter/data/app.so",
  ]);
});

test("Sunlogin owns its backend service integration", () => {
  validateManifest(service, "sunlogin", "16.8.0.33445");
  const after = service.platforms["windows-x64"];
  assert.deepEqual(after.persist, [
    "log",
    "FileTransferFiles",
    { path: "config.ini", kind: "file", mode: "hardlink", initial: "" },
    { path: "AweSun/config.ini", kind: "file", mode: "hardlink", initial: "" },
    ".piko-system",
  ]);
  const script = after.configFiles["piko-service.ps1"];
  assert.match(script, /--cmd=install_silent/);
  assert.match(script, /--serviceonly=1/);
  assert.match(script, /AweSunService/);
  assert.match(script, /Another Piko version owns/);
  assert.deepEqual(after.admin, {
    required: true,
    install: {
      kind: "powershell",
      path: "piko-service.ps1",
      args: ["install", "{root}", "{persist}/.piko-system"],
    },
    remove: {
      kind: "powershell",
      path: "piko-service.ps1",
      args: ["remove", "{root}", "{persist}/.piko-system"],
    },
  });
});

test("future Sunlogin updates inherit the service integration", () => {
  const next = nextManifest(service, { version: "16.9.0.40000", url: "https://vendor.example/new.exe" }, { provider: "manual", trust: "https", reason: "recipe regression" });
  const p = next.platforms["windows-x64"];
  assert.deepEqual(p.admin, service.platforms["windows-x64"].admin);
  assert.ok(p.configFiles["piko-service.ps1"]);
  assert.deepEqual(p.persist, service.platforms["windows-x64"].persist);
});

test("Sunlogin index keeps the upstream version as latest", async () => {
  const index = JSON.parse(
    await readFile(new URL("../index.json", import.meta.url), "utf8"),
  );
  assert.equal(index.packages.sunlogin.latest, "16.8.0.33445");
  assert.equal(
    index.packages.sunlogin.versions["16.8.0.33445"],
    "packages/desktop/sunlogin/package.json",
  );
});

// Run the actual generated script; all service/process boundaries are shadowed
// in the child PowerShell. The filesystem and receipt/state transitions are real.
test("Sunlogin script lifecycle with isolated services and temporary data", { skip: process.platform !== "win32" }, async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "piko-sunlogin-behavior-")));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 10 }));
  const ps = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const recipe = service.platforms["windows-x64"].configFiles["piko-service.ps1"];
  const harness = String.raw`
$ErrorActionPreference='Stop'
$global:fake=Get-Content -LiteralPath $env:FAKE -Raw|ConvertFrom-Json
function global:Get-CimInstance {param($ClassName,$Filter) @($global:fake.services)}
function global:Start-Sleep {param($Seconds,$Milliseconds)}
function global:Stop-Process {throw 'A real process must never be killed'}
function global:Get-FileHash {throw 'The recipe cannot depend on Get-FileHash'}
function global:Copy-Item {
 [CmdletBinding()]
 param([string]$LiteralPath,[string]$Destination,[switch]$Recurse,[switch]$Force)
 foreach($s in @($global:fake.services)){
  if($s.State -ne 'Stopped' -and $s.PathName.StartsWith(('"'+$LiteralPath+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Attempted to back up a running service tree'}
 }
 Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
}
function global:Start-Process {
 param($FilePath,[string[]]$ArgumentList,[string]$WorkingDirectory,[switch]$PassThru)
 $global:fake.launches+=@(@{file=$FilePath;args=@($ArgumentList);cwd=$WorkingDirectory})
 if($global:fake.replaceConfig){
  $configuration=Join-Path $env:ROOT 'AweSun\config.ini'
  [IO.File]::Delete($configuration)
  [IO.File]::WriteAllText($configuration,'vendor-atomic-identity')
 }
 $global:fake.services=@([pscustomobject]@{Name='AweSunService';PathName=('"'+(Join-Path $env:ROOT 'AweSun\AweSun.exe')+'" --mod=service');State=$(if($global:fake.failInstall -or $global:fake.registerStopped){'Stopped'}else{'Running'})})
 if($global:fake.twoServices){$global:fake.services+=@([pscustomobject]@{Name='SunloginService';PathName=('"'+(Join-Path $env:ROOT 'AweSun\OldAweSun.exe')+'"');State='Running'})}
 if($global:fake.watchdogs){
  $global:fake.services+=@([pscustomobject]@{Name='AweSunServiceDeamon';PathName=('"'+(Join-Path $env:ROOT 'AweSun\AweSun.exe')+'" --mod=daemon');State='Running'})
  $global:fake.services+=@([pscustomobject]@{Name='SunloginServiceDeamon';PathName=('"'+(Join-Path $env:ROOT 'AweSun\OldAweSun.exe')+'" --mod=daemon');State='Running'})
 }
 $p=[pscustomobject]@{HasExited=$true;ExitCode=$(if($global:fake.failInstall){23}else{0})}
 $p|Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($timeout) $true}
 $p
}
function global:sc.exe {
 param([string]$operation,[string]$name)
 $global:fake.calls+=@($operation+':'+$name)
 $global:LASTEXITCODE=0
 if($operation -eq 'stop'){
  if($global:fake.failStop){$global:LASTEXITCODE=5;return}
  if($name -notlike '*Deamon' -and @($global:fake.services|Where-Object {$_.Name -like '*Deamon' -and $_.State -eq 'Running'}).Count){$global:LASTEXITCODE=1051;return}
  @($global:fake.services|Where-Object Name -eq $name)|ForEach-Object{$_.State='Stopped'}
 }
 elseif($operation -eq 'start'){
  if($global:fake.failStart){$global:LASTEXITCODE=1053;Write-Output 'The service did not respond to the start request';return}
  @($global:fake.services|Where-Object Name -eq $name)|ForEach-Object{$_.State='Running'}
 }
 elseif($operation -eq 'delete'){
  if($global:fake.failDelete){$global:LASTEXITCODE=5;return}
  $global:fake.services=@($global:fake.services|Where-Object Name -ne $name)
 }else{throw 'Unexpected service-control operation'}
}
$errorText=$null
try{& $env:RECIPE -Action $env:ACTION -Root $env:ROOT -Data $env:DATA|Out-Null}catch{$errorText=$_.Exception.Message}
@{error=$errorText;services=@($global:fake.services);calls=@($global:fake.calls);launches=@($global:fake.launches)}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $env:RESULT -Encoding UTF8
`;
  let sequence = 0;
  const fixture = async () => {
    const home = join(temp, "case " + sequence++), data = join(home, "persist/sunlogin/.piko-system");
    await mkdir(data, { recursive: true });
    const roots = [join(home, "apps/sunlogin/1.0"), join(home, "apps/sunlogin/2.0")], receipts = [];
    for (const [i, root] of roots.entries()) {
      await mkdir(join(root, "AweSun"), { recursive: true });
      await writeFile(join(root, "AweSun.exe"), "not executable");
      await writeFile(join(root, "AweSun/config.ini"), i === 0 ? "secret=old-identity" : "");
      await writeFile(join(root, "AweSun/unknown-state.dat"), "preserve unknown vendor data");
      await writeFile(join(root, "piko-service.ps1"), recipe);
      const receipt = { id: "install-"+i, key: "same-source-key", name: "sunlogin", version: (i+1)+".0", layout: "named-v1", kind: "portable", verified: true, checksum: "a".repeat(64), manifestHash: "b".repeat(64), source: { identity: "same-source", type: "git" }, dir: "apps/sunlogin/"+(i+1)+".0" };
      receipts.push(receipt);
      await writeFile(join(root, ".piko-install.json"), JSON.stringify(receipt));
    }
    const journal = join(data, "piko-sunlogin-service.json");
    const invoke = async (action, root, services = [], flags = {}) => {
      const fake = join(home, "fake.json"), result = join(home, "result.json");
      await writeFile(fake, JSON.stringify({ services, calls: [], launches: [], failInstall: false, failDelete: false, failStop: false, replaceConfig: false, twoServices: false, ...flags }));
      execFileSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64")], {
        env: { ...process.env, FAKE: fake, RESULT: result, RECIPE: join(root, "piko-service.ps1"), ROOT: root, DATA: data, ACTION: action }, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse((await readFile(result, "utf8")).replace(/^\uFEFF/, ""));
    };
    const record = async () => JSON.parse((await readFile(journal, "utf8")).replace(/^\uFEFF/, ""));
    const svc = (image, name = "AweSunService") => ({ Name: name, PathName: '"'+image+'" --mod=service', State: "Running" });
    return { home, data, roots, receipts, journal, invoke, record, svc };
  };
  await t.test("clean install, upgrade before current switches, remove and reinstall preserve actual data", async () => {
    const f = await fixture(), [old, next] = f.roots;
    await symlink(old, join(f.home, "apps/sunlogin/current"), "junction");
    let r = await f.invoke("install", old);
    assert.equal(r.error, null);
    assert.equal((await f.record()).state, "installed");
    assert.deepEqual(r.launches[0].args, ["--mod=install", "--admin=1", "--cmd=install_silent", "--serviceonly=1", '--path="'+old+'"']);
    assert.equal(r.launches[0].cwd, old, 'vendor installer uses the real version directory');
    r = await f.invoke("remove", old, r.services);
    assert.equal(r.error, null);
    assert.equal(r.services.length, 0);
    await assert.rejects(readFile(f.journal));
    r = await f.invoke("install", next);
    assert.equal(r.error, null);
    assert.equal(await realpath(join(f.home, "apps/sunlogin/current")), old);
    assert.equal(await readFile(join(next, "AweSun/config.ini"), "utf8"), "secret=old-identity");
    assert.equal(await readFile(join(f.home, "persist/sunlogin/AweSun/config.ini"), "utf8"), "secret=old-identity");
    await rm(join(next, "AweSun.exe"));
    r = await f.invoke("remove", next, r.services);
    assert.equal(r.error, null, "remove cannot require outer installer");
    await writeFile(join(next, "AweSun.exe"), "not executable");
    r = await f.invoke("install", next);
    assert.equal(r.error, null);
    const backups = await readdir(join(f.data, "backups"));
    assert.ok(backups.length);
    assert.equal(await readFile(join(f.data, "backups", backups[0], "AweSun/unknown-state.dat"), "utf8"), "preserve unknown vendor data");
  });
  await t.test("failed installer remains removable and deletion failure remains retryable", async () => {
    const f = await fixture(), root = f.roots[0];
    let r = await f.invoke("install", root, [], { failInstall: true });
    assert.match(r.error, /exit code 23/);
    assert.equal((await f.record()).state, "cleanup-pending");
    await rm(join(root, "AweSun.exe"));
    r = await f.invoke("remove", root, r.services, { failDelete: true });
    assert.match(r.error, /Failed to delete/);
    assert.equal((await f.record()).state, "cleanup-pending");
    r = await f.invoke("remove", root, r.services);
    assert.equal(r.error, null);
    assert.equal(r.services.length, 0);
    await assert.rejects(readFile(f.journal));
  });
  await t.test("schema-one installing receipt can be removed without an installer", async () => {
    const f = await fixture(), root = f.roots[0];
    await writeFile(f.journal, JSON.stringify({ schemaVersion: 1, root, state: "installing" }));
    await rm(join(root, "AweSun.exe"));
    const r = await f.invoke("remove", root, [f.svc(join(root, "AweSun/AweSun.exe"))]);
    assert.equal(r.error, null);
    assert.equal(r.services.length, 0);
  });
  await t.test("no service journal: receipt-proven current and OldAweSun remnants recover", async () => {
    const f = await fixture(), [old, next] = f.roots, current = join(f.home, "apps/sunlogin/current");
    await symlink(old, current, "junction");
    const r = await f.invoke("install", next, [f.svc(join(current, "AweSun/AweSun.exe")), f.svc(join(current, "AweSun/OldAweSun.exe"), "SunloginService")]);
    assert.equal(r.error, null);
    assert.ok(r.calls.includes("delete:AweSunService"));
    assert.ok(r.calls.includes("delete:SunloginService"));
    assert.equal((await f.record()).state, "installed");
    assert.equal(await readFile(join(next, "AweSun/config.ini"), "utf8"), "secret=old-identity");
  });
  await t.test("external, sibling-prefix, ambiguous and unreceipted services remain untouched", async () => {
    for (const kind of ["external", "sibling", "ambiguous", "unreceipted", "other-source"]) {
      const f = await fixture(), root = f.roots[0];
      let image = join(f.home, "external/AweSun.exe");
      if (kind === "sibling") image = join(f.home, "apps/sunlogin-extra/1.0/AweSun/AweSun.exe");
      if (kind === "ambiguous") image = join(root, "AweSun/AweSun.exe");
      if (kind === "unreceipted") image = join(f.home, "apps/sunlogin/untracked/AweSun/AweSun.exe");
      if (kind === "other-source") {
        image = join(f.roots[1], "AweSun/AweSun.exe");
        await writeFile(join(f.roots[1], ".piko-install.json"), JSON.stringify({ ...f.receipts[1], source: { identity: "foreign-source" } }));
      }
      const entry = f.svc(image);
      if (kind === "ambiguous") entry.PathName = image + " --mod=service";
      for (const action of ["install", "remove"]) {
        const r = await f.invoke(action, root, [entry]);
        assert.ok(r.error, kind);
        assert.deepEqual(r.services, [entry], kind);
        assert.deepEqual(r.calls, [], kind);
        assert.deepEqual(r.launches, [], kind);
      }
    }
  });
  await t.test("vendor atomic replacement repairs the link after stopping every service", async () => {
    const f = await fixture(), root = f.roots[0];
    const r = await f.invoke("install", root, [], { replaceConfig: true, twoServices: true });
    assert.equal(r.error, null);
    assert.deepEqual(r.calls, ["stop:AweSunService", "stop:SunloginService", "start:AweSunService", "start:SunloginService"]);
    const shared = join(f.home, "persist/sunlogin/AweSun/config.ini");
    assert.equal(await readFile(join(root, "AweSun/config.ini"), "utf8"), "vendor-atomic-identity");
    assert.equal(await readFile(shared, "utf8"), "vendor-atomic-identity");
    await writeFile(join(root, "AweSun/config.ini"), "write-through-repaired-link");
    assert.equal(await readFile(shared, "utf8"), "write-through-repaired-link");
    for (const backup of await readdir(join(f.data, "backups"))) {
      const marker = JSON.parse(await readFile(join(f.data, "backups", backup, "complete.json"), "utf8"));
      assert.equal(marker.root, root);
    }
  });
  await t.test("successful stopped registration is explicitly activated after preserving data", async () => {
    const f = await fixture(), root = f.roots[0];
    const r = await f.invoke("install", root, [], { registerStopped: true });
    assert.equal(r.error, null);
    assert.deepEqual(r.calls, ["start:AweSunService"]);
    assert.equal(r.services[0].State, "Running");
    assert.equal((await f.record()).state, "installed");
    assert.ok((await readdir(join(f.data, "backups"))).length);
  });
  await t.test("native startup failure remains visible and retains a removable recovery receipt", async () => {
    const f = await fixture(), root = f.roots[0];
    const r = await f.invoke("install", root, [], { registerStopped: true, failStart: true });
    assert.match(r.error, /Failed to start service: AweSunService \(sc.exe exit 1053\)/);
    assert.match(r.error, /did not respond/);
    assert.deepEqual(r.calls, ["start:AweSunService"]);
    assert.equal(r.services[0].State, "Stopped");
    assert.equal((await f.record()).state, "cleanup-pending");
    const removed = await f.invoke("remove", root, r.services);
    assert.equal(removed.error, null);
    assert.deepEqual(removed.services, []);
  });
  await t.test("native watchdogs stop before workers and restart after data preservation", async () => {
    const f = await fixture(), root = f.roots[0];
    const r = await f.invoke("install", root, [], { twoServices: true, watchdogs: true });
    assert.equal(r.error, null);
    assert.deepEqual(r.calls, [
      "stop:AweSunServiceDeamon", "stop:SunloginServiceDeamon",
      "stop:AweSunService", "stop:SunloginService",
      "start:AweSunService", "start:SunloginService",
      "start:AweSunServiceDeamon", "start:SunloginServiceDeamon",
    ]);
    assert.equal((await f.record()).services.length, 4);
    const removed = await f.invoke("remove", root, r.services);
    assert.equal(removed.error, null);
    assert.deepEqual(removed.services, []);
    assert.deepEqual(removed.calls.slice(0, 4), r.calls.slice(0, 4));
  });
  await t.test("external watchdog blocks vendor execution and every service mutation", async () => {
    for (const name of ["AweSunServiceDeamon", "SunloginServiceDeamon"]) {
      const f = await fixture(), root = f.roots[0];
      const external = { ...f.svc(join(f.home, "external/AweSun.exe"), name), PathName: '"'+join(f.home, "external/AweSun.exe")+'" --mod=daemon' };
      for (const action of ["install", "remove"]) {
        const r = await f.invoke(action, root, [external]);
        assert.match(r.error, /External Sunlogin service retained/);
        assert.deepEqual(r.services, [external]);
        assert.deepEqual(r.calls, []);
        assert.deepEqual(r.launches, []);
      }
    }
  });
  await t.test("service names cannot disguise GUI, installer or mismatched native modes", async () => {
    for (const [name, mode] of [["AweSunService", "install"], ["AweSunService", "daemon"], ["AweSunServiceDeamon", "service"]]) {
      const f = await fixture(), root = f.roots[0];
      const entry = { ...f.svc(join(root, "AweSun/AweSun.exe"), name), PathName: '"'+join(root, "AweSun/AweSun.exe")+'" --mod='+mode };
      const r = await f.invoke("remove", root, [entry]);
      assert.match(r.error, /Unexpected native service mode/);
      assert.deepEqual(r.services, [entry]);
      assert.deepEqual(r.calls, []);
      assert.deepEqual(r.launches, []);
    }
  });
  await t.test("a failed stop preserves recovery state without copying live data", async () => {
    const f = await fixture(), root = f.roots[0];
    const running = f.svc(join(root, "AweSun/AweSun.exe"));
    const r = await f.invoke("remove", root, [running], { failStop: true });
    assert.match(r.error, /Failed to stop/);
    assert.deepEqual(r.calls, ["stop:AweSunService"]);
    assert.deepEqual(r.services, [running]);
    assert.equal((await f.record()).state, "cleanup-pending");
    await assert.rejects(readdir(join(f.data, "backups")));
  });
  await t.test("candidate removal with an active receipt leaves service and receipt bytes unchanged", async () => {
    const f = await fixture(), [activeRoot, candidate] = f.roots;
    const installed = await f.invoke("install", activeRoot);
    assert.equal(installed.error, null);
    const receiptBefore = await readFile(f.journal, "utf8");
    const shared = join(f.home, "persist/sunlogin/AweSun/config.ini");
    const configBefore = await readFile(shared, "utf8");
    await rm(join(candidate, "AweSun.exe"));
    const removed = await f.invoke("remove", candidate, installed.services);
    assert.equal(removed.error, null);
    assert.deepEqual(removed.services, installed.services);
    assert.deepEqual(removed.calls, []);
    assert.deepEqual(removed.launches, []);
    assert.equal(await readFile(f.journal, "utf8"), receiptBefore);
    assert.equal(await readFile(shared, "utf8"), configBefore);
    assert.equal((await f.record()).root, activeRoot);
  });
  await t.test("candidate without journal does not adopt another active version", async () => {
    const f = await fixture(), root = f.roots[1];
    await rm(join(root, "AweSun.exe"));
    await mkdir(join(f.home, "persist/sunlogin/AweSun"), { recursive: true });
    await writeFile(join(f.home, "persist/sunlogin/AweSun/config.ini"), "active-version-identity");
    const active = f.svc(join(f.roots[0], "AweSun/AweSun.exe"));
    const r = await f.invoke("remove", root, [active]);
    assert.equal(r.error, null);
    assert.equal(await readFile(join(f.home, "persist/sunlogin/AweSun/config.ini"), "utf8"), "active-version-identity");
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.services, [active]);
    assert.ok((await readdir(join(f.data, "backups"))).length);
    await assert.rejects(readFile(f.journal));
  });
  await t.test("unactivated candidate without any services or journal can be removed", async () => {
    const f = await fixture(), root = f.roots[1];
    await rm(join(root, "AweSun.exe"));
    const r = await f.invoke("remove", root);
    assert.equal(r.error, null);
    assert.deepEqual(r.services, []);
    assert.deepEqual(r.calls, []);
    assert.ok((await readdir(join(f.data, "backups"))).length);
    await assert.rejects(readFile(f.journal));
  });
});

for (const missingEntry of [false, true]) {
  test(
    missingEntry
      ? "Sunlogin update pipeline retains the working revision when layout verification fails"
      : "Sunlogin update pipeline publishes a newer upstream with the corrected GUI entries",
    async (t) => {
      // Synthetic upstream metadata/payload: no download or application execution.
      const root = await mkdtemp(join(tmpdir(), "piko-sunlogin-update-"));
      t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
      const file = "packages/desktop/sunlogin/package.json";
      const rules = { packages: { sunlogin: catalog.documents.get(catalog.index.packages.sunlogin.versions[catalog.index.packages.sunlogin.latest]).upstream } };
      let previousBytes = JSON.stringify({ ...appendManifest(undefined, revision), upstream: rules.packages.sunlogin }, null, 2) + "\n";
      await mkdir(join(root, "packages/desktop/sunlogin"), {
        recursive: true,
      });
      await mkdir(join(root, "automation"));
      await writeFile(join(root, file), previousBytes);
      await writeFile(
        join(root, "index.json"),
        JSON.stringify({
          schemaVersion: 1,
          packages: {
            sunlogin: {
              category: "desktop",
              latest: revision.version,
              versions: { [revision.version]: file },
            },
          },
        }),
      );
      await embedRules(root, { packages: { sunlogin: rules.packages.sunlogin } });
      previousBytes = await readFile(join(root, file), "utf8");
      const payload = Buffer.from("synthetic update pipeline fixture");
      const candidate = {
        version: "16.9.0.40000",
        url: "https://example.invalid/AweSun_16.9.0.40000_x64.exe",
        sha256: digest(payload),
      };
      const result = await runUpdate(root, {
        mode: "write",
        discoverer: async () => candidate,
        net: network({
          token: undefined,
          fetcher: async () => new Response(payload),
        }),
        verify: async (manifest, artifacts, rule) => {
          const platform = manifest.platforms["windows-x64"];
          assert.deepEqual(platform.bin, revision.platforms["windows-x64"].bin);
          assert.deepEqual(
            platform.desktop,
            revision.platforms["windows-x64"].desktop,
          );
          assert.deepEqual(
            platform.persist,
            revision.platforms["windows-x64"].persist,
          );
          assert.deepEqual(rule.required, rules.packages.sunlogin.required);
          for (const download of platform.downloads) {
            assert.equal(download.url, candidate.url);
            assert.equal(download.sha256, candidate.sha256);
          }
          assert.equal(artifacts.length, 2);
          if (missingEntry)
            throw Error(
              "Required application entry missing: flutter/AweSun.exe",
            );
          return { files: 5, unknownSizeFiles: 0, reviewSensitive: false };
        },
      });
      const after = await loadCatalog(root);
      assert.equal(result.changed, missingEntry ? 0 : 1);
      assert.equal(result.blocked, missingEntry ? 1 : 0);
      assert.equal(
        after.index.packages.sunlogin.latest,
        missingEntry ? revision.version : candidate.version,
      );
      assert.equal(
        after.index.packages.sunlogin.versions[candidate.version] !== undefined,
        !missingEntry,
      );
      if (missingEntry)
        // A blocked package leaves the shared template byte-identical.
        assert.equal(await readFile(join(root, file), "utf8"), previousBytes);
      else
        assert.match(
          await readFile(join(root, file), "utf8"),
          /"16\.9\.0\.40000"/,
        );
    },
  );
}
