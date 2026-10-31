import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { component, requireThat, loadCatalog } from "./lib/catalog.mjs";
import { appendManifest } from "./lib/manifest-template.mjs";
import { checkSource } from "./check.mjs";
import { request } from "./lib/net.mjs";

const sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const repositoryName = (v) =>
  typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v);
const branch = "automation/upstream-updates";
const splitNames = (v) => v.split("\0").filter(Boolean);

export async function prepareMerge(
  root,
  report,
  { repository, baseRef = "main" } = {},
) {
  requireThat(repositoryName(repository), "Invalid target repository");
  requireThat(
    typeof baseRef === "string" && baseRef && !baseRef.startsWith("-"),
    "Invalid base branch",
  );
  requireThat(
    report.mode === "write" && Array.isArray(report.results),
    "Auto-merge requires a completed write report",
  );
  const updates = report.results.filter((r) => r.status === "updated");
  requireThat(
    Number.isSafeInteger(report.blocked) &&
      report.blocked >= 0 &&
      report.blocked ===
        report.results.filter((r) => r.status === "blocked").length,
    "Blocked package count differs from the report results",
  );
  requireThat(
    new Set(report.results.map((r) => r.name)).size === report.results.length,
    "Duplicate package results in updater report",
  );
  requireThat(
    Number.isSafeInteger(report.changed) &&
      report.changed > 0 &&
      report.changed === updates.length,
    "No complete verified update set to merge",
  );
  requireThat(
    report.results.every((r) =>
      [
        "updated",
        "current",
        "manual",
        "provider-behind",
        "already-indexed",
        "blocked",
      ].includes(r.status),
    ),
    "Updater report contains unverified results",
  );
  const git = (args, env) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: env ?? process.env,
      maxBuffer: 16 * 1024 * 1024,
    }).trimEnd();
  const baseSha = git(["rev-parse", "HEAD"]);
  requireThat(sha(baseSha), "Invalid baseline commit");
  await checkSource(root, { base: baseSha });
  const expected = new Set(["index.json"]);
  const catalog = await loadCatalog(root);
  const index = catalog.index;
  const expectedIndex = JSON.parse(git(["show", baseSha + ":index.json"]));
  for (const result of report.results)
    requireThat(
      Object.hasOwn(expectedIndex.packages, result.name),
      "Updater report references an unknown baseline package",
    );
  for (const update of updates) {
    component(update.name);
    component(update.version);
    const file = index.packages[update.name]?.versions[update.version];
    requireThat(
      typeof file === "string",
      "Updated version is missing from the index",
    );
    requireThat(!expected.has(file), "Duplicate verified update");
    expected.add(file);
    const entry = index.packages[update.name];
    const baselineEntry = expectedIndex.packages[update.name];
    requireThat(
      !Object.hasOwn(baselineEntry.versions, update.version),
      "Verified updates must append a new package version",
    );
    baselineEntry.versions[update.version] = file;
    baselineEntry.latest = update.version;
    requireThat(
      entry?.latest === update.version &&
        entry.versions[update.version] === file,
      "Report differs from the generated index",
    );
    const manifest = catalog.manifests.get(update.name + "@" + update.version);
    if (file === `packages/${update.name}/package.json`) {
      const previous = JSON.parse(git(["show", baseSha + ":" + file]));
      const expectedDocument = appendManifest(previous, manifest);
      requireThat(
        isDeepStrictEqual(catalog.documents.get(file), expectedDocument),
        "Template contains changes outside the verified update",
      );
    }
    const platform = manifest.platforms["windows-x64"];
    requireThat(
      /^[a-f0-9]{64}$/.test(update.sha256) &&
        (platform.downloads ?? [platform]).every(
          (d) => d.sha256 === update.sha256,
        ),
      "Report differs from verified payload checksums",
    );
  }
  requireThat(
    isDeepStrictEqual(index, expectedIndex),
    "Generated index contains changes outside the verified updates",
  );
  const changed = new Set([
    ...splitNames(git(["diff", "--name-only", "-z", baseSha, "--"])),
    ...splitNames(git(["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
  requireThat(
    changed.size === expected.size &&
      [...changed].every((file) => expected.has(file)),
    "Auto-merge may only include this run's index and verified package files",
  );
  // A separate temporary Git index builds the ENTIRE expected tree without
  // altering the real staging area. The remote PR must match it exactly.
  const temp = await mkdtemp(join(tmpdir(), "piko-merge-index-"));
  let treeSha;
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
    git(["read-tree", baseSha], env);
    git(["add", "--", ...expected], env);
    treeSha = git(["write-tree"], env);
    requireThat(sha(treeSha), "Invalid expected tree");
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  return {
    schemaVersion: 1,
    repository,
    baseRef,
    baseSha,
    headRef: branch,
    treeSha,
    files: [...expected].sort(),
    verifiedUpdates: updates.map(({ name, version, sha256 }) => ({
      name,
      version,
      sha256,
    })),
  };
}

export async function mergeVerified(
  plan,
  {
    number,
    headSha,
    api,
    wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  requireThat(
    plan.schemaVersion === 1 &&
      repositoryName(plan.repository) &&
      plan.headRef === branch &&
      sha(plan.baseSha) &&
      sha(plan.treeSha),
    "Invalid merge verification plan",
  );
  requireThat(
    Number.isSafeInteger(number) && number > 0 && sha(headSha),
    "Missing exact PR number or verified head SHA",
  );
  requireThat(
    Array.isArray(plan.verifiedUpdates) &&
      plan.verifiedUpdates.length > 0 &&
      Array.isArray(plan.files) &&
      plan.files.length === plan.verifiedUpdates.length + 1,
    "Merge plan is incomplete",
  );
  const prefix = "/repos/" + plan.repository;
  let pr;
  for (let attempt = 0; attempt < 6; attempt++) {
    pr = await api("GET", `${prefix}/pulls/${number}`);
    requireThat(
      pr.number === number && pr.state === "open" && !pr.draft && !pr.merged,
      "Only the open generated PR can auto-merge",
    );
    requireThat(
      pr.head.repo?.full_name === plan.repository &&
        pr.base.repo?.full_name === plan.repository &&
        pr.head.ref === branch &&
        pr.base.ref === plan.baseRef,
      "PR repository or branch differs from the verification plan",
    );
    requireThat(
      pr.head.sha === headSha,
      "PR head changed after generation; refusing unverified code",
    );
    requireThat(
      pr.base.sha === plan.baseSha,
      "Default branch advanced after validation; rerun updater",
    );
    if (pr.mergeable !== null) break;
    requireThat(
      attempt < 5,
      "GitHub has not finished computing mergeability; refusing automatic merge",
    );
    await wait(2000);
  }
  requireThat(
    pr.mergeable === true && pr.mergeable_state !== "dirty",
    "Generated PR has conflicts or is not mergeable",
  );
  const commit = await api("GET", `${prefix}/git/commits/${headSha}`);
  requireThat(
    commit.sha === headSha && commit.tree?.sha === plan.treeSha,
    "Remote PR file tree differs from the fully validated local tree",
  );
  const base = await api(
    "GET",
    `${prefix}/git/ref/heads/${encodeURIComponent(plan.baseRef)}`,
  );
  requireThat(
    base.object?.sha === plan.baseSha,
    "Default branch changed during merge checks; rerun updater",
  );
  // No admin bypass, forced push, auto-approval, or broad 'merge all' rule.
  // GitHub's merge endpoint enforces repository policies and atomically
  // requires the exact head SHA verified above.
  const result = await api("PUT", `${prefix}/pulls/${number}/merge`, {
    sha: headSha,
    merge_method: "squash",
    commit_title: "chore(source): merge verified upstream package updates",
  });
  requireThat(
    result.merged === true && sha(result.sha),
    "GitHub did not merge the verified PR",
  );
  return {
    number,
    headSha,
    merged: true,
    mergeSha: result.sha,
    packages: plan.verifiedUpdates.map((r) => r.name),
  };
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const args = process.argv.slice(2);
  requireThat(
    args.length === 1 && ["--prepare", "--merge"].includes(args[0]),
    "Usage: node scripts/auto-merge.mjs --prepare|--merge",
  );
  const file = join(root, "update-merge-plan.json");
  if (args[0] === "--prepare") {
    const report = JSON.parse(
      await readFile(join(root, "update-report.json"), "utf8"),
    );
    const plan = await prepareMerge(root, report, {
      repository: process.env.GITHUB_REPOSITORY,
      baseRef: process.env.GITHUB_REF_NAME,
    });
    await writeFile(file, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    console.log(
      JSON.stringify({
        prepared: true,
        expectedTree: plan.treeSha,
        updatedPackages: plan.verifiedUpdates.map((r) => r.name),
      }),
    );
    return;
  }
  requireThat(process.env.GITHUB_TOKEN, "Missing GitHub workflow token");
  const plan = JSON.parse(await readFile(file, "utf8"));
  requireThat(
    plan.repository === process.env.GITHUB_REPOSITORY,
    "Merge plan repository differs from the workflow",
  );
  const api = async (method, path, body) => {
    requireThat(
      path.startsWith("/repos/" + plan.repository + "/"),
      "API path escaped the target repository",
    );
    const response = await request("https://api.github.com" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response.json();
  };
  const result = await mergeVerified(plan, {
    number: Number(process.env.UPDATE_PR_NUMBER),
    headSha: process.env.UPDATE_PR_HEAD_SHA,
    api,
  });
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Automatic merge\n\nMerged verified update PR #${result.number} as ${result.mergeSha}. Exact payload tree and head SHA matched; no administrator bypass was used.\n`,
      { flag: "a" },
    );
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
