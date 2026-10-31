import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, requireThat, digest } from "./lib/catalog.mjs";
import { appendManifest } from "./lib/manifest-template.mjs";

export async function compactSource(root, { write = false } = {}) {
  const before = await loadCatalog(root);
  const index = structuredClone(before.index);
  const targets = new Map(),
    removed = new Set();
  for (const [name, entry] of Object.entries(index.packages)) {
    let document;
    for (const version of Object.keys(entry.versions)) {
      const manifest = before.manifests.get(name + "@" + version);
      document = appendManifest(document, manifest);
      const previous = entry.versions[version];
      const file = `packages/${name}/package.json`;
      if (previous !== file) removed.add(previous);
      entry.versions[version] = file;
    }
    const file = `packages/${name}/package.json`;
    const bytes = Buffer.from(JSON.stringify(document, null, 2) + "\n");
    if (!before.fileBytes.get(file)?.equals(bytes)) targets.set(file, bytes);
  }
  const report = {
    packages: Object.keys(index.packages).length,
    versions: before.manifests.size,
    filesBefore: before.documents.size,
    filesAfter: Object.keys(index.packages).length,
    changedPackages: targets.size,
    removedFiles: [...removed],
    written: false,
  };
  if (!write || !targets.size) return report;
  requireThat(
    (await readFile(join(root, "index.json"))).equals(before.indexBytes),
    "Index changed during compaction",
  );
  for (const [file, bytes] of before.fileBytes)
    requireThat(
      (await readFile(join(root, file))).equals(bytes),
      "Manifest changed during compaction: " + file,
    );
  const temporary = [],
    written = [];
  try {
    for (const [file, bytes] of targets) {
      const target = join(root, file),
        temp = target + ".tmp-" + process.pid;
      temporary.push(temp);
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, target);
      written.push(file);
    }
    const temp = join(root, ".tmp-index-" + process.pid + ".json");
    temporary.push(temp);
    await writeFile(temp, JSON.stringify(index, null, 2) + "\n", {
      flag: "wx",
    });
    await rename(temp, join(root, "index.json"));
    for (const file of removed) await rm(join(root, file));
    const after = await loadCatalog(root);
    requireThat(
      after.manifests.size === before.manifests.size,
      "Compaction lost a package version",
    );
    for (const [key, manifest] of before.manifests)
      requireThat(
        digest(JSON.stringify(manifest)) ===
          digest(JSON.stringify(after.manifests.get(key))),
        "Compaction changed an installed manifest hash: " + key,
      );
    report.written = true;
    return report;
  } catch (error) {
    for (const file of written)
      if (!before.fileBytes.has(file))
        await rm(join(root, file), { force: true });
    for (const [file, bytes] of before.fileBytes)
      await writeFile(join(root, file), bytes);
    await writeFile(join(root, "index.json"), before.indexBytes);
    throw error;
  } finally {
    for (const file of temporary) await rm(file, { force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  requireThat(
    args.length <= 1 &&
      (!args.length || ["--write", "--check"].includes(args[0])),
    "Usage: node scripts/compact.mjs [--check|--write]",
  );
  console.log(
    JSON.stringify(
      await compactSource(fileURLToPath(new URL("../", import.meta.url)), {
        write: args[0] === "--write",
      }),
      null,
      2,
    ),
  );
}
