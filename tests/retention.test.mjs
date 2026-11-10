import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  RETENTION_KEEP,
  retainedVersions,
  prunedVersions,
  pruneDocument,
  versionGroup,
} from "../scripts/lib/retention.mjs";
import { appendManifest } from "../scripts/lib/manifest-template.mjs";
import { checkSource } from "../scripts/check.mjs";
import { pruneSource } from "../scripts/prune.mjs";
import { runUpdate } from "../scripts/update.mjs";
import { digest, loadCatalog } from "../scripts/lib/catalog.mjs";
import { network } from "../scripts/lib/net.mjs";

const manifest = (name, version) => ({
  schemaVersion: 1,
  name,
  version,
  platforms: {
    "windows-x64": {
      url: `https://vendor.example/${name}-${version}.zip`,
      sha256: digest(`${name}@${version}`),
      format: "zip",
      bin: { [name]: name + ".exe" },
    },
  },
});

test("version groups keep piko revisions attached to their base version", () => {
  assert.equal(versionGroup("1.0.0"), "1.0.0");
  assert.equal(versionGroup("1.0.0-piko.1"), "1.0.0");
  assert.equal(versionGroup("1.0.0-piko.12"), "1.0.0");
});

test("the window keeps the newest groups and prunes by registration order", () => {
  const entry = {
    versions: {
      "1.0.0": "f", "1.0.0-piko.1": "f", "1.1.0": "f", "1.2.0": "f",
      "1.3.0": "f", "1.4.0": "f", "1.5.0": "f", "1.6.0": "f", "1.7.0": "f",
      "1.7.0-piko.2": "f", "1.8.0": "f",
    },
  };
  // Groups: 1.0.0(+piko.1), 1.1.0 … 1.7.0(+piko.2), 1.8.0 = 9 groups; keep
  // the newest 8, so only 1.0.0 and its revision fall outside the window.
  assert.deepEqual(prunedVersions(entry), ["1.0.0", "1.0.0-piko.1"]);
  const kept = retainedVersions(entry);
  assert.equal(kept.has("1.7.0-piko.2"), true);
  assert.equal(kept.size, 9);
});

test("pruneDocument drops expired rows and orphan recipes, keeps shared ones", () => {
  const base = manifest("demo", "1.0.0"),
    revised = {
      ...base,
      platforms: {
        "windows-x64": {
          ...base.platforms["windows-x64"],
          bin: { demo: "other.exe" },
        },
      },
    };
  let document = appendManifest(undefined, base);
  document = appendManifest(document, { ...base, version: "1.0.0-piko.1", ...{}, platforms: revised.platforms });
  document = appendManifest(document, { ...base, version: "2.0.0" });
  // The 1.0.0 group (2 versions, 2 distinct recipes) is outside a 1-group
  // window; both rows and both recipes must go.
  const pruned = pruneDocument(document, {
    versions: { "1.0.0": "f", "1.0.0-piko.1": "f", "2.0.0": "f" },
  }, 1);
  assert.deepEqual(Object.keys(pruned.versions), ["2.0.0"]);
  assert.equal(Object.keys(pruned.recipes).length, 1);
});

async function fixture(t, versions) {
  const root = await mkdtemp(join(tmpdir(), "piko-retention-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const file = "packages/dev/demo/package.json";
  await mkdir(join(root, "packages/dev/demo"), { recursive: true });
  await mkdir(join(root, "automation"));
  let document;
  const rows = {};
  for (const version of versions) {
    document = appendManifest(document, manifest("demo", version));
    rows[version] = file;
  }
  await writeFile(
    join(root, file),
    JSON.stringify(document, null, 2) + "\n",
  );
  await writeFile(
    join(root, "index.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        packages: {
          demo: { category: "dev", latest: versions.at(-1), versions: rows },
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, "automation/rules.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        demo: {
          provider: "json",
          url: "https://vendor.example/latest.json",
          versionPath: "version",
          urlTemplate: "https://vendor.example/demo-{version}.zip",
        },
      },
    }),
  );
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "--initial-branch=main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Retention fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=" + join(root, "empty-hooks"),
    "commit",
    "-m",
    "baseline",
  ]);
  return { root, git, base: git(["rev-parse", "HEAD"]) };
}

const MANY = [
  "1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0",
  "1.8.0",
];

test("check refuses a package that outgrew the retention window", async (t) => {
  const { root } = await fixture(t, MANY);
  await assert.rejects(
    () => checkSource(root),
    new RegExp("exceeds the retention window"),
  );
  const pruned = await pruneSource(root);
  assert.equal(pruned.versions, 1);
  assert.deepEqual(pruned.planned[0].pruned, ["1.0.0"]);
  const written = await pruneSource(root, { write: true });
  assert.equal(written.written, true);
  await checkSource(root);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  assert.equal(Object.keys(index.packages.demo.versions).length, RETENTION_KEEP);
});

test("check --base allows compliant pruning and refuses window-internal removals", async (t) => {
  const { root, base } = await fixture(t, MANY);
  // Compliant: prune exactly the expired oldest group.
  await pruneSource(root, { write: true });
  await checkSource(root, { base });
  // Non-compliant: remove a version that is inside the retention window,
  // consistently from both the index and the template document.
  const indexPath = join(root, "index.json"),
    file = join(root, "packages/dev/demo/package.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")),
    document = JSON.parse(await readFile(file, "utf8"));
  delete index.packages.demo.versions["1.5.0"];
  delete document.versions["1.5.0"];
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
  await writeFile(file, JSON.stringify(document, null, 2) + "\n");
  await assert.rejects(
    () => checkSource(root, { base }),
    /Previously published version removed: demo@1\.5\.0/,
  );
});

test("the updater prunes to the window while appending a verified version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piko-retention-update-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const file = "packages/dev/demo/package.json";
  await mkdir(join(root, "packages/dev/demo"), { recursive: true });
  await mkdir(join(root, "automation"));
  let document;
  const rows = {};
  for (const version of MANY.slice(0, RETENTION_KEEP)) {
    document = appendManifest(document, manifest("demo", version));
    rows[version] = file;
  }
  await writeFile(join(root, file), JSON.stringify(document, null, 2) + "\n");
  await writeFile(
    join(root, "index.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        packages: {
          demo: { category: "dev", latest: "1.7.0", versions: rows },
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, "automation/rules.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        demo: {
          provider: "json",
          url: "https://vendor.example/latest.json",
          versionPath: "version",
          urlTemplate: "https://vendor.example/demo-{version}.zip",
        },
      },
    }),
  );
  const body = Buffer.from("verified update payload");
  const r = await runUpdate(root, {
    mode: "write",
    discoverer: async () => ({
      version: "2.0.0",
      url: "https://vendor.example/demo-2.0.0.zip",
      sha256: digest(body),
    }),
    net: network({ token: undefined, fetcher: async () => new Response(body) }),
    verify: async () => ({ files: 1, unknownSizeFiles: 0 }),
  });
  assert.equal(r.changed, 1);
  const after = await loadCatalog(root);
  assert.equal(after.index.packages.demo.latest, "2.0.0");
  // The append pushed the window: the oldest registered version fell out.
  assert.deepEqual(Object.keys(after.index.packages.demo.versions), [
    "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "2.0.0",
  ]);
  const doc = JSON.parse(await readFile(join(root, file), "utf8"));
  assert.deepEqual(Object.keys(doc.versions), Object.keys(after.index.packages.demo.versions));
});
