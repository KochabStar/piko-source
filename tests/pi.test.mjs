import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateManifest } from "../scripts/lib/catalog.mjs";
import { discover } from "../scripts/lib/providers.mjs";
import { nextManifest } from "../scripts/update.mjs";

const json = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const index = await json("../index.json");
const entry = index.packages.pi;
const manifest = await json("../" + entry.versions[entry.latest]);
const rules = await json("../automation/rules.json");
const rule = rules.packages.pi;
const platform = manifest.platforms["windows-x64"];
const version = "9.8.7";
const url = `https://github.com/earendil-works/pi/releases/download/v${version}/pi-windows-x64.zip`;
const sha256 = "a".repeat(64);
const release = {
  tag_name: "v" + version,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "pi-windows-arm64.zip",
      browser_download_url: url.replace("x64", "arm64"),
    },
    { name: "pi-linux-x64.tar.gz" },
    { name: `pi-${version}-source.tar.gz` },
    { name: "pi-coding-agent-install-package-lock.json" },
    {
      name: "pi-windows-x64.zip",
      browser_download_url: url,
      digest: "sha256:" + sha256,
      size: 123,
    },
  ],
};

test("Pi catalog uses the complete official native Windows ZIP without running an installer or owning user data", () => {
  validateManifest(manifest, "pi", entry.latest);
  assert.equal(platform.format, "zip");
  assert.equal(
    platform.url,
    `https://github.com/earendil-works/pi/releases/download/v${manifest.version}/pi-windows-x64.zip`,
  );
  assert.deepEqual(platform.bin, { pi: "pi.exe" });
  assert.equal(rule.repo, "earendil-works/pi");
  for (const key of [
    "files",
    "stripPrefix",
    "configFiles",
    "persist",
    "env",
    "shell",
    "bootstrap",
    "admin",
    "depends",
  ])
    assert.equal(platform[key], undefined, key);
  assert.deepEqual(rule.required, [
    "package.json",
    "photon_rs_bg.wasm",
    "theme/dark.json",
    "theme/light.json",
    "assets/clankolas.png",
    "native/win32/prebuilds/win32-x64/win32-platform.node",
  ]);
});

test("Pi discovery selects only the stable Windows x64 binary archive and keeps the publisher SHA256", async () => {
  const candidate = await discover(rule, manifest, {
    json: async (endpoint) => {
      assert.equal(
        endpoint,
        "https://api.github.com/repos/earendil-works/pi/releases/latest",
      );
      return release;
    },
  });
  assert.equal(candidate.version, version);
  assert.equal(candidate.url, url);
  assert.equal(candidate.sha256, sha256);
  assert.equal(candidate.assetBytes, 123);
  const next = nextManifest(manifest, candidate, rule);
  assert.deepEqual(next.platforms["windows-x64"], platform);
  assert.equal(next.version, version);
  validateManifest(next, "pi", version);
});

test("Pi discovery refuses a release missing x64 or publishing ambiguous x64 archives", async () => {
  for (const assets of [
    release.assets.filter((a) => a.name !== "pi-windows-x64.zip"),
    [...release.assets, release.assets.at(-1)],
  ])
    await assert.rejects(
      () =>
        discover(rule, manifest, {
          json: async () => ({ ...release, assets }),
        }),
      /Missing or ambiguous Windows release asset/,
    );
});

test("Pi discovery excludes prereleases even when the latest endpoint returns one", async () => {
  const candidate = await discover(rule, manifest, {
    json: async (endpoint) =>
      endpoint.endsWith("/latest")
        ? { ...release, tag_name: "v10.0.0-beta.1", prerelease: true }
        : [{ ...release, tag_name: "v10.0.0", draft: true }, release],
  });
  assert.equal(candidate.version, version);
  assert.equal(candidate.url, url);
});
