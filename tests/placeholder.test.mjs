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
import { runUpdate } from "../scripts/update.mjs";
import { checkSource } from "../scripts/check.mjs";
import {
  digest,
  loadCatalog,
  downloads,
  PLACEHOLDER_SHA256,
} from "../scripts/lib/catalog.mjs";
import { network } from "../scripts/lib/net.mjs";
import { appendManifest } from "../scripts/lib/manifest-template.mjs";

const body = Buffer.from("verified completion payload");

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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piko-placeholder-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const file = "packages/dev/demo/package.json";
  await mkdir(join(root, "packages/dev/demo"), { recursive: true });
  await mkdir(join(root, "automation"));
  const document = appendManifest(undefined, manifest("demo", "1.0.0"));
  await writeFile(join(root, file), JSON.stringify(document, null, 2) + "\n");
  await writeFile(
    join(root, "index.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        packages: {
          demo: {
            category: "dev",
            latest: "1.0.0",
            versions: { "1.0.0": file },
          },
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
    "user.name=Placeholder fixture",
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
  return { root, git, base: git(["rev-parse", "HEAD"]), file };
}

test("a network-blocked download registers the discovered version with a placeholder digest", async (t) => {
  const { root, base } = await fixture(t);
  const blocked = await runUpdate(root, {
    mode: "write",
    discoverer: async () => ({
      version: "2.0.0",
      url: "https://vendor.example/demo-2.0.0.zip",
    }),
    net: network({
      token: undefined,
      fetcher: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    verify: async () => ({ files: 1, unknownSizeFiles: 0 }),
  });
  assert.equal(blocked.changed, 1);
  assert.equal(
    blocked.results.find((r) => r.name === "demo").status,
    "registered-unverified",
  );
  let catalog = await loadCatalog(root);
  assert.equal(catalog.index.packages.demo.latest, "2.0.0");
  const placeholder = catalog.manifests.get("demo@2.0.0");
  assert.equal(
    downloads(placeholder.platforms["windows-x64"])[0].sha256,
    PLACEHOLDER_SHA256,
  );
  assert.equal(
    downloads(placeholder.platforms["windows-x64"])[0].url,
    "https://vendor.example/demo-2.0.0.zip",
  );
  // The placeholder row itself passes the catalog checks.
  await checkSource(root, { base });

  // A later run that can fetch the payload completes the placeholder.
  const completed = await runUpdate(root, {
    mode: "write",
    discoverer: async () => ({
      version: "2.0.0",
      url: "https://vendor.example/demo-2.0.0.zip",
    }),
    net: network({
      token: undefined,
      fetcher: async () => new Response(body),
    }),
    verify: async () => ({ files: 1, unknownSizeFiles: 0 }),
  });
  assert.equal(completed.changed, 1);
  assert.equal(
    completed.results.find((r) => r.name === "demo").status,
    "updated",
  );
  catalog = await loadCatalog(root);
  const measured = catalog.manifests.get("demo@2.0.0");
  assert.equal(
    downloads(measured.platforms["windows-x64"])[0].sha256,
    digest(body),
  );
  // Completing the placeholder is the one allowed change to a published row.
  await checkSource(root, { base });
});

test("a still-blocked payload keeps its published placeholder instead of re-registering", async (t) => {
  const { root, git } = await fixture(t);
  const blockedRun = () =>
    runUpdate(root, {
      mode: "write",
      discoverer: async () => ({
        version: "2.0.0",
        url: "https://vendor.example/demo-2.0.0.zip",
      }),
      net: network({
        token: undefined,
        fetcher: async () => {
          throw new TypeError("fetch failed");
        },
      }),
      verify: async () => ({ files: 1, unknownSizeFiles: 0 }),
    });
  const first = await blockedRun();
  assert.equal(first.changed, 1);
  assert.equal(
    first.results.find((r) => r.name === "demo").status,
    "registered-unverified",
  );
  // Publish the placeholder the way the auto-merged update PR would.
  git(["add", "."]);
  git([
    "-c",
    "user.name=Placeholder fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=" + join(root, "empty-hooks"),
    "commit",
    "-m",
    "placeholder published",
  ]);
  const second = await blockedRun();
  assert.equal(second.changed, 0);
  const result = second.results.find((r) => r.name === "demo");
  assert.equal(result.status, "already-indexed");
  assert.equal(result.version, "2.0.0");
  // The run claims no change, so the tree must show none either: the
  // auto-merge exact-tree check compares both sets.
  assert.equal(git(["diff", "--name-only", "HEAD", "--"]), "");
  assert.equal(git(["ls-files", "--others", "--exclude-standard"]), "");
});

test("a placeholder may not be modified beyond its digest completion", async (t) => {
  const { root, git, file } = await fixture(t);
  await runUpdate(root, {
    mode: "write",
    discoverer: async () => ({
      version: "2.0.0",
      url: "https://vendor.example/demo-2.0.0.zip",
    }),
    net: network({
      token: undefined,
      fetcher: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    verify: async () => ({ files: 1, unknownSizeFiles: 0 }),
  });
  // The placeholder row is only immutable once published: commit it as the
  // comparison baseline, then attempt an edit beyond the digest completion.
  git(["add", "."]);
  git([
    "-c",
    "user.name=Placeholder fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=" + join(root, "empty-hooks"),
    "commit",
    "-m",
    "placeholder baseline",
  ]);
  const placeholderBase = git(["rev-parse", "HEAD"]);
  // Rewrite the placeholder row with a different bin mapping: the digest
  // completion exception must not open the row to other edits.
  const document = JSON.parse(await readFile(join(root, file), "utf8"));
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  const completed = appendManifest(
    (() => {
      const stripped = structuredClone(document);
      delete stripped.versions["2.0.0"];
      return stripped;
    })(),
    (() => {
      const m = manifest("demo", "2.0.0");
      m.platforms["windows-x64"].sha256 = digest(body);
      m.platforms["windows-x64"].bin = { other: "other.exe" };
      return m;
    })(),
  );
  await writeFile(join(root, file), JSON.stringify(completed, null, 2) + "\n");
  await writeFile(join(root, "index.json"), JSON.stringify(index, null, 2) + "\n");
  await assert.rejects(
    () => checkSource(root, { base: placeholderBase }),
    /Previously published manifest modified: demo@2\.0\.0/,
  );
});
