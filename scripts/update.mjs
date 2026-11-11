import {
  readFile,
  writeFile,
  mkdtemp,
  rm,
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
  PLACEHOLDER_SHA256,
  isPlaceholderManifest,
} from "./lib/catalog.mjs";
import { discover, compareVersions } from "./lib/providers.mjs";
import { network } from "./lib/net.mjs";
import { applyTortoiseRecipe } from "./lib/tortoise-recipe.mjs";
import { Tools } from "./lib/tools.mjs";
import { checkLayout } from "./lib/layout.mjs";
import { appendManifest } from "./lib/manifest-template.mjs";
import { pruneDocument } from "./lib/retention.mjs";

export function nextManifest(current, candidate, rule) {
  const next = structuredClone(current),
    p = next.platforms["windows-x64"];
  next.version = candidate.version;
  // A piko.N revision keeps the upstream version literally in its URLs and
  // payload names, because upstream never publishes a "-piko.N" artifact.
  // Retarget both spellings so the next upstream release does not inherit a
  // manifest whose version and payload disagree.
  const upstream = current.version.replace(/-piko\.[0-9]+$/, "");
  const updatePath = (s) =>
    typeof s === "string"
      ? (upstream === current.version
          ? s
          : s.replaceAll(upstream, candidate.version)
        ).replaceAll(current.version, candidate.version)
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
            // A registered placeholder at the feed version falls through to
            // the download path below, which completes it with the measured
            // digest; only verified rows are reported current.
            if (!isPlaceholderManifest(current)) {
              requireThat(
                !candidate.sha256 ||
                  candidate.sha256.toLowerCase() === old.sha256.toLowerCase(),
                "Same-version publisher digest changed; immutable manifest retained",
              );
              row.status = "current";
              continue;
            }
          } else if (Object.hasOwn(entry.versions, candidate.version)) {
            const indexed = catalog.manifests.get(
              name + "@" + candidate.version,
            );
            if (!isPlaceholderManifest(indexed)) {
              Object.assign(row, {
                status: "already-indexed",
                reason:
                  "Version is already published; current latest selection retained",
              });
              continue;
            }
            // Fall through: a registered-but-unverified placeholder is
            // completed by the normal download-and-verify path below.
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
        // A CDN edge can serve the previous build for a newer feed entry, which
        // shows up as a digest that belongs to an older published version. That
        // is a transient cache miss, not a republished build, so retry with a
        // cache-busting query and give up only if every attempt is stale.
        const published = new Map();
        for (const version of Object.keys(entry.versions)) {
          const manifest = catalog.manifests.get(name + "@" + version);
          if (!manifest) continue;
          for (const d of downloads(manifest.platforms["windows-x64"]))
            if (d.sha256)
              published.set(
                d.sha256.toLowerCase(),
                (published.get(d.sha256.toLowerCase()) ?? []).concat(version),
              );
        }
        const publishedAs = (info) =>
          published.get(info.sha256.toLowerCase()) ?? [];
        // The feed reports a three-part version (9.9.37) while the published
        // row is keyed by the PE version (9.9.37.54395), so a digest is only
        // stale when it belongs to a different version family.
        const sameFamily = (version) =>
          version === candidate.version ||
          version.startsWith(candidate.version + ".");
        const stale = (info) =>
          candidate.versionFromPE &&
          publishedAs(info).length > 0 &&
          !publishedAs(info).some(sameFamily);
        let artifact, attempt = 0;
        try {
          for (;;) {
            const url =
              attempt === 0
                ? candidate.url
                : candidate.url.includes("?")
                  ? candidate.url + "&piko-retry=" + attempt
                  : candidate.url + "?piko-retry=" + attempt;
            artifact = await net.download(
              url,
              join(work, "distribution-" + attempt + ".exe"),
              {
                sha256: attempt === 0 ? candidate.sha256 : undefined,
                sha512: attempt === 0 ? candidate.sha512 : undefined,
                md5: attempt === 0 ? candidate.md5 : undefined,
                maxBytes: 2 * GiB,
              },
            );
            if (!stale(artifact) || ++attempt >= 3) break;
            log(
              name +
                ": stale CDN build (sha256 " +
                artifact.sha256.slice(0, 16) +
                "), retrying",
            );
          }
        } catch (downloadError) {
          // A feed-discovered release blocked by a geo-restricted or flaky
          // vendor CDN is still registered with a placeholder digest: the
          // version and its official URL become installable immediately
          // through the client's explicit checksum bypass, and the next run
          // that can actually fetch the payload replaces the placeholder
          // with the measured digest. PE-version probes need the payload to
          // even know the version, so they keep the ordinary blocked path.
          if (
            !(
              !candidate.versionFromPE &&
              downloadError instanceof TypeError &&
              /fetch failed/i.test(String(downloadError.message))
            )
          )
            throw downloadError;
          const next = nextManifest(current, candidate, rule);
          if (name === "tortoise-svn") await applyTortoiseRecipe(next);
          for (const d of downloads(next.platforms["windows-x64"])) {
            d.url = candidate.url;
            d.sha256 = PLACEHOLDER_SHA256;
          }
          validateManifest(next, name, next.version);
          requireThat(
            !Object.hasOwn(entry.versions, next.version) ||
              isPlaceholderManifest(
                catalog.manifests.get(name + "@" + next.version),
              ),
            "Never replace an already-published manifest",
          );
          Object.assign(row, {
            version: next.version,
            status: "registered-unverified",
            reason:
              "Payload fetch blocked by the vendor network; placeholder digest, install with --skip-checksum until a run completes it",
          });
          if (mode === "write") planned.push({ name, manifest: next });
          log(
            name +
              ": registered " +
              next.version +
              " without a verified download (network blocked)",
          );
          continue;
        }
        requireThat(
          !stale(artifact),
          "Feed points at " +
            candidate.version +
            " but every download served the already-published build " +
            publishedAs(artifact).join(",") +
            "; the CDN edge is stale, retry the run",
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
          row.version = layout.version;
          // A feed edge can lag behind what is already published: QQNT's
          // pcConfig.json is served per region, and some edges still answer with
          // the previous build while the newest one is already indexed. That is
          // a stale hint, not a repackaging and not an upstream regression, so
          // it must not fail the run. A digest change for a version that is
          // already published is still refused, because published rows are
          // immutable.
          if (compareVersions(layout.version, current.version) <= 0) {
            // The identity that must stay immutable is the published row for the
            // version actually downloaded, which is not necessarily the latest
            // one. Comparing against the latest row would reject a byte-identical
            // re-download of an older build.
            const sameRow = catalog.manifests.get(name + "@" + layout.version),
              expected = sameRow
                ? downloads(sameRow.platforms["windows-x64"])[0].sha256
                : undefined;
            requireThat(
              expected === undefined ||
                artifact.sha256.toLowerCase() === expected.toLowerCase(),
              "Distribution changed without a newer application version; existing version retained" +
                " (published " +
                layout.version +
                " sha256 " +
                String(expected ?? "unknown").slice(0, 16) +
                ", downloaded " +
                layout.version +
                " sha256 " +
                artifact.sha256.slice(0, 16) +
                ")",
            );
            row.version = current.version;
            Object.assign(row, {
              status: "provider-behind",
              reason:
                "Upstream feed still points at the already-published build " +
                current.version +
                "; the edge is behind, no downgrade",
            });
            continue;
          }
          next.version = layout.version;
        }
        validateManifest(next, name, next.version);
        requireThat(
          !Object.hasOwn(entry.versions, next.version) ||
            isPlaceholderManifest(
              catalog.manifests.get(name + "@" + next.version),
            ),
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
      // Append verified rows to the shared template documents, then apply the
      // retention window so the published catalog never outgrows the policy.
      // Retained resolved manifests stay immutable; restore replaced documents
      // if the index cannot be published.
      const replaced = [],
        temporary = [];
      const draft = structuredClone(catalog.index);
      let published = false,
        stage;
      try {
        for (const { name, manifest } of planned) {
          const entry = catalog.index.packages[name];
          const file = entry.versions[entry.latest];
          const path = join(root, file);
          const nextEntry = {
            ...entry.versions,
            [manifest.version]: file,
          };
          // Completing a placeholder replaces its template row instead of
          // appending a duplicate version; orphaned recipes are dropped.
          let base = catalog.documents.get(file);
          if (Object.hasOwn(base?.versions ?? {}, manifest.version)) {
            const stripped = structuredClone(base);
            delete stripped.versions[manifest.version];
            const used = new Set(
              Object.values(stripped.versions).map((r) => r.recipe),
            );
            for (const id of Object.keys(stripped.recipes))
              if (!used.has(id)) delete stripped.recipes[id];
            base = stripped;
          }
          const nextDocument = pruneDocument(appendManifest(base, manifest), {
            versions: nextEntry,
          });
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
          draft.packages[name].versions = Object.fromEntries(
            Object.keys(nextDocument.versions).map((version) => [
              version,
              file,
            ]),
          );
          draft.packages[name].latest = manifest.version;
        }
        stage = join(root, ".tmp-index-" + process.pid + ".json");
        await writeFile(stage, JSON.stringify(draft, null, 2) + "\n", {
          flag: "wx",
        });
        await rename(stage, join(root, "index.json"));
        published = true;
      } finally {
        if (!published)
          for (const { path, before } of replaced.reverse())
            await writeFile(path, before);
        for (const path of temporary) await rm(path, { force: true });
        if (stage) await rm(stage, { force: true });
      }
      await loadCatalog(root);
    }
    report.changed = report.results.filter((r) =>
      ["updated", "registered-unverified"].includes(r.status),
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
