import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateManifest } from "../scripts/lib/catalog.mjs";
import { discover } from "../scripts/lib/providers.mjs";
import { nextManifest } from "../scripts/update.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
).packages;
const manifest = (name) =>
  catalog.manifests.get(name + "@" + catalog.index.packages[name].latest);
const platform = (name) => manifest(name).platforms["windows-x64"];

for (const name of [
  "claude-code",
  "opencode",
  "nushell",
  "nvidia-app",
  "qqnt",
  "codex",
])
  test(`${name} has a registered, checksummed Windows distribution without implicit installation hooks`, () => {
    const m = manifest(name),
      p = platform(name);
    validateManifest(m, name, m.version);
    assert.match(p.sha256, /^[a-f0-9]{64}$/);
    assert.equal(new URL(p.url).search, "");
    for (const key of ["bootstrap", "admin", "shell"])
      assert.equal(p[key], undefined, key);
  });

test("Claude Code uses the native executable and disables all upstream update paths", () => {
  const p = platform("claude-code");
  assert.equal(p.format, "file");
  assert.equal(p.file, "claude.exe");
  assert.deepEqual(p.bin, { claude: "claude.exe" });
  assert.deepEqual(p.env, { DISABLE_UPDATES: "1" });
  assert.equal(p.persist, undefined);
  assert.equal(p.depends, undefined);
});

const base = "https://downloads.claude.ai/claude-code-releases";
const version = "9.8.7",
  checksum = "a".repeat(64);
const nativeRelease = () => ({
  version,
  platforms: { "win32-x64": { binary: "claude.exe", checksum, size: 123 } },
});
const nativeNet = (release = nativeRelease(), latest = version) => ({
  text: async (url) => {
    assert.equal(url, base + "/latest");
    return latest + "\n";
  },
  json: async (url) => {
    assert.equal(url, `${base}/${version}/manifest.json`);
    return release;
  },
});

test("Claude Code discovers a version-bound native binary with the official checksum and size", async () => {
  const candidate = await discover(
    rules["claude-code"],
    manifest("claude-code"),
    nativeNet(),
  );
  assert.equal(candidate.version, version);
  assert.equal(candidate.url, `${base}/${version}/win32-x64/claude.exe`);
  assert.equal(candidate.sha256, checksum);
  assert.equal(candidate.assetBytes, 123);
  assert.equal(candidate.provenance, `${base}/${version}/manifest.json`);
  assert.deepEqual(
    nextManifest(manifest("claude-code"), candidate, rules["claude-code"])
      .platforms,
    manifest("claude-code").platforms,
  );
});

test("Claude Code rejects invalid version hints before requesting a manifest", async () => {
  for (const latest of [
    "<html>error</html>",
    "../1.2.3",
    "1.2.3-beta.1",
    "1.2.3/path",
    "1.2.3\n9.8.7",
  ])
    await assert.rejects(
      () =>
        discover(
          rules["claude-code"],
          manifest("claude-code"),
          nativeNet(undefined, latest),
        ),
      /Invalid Claude Code stable version/,
    );
});

test("Claude Code rejects mismatched manifests, missing x64, bad checksums and invalid sizes", async () => {
  const cases = [
    { ...nativeRelease(), version: "0.0.0" },
    {
      version,
      platforms: { "win32-arm64": nativeRelease().platforms["win32-x64"] },
    },
    ...[
      { binary: "install.ps1" },
      { checksum: undefined },
      { checksum: "not-a-sha256" },
      { size: 0 },
      { size: -1 },
      { size: "123" },
      { size: 2 ** 31 + 1 },
    ].map((patch) => ({
      version,
      platforms: {
        "win32-x64": { ...nativeRelease().platforms["win32-x64"], ...patch },
      },
    })),
  ];
  for (const release of cases)
    await assert.rejects(
      () =>
        discover(
          rules["claude-code"],
          manifest("claude-code"),
          nativeNet(release),
        ),
      /Invalid Claude Code Windows x64 manifest/,
    );
});

