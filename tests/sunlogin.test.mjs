import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextManifest, runUpdate } from "../scripts/update.mjs";
import {
  digest,
  loadCatalog,
  validateManifest,
} from "../scripts/lib/catalog.mjs";
import { network } from "../scripts/lib/net.mjs";

const original = JSON.parse(
  await readFile(
    new URL("../packages/sunlogin/16.8.0.33445.json", import.meta.url),
    "utf8",
  ),
);
const revision = JSON.parse(
  await readFile(
    new URL("../packages/sunlogin/16.8.0.33445-piko.1.json", import.meta.url),
    "utf8",
  ),
);

test("Sunlogin revision launches the extracted GUI, not the outer installer", () => {
  validateManifest(revision, "sunlogin", "16.8.0.33445-piko.1");
  const before = original.platforms["windows-x64"];
  const after = revision.platforms["windows-x64"];
  assert.deepEqual(after.bin, {
    sunlogin: "flutter/AweSun.exe",
    awesun: "flutter/AweSun.exe",
  });
  assert.deepEqual(after.desktop.shortcuts, [
    { name: "向日葵", path: "flutter/AweSun.exe" },
  ]);
  assert.deepEqual(after.downloads, before.downloads);
  assert.deepEqual(after.persist, before.persist);
  assert.equal(after.maxExpandedBytes, before.maxExpandedBytes);
  assert.equal(after.admin, undefined);
  assert.equal(after.bootstrap, undefined);
  assert.equal(before.bin.sunlogin, "AweSun.exe");
  assert.equal(before.desktop.shortcuts[0].path, "AweSun.exe");
});

test("future Sunlogin updates retain the GUI command and shortcut targets", () => {
  const next = nextManifest(revision, { version: "16.9.0.40000" }, {});
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

test("Sunlogin index retains the revision and latest keeps the corrected GUI entries", async () => {
  const index = JSON.parse(
    await readFile(new URL("../index.json", import.meta.url), "utf8"),
  );
  assert.equal(
    index.packages.sunlogin.versions[revision.version],
    "packages/sunlogin/16.8.0.33445-piko.1.json",
  );
  const latestFile =
    index.packages.sunlogin.versions[index.packages.sunlogin.latest];
  const latest = JSON.parse(
    await readFile(new URL("../" + latestFile, import.meta.url), "utf8"),
  );
  assert.deepEqual(
    latest.platforms["windows-x64"].bin,
    revision.platforms["windows-x64"].bin,
  );
  assert.deepEqual(
    latest.platforms["windows-x64"].desktop,
    revision.platforms["windows-x64"].desktop,
  );
  const rules = JSON.parse(
    await readFile(
      new URL("../automation/rules.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(rules.packages.sunlogin.required, [
    "flutter/flutter_windows.dll",
    "flutter/data/icudtl.dat",
    "flutter/data/app.so",
  ]);
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
      const file = "packages/sunlogin/" + revision.version + ".json";
      const previousBytes = JSON.stringify(revision, null, 2) + "\n";
      const rules = JSON.parse(
        await readFile(
          new URL("../automation/rules.json", import.meta.url),
          "utf8",
        ),
      );
      await mkdir(join(root, "packages/sunlogin"), { recursive: true });
      await mkdir(join(root, "automation"));
      await writeFile(join(root, file), previousBytes);
      await writeFile(
        join(root, "index.json"),
        JSON.stringify({
          schemaVersion: 1,
          packages: {
            sunlogin: {
              latest: revision.version,
              versions: { [revision.version]: file },
            },
          },
        }),
      );
      await writeFile(
        join(root, "automation/rules.json"),
        JSON.stringify({
          schemaVersion: 1,
          packages: { sunlogin: rules.packages.sunlogin },
        }),
      );
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
      assert.equal(await readFile(join(root, file), "utf8"), previousBytes);
    },
  );
}
