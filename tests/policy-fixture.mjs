import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function embedRules(root, config) {
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8").catch(() => "null"));
  for (const [name, rule] of Object.entries(config.packages)) {
    const entry = index?.packages[name];
    const file = entry?.versions[entry.latest] ?? `packages/dev/${name}/package.json`;
    const path = join(root, file);
    const document = JSON.parse(await readFile(path, "utf8"));
    document.upstream = { trust: "https", ...rule };
    await writeFile(path, JSON.stringify(document, null, 2) + "\n");
  }
}
