import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const workflow = await readFile(
  new URL("../.github/workflows/update-source.yml", import.meta.url),
  "utf8",
);
const steps = workflow.split(/^      - name: /m).slice(1);
const step = (name) => {
  const block = steps.find((s) => s.startsWith(name + "\n"));
  assert.ok(block, "Missing workflow step: " + name);
  return block;
};
const condition = (name) => {
  const result = /^        if: (.+)$/m.exec(step(name));
  assert.ok(result, "Missing condition: " + name);
  return result[1];
};

// Evaluate the workflow's comparison-only gates, not an independently copied
// policy, so a future accidental outcome=='success' gate breaks these tests.
function eligible(name, state) {
  return condition(name)
    .split(" && ")
    .every((term) => {
      const match =
        /^steps\.([a-z_]+)\.(outcome|outputs\.[a-z_-]+) (!=|==) '([^']*)'$/.exec(
          term,
        );
      assert.ok(match, "Unsupported gate expression: " + term);
      const [, id, field, operator, expected] = match;
      const value =
        field.split(".").reduce((v, key) => v?.[key], state[id]) ?? "";
      return operator === "==" ? value === expected : value !== expected;
    });
}
const bind = "Bind verified package updates to their exact file tree";
const open = "Open or refresh the update PR";
const merge = "Auto-merge the fully verified update PR";
const state = () => ({
  update: {
    outcome: "failure",
    outputs: {
      report_complete: "true",
      changed_count: "1",
      blocked_count: "1",
    },
  },
  prepare_merge: { outcome: "success" },
  update_pr: {
    outputs: {
      "pull-request-number": "12",
      "pull-request-head-sha": "2".repeat(40),
    },
  },
});

test("workflow continues from a per-package failure to bind, create and merge verified updates", () => {
  const s = state();
  for (const name of [bind, open, merge]) assert.equal(eligible(name, s), true);
  assert.match(
    step("Discover, download and verify upstream changes"),
    /continue-on-error: true/,
  );
  assert.ok(steps.indexOf(step(bind)) < steps.indexOf(step(open)));
  assert.ok(steps.indexOf(step(open)) < steps.indexOf(step(merge)));
  const report = step("Report blocked upstreams or updater failure");
  assert.ok(steps.indexOf(step(merge)) < steps.indexOf(report));
  assert.match(report, /if: always\(\) && steps\.update\.outcome == 'failure'/);
  assert.match(report, /exit 1/);
});

test("workflow refuses incomplete, fatal and empty runs before preparing a PR", () => {
  for (const outputs of [
    {},
    { changed_count: "1", blocked_count: "1" },
    { report_complete: "false", changed_count: "1" },
    { report_complete: "true", changed_count: "0", blocked_count: "1" },
    { report_complete: "true", changed_count: "0", blocked_count: "0" },
  ]) {
    const s = state();
    s.update.outputs = outputs;
    assert.equal(eligible(bind, s), false);
  }
});

test("PR creation and automatic merging require successful exact-tree preparation", () => {
  for (const outcome of ["failure", "skipped", "cancelled"]) {
    const s = state();
    s.prepare_merge.outcome = outcome;
    assert.equal(eligible(open, s), false);
    assert.equal(eligible(merge, s), false);
  }
  for (const key of ["pull-request-number", "pull-request-head-sha"]) {
    const s = state();
    delete s.update_pr.outputs[key];
    assert.equal(eligible(merge, s), false);
  }
});

async function cliFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piko-update-cli-test-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
  await mkdir(join(root, "scripts/lib"), { recursive: true });
  for (const name of ["update.mjs", "check.mjs"])
    await writeFile(
      join(root, "scripts", name),
      await readFile(join(scripts, name)),
    );
  // The updater resolves its catalog relative to its own script. Copy only its
  // small standard-library modules; no network or project dependencies needed.
  for (const name of await readdir(join(scripts, "lib")))
    await writeFile(
      join(root, "scripts/lib", name),
      await readFile(join(scripts, "lib", name)),
    );
  await mkdir(join(root, "automation"));
  await mkdir(join(root, "packages/demo"), { recursive: true });
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        demo: {
          latest: "1.0.0",
          versions: { "1.0.0": "packages/demo/1.0.0.json" },
        },
      },
    }),
  );
  await writeFile(
    join(root, "packages/demo/1.0.0.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "demo",
      version: "1.0.0",
      platforms: {
        "windows-x64": {
          url: "https://vendor.example/demo.exe",
          sha256: "a".repeat(64),
          format: "file",
          file: "demo.exe",
          bin: { demo: "demo.exe" },
        },
      },
    }),
  );
  await writeFile(
    join(root, "automation/rules.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: { demo: { provider: "manual", reason: "Offline fixture" } },
    }),
  );
  return {
    root,
    output: join(root, "outputs"),
    summary: join(root, "summary"),
  };
}

