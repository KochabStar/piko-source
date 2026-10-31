import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateManifest } from "../scripts/lib/catalog.mjs";
import { discover } from "../scripts/lib/providers.mjs";

const json = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const index = await json("../index.json");
const old = await json("../packages/oh-my-pi/18.13.2.json");
const next = await json("../packages/oh-my-pi/18.14.1.json");
const rule = (await json("../automation/rules.json")).packages["oh-my-pi"];

test("oh-my-pi retains its published pin and registers the CI-verified native update", () => {
  validateManifest(next, "oh-my-pi", "18.14.1");
  assert.equal(
    index.packages["oh-my-pi"].versions["18.13.2"],
    "packages/oh-my-pi/18.13.2.json",
  );
  assert.equal(
    index.packages["oh-my-pi"].versions["18.14.1"],
    "packages/oh-my-pi/18.14.1.json",
  );
  assert.equal(
    old.platforms["windows-x64"].sha256,
    "95c45f53fff419ae4aff5cf07e6af38f297fc7e754947bcb85d9d2253fcae17a",
  );
  assert.deepEqual(next.platforms["windows-x64"].bin, { omp: "omp.exe" });
  assert.equal(next.platforms["windows-x64"].file, "omp.exe");
  assert.equal(next.platforms["windows-x64"].format, "file");
});

test("oh-my-pi discovery resolves the full 18.14.1 version and selects x64 instead of arm64", async () => {
  const p = next.platforms["windows-x64"];
  const candidate = await discover(rule, old, {
    json: async (url) => {
      assert.equal(
        url,
        "https://api.github.com/repos/can1357/oh-my-pi/releases/latest",
      );
      return {
        tag_name: "v18.14.1",
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
  assert.equal(candidate.version, "18.14.1");
  assert.equal(candidate.url, p.url);
  assert.equal(candidate.sha256, p.sha256);
  assert.equal(candidate.assetBytes, 242863104);
});
