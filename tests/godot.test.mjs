import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateManifest, validateRules } from "../scripts/lib/catalog.mjs";
import { discover } from "../scripts/lib/providers.mjs";
import { nextManifest } from "../scripts/update.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);
const version = catalog.index.packages.godot.latest;
const manifest = catalog.manifests.get("godot@" + version);
const platform = manifest.platforms["windows-x64"];
// piko.1 is a packaging revision: upstream never publishes a -piko.N artifact,
// so the download URL and payload names keep the upstream version literally.
const upstream = "4.7.2";

test("godot publishes the official Windows x64 editor ZIP without install hooks", () => {
  validateManifest(manifest, "godot", version);
  assert.equal(platform.format, "zip");
  assert.equal(platform.stripPrefix, undefined);
  assert.match(platform.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    platform.url,
    "https://github.com/godotengine/godot/releases/download/" +
      upstream +
      "-stable/Godot_v" +
      upstream +
      "-stable_win64.exe.zip",
  );
  assert.equal(new URL(platform.url).search, "");
  // The upstream ZIP ships exactly these two executables: the editor and the
  // console-attaching wrapper. Both are registered; nothing is filtered out
  // and no file is renamed.
  assert.deepEqual(platform.bin, {
    godot: "Godot_v" + upstream + "-stable_win64.exe",
    "godot-console": "Godot_v" + upstream + "-stable_win64_console.exe",
  });
  assert.equal(platform.maxBytes, 95420416);
  assert.equal(platform.maxExpandedBytes, 268435456);
  for (const key of ["shell", "bootstrap", "admin", "depends"])
    assert.equal(platform[key], undefined, key);
});

test("godot piko.1 adds only the Start Menu launcher for the GUI editor", () => {
  // Without a desktop declaration the installed editor had no launcher at
  // all, so a user could only reach it through the command shims. The GUI
  // editor binary (PE subsystem 2) is the only correct target: the
  // _console.exe wrapper would open a console window instead of the editor.
  assert.deepEqual(platform.desktop, {
    shortcuts: [{ name: "Godot", path: "Godot_v4.7.2-stable_win64.exe" }],
  });
  const published = catalog.manifests.get("godot@4.7.2");
  const expected = structuredClone(published.platforms["windows-x64"]);
  expected.desktop = platform.desktop;
  assert.deepEqual(platform, expected);
  assert.equal(published.desktop, undefined);
  // Same verified payload: a packaging revision never re-identifies the bytes.
  assert.equal(platform.sha256, published.platforms["windows-x64"].sha256);
});

test("godot keeps its native state model: no persist and no env redirection", () => {
  // The Godot editor stores its own settings in %APPDATA%\Godot and project
  // data wherever the user opens it from; the engine also self-contains its
  // per-project .godot directories. Piko does not own or migrate any of it,
  // and the editor does not redirect via environment variables.
  assert.equal(platform.persist, undefined);
  assert.equal(platform.env, undefined);
});

test("godot-console is the upstream console wrapper shipped in the same archive", () => {
  // Since 4.3 the Windows distribution embeds a small _console.exe wrapper
  // next to the main editor binary; it forwards arguments and attaches the
  // console so CLI invocations print when launched from scripts. Both native
  // executables print `4.7.2.stable.official...` for --version, so either
  // command works under a Piko shim.
  assert.deepEqual(Object.keys(platform.bin), ["godot", "godot-console"]);
  for (const path of Object.values(platform.bin))
    assert.match(path, /\.exe$/);
});

test("godot discovery selects the standard win64 editor asset among mono/32-bit/arm64 variants", async () => {
  const rule = rules.packages.godot;
  assert.equal(rule.provider, "github-release");
  assert.equal(rule.repo, "godotengine/godot");
  validateRules(catalog, rules);
  const checksum = "a".repeat(64);
  const asset = (name, extra = {}) => ({
    name,
    browser_download_url:
      "https://github.com/godotengine/godot/releases/download/4.7.3-stable/" +
      name,
    digest: "sha256:" + (extra.digest ?? checksum),
    size: 123,
    ...extra,
  });
  const candidate = await discover(rule, manifest, {
    json: async (url) => {
      assert.equal(
        url,
        "https://api.github.com/repos/godotengine/godot/releases/latest",
      );
      return {
        tag_name: "4.7.3-stable",
        draft: false,
        prerelease: false,
        assets: [
          asset("godot-4.7.3-stable.tar.xz"),
          asset("Godot_v4.7.3-stable_export_templates.tpz"),
          asset("Godot_v4.7.3-stable_linux.x86_64.zip"),
          asset("Godot_v4.7.3-stable_macos.universal.zip"),
          asset("Godot_v4.7.3-stable_mono_win64.zip"),
          asset("Godot_v4.7.3-stable_win32.exe.zip"),
          asset("Godot_v4.7.3-stable_win64.exe.zip", { size: 86013866 }),
          asset("Godot_v4.7.3-stable_windows_arm64.exe.zip"),
          { name: "SHA512-SUMS.txt" },
        ],
      };
    },
  });
  assert.equal(candidate.version, "4.7.3");
  assert.equal(
    candidate.url,
    "https://github.com/godotengine/godot/releases/download/4.7.3-stable/Godot_v4.7.3-stable_win64.exe.zip",
  );
  assert.equal(candidate.sha256, checksum);
  assert.equal(candidate.assetBytes, 86013866);
  assert.equal(candidate.url.includes("mono"), false);
  assert.equal(candidate.url.includes("arm64"), false);
});

test("godot version updates retarget both versioned executables", () => {
  const next = nextManifest(
    manifest,
    {
      version: "4.7.3",
      url: "https://github.com/godotengine/godot/releases/download/4.7.3-stable/Godot_v4.7.3-stable_win64.exe.zip",
      sha256: "b".repeat(64),
      provenance: "https://github.com/godotengine/godot/releases/tag/4.7.3-stable",
    },
    rules.packages.godot,
  );
  const p = next.platforms["windows-x64"];
  assert.equal(next.version, "4.7.3");
  // Upstream names every payload file after the release version, so the
  // updater must retarget both bin entries alongside the download URL.
  assert.deepEqual(p.bin, {
    godot: "Godot_v4.7.3-stable_win64.exe",
    "godot-console": "Godot_v4.7.3-stable_win64_console.exe",
  });
  // The piko.1 revision stores the upstream version literally; the successor
  // must not inherit "4.7.2" in the payload names or the launcher target.
  // nextManifest does not rewrite `url`; the update pipeline assigns the
  // discovered asset URL afterwards, so assert the two agree once applied.
  assert.deepEqual(p.desktop, {
    shortcuts: [{ name: "Godot", path: "Godot_v4.7.3-stable_win64.exe" }],
  });
  p.url = "https://github.com/godotengine/godot/releases/download/4.7.3-stable/Godot_v4.7.3-stable_win64.exe.zip";
  assert.equal(
    new URL(p.url).pathname.endsWith("/" + p.bin.godot + ".zip"),
    true,
    "download asset name and registered command must agree",
  );
  assert.equal(p.persist, undefined);
  assert.equal(p.env, undefined);
  validateManifest(next, "godot", "4.7.3");
});
