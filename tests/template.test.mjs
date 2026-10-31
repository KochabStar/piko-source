import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadCatalog, digest } from "../scripts/lib/catalog.mjs";
import {
  appendManifest,
  resolveManifestDocument,
} from "../scripts/lib/manifest-template.mjs";
import { compactSource } from "../scripts/compact.mjs";
import { runUpdate } from "../scripts/update.mjs";
import { checkSource } from "../scripts/check.mjs";
import { prepareMerge } from "../scripts/auto-merge.mjs";
import { network } from "../scripts/lib/net.mjs";

const artifact = Buffer.from("MZnot an executable, offline fixture only");
const manifest = (name, version, extra = {}) => ({
  schemaVersion: 1,
  name,
  version,
  platforms: {
    "windows-x64": {
      url: `https://vendor.example/${name}-${version}.exe`,
      sha256: digest(artifact),
      format: "file",
      file: name + ".exe",
      bin: { [name]: name + ".exe" },
      ...extra,
    },
  },
});
async function fixture(t, { compact = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "piko-template-source-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const index = { schemaVersion: 1, packages: {} },
    rules = { schemaVersion: 1, packages: {} };
  for (const name of ["demo", "other"]) {
    await mkdir(join(root, "packages", name), { recursive: true });
    const file = `packages/${name}/1.0.0.json`;
    await writeFile(
      join(root, file),
      JSON.stringify(manifest(name, "1.0.0"), null, 2) + "\n",
    );
    index.packages[name] = { latest: "1.0.0", versions: { "1.0.0": file } };
    rules.packages[name] = {
      provider: "json",
      url: `https://vendor.example/${name}.json`,
      versionPath: "version",
      urlTemplate: `https://vendor.example/${name}-{version}.exe`,
    };
  }
  await mkdir(join(root, "automation"));
  await writeFile(join(root, "automation/rules.json"), JSON.stringify(rules));
  await writeFile(
    join(root, "index.json"),
    JSON.stringify(index, null, 2) + "\n",
  );
  if (compact) await compactSource(root, { write: true });
  const git = (args) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "--initial-branch=main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Source fixture",
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
const dependencies = {
  mode: "write",
  packages: ["demo"],
  discoverer: async (_rule, current) => ({
    version: "2.0.0",
    url: `https://vendor.example/${current.name}-2.0.0.exe`,
    sha256: digest(artifact),
  }),
  net: network({
    token: undefined,
    fetcher: async () => new Response(artifact),
  }),
};

test("compaction replaces version files while preserving exact resolved bytes and immutable history", async (t) => {
  const { root, base } = await fixture(t);
  const before = await loadCatalog(root);
  const preview = await compactSource(root);
  assert.equal(preview.written, false);
  assert.deepEqual(await readdir(join(root, "packages/demo")), ["1.0.0.json"]);
  const report = await compactSource(root, { write: true });
  assert.equal(report.written, true);
  const after = await loadCatalog(root);
  for (const [key, m] of before.manifests)
    assert.equal(JSON.stringify(after.manifests.get(key)), JSON.stringify(m));
  assert.deepEqual(await readdir(join(root, "packages/demo")), [
    "package.json",
  ]);
  await checkSource(root, { base });
  assert.equal((await compactSource(root, { write: true })).changedPackages, 0);
});

test("template updates append verified rows without adding files and qualify for exact-tree auto-merge", async (t) => {
  const { root, base } = await fixture(t, { compact: true });
  const original = JSON.stringify(
    (await loadCatalog(root)).manifests.get("demo@1.0.0"),
  );
  const result = await runUpdate(root, dependencies);
  assert.equal(result.changed, 1);
  assert.equal(result.blocked, 0);
  assert.deepEqual(await readdir(join(root, "packages/demo")), [
    "package.json",
  ]);
  const c = await loadCatalog(root);
  assert.equal(c.index.packages.demo.latest, "2.0.0");
  assert.equal(
    c.index.packages.demo.versions["2.0.0"],
    "packages/demo/package.json",
  );
  assert.equal(JSON.stringify(c.manifests.get("demo@1.0.0")), original);
  assert.equal(
    Object.keys(c.documents.get("packages/demo/package.json").recipes).length,
    1,
  );
  await checkSource(root, { base });
  const plan = await prepareMerge(root, result, {
    repository: "owner/piko-source",
  });
  assert.deepEqual(plan.files, ["index.json", "packages/demo/package.json"]);
  assert.deepEqual(
    plan.verifiedUpdates.map((r) => r.version),
    ["2.0.0"],
  );
});

test("a failed template package remains byte-identical while another verified template can merge", async (t) => {
  const { root } = await fixture(t, { compact: true });
  const unchanged = await readFile(join(root, "packages/other/package.json"));
  const result = await runUpdate(root, {
    ...dependencies,
    packages: ["demo", "other"],
    verify: async (m) => {
      if (m.name === "other") throw Error("bad layout");
      return { files: 1 };
    },
  });
  assert.equal(result.changed, 1);
  assert.equal(result.blocked, 1);
  assert.ok(
    unchanged.equals(await readFile(join(root, "packages/other/package.json"))),
  );
  const plan = await prepareMerge(root, result, {
    repository: "owner/piko-source",
  });
  assert.deepEqual(plan.files, ["index.json", "packages/demo/package.json"]);
});

test("shared historical recipe changes are rejected even when a newly added row is verified", async (t) => {
  const { root, base } = await fixture(t, { compact: true });
  const result = await runUpdate(root, dependencies);
  const file = join(root, "packages/demo/package.json");
  const document = JSON.parse(await readFile(file, "utf8"));
  Object.values(document.recipes)[0].platforms["windows-x64"].bin.demo =
    "wrong.exe";
  await writeFile(file, JSON.stringify(document));
  await assert.rejects(() => checkSource(root, { base }), /manifest modified/);
  await assert.rejects(
    () => prepareMerge(root, result, { repository: "owner/piko-source" }),
    /manifest modified/,
  );
});

test("template changes during payload verification block publication and retain the old index", async (t) => {
  const { root } = await fixture(t, { compact: true });
  const index = await readFile(join(root, "index.json"));
  await assert.rejects(
    () =>
      runUpdate(root, {
        ...dependencies,
        verify: async () => {
          const file = join(root, "packages/demo/package.json");
          await writeFile(file, (await readFile(file, "utf8")) + " ");
          return { files: 1 };
        },
      }),
    /changed during verification/,
  );
  assert.ok(index.equals(await readFile(join(root, "index.json"))));
});

test("new shared recipes retain literal configuration and distinct revision payload URLs", () => {
  const first = manifest("demo", "1.0.0", {
    configFiles: { "settings.ini": "version=1.0.0\nroot={root}\n" },
  });
  const revision = manifest("demo", "1.0.0-piko.1", {
    url: first.platforms["windows-x64"].url,
    configFiles: { "settings.ini": "changed literal recipe\n" },
  });
  const document = appendManifest(appendManifest(undefined, first), revision);
  assert.equal(Object.keys(document.recipes).length, 2);
  assert.equal(
    JSON.stringify(resolveManifestDocument(document, "demo", "1.0.0")),
    JSON.stringify(first),
  );
  assert.equal(
    JSON.stringify(resolveManifestDocument(document, "demo", "1.0.0-piko.1")),
    JSON.stringify(revision),
  );
});
