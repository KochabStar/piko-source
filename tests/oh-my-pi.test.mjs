import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateManifest, loadCatalog } from "../scripts/lib/catalog.mjs";
import { fileURLToPath } from "node:url";
import { discover } from "../scripts/lib/providers.mjs";

const json = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const index = await json("../index.json");
const catalog = await loadCatalog(
  fileURLToPath(new URL("../", import.meta.url)),
);
// The retention window pruned 18.13.2 and 18.14.1; the oldest retained
// version anchors the discovery comparison.
const old = catalog.manifests.get("oh-my-pi@18.14.2");
const next = catalog.manifests.get("oh-my-pi@18.18.6");
const rule = (await json("../automation/rules.json")).packages["oh-my-pi"];

test("oh-my-pi keeps the retention window and a valid latest manifest", () => {
  validateManifest(next, "oh-my-pi", "18.18.6");
  assert.equal(index.packages["oh-my-pi"].category, "ai");
  assert.equal(
    index.packages["oh-my-pi"].versions["18.14.2"],
    "packages/ai/oh-my-pi/package.json",
  );
  assert.equal(index.packages["oh-my-pi"].versions["18.13.2"], undefined);
  assert.equal(index.packages["oh-my-pi"].versions["18.14.1"], undefined);
  assert.equal(Object.keys(index.packages["oh-my-pi"].versions).length, 8);
  assert.equal(
    index.packages["oh-my-pi"].versions[index.packages["oh-my-pi"].latest],
    "packages/ai/oh-my-pi/package.json",
  );
  assert.deepEqual(next.platforms["windows-x64"].bin, { omp: "omp.exe" });
  assert.equal(next.platforms["windows-x64"].file, "omp.exe");
  assert.equal(next.platforms["windows-x64"].format, "file");
});

test("oh-my-pi discovery resolves the full upstream version and selects x64 instead of arm64", async () => {
  const p = next.platforms["windows-x64"];
  const candidate = await discover(rule, old, {
    json: async (url) => {
      assert.equal(
        url,
        "https://api.github.com/repos/can1357/oh-my-pi/releases/latest",
      );
      return {
        tag_name: "v18.19.0",
        draft: false,
        prerelease: false,
        assets: [
          { name: "omp-windows-arm64.exe" },
          { name: "omp-browser-relay-extension.zip" },
          {
            name: "omp-windows-x64.exe",
            browser_download_url: p.url,
            digest: "sha256:" + p.sha256,
            size: 242863104,
          },
        ],
      };
    },
  });
  assert.equal(candidate.version, "18.19.0");
  assert.equal(candidate.url, p.url);
  assert.equal(candidate.sha256, p.sha256);
  assert.equal(candidate.assetBytes, 242863104);
});
