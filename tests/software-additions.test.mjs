import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("Lertaro keeps its portable Data tree and abandons the vendor's version-anchored service registration", () => {
  const p = platform("lertaro");
  assert.equal(p.stripPrefix, "Lertaro");
  assert.deepEqual(p.persist, ["Data", ".piko-system"]);
  assert.deepEqual(p.bin, { lertaro: "Lertaro.App.exe", lff: "lff.exe" });
  assert.equal(p.depends, undefined);
  assert.ok(rules.lertaro.required.includes("Lertaro.Service.exe"));
  // The vendor registers LertaroService from the running version directory,
  // which Piko replaces, so the start path dies with that directory.
  assert.deepEqual(p.admin, {
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
  const script = p.configFiles["piko-service.ps1"];
  assert.match(script, /Lertaro\.Service\.exe/);
  assert.match(script, /current/);
  assert.match(script, /-ieq \$image/);
  assert.doesNotMatch(script, /5\.13\.1/);
});

test("future Lertaro updates inherit the current-anchored service integration", () => {
  const current = manifest("lertaro"),
    next = nextManifest(
      current,
      { version: "5.14.0", url: "https://example.invalid/Lertaro-Portable.zip" },
      rules.lertaro,
    );
  const p = next.platforms["windows-x64"],
    before = current.platforms["windows-x64"];
  assert.deepEqual(p.admin, before.admin);
  assert.deepEqual(p.persist, before.persist);
  assert.equal(p.configFiles["piko-service.ps1"], before.configFiles["piko-service.ps1"]);
  // The script derives the stable entry from {root}, so a new version does not
  // need a new payload or a re-approved recipe.
  assert.doesNotMatch(p.configFiles["piko-service.ps1"], /5\.13\.1/);
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