for (const [name, asset, tag] of [
  ["opencode", "opencode-windows-x64-baseline.zip", "v" + version],
  ["nushell", `nu-${version}-x86_64-pc-windows-msvc.zip`, version],
  ["lertaro", "Lertaro-Portable.zip", "v" + version],
]) {
  const rule = rules[name];
  const url = `https://github.com/${rule.repo}/releases/download/${tag}/${asset}`;
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      { name: "arm64.zip" },
      { name: "setup.exe" },
      {
        name: asset,
        browser_download_url: url,
        digest: "sha256:" + checksum,
        size: 123,
      },
    ],
  };
  test(`${name} discovers only its reviewed Windows x64 archive and preserves recipe semantics`, async () => {
    const candidate = await discover(rule, manifest(name), {
      json: async () => release,
    });
    assert.equal(candidate.version, version);
    assert.equal(candidate.url, url);
    assert.equal(candidate.sha256, checksum);
    const next = nextManifest(manifest(name), candidate, rule);
    assert.deepEqual(next.platforms, manifest(name).platforms);
    validateManifest(next, name, version);
  });
  test(`${name} refuses missing or ambiguous Windows x64 assets`, async () => {
    for (const assets of [
      release.assets.slice(0, -1),
      [...release.assets, release.assets.at(-1)],
    ])
      await assert.rejects(
        () =>
          discover(rule, manifest(name), {
            json: async () => ({ ...release, assets }),
          }),
        /Missing or ambiguous Windows release asset/,
      );
  });
}

test("OpenCode uses the baseline build without AVX2 and disables upstream automatic updates", () => {
  const p = platform("opencode");
  assert.match(p.url, /windows-x64-baseline\.zip$/);
  assert.deepEqual(p.env, { OPENCODE_DISABLE_AUTOUPDATE: "1" });
  assert.deepEqual(p.bin, { opencode: "opencode.exe" });
});

test("Nushell retains the full archive but does not claim less, activate plugins or change the login shell", () => {
  const p = platform("nushell");
  assert.deepEqual(p.bin, { nu: "nu.exe" });
  assert.equal(p.files, undefined);
  assert.equal(p.desktop, undefined);
  assert.equal(p.persist, undefined);
  assert.ok(rules.nushell.required.includes("nu_plugin_polars.exe"));
});

test("Lertaro requires approved real-directory service integration without Data junctions", () => {
  const m = manifest("lertaro"), p = platform("lertaro");
  validateManifest(m, "lertaro", m.version);
  assert.equal(p.stripPrefix, "Lertaro");
  assert.equal(p.persist, undefined);
  assert.equal(p.admin.required, true);
  for (const action of ["install", "remove"]) {
    assert.deepEqual(p.admin[action], {
      kind: "powershell",
      path: "piko-service.ps1",
      args: [action, "{root}", "{persist}/.piko-system"],
    });
  }
  assert.deepEqual(Object.keys(p.configFiles), ["piko-service.ps1"]);
  assert.deepEqual(p.bin, { lertaro: "Lertaro.App.exe", lff: "lff.exe" });
  assert.equal(p.depends, undefined);
  assert.ok(rules.lertaro.required.includes("Lertaro.Service.exe"));
});

test("future Lertaro releases retain the required service recipe without persistence links", () => {
  const current = manifest("lertaro"),
    next = nextManifest(
      current,
      { version: "5.14.0", url: "https://example.invalid/Lertaro-Portable.zip" },
      rules.lertaro,
    );
  validateManifest(next, "lertaro", "5.14.0");
  const p = next.platforms["windows-x64"];
  assert.deepEqual(p.admin, current.platforms["windows-x64"].admin);
  assert.equal(p.persist, undefined);
  assert.deepEqual(p.configFiles, current.platforms["windows-x64"].configFiles);
});

