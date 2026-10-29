import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateRules, requireThat } from "./lib/catalog.mjs";
export async function checkSource(root, { base } = {}) {
  const catalog = await loadCatalog(root),
    config = validateRules(
      catalog,
      JSON.parse(await readFile(join(root, "automation/rules.json"), "utf8")),
    );
  if (base) {
    requireThat(
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base),
      "Base must be a full commit hash",
    );
    const show = (file) =>
      execFileSync("git", ["show", base + ":" + file], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      });
    const before = JSON.parse(show("index.json").toString("utf8"));
    for (const [name, entry] of Object.entries(before.packages))
      for (const [version, file] of Object.entries(entry.versions)) {
        requireThat(
          catalog.index.packages[name]?.versions[version] === file,
          "Previously published version removed or repointed: " +
            name +
            "@" +
            version,
        );
        requireThat(
          show(file).equals(await readFile(join(root, file))),
          "Previously published manifest modified: " + file,
        );
      }
  }
  return {
    packages: Object.keys(catalog.index.packages).length,
    versions: catalog.manifests.size,
    automatic: Object.values(config.packages).filter(
      (r) => r.provider !== "manual",
    ).length,
    manual: Object.entries(config.packages)
      .filter(([, r]) => r.provider === "manual")
      .map(([name]) => name),
  };
}
async function main() {
  const args = process.argv.slice(2);
  requireThat(
    !args.length || (args.length === 2 && args[0] === "--base"),
    "Usage: node scripts/check.mjs [--base full-commit-hash]",
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  console.log(
    JSON.stringify(
      await checkSource(root, {
        base: args[1] ?? process.env.BASE_SHA ?? undefined,
      }),
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
