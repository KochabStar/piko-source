// Apply the version retention policy to the published catalog.
//
// The updater prunes automatically after appending a new version, so this
// script exists for two cases: pruning an accumulation that predates the
// policy, and auditing what the window would drop today.
//
// Usage:
//   node scripts/prune.mjs --check   (default) report, change nothing
//   node scripts/prune.mjs --write   prune index rows, template version rows
//                                    and recipes no retained version uses

import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, requireThat } from "./lib/catalog.mjs";
import {
  RETENTION_KEEP,
  prunedVersions,
  pruneDocument,
} from "./lib/retention.mjs";

export async function pruneSource(root, { write = false } = {}) {
  const catalog = await loadCatalog(root);
  const changes = [];
  for (const [name, entry] of Object.entries(catalog.index.packages)) {
    const drop = prunedVersions(entry);
    if (!drop.length) continue;
    const file = entry.versions[entry.latest];
    changes.push({
      name,
      file,
      drop,
      document: pruneDocument(catalog.documents.get(file), entry),
    });
  }
  const report = {
    schemaVersion: 1,
    keep: RETENTION_KEEP,
    packages: changes.length,
    versions: changes.reduce((sum, c) => sum + c.drop.length, 0),
    planned: changes.map((c) => ({ name: c.name, pruned: c.drop })),
    written: false,
  };
  if (!write || !changes.length) return report;

  // The source must not move while the prune is being published.
  requireThat(
    (await readFile(join(root, "index.json"))).equals(catalog.indexBytes),
    "Source index changed during pruning; rerun without overwriting concurrent edits",
  );
  const draft = structuredClone(catalog.index),
    replaced = [],
    temporary = [];
  let stage, published = false;
  try {
    for (const change of changes) {
      const path = join(root, change.file);
      requireThat(
        (await readFile(path)).equals(catalog.fileBytes.get(change.file)),
        "Manifest changed during pruning: " + change.file,
      );
      const temp = path + ".tmp-" + process.pid;
      temporary.push(temp);
      await writeFile(
        temp,
        JSON.stringify(change.document, null, 2) + "\n",
        { flag: "wx" },
      );
      await rename(temp, path);
      replaced.push({ path, before: catalog.fileBytes.get(change.file) });
      for (const version of change.drop)
        delete draft.packages[change.name].versions[version];
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
  report.written = true;
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "node scripts/prune.mjs [--check|--write]\nCheck: report what the retention window would drop. Write: prune it.",
    );
  } else {
    requireThat(
      args.length <= 1 && (!args.length || ["--write", "--check"].includes(args[0])),
      "Usage: node scripts/prune.mjs [--check|--write]",
    );
    console.log(
      JSON.stringify(
        await pruneSource(fileURLToPath(new URL("../", import.meta.url)), {
          write: args[0] === "--write",
        }),
        null,
        2,
      ),
    );
  }
}