test("Lertaro script lifecycle with isolated services and temporary data", { skip: process.platform !== "win32" }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "piko-lertaro-behavior-"));
  t.after(() => rm(temp, { recursive: true, force: true, maxRetries: 10 }));
  const ps = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const recipe = platform("lertaro").configFiles["piko-service.ps1"];
  const harness = String.raw`
$ErrorActionPreference='Stop'
$global:fake=Get-Content -LiteralPath $env:FAKE -Raw|ConvertFrom-Json
function global:Get-CimInstance {
 param($ClassName,$Filter)
 if($ClassName -eq 'Win32_Process'){return @()}
 if($ClassName -ne 'Win32_Service'){throw 'Unexpected CIM boundary'}
 @($global:fake.services)
}
function global:Set-Acl {param($LiteralPath,$AclObject) $global:fake.acls+=@($LiteralPath)}
function global:Start-Sleep {param($Seconds,$Milliseconds) throw 'Unexpected service wait: fake controls must complete synchronously'}
function global:Stop-Process {throw 'A real process must never be killed'}
function global:Start-Process {throw 'A real executable must never be started'}
function global:New-Service {
 param($Name,$DisplayName,$BinaryPathName,$StartupType)
 $global:fake.calls+=@('create:'+ $Name)
 $global:fake.services=@([pscustomobject]@{Name=$Name;PathName=$BinaryPathName;State='Stopped'})
}
function global:robocopy.exe {
 param([string]$Source,[string]$Destination)
 $global:fake.copies+=@(@{source=$Source;destination=$Destination})
 $null=[IO.Directory]::CreateDirectory($Destination)
 if($global:fake.failCopy -or ($global:fake.failRestore -and (Split-Path -Leaf $Destination) -like '.piko-restore-*')){
  [IO.File]::WriteAllText((Join-Path $Destination 'partial-copy'),'incomplete')
  $global:LASTEXITCODE=8
  return
 }
 foreach($item in Get-ChildItem -LiteralPath $Source -Force){Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Destination $item.Name) -Recurse -Force}
 $global:LASTEXITCODE=1
}
function global:sc.exe {
 param([string]$Operation,[string]$Name)
 $global:fake.calls+=@($Operation+':'+$Name)
 $global:LASTEXITCODE=0
 if($Operation -eq 'stop'){@($global:fake.services)|ForEach-Object{$_.State='Stopped'}}
 elseif($Operation -eq 'delete'){
  if($global:fake.failDelete){$global:LASTEXITCODE=5;return}
  $global:fake.services=@()
 }elseif($Operation -eq 'start'){
  if($global:fake.failStart){$global:LASTEXITCODE=5;return}
  @($global:fake.services)|ForEach-Object{$_.State='Running'}
 }elseif($Operation -notin @('config','failure')){throw 'Unexpected service-control operation'}
}
$errorText=$null
try{& $env:RECIPE -Action $env:ACTION -Root $env:ROOT -Data $env:DATA|Out-Null}catch{$errorText=$_.Exception.Message}
@{error=$errorText;services=@($global:fake.services);calls=@($global:fake.calls);copies=@($global:fake.copies);acls=@($global:fake.acls)}|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $env:RESULT -Encoding UTF8
`;
  let sequence = 0;
  const fixture = async (legacy = false) => {
    const home = join(temp, "case " + sequence++), key = "lertaro--0123456789abcdef";
    const folder = legacy ? key : "lertaro", data = join(home, "persist", folder, ".piko-system");
    const versions = ["5.13.1", "5.14.0"], roots = versions.map(v => join(home, "apps", folder, v)), receipts = [];
    await mkdir(data, { recursive: true });
    for (const [i, root] of roots.entries()) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "Lertaro.Service.exe"), "not executable");
      await writeFile(join(root, "piko-service.ps1"), recipe);
      const receipt = { id: "install-" + i, key, name: "lertaro", version: versions[i], ...(legacy ? {} : { layout: "named-v1" }), kind: "portable", verified: true, checksum: "a".repeat(64), manifestHash: "b".repeat(64), source: { identity: "same-source", type: "git" }, dir: "apps/" + folder + "/" + versions[i] };
      receipts.push(receipt);
      await writeFile(join(root, ".piko-install.json"), JSON.stringify(receipt));
    }
    const journal = join(data, "piko-lertaro-service.json");
    const invoke = async (action, root, services = [], flags = {}) => {
      const fake = join(home, "fake.json"), result = join(home, "result.json");
      await writeFile(fake, JSON.stringify({ services, calls: [], copies: [], acls: [], failCopy: false, failRestore: false, failStart: false, failDelete: false, ...flags }));
      execFileSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64")], {
        env: { ...process.env, FAKE: fake, RESULT: result, RECIPE: join(root, "piko-service.ps1"), ROOT: root, DATA: data, ACTION: action }, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse((await readFile(result, "utf8")).replace(/^\uFEFF/, ""));
    };
    const record = async () => JSON.parse((await readFile(journal, "utf8")).replace(/^\uFEFF/, ""));
    const svc = (image) => ({ Name: "LertaroService", PathName: '"' + image + '" --service', State: "Running" });
    return { home, data, roots, receipts, journal, invoke, record, svc };
  };
  await t.test("clean install, cross-version upgrade, uninstall and reinstall preserve actual Data", async () => {
    const f = await fixture(), [old, next] = f.roots;
    let r = await f.invoke("install", old);
    assert.equal(r.error, null);
    assert.equal((await f.record()).phase, "installed");
    assert.deepEqual(r.services, [f.svc(join(old, "Lertaro.Service.exe"))]);
    await writeFile(join(old, "Data/state.txt"), "identity-and-settings");
    await writeFile(join(old, "Data/.hidden"), "hidden-data");
    r = await f.invoke("remove", old, r.services);
    assert.equal(r.error, null);
    assert.deepEqual(r.services, []);
    assert.equal((await f.record()).phase, "removed");
    r = await f.invoke("install", next);
    assert.equal(r.error, null);
    assert.equal(await readFile(join(next, "Data/state.txt"), "utf8"), "identity-and-settings");
    assert.equal(await readFile(join(next, "Data/.hidden"), "utf8"), "hidden-data");
    assert.deepEqual(r.services, [f.svc(join(next, "Lertaro.Service.exe"))]);
    r = await f.invoke("remove", next, r.services);
    assert.equal(r.error, null);
    await rm(join(next, "Data"), { recursive: true });
    await writeFile(join(next, ".piko-install.json"), JSON.stringify({ ...f.receipts[1], id: "reinstalled-version" }));
    r = await f.invoke("install", next);
    assert.equal(r.error, null);
    assert.equal(await readFile(join(next, "Data/state.txt"), "utf8"), "identity-and-settings");
  });
  await t.test("failed backup does not publish a partial generation or delete the service", async () => {
    const f = await fixture(), root = f.roots[0];
    let r = await f.invoke("install", root);
    assert.equal(r.error, null);
    await writeFile(join(root, "Data/state.txt"), "keep-me");
    r = await f.invoke("remove", root, r.services, { failCopy: true });
    assert.match(r.error, /Data copy failed/);
    assert.equal((await f.record()).backups.length, 0);
    assert.ok(!(r.calls.includes("delete:LertaroService")));
    assert.equal(await readFile(join(root, "Data/state.txt"), "utf8"), "keep-me");
    r = await f.invoke("remove", root, r.services);
    assert.equal(r.error, null);
    assert.equal((await f.record()).backups.length, 1);
  });
  await t.test("partial restore and failed service start remain retryable without losing Data", async () => {
    const f = await fixture(), [old, next] = f.roots;
    let r = await f.invoke("install", old);
    assert.equal(r.error, null);
    await writeFile(join(old, "Data/state.txt"), "retry-data");
    r = await f.invoke("remove", old, r.services);
    assert.equal(r.error, null);
    r = await f.invoke("install", next, [], { failRestore: true });
    assert.match(r.error, /Data copy failed/);
    assert.equal((await f.record()).pending.kind, "restore-copying");
    r = await f.invoke("install", next, [], { failStart: true });
    assert.match(r.error, /sc.exe failed/);
    assert.equal((await f.record()).phase, "registering");
    assert.equal(await readFile(join(next, "Data/state.txt"), "utf8"), "retry-data");
    r = await f.invoke("install", next, r.services);
    assert.equal(r.error, null);
    assert.equal((await f.record()).phase, "installed");
  });
  await t.test("target Data conflicts preserve both target and complete backups", async () => {
    const f = await fixture(), [old, next] = f.roots;
    let r = await f.invoke("install", old);
    await writeFile(join(old, "Data/state.txt"), "source");
    r = await f.invoke("remove", old, r.services);
    assert.equal(r.error, null);
    await mkdir(join(next, "Data"));
    await writeFile(join(next, "Data/state.txt"), "conflict");
    r = await f.invoke("install", next);
    assert.match(r.error, /Data conflict/);
    assert.equal(await readFile(join(next, "Data/state.txt"), "utf8"), "conflict");
    const b = (await f.record()).backups[0];
    assert.equal(await readFile(join(f.data, b.generation, "state.txt"), "utf8"), "source");
  });
  await t.test("receipt-proven dangling old executable is migrated without a service journal", async () => {
    const f = await fixture(), [old, next] = f.roots;
    await mkdir(join(old, "Data"));
    await writeFile(join(old, "Data/state.txt"), "legacy-data");
    await rm(join(old, "Lertaro.Service.exe"));
    const r = await f.invoke("install", next, [f.svc(join(old, "Lertaro.Service.exe"))]);
    assert.equal(r.error, null);
    assert.equal(await readFile(join(next, "Data/state.txt"), "utf8"), "legacy-data");
    assert.deepEqual(r.services, [f.svc(join(next, "Lertaro.Service.exe"))]);
  });
  await t.test("external, ambiguous, sibling, unreceipted and foreign-source registrations are untouched", async () => {
    for (const kind of ["external", "ambiguous", "sibling", "unreceipted", "foreign-source"]) {
      const f = await fixture(), [root, other] = f.roots;
      let image = join(f.home, "external/Lertaro.Service.exe");
      if (kind === "sibling") image = join(f.home, "apps/lertaro-extra/5.13.1/Lertaro.Service.exe");
      if (kind === "unreceipted") image = join(f.home, "apps/lertaro/untracked/Lertaro.Service.exe");
      if (kind === "foreign-source") {
        image = join(other, "Lertaro.Service.exe");
        await writeFile(join(other, ".piko-install.json"), JSON.stringify({ ...f.receipts[1], source: { identity: "another-source" } }));
      }
      if (kind === "ambiguous") image = join(root, "Lertaro.Service.exe");
      const entry = f.svc(image);
      if (kind === "ambiguous") entry.PathName = image + " --service --unexpected";
      for (const action of ["install", "remove"]) {
        const r = await f.invoke(action, root, [entry]);
        assert.ok(r.error, kind);
        assert.deepEqual(r.services, [entry], kind);
        assert.deepEqual(r.calls, [], kind);
      }
    }
  });
  await t.test("missing historical Data is an explicit recovery error, not a fresh empty install", async () => {
    const f = await fixture(), [old, next] = f.roots;
    const r = await f.invoke("install", next, [f.svc(join(old, "Lertaro.Service.exe"))]);
    assert.match(r.error, /Previous Data is missing/);
    assert.equal((await f.record()).backups.length, 0);
    assert.ok(!r.calls.includes("create:LertaroService"));
  });
  await t.test("candidate remove and legacy package-key layout are supported", async () => {
    const f = await fixture(true), [old, next] = f.roots;
    let r = await f.invoke("install", old);
    assert.equal(r.error, null);
    const active = r.services;
    r = await f.invoke("remove", next, active);
    assert.equal(r.error, null);
    assert.deepEqual(r.services, active);
    assert.deepEqual(r.calls, []);
    assert.equal((await f.record()).active.root.toLowerCase(), old.toLowerCase());
  });
});

