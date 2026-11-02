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
  "lertaro",
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

test("Lertaro preserves its native portable Data tree and does not automatically install .NET or a service", () => {
  const p = platform("lertaro");
  assert.equal(p.stripPrefix, "Lertaro");
  assert.deepEqual(p.persist, ["Data"]);
  assert.deepEqual(p.bin, { lertaro: "Lertaro.App.exe", lff: "lff.exe" });
  assert.equal(p.configFiles, undefined);
  assert.equal(p.depends, undefined);
  assert.ok(rules.lertaro.required.includes("Lertaro.Service.exe"));
});

test("NVIDIA App is explicitly an installer-only entry, never a falsely portable app or implicit system install", async () => {
  const p = platform("nvidia-app"),
    rule = rules["nvidia-app"];
  assert.equal(p.format, "file");
  assert.equal(p.file, "NVIDIA_app_setup.exe");
  assert.deepEqual(p.bin, { "nvidia-app-setup": "NVIDIA_app_setup.exe" });
  assert.equal(p.desktop, undefined);
  assert.equal(rule.signature, true);
  const url = `https://us.download.nvidia.com/nvapp/client/${version}/NVIDIA_app_v${version}.exe`;
  const candidate = await discover(rule, manifest("nvidia-app"), {
    text: async () =>
      `<a href="https://us.download.nvidia.com/nvapp/client/99.99.99/NVIDIA_app_arm64_v99.99.99.exe">ARM</a><a href="${url}">x64</a>`,
  });
  assert.equal(candidate.url, url);
  assert.equal(candidate.version, version);
});

test("QQNT retains a durable official artifact and selects only its embedded application archive", async () => {
  const p = platform("qqnt"),
    rule = rules.qqnt;
  assert.equal(p.format, "pe");
  assert.deepEqual(p.nested, [
    { path: ".rsrc/2052/MSI/101", format: "7z", stripPrefix: "Files" },
  ]);
  assert.deepEqual(p.bin, { qq: "QQ.exe", qqnt: "QQ.exe" });
  assert.match(p.url, /^https:\/\/qqdl\.gtimg\.cn\/qqfile\/QQNT\//);
  assert.equal(rule.provider, "manual");
  assert.match(rule.reason, /short-lived signature/);
  assert.equal(rule.verifyPEVersion, true);
  assert.equal(rule.signature, true);
  assert.equal(p.persist, undefined);
  assert.equal(p.configFiles, undefined);
  assert.equal(
    (
      await discover(rule, manifest("qqnt"), {
        json: () => assert.fail("manual discovery must not access the network"),
      })
    ).manual,
    true,
  );
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
