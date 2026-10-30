import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareMerge, mergeVerified } from "../scripts/auto-merge.mjs";
import { request } from "../scripts/lib/net.mjs";

const baseSha = "1".repeat(40),
  headSha = "2".repeat(40),
  treeSha = "3".repeat(40),
  mergeSha = "4".repeat(40),
  sha256 = "a".repeat(64);
const plan = () => ({
  schemaVersion: 1,
  repository: "owner/piko-source",
  baseRef: "main",
  baseSha,
  headRef: "automation/upstream-updates",
  treeSha,
  files: ["index.json", "packages/demo/2.0.0.json"],
  verifiedUpdates: [{ name: "demo", version: "2.0.0", sha256 }],
});
const pull = () => ({
  number: 12,
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
  head: {
    ref: "automation/upstream-updates",
    sha: headSha,
    repo: { full_name: "owner/piko-source" },
  },
  base: { ref: "main", sha: baseSha, repo: { full_name: "owner/piko-source" } },
});
function backend({
  mutatePull,
  tree = treeSha,
  base = baseSha,
  merged = true,
} = {}) {
  const calls = [];
  return {
    calls,
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith("/pulls/12") && method === "GET") {
        const p = pull();
        mutatePull?.(p);
        return p;
      }
      if (path.includes("/git/commits/"))
        return { sha: headSha, tree: { sha: tree } };
      if (path.includes("/git/ref/heads/")) return { object: { sha: base } };
      if (method === "PUT" && path.endsWith("/pulls/12/merge"))
        return { merged, sha: mergeSha };
      throw Error("Unexpected API request");
    },
  };
}

test("auto-merge uses squash with the exact verified PR head, never an admin bypass", async () => {
  const b = backend(),
    result = await mergeVerified(plan(), { number: 12, headSha, api: b.api });
  assert.equal(result.merged, true);
  assert.equal(result.mergeSha, mergeSha);
  const writes = b.calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, {
    sha: headSha,
    merge_method: "squash",
    commit_title: "chore(source): merge verified upstream package updates",
  });
});
for (const [name, mutatePull] of [
  ["fork", (p) => (p.head.repo.full_name = "attacker/fork")],
  ["other branch", (p) => (p.head.ref = "feature/arbitrary")],
  ["wrong base", (p) => (p.base.ref = "release")],
  ["changed head", (p) => (p.head.sha = "f".repeat(40))],
  ["advanced base", (p) => (p.base.sha = "f".repeat(40))],
  ["draft", (p) => (p.draft = true)],
  ["closed PR", (p) => (p.state = "closed")],
  [
    "conflict",
    (p) => {
      p.mergeable = false;
      p.mergeable_state = "dirty";
    },
  ],
])
  test("auto-merge refuses " + name, async () => {
    const b = backend({ mutatePull });
    await assert.rejects(() =>
      mergeVerified(plan(), { number: 12, headSha, api: b.api }),
    );
    assert.equal(b.calls.filter((c) => c.method !== "GET").length, 0);
  });