test("NVIDIA App is explicitly an installer-only entry, never a falsely portable app or implicit system install", async () => {
  const p = platform("nvidia-app"),
    rule = rules["nvidia-app"];
  assert.equal(p.format, "file");
  assert.equal(p.file, "NVIDIA_app_setup.exe");
  assert.deepEqual(p.bin, { "nvidia-app-setup": "NVIDIA_app_setup.exe" });
  assert.equal(p.desktop, undefined);
  assert.equal(rule.signature, true);
  // Upstream moved to an architecture directory and an arch-suffixed asset
  // name, publishing arm64 alongside x64. The rule must follow the x64 link
  // and never publish the arm64 build as this package.
  const url = `https://us.download.nvidia.com/nvapp/client/${version}/x64/NVIDIA_app_v${version}_x64.exe`;
  const candidate = await discover(rule, manifest("nvidia-app"), {
    text: async () =>
      `<a href="https://us.download.nvidia.com/nvapp/client/99.99.99/arm64/NVIDIA_app_v99.99.99_arm64.exe">ARM</a><a href="${url}">x64</a>`,
  });
  assert.equal(candidate.url, url);
  assert.equal(candidate.version, version);
});

test("QQNT preserves old versions while using official on-demand authorization for its current channel", async () => {
  const old =
    catalog.manifests.get("qqnt@9.9.33.52230").platforms["windows-x64"];
  assert.match(old.url, /^https:\/\/qqdl\.gtimg\.cn\/qqfile\/QQNT\//);
  const p = platform("qqnt"),
    rule = rules.qqnt;
  assert.equal(p.format, "pe");
  assert.deepEqual(p.nested, [
    { path: ".rsrc/2052/MSI/101", format: "7z", stripPrefix: "Files" },
  ]);
  assert.deepEqual(p.bin, { qq: "QQ.exe", qqnt: "QQ.exe" });
  assert.equal(new URL(p.url).search, "");
  assert.equal(rule.provider, "qqnt");
  assert.equal(rule.versionFromPE, true);
  assert.equal(rule.signature, true);
  assert.equal(p.persist, undefined);
  const url =
    "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe";
  const candidate = await discover(rule, manifest("qqnt"), {
    json: async (endpoint) => {
      assert.equal(
        endpoint,
        "https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json",
      );
      return { Windows: { version: "9.9.36", ntDownloadX64Url: url } };
    },
  });
  assert.equal(candidate.url, url);
  assert.equal(candidate.version, "9.9.36");
  assert.equal(candidate.versionFromPE, true);
});

test("Codex appends the complete native package without changing the previously published version", () => {
  const old = catalog.manifests.get("codex@0.164.0");
  assert.equal(
    old.platforms["windows-x64"].sha256,
    "700116be3143576d006467af8576f7f4c9dada1feddfdb7f69743bfde0997018",
  );
  assert.ok(catalog.manifests.has("codex@0.166.0"));
  assert.equal(platform("codex").format, "tar.gz");
  assert.deepEqual(platform("codex").bin, { codex: "bin/codex.exe" });
});
