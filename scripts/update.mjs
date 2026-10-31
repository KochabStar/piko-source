import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  lstat,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  validateRules,
  validateManifest,
  downloads,
  requireThat,
  component,
  MiB,
  GiB,
} from "./lib/catalog.mjs";
import { discover, compareVersions } from "./lib/providers.mjs";
import { network } from "./lib/net.mjs";
import { applyTortoiseRecipe } from "./lib/tortoise-recipe.mjs";
import { Tools } from "./lib/tools.mjs";
import { checkLayout } from "./lib/layout.mjs";
import { appendManifest } from "./lib/manifest-template.mjs";

export function nextManifest(current, candidate, rule) {
  const next = structuredClone(current),
    p = next.platforms["windows-x64"];
  next.version = candidate.version;
  const updatePath = (s) =>
    typeof s === "string"
      ? s.replaceAll(current.version, candidate.version)
      : s;
  for (const d of downloads(p)) {
    for (const key of ["file", "into", "stripPrefix"])
      if (d[key]) d[key] = updatePath(d[key]);
    if (d.nested)
      for (const step of d.nested)
        for (const key of ["path", "stripPrefix"])
          if (step[key]) step[key] = updatePath(step[key]);
    if (d.files)
      d.files = Object.fromEntries(
        Object.entries(d.files).map(([from, to]) => [
          updatePath(from),
          updatePath(to),
        ]),
      );
  }
  if (candidate.stripPrefix)
    downloads(p)[0].stripPrefix = candidate.stripPrefix;
  for (const [name, b] of Object.entries(p.bin))
    if (typeof b === "string") p.bin[name] = updatePath(b);
    else b.path = updatePath(b.path);
  if (rule.layout === "lua") {
    const old = current.version.split(".").slice(0, 2).join(""),
      version = candidate.version.split(".").slice(0, 2).join("");
    for (const [name, b] of Object.entries(p.bin))
      if (
        typeof b === "string" &&
        new RegExp("^(?:lua|luac|wlua)" + old + "\\.exe$").test(b)
      )
        p.bin[name] = b.replace(old + ".exe", version + ".exe");
  }
  for (const kind of ["shortcuts", "fonts", "associations", "menus"])
    if (p.desktop?.[kind])
      p.desktop[kind] = p.desktop[kind].map((e) =>
        typeof e === "string"
          ? updatePath(e)
          : { ...e, path: updatePath(e.path) },
      );
  // Persist paths, configuration code and execution declarations must retain
  // their original meaning. Version-bound code needs an explicit review.
  const sensitive = JSON.stringify({
    persist: p.persist,
    configFiles: p.configFiles,
    configTemplates: p.configTemplates,
    shell: p.shell,
    bootstrap: p.bootstrap,
    admin: p.admin,
  });
  requireThat(
    current.version === candidate.version ||
      !sensitive.includes(current.version),
    "Version-bound configuration/execution code requires manual recipe review",
  );
  return next;
}
export function markdownReport(report) {
  const clean = (s) =>
    String(s ?? "")
      .replace(/[\r\n]/g, " ")
      .replaceAll("|", "\\|")
      .replaceAll("`", "\\`");
  const lines = [
    "# Upstream source update",
    "",
    `Mode: ${report.mode}. Validated changes: ${report.changed}. Blocked: ${report.blocked}.`,
    "",
    "This workflow only reads metadata and unpacks payloads. It does not run downloaded applications, installers, bootstrap hooks, services or drivers. Generated update PRs contain only independently verified package updates and auto-merge after passing catalog checks, tests and an exact verified file-tree match. Blocked packages retain their published versions and do not prevent valid updates from merging; global validation or merge failures still stop publication.",
    "",
    ...(report.mode === "write" && report.changed > 0
      ? [
          report.blocked > 0
            ? "> **Partial success:** Blocked packages keep their published versions. Verified updates can still auto-merge after catalog validation, tests and exact-tree checks pass. The `updated` result means written to the candidate branch, not merged into the default branch or installed locally."
            : "> **Pending merge:** The `updated` result means written to the candidate branch, not merged into the default branch or installed locally. Publication still requires successful validation and an exact verified file-tree match.",
          "",
        ]
      : []),
    "| Package | Current | Upstream | Result | Details |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of report.results)
    lines.push(
      `| ${clean(r.name)} | ${clean(r.current)} | ${clean(r.version)} | ${clean(r.status)} | ${clean(r.reason ?? (r.layout?.reviewSensitive ? "Review shell/admin/bootstrap declarations" : ""))} |`,
    );
  const changed = report.results.filter(
    (r) => r.status === "updated" || r.status === "validated",
  );
  if (changed.length) {
    lines.push("", "## Verified candidates", "");
    for (const r of changed) {
      lines.push(
        `- ${r.name} ${r.version}: ${r.sha256}; ${r.provenance ?? r.url}`,
      );
      if (r.layout?.unknownSizeFiles)
        lines.push(
          `  NSIS has ${r.layout.unknownSizeFiles} files without declared sizes; the Piko runtime still enforces actual output quotas.`,
        );
    }
  }
  lines.push(
    "",
    "Layout/signature checks are not GUI, service/driver or real-data migration certification.",
    "",
  );
  return lines.join("\n");
}
export async function runUpdate(
  root,
  {
    mode = "check",
    packages,
    net = network(),
    discoverer = discover,
    verify = checkLayout,
    tools,
    log = () => {},
  } = {},
) {
  requireThat(
    ["discover", "check", "write"].includes(mode),
    "Unknown update mode",
  );
  const catalog = await loadCatalog(root),
    config = validateRules(
      catalog,
      JSON.parse(await readFile(join(root, "automation/rules.json"), "utf8")),
    );
  const names = packages?.length
    ? [...new Set(packages)]
    : Object.keys(catalog.index.packages);
  for (const name of names)
    requireThat(
      Object.hasOwn(config.packages, name),
      "Unknown package selection: " + name,
    );
  const report = {
      schemaVersion: 1,
      mode,
      checkedAt: new Date().toISOString(),
      changed: 0,
      blocked: 0,
      results: [],
    },
    planned = [];
  const temp = await mkdtemp(join(tmpdir(), "piko-source-update-"));
  tools ??= new Tools(root, net);
  try {
    for (const name of names) {
      const entry = catalog.index.packages[name],
        current = catalog.manifests.get(name + "@" + entry.latest),
        rule = config.packages[name],
        row = { name, current: current.version };
      report.results.push(row);
      log(name + ": checking " + rule.provider);
      let work;
      try {
        const candidate = await discoverer(rule, current, net);
        if (candidate.manual) {
          Object.assign(row, { status: "manual", reason: candidate.reason });
          continue;
        }
        component(candidate.version);
        Object.assign(row, {
          version: candidate.version,
          url: candidate.url,
          provenance: candidate.provenance,
        });
        const oldDownloads = downloads(current.platforms["windows-x64"]),
          old = oldDownloads[0];
        if (!candidate.versionFromPE && !candidate.commitChanged) {
          const comparison = compareVersions(
            candidate.version,
            current.version,
          );
          if (comparison < 0) {
            Object.assign(row, {
              status: "provider-behind",
              reason:
                "Upstream feed is older than the indexed version; no downgrade",
            });
            continue;
          }
          if (comparison === 0) {
            requireThat(
              !candidate.sha256 ||
                candidate.sha256.toLowerCase() === old.sha256.toLowerCase(),
              "Same-version publisher digest changed; immutable manifest retained",
            );
            row.status = "current";
            continue;
          }
          if (Object.hasOwn(entry.versions, candidate.version)) {
            Object.assign(row, {
              status: "already-indexed",
              reason:
                "Version is already published; current latest selection retained",
            });
            continue;
          }
        }
        if (mode === "discover") {
          row.status = candidate.versionFromPE
            ? "inspection-required"
            : "available";
          continue;
        }
        requireThat(
          oldDownloads.every((d) => d.url === old.url),
          "Combined downloads need an explicit per-artifact update recipe",
        );
        work = await mkdtemp(join(temp, name + "-"));
        const artifact = await net.download(
          candidate.url,
          join(work, "distribution.exe"),
          {
            sha256: candidate.sha256,
            sha512: candidate.sha512,
            md5: candidate.md5,
            maxBytes: 2 * GiB,
          },
        );
        if (candidate.versionFromPE && artifact.sha256 === old.sha256) {
          row.version = current.version;
          row.status = "current";
          continue;
        }
        const next = nextManifest(current, candidate, rule);
        if (name === "tortoise-svn") await applyTortoiseRecipe(next);
        const ds = downloads(next.platforms["windows-x64"]);
        for (const d of ds) {
          d.url = candidate.url;
          d.sha256 = artifact.sha256;
          d.maxBytes = Math.min(
            2 * GiB,
            Math.max(
              d.maxBytes ?? 512 * MiB,
              Math.ceil(artifact.bytes / MiB) * MiB + 8 * MiB,
            ),
          );
        }
        const layout = await verify(
          next,
          ds.map(() => artifact),
          rule,
          tools,
          work,
        );
        if (candidate.versionFromPE) {
          component(layout.version);
          row.version = next.version = layout.version;
          requireThat(
            compareVersions(layout.version, current.version) > 0,
            "Distribution changed without a newer application version; existing version retained",
          );
        }
        validateManifest(next, name, next.version);
        requireThat(
          !Object.hasOwn(entry.versions, next.version),
          "Never replace an already-published manifest",
        );
        Object.assign(row, {
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          layout,
          status: mode === "write" ? "updated" : "validated",
        });
        if (mode === "write") planned.push({ name, manifest: next });
      } catch (error) {
        let reason = String(error.message ?? error)
          .split(temp)
          .join("[temporary]")
          .split(resolve(root))
          .join("[source]");
        reason = reason.replace(/[\r\n]/g, " ").slice(0, 700);
        Object.assign(row, { status: "blocked", reason });
        report.blocked++;
        log(name + ": blocked: " + reason);
      } finally {
        if (work)
          await rm(work, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
      }
    }
    if (mode === "write" && planned.length) {
      requireThat(
        (await readFile(join(root, "index.json"))).equals(catalog.indexBytes),
        "Source index changed during verification; rerun without overwriting concurrent edits",
      );
      for (const { name } of planned) {
        const file =
          catalog.index.packages[name].versions[
            catalog.index.packages[name].latest
          ];
        requireThat(
          (await readFile(join(root, file))).equals(
            catalog.fileBytes.get(file),
          ),
          "Manifest changed during verification; rerun without overwriting concurrent edits",
        );
      }
      // Append verified rows to shared package documents, or create legacy
      // version files. Retained resolved manifests stay immutable; restore
      // replaced documents if the index cannot be published.
      const created = [],
        replaced = [],
        temporary = [];
      const draft = structuredClone(catalog.index);
      let published = false,
        stage;
      try {
        for (const { name, manifest } of planned) {
          const entry = catalog.index.packages[name];
          const previousFile = entry.versions[entry.latest];
          const template =
            catalog.documents.get(previousFile)?.schemaVersion === 2;
          const file = template
            ? previousFile
            : `packages/${name}/${manifest.version}.json`;
          const path = join(root, file);
          await mkdir(join(root, "packages", name), { recursive: true });
          if (template) {
            const nextDocument = appendManifest(
              catalog.documents.get(file),
              manifest,
            );
            const tempFile = path + ".tmp-" + process.pid;
            temporary.push(tempFile);
            await writeFile(
              tempFile,
              JSON.stringify(nextDocument, null, 2) + "\n",
              { flag: "wx" },
            );
            requireThat(
              (await readFile(path)).equals(catalog.fileBytes.get(file)),
              "Template changed during verification",
            );
            await rename(tempFile, path);
            replaced.push({ path, before: catalog.fileBytes.get(file) });
          } else {
            try {
              await lstat(path);
              throw Error("Version file already exists: " + file);
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", {
              flag: "wx",
            });
            created.push(path);
          }
          draft.packages[name].versions[manifest.version] = file;
          draft.packages[name].latest = manifest.version;
        }
        stage = join(root, ".tmp-index-" + process.pid + ".json");
        await writeFile(stage, JSON.stringify(draft, null, 2) + "\n", {
          flag: "wx",
        });
        await rename(stage, join(root, "index.json"));
        published = true;
      } finally {
        if (!published) {
          for (const { path, before } of replaced.reverse())
            await writeFile(path, before);
          for (const path of created) await rm(path, { force: true });
        }
        for (const path of temporary) await rm(path, { force: true });
        if (stage) await rm(stage, { force: true });
      }
      await loadCatalog(root);
    }
    report.changed = report.results.filter(
      (r) => r.status === "updated",
    ).length;
    return report;
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "node scripts/update.mjs --discover|--check|--write [--packages name,name]\nDiscover: metadata only. Check: download and validate without writing. Write: append validated versions.",
    );
    return;
  }
  const modes = args.filter((a) =>
    ["--discover", "--check", "--write"].includes(a),
  );
  requireThat(modes.length <= 1, "Choose one update mode");
  const mode = modes[0]?.slice(2) ?? "check";
  let selected = process.env.SOURCE_PACKAGES ?? "";
  for (let i = 0; i < args.length; i++) {
    if (modes.includes(args[i])) continue;
    if (args[i] === "--packages") {
      selected = args[++i] ?? "";
      requireThat(selected, "Missing package selection");
    } else throw Error("Unknown argument: " + args[i]);
  }
  const root = fileURLToPath(new URL("../", import.meta.url)),
    packages = selected ? selected.split(",").map((s) => s.trim()) : undefined;
  const report = await runUpdate(root, {
      mode,
      packages,
      log: (message) => console.log(message),
    }),
    md = markdownReport(report);
  await writeFile(
    join(root, "update-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(join(root, "update-report.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(process.env.GITHUB_STEP_SUMMARY, md, { flag: "a" });
  console.log(
    JSON.stringify(
      {
        mode,
        changed: report.changed,
        blocked: report.blocked,
        results: report.results.map((r) => ({
          name: r.name,
          version: r.version,
          status: r.status,
          reason: r.reason,
        })),
      },
      null,
      2,
    ),
  );
  // Publish completion only after the report and summary were fully written.
  // Per-package failures may still yield a verified subset; fatal failures must
  // never make a stale or incomplete report eligible for automatic merging.
  if (process.env.GITHUB_OUTPUT)
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `changed_count=${report.changed}\nblocked_count=${report.blocked}\nreport_complete=true\n`,
      { flag: "a" },
    );
  if (report.blocked) process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