test("remote file-tree mismatch is blocked before writing", async () => {
  const b = backend({ tree: "f".repeat(40) });
  await assert.rejects(
    () => mergeVerified(plan(), { number: 12, headSha, api: b.api }),
    /file tree differs/,
  );
  assert.equal(b.calls.filter((c) => c.method !== "GET").length, 0);
});
test("a default branch change during final checks is blocked", async () => {
  const b = backend({ base: "f".repeat(40) });
  await assert.rejects(
    () => mergeVerified(plan(), { number: 12, headSha, api: b.api }),
    /changed during merge/,
  );
  assert.equal(b.calls.filter((c) => c.method !== "GET").length, 0);
});
test("an unresolved mergeability state is never treated as approval", async () => {
  const b = backend({ mutatePull: (p) => (p.mergeable = null) });
  await assert.rejects(
    () =>
      mergeVerified(plan(), {
        number: 12,
        headSha,
        api: b.api,
        wait: async () => {},
      }),
    /not finished computing/,
  );
  assert.equal(b.calls.filter((c) => c.method !== "GET").length, 0);
});
test("GitHub refusal is surfaced, not replaced by a forced or administrator merge", async () => {
  const b = backend({ merged: false });
  await assert.rejects(
    () => mergeVerified(plan(), { number: 12, headSha, api: b.api }),
    /did not merge/,
  );
  assert.equal(b.calls.filter((c) => c.method === "PUT").length, 1);
});
test("write requests preserve their JSON body and may not follow redirects", async () => {
  let sent;
  await request(
    "https://api.github.com/repos/owner/piko-source/pulls/12/merge",
    {
      method: "PUT",
      body: '{"sha":"verified"}',
      token: "fake-fixture-token",
      fetcher: async (_url, options) => {
        sent = options;
        return new Response('{"merged":true}', {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(sent.body, '{"sha":"verified"}');
  await assert.rejects(
    () =>
      request("https://api.github.com/write", {
        method: "PUT",
        body: "secret",
        fetcher: async () =>
          new Response(null, {
            status: 307,
            headers: { location: "https://other.example/write" },
          }),
      }),
    /redirect a write request/,
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piko-merge-test-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  await mkdir(join(root, "packages/demo"), { recursive: true });
  await mkdir(join(root, "automation"));
  const m = {
      schemaVersion: 1,
      name: "demo",
      version: "1.0.0",
      platforms: {
        "windows-x64": {
          url: "https://vendor.example/demo-1.0.0.zip",
          sha256: "b".repeat(64),
          format: "zip",
          bin: { demo: "demo.exe" },
        },
      },
    },
    index = {
      schemaVersion: 1,
      packages: {
        demo: {
          latest: "1.0.0",
          versions: { "1.0.0": "packages/demo/1.0.0.json" },
        },
      },
    };
  await writeFile(join(root, "packages/demo/1.0.0.json"), JSON.stringify(m));
  await writeFile(join(root, "index.json"), JSON.stringify(index));
  await writeFile(
    join(root, "automation/rules.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: { demo: { provider: "manual", reason: "test fixture" } },
    }),
  );
  await writeFile(
    join(root, ".gitignore"),
    "/update-report.json\n/update-merge-plan.json\n",
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
    "user.name=Fixture",
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
  m.version = "2.0.0";
  m.platforms["windows-x64"].sha256 = sha256;
  m.platforms["windows-x64"].url = "https://vendor.example/demo-2.0.0.zip";
  index.packages.demo.latest = "2.0.0";
  index.packages.demo.versions["2.0.0"] = "packages/demo/2.0.0.json";
  await writeFile(join(root, "packages/demo/2.0.0.json"), JSON.stringify(m));
  await writeFile(join(root, "index.json"), JSON.stringify(index));
  const report = {
    mode: "write",
    changed: 1,
    blocked: 0,
    results: [{ name: "demo", version: "2.0.0", sha256, status: "updated" }],
  };
  return { root, git, report };
}
test("prepare binds the entire candidate tree and does not mutate the real index", async (t) => {
  const { root, git, report } = await fixture(t),
    before = git(["diff", "--cached", "--name-only"]);
  const p = await prepareMerge(root, report, {
    repository: "owner/piko-source",
    baseRef: "main",
  });
  assert.equal(p.files.length, 2);
  assert.equal(p.baseSha, git(["rev-parse", "HEAD"]));
  assert.match(p.treeSha, /^[a-f0-9]{40}$/);
  assert.equal(git(["diff", "--cached", "--name-only"]), before);
  git(["add", "index.json", "packages/demo/2.0.0.json"]);
  assert.equal(p.treeSha, git(["write-tree"]));
});
test("any failed upstream prevents preparation even when another candidate is valid", async (t) => {
  const { root, report } = await fixture(t);
  report.blocked = 1;
  await assert.rejects(
    () => prepareMerge(root, report, { repository: "owner/piko-source" }),
    /zero blocked/,
  );
});
test("unexpected workflow or script changes cannot enter an automatic update merge", async (t) => {
  const { root, report } = await fixture(t);
  await writeFile(
    join(root, "unexpected-script.mjs"),
    "throw Error('must not merge');",
  );
  await assert.rejects(
    () => prepareMerge(root, report, { repository: "owner/piko-source" }),
    /only include this run/,
  );
});
test("payload checksum divergence from the updater report is blocked", async (t) => {
  const { root, report } = await fixture(t);
  report.results[0].sha256 = "f".repeat(64);
  await assert.rejects(
    () => prepareMerge(root, report, { repository: "owner/piko-source" }),
    /payload checksums/,
  );
});
test("ignored local reports never become part of the PR tree", async (t) => {
  const { root, git, report } = await fixture(t);
  await writeFile(join(root, "update-report.json"), JSON.stringify(report));
  await writeFile(
    join(root, "update-merge-plan.json"),
    "local verification only",
  );
  const p = await prepareMerge(root, report, {
    repository: "owner/piko-source",
  });
  assert.deepEqual(p.files, ["index.json", "packages/demo/2.0.0.json"]);
  assert.equal(
    git(["ls-files", "update-report.json", "update-merge-plan.json"]),
    "",
  );
});