test("updater publishes the completion marker only after writing a complete report and summary", async (t) => {
  const { root, output, summary } = await cliFixture(t);
  execFileSync(
    process.execPath,
    [join(root, "scripts/update.mjs"), "--write"],
    {
      cwd: root,
      env: {
        ...process.env,
        SOURCE_PACKAGES: "",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  assert.equal(
    await readFile(output, "utf8"),
    "changed_count=0\nblocked_count=0\nreport_complete=true\n",
  );
  const report = JSON.parse(
    await readFile(join(root, "update-report.json"), "utf8"),
  );
  assert.equal(report.results[0].status, "manual");
  assert.match(await readFile(summary, "utf8"), /Upstream source update/);
});

test("a real partial CLI run exits nonzero but publishes a complete report for its successful subset", async (t) => {
  const { root, output, summary } = await cliFixture(t);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const other = JSON.parse(
    await readFile(join(root, "packages/demo/1.0.0.json"), "utf8"),
  );
  other.name = "other";
  other.platforms["windows-x64"].bin = { other: "other.exe" };
  await mkdir(join(root, "packages/other"));
  await writeFile(
    join(root, "packages/other/1.0.0.json"),
    JSON.stringify(other),
  );
  index.packages.other = {
    latest: "1.0.0",
    versions: { "1.0.0": "packages/other/1.0.0.json" },
  };
  await writeFile(indexPath, JSON.stringify(index));
  await writeFile(
    join(root, "automation/rules.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: Object.fromEntries(
        ["demo", "other"].map((name) => [
          name,
          {
            provider: "json",
            url: `https://vendor.example/${name}.json`,
            versionPath: "version",
            urlTemplate: `https://vendor.example/${name}-{version}.exe`,
          },
        ]),
      ),
    }),
  );
  const payload = "MZoffline fixture, not an executable";
  const checksum = createHash("sha256").update(payload).digest("hex");
  const mock = join(root, "offline-network.mjs");
  await writeFile(
    mock,
    `globalThis.fetch = async (url) => {
    switch (String(url)) {
      case "https://vendor.example/demo.json": return new Response(JSON.stringify({ version: "2.0.0" }));
      case "https://vendor.example/demo-2.0.0.exe": return new Response(${JSON.stringify(payload)});
      case "https://vendor.example/other.json": return new Response("fixture failure", { status: 500 });
      default: throw Error("Unexpected network call: " + url);
    }
  };`,
  );
  let failure;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(mock).href,
        join(root, "scripts/update.mjs"),
        "--write",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          SOURCE_PACKAGES: "",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.status, 1);
  assert.equal(
    await readFile(output, "utf8"),
    "changed_count=1\nblocked_count=1\nreport_complete=true\n",
  );
  const report = JSON.parse(
    await readFile(join(root, "update-report.json"), "utf8"),
  );
  assert.deepEqual(
    report.results.map((r) => r.status),
    ["updated", "blocked"],
  );
  assert.equal(report.results[0].sha256, checksum);
  const after = JSON.parse(await readFile(indexPath, "utf8"));
  assert.equal(after.packages.demo.latest, "2.0.0");
  assert.deepEqual(after.packages.other, index.packages.other);
  await assert.rejects(
    () => readFile(join(root, "packages/other/2.0.0.json")),
    { code: "ENOENT" },
  );
  assert.match(await readFile(summary, "utf8"), /Partial success/);
});

test("a fatal summary-write failure cannot mark a report as complete for merging", async (t) => {
  const { root, output } = await cliFixture(t);
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [join(root, "scripts/update.mjs"), "--write"],
      {
        cwd: root,
        env: {
          ...process.env,
          SOURCE_PACKAGES: "",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  await assert.rejects(() => readFile(output), { code: "ENOENT" });
});
