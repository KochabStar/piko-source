import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Rebuild the same version-independent recipe for every future upstream release.
// Published manifests remain immutable: only newly generated candidates use it.
export async function tortoiseRecipe(current) {
  const old =
    current.platforms["windows-x64"].configFiles["piko-shell-extension.ps1"];
  const match = /\$values=ConvertFrom-Json @'\r?\n([\s\S]*?)\r?\n'@/.exec(old);
  if (!match) throw Error("TortoiseSVN registry recipe data missing");
  const entries = new Map();
  for (const item of JSON.parse(match[1])) {
    const v = { ...item, key: item.key.replace(/\\+/g, "\\") };
    if (/ShellIconOverlayIdentifiers\\Offline Files$/i.test(v.key)) continue;
    // File associations are not needed for Explorer integration and must not
    // become part of an upgrade's machine-wide default changes.
    if (
      /^Software\\Classes\\(?:\.diff|\.patch|unified_diff_file)(?:\\|$)/i.test(
        v.key,
      )
    )
      continue;
    if (typeof v.value !== "string" || v.kind !== "String")
      throw Error("Unexpected TortoiseSVN registry value");
    v.value = v.value.replace(/\\+/g, "\\");
    if (/^\{\{root\}\}\\.+\.exe(?:\s|$)/i.test(v.value))
      v.value = v.value.replace(/^(\{\{root\}\}\\.+?\.exe)(\s|$)/i, '"$1"$2');
    entries.set(v.key.toLowerCase() + "|" + v.name, v);
  }
  const template = await readFile(
    fileURLToPath(
      new URL("../recipes/tortoise-shell-extension.ps1", import.meta.url),
    ),
    "utf8",
  );
  return template.replace(
    "@@REGISTRY_VALUES@@",
    JSON.stringify([...entries.values()]),
  );
}
export async function applyTortoiseRecipe(manifest) {
  const script = await tortoiseRecipe(manifest);
  manifest.platforms["windows-x64"].configFiles["piko-shell-extension.ps1"] =
    script;
  return manifest;
}
