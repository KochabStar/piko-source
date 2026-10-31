import { readFile, lstat, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { resolveManifestDocument } from "./manifest-template.mjs";
export const MiB = 1024 * 1024,
  GiB = 1024 * MiB;
export const digest = (data) => createHash("sha256").update(data).digest("hex");
export const object = (x) =>
  x !== null && typeof x === "object" && !Array.isArray(x);
export function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}
export function component(value) {
  requireThat(
    typeof value === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,159}$/.test(value) &&
      !value.includes(".."),
    "Unsafe package/version component",
  );
  return value;
}
export function pathName(value) {
  requireThat(
    typeof value === "string" &&
      value.length > 0 &&
      value.length < 4096 &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/[\x00-\x1f\x7f<>:"|?*]/.test(value),
    "Unsafe relative path",
  );
  for (const part of value.split("/"))
    requireThat(
      part &&
        part !== "." &&
        part !== ".." &&
        !/[ .]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      "Unsafe Windows path component",
    );
  return value;
}
export function httpsURL(value) {
  const url = new URL(value);
  requireThat(
    url.protocol === "https:" && !url.username && !url.password && !url.hash,
    "Source URLs must use credential-free HTTPS",
  );
  return url;
}
function keys(value, allowed, label) {
  requireThat(
    object(value) && Object.keys(value).every((k) => allowed.includes(k)),
    "Invalid fields in " + label,
  );
}
function texts(value, label) {
  requireThat(
    object(value) &&
      Object.values(value).every(
        (v) => typeof v === "string" && Buffer.byteLength(v) <= 65536,
      ),
    "Invalid " + label,
  );
}
function uniquePaths(paths) {
  const seen = new Set();
  for (const path of paths) {
    pathName(path);
    requireThat(!seen.has(path.toLowerCase()), "Case-colliding path");
    seen.add(path.toLowerCase());
  }
}
export const downloads = (platform) => platform.downloads ?? [platform];
export function validateManifest(m, name, version) {
  keys(m, ["schemaVersion", "name", "version", "platforms"], "manifest");
  requireThat(
    m.schemaVersion === 1 && m.name === name && m.version === version,
    "Manifest identity differs from index",
  );
  component(name);
  component(version);
  keys(m.platforms, ["windows-x64"], "platforms");
  const p = m.platforms["windows-x64"];
  const downloadKeys = [
    "url",
    "sha256",
    "format",
    "file",
    "stripPrefix",
    "into",
    "nested",
    "files",
    "maxBytes",
    "cabinets",
  ];
  keys(
    p,
    [
      ...downloadKeys,
      "downloads",
      "bin",
      "depends",
      "env",
      "persist",
      "configTemplates",
      "configFiles",
      "shell",
      "desktop",
      "bootstrap",
      "admin",
      "maxExpandedBytes",
    ],
    "distribution",
  );
  requireThat(object(p.bin), "Missing command map");
  for (const [command, b] of Object.entries(p.bin)) {
    requireThat(
      /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(command),
      "Invalid command",
    );
    if (typeof b === "string") pathName(b);
    else {
      keys(b, ["path", "kind", "data"], "bin");
      pathName(b.path);
      requireThat(
        ["native", "node", "powershell"].includes(b.kind) &&
          (b.data === undefined || typeof b.data === "boolean"),
        "Invalid bin kind",
      );
    }
  }
  if (p.maxExpandedBytes !== undefined)
    requireThat(
      Number.isSafeInteger(p.maxExpandedBytes) &&
        p.maxExpandedBytes > 0 &&
        p.maxExpandedBytes <= 8 * GiB,
      "Invalid expanded quota",
    );
  if (p.downloads !== undefined)
    requireThat(
      Array.isArray(p.downloads) &&
        p.downloads.length > 0 &&
        p.downloads.length <= 32 &&
        !downloadKeys.some((k) => k in p),
      "Invalid combined downloads",
    );
  for (const d of downloads(p)) {
    if (p.downloads) keys(d, downloadKeys, "download");
    httpsURL(d.url);
    requireThat(/^[a-f0-9]{64}$/i.test(d.sha256), "Release SHA256 required");
    requireThat(
      [
        "file",
        "zip",
        "7z",
        "tar",
        "tar.gz",
        "tar.xz",
        "inno",
        "msi",
        "nsis",
        "pe",
      ].includes(d.format),
      "Unknown archive format",
    );
    if (d.maxBytes !== undefined)
      requireThat(
        Number.isSafeInteger(d.maxBytes) &&
          d.maxBytes > 0 &&
          d.maxBytes <= 2 * GiB,
        "Invalid download quota",
      );
    if (d.format === "file") {
      pathName(d.file);
      requireThat(
        !d.stripPrefix && !d.nested && !d.files,
        "File cannot have archive options",
      );
    } else requireThat(!d.file, "Archive cannot have file target");
    for (const field of ["stripPrefix", "into"])
      if (d[field] !== undefined) pathName(d[field]);
    if (d.files !== undefined) {
      requireThat(
        ["inno", "msi", "nsis"].includes(d.format) &&
          object(d.files) &&
          Object.keys(d.files).length > 0 &&
          Object.keys(d.files).length <= 100000,
        "Invalid explicit file map",
      );
      uniquePaths(Object.keys(d.files));
      uniquePaths(Object.values(d.files));
      for (const target of Object.values(d.files))
        requireThat(
          target.split("/")[0].toLowerCase() !== ".piko-install.json",
          "Reserved output target",
        );
    }
    if (d.nested !== undefined) {
      requireThat(
        ["zip", "7z", "nsis", "pe"].includes(d.format) &&
          !d.files &&
          !d.stripPrefix &&
          Array.isArray(d.nested) &&
          d.nested.length > 0 &&
          d.nested.length <= 3,
        "Invalid nested selection",
      );
      for (const step of d.nested) {
        keys(step, ["path", "format", "stripPrefix"], "nested step");
        pathName(step.path);
        requireThat(
          ["zip", "7z"].includes(step.format),
          "Invalid nested codec",
        );
        if (step.stripPrefix) pathName(step.stripPrefix);
      }
    }
    if (d.format === "pe")
      requireThat(d.nested, "PE requires explicit resource selection");
    if (d.format === "nsis")
      requireThat(
        (d.nested || d.files) && !(d.files && d.stripPrefix),
        "NSIS requires explicit selection",
      );
    if (d.cabinets !== undefined) {
      requireThat(
        d.format === "msi" &&
          object(d.cabinets) &&
          Object.keys(d.cabinets).length > 0 &&
          Object.keys(d.cabinets).length <= 32,
        "Invalid CAB declarations",
      );
      uniquePaths(Object.keys(d.cabinets));
      for (const [name, cabinet] of Object.entries(d.cabinets)) {
        requireThat(!name.includes("/"), "CAB name must be a component");
        keys(cabinet, ["url", "sha256", "maxBytes"], "CAB");
        httpsURL(cabinet.url);
        requireThat(
          /^[a-f0-9]{64}$/i.test(cabinet.sha256),
          "CAB checksum required",
        );
        if (cabinet.maxBytes !== undefined)
          requireThat(
            Number.isSafeInteger(cabinet.maxBytes) &&
              cabinet.maxBytes > 0 &&
              cabinet.maxBytes <= 2 * GiB,
            "Invalid CAB size",
          );
      }
    }
  }
  if (p.configFiles) {
    texts(p.configFiles, "configuration files");
    uniquePaths(Object.keys(p.configFiles));
  }
  if (p.configTemplates) {
    uniquePaths(Object.keys(p.configTemplates));
    for (const t of Object.values(p.configTemplates)) {
      keys(t, ["text"], "template");
      requireThat(typeof t.text === "string", "Invalid template");
    }
  }
  if (p.env) texts(p.env, "environment");
  if (p.shell) {
    keys(p.shell, ["powershell", "bash"], "shell");
    texts(p.shell, "shell");
  }
  if (p.persist) {
    requireThat(Array.isArray(p.persist), "Invalid persistent data");
    uniquePaths(p.persist.map((v) => (typeof v === "string" ? v : v.path)));
    for (const v of p.persist)
      if (typeof v !== "string") {
        keys(v, ["path", "kind", "mode", "initial"], "persistent file");
        requireThat(
          v.kind === "file" &&
            ["hardlink", "seed"].includes(v.mode) &&
            typeof v.initial === "string",
          "Invalid persistent file",
        );
      }
  }
  if (p.depends) {
    requireThat(Array.isArray(p.depends), "Invalid dependencies");
    for (const d of p.depends) {
      keys(d, ["package", "commands"], "dependency");
      requireThat(
        typeof d.package === "string" && !/[\x00-\x20]/.test(d.package),
        "Invalid dependency",
      );
      if (d.commands)
        requireThat(
          Array.isArray(d.commands) &&
            d.commands.every((c) => typeof c === "string"),
          "Invalid dependency commands",
        );
    }
  }
  function exec(v) {
    keys(
      v,
      ["path", "args", "env", "kind", "outputs"],
      "execution declaration",
    );
    pathName(v.path);
    requireThat(
      Array.isArray(v.args) &&
        v.args.every((a) => typeof a === "string" && !/[\0\r\n]/.test(a)),
      "Invalid execution arguments",
    );
    if (v.kind)
      requireThat(
        ["native", "powershell"].includes(v.kind),
        "Invalid execution kind",
      );
    if (v.env) texts(v.env, "execution environment");
    if (v.outputs) uniquePaths(v.outputs);
  }
  if (p.bootstrap) exec(p.bootstrap);
  if (p.admin) {
    keys(p.admin, ["install", "remove"], "admin");
    exec(p.admin.install);
    exec(p.admin.remove);
  }
  if (p.desktop) {
    keys(
      p.desktop,
      ["environment", "path", "shortcuts", "fonts", "associations", "menus"],
      "desktop",
    );
    if (p.desktop.environment)
      texts(p.desktop.environment, "desktop environment");
    if (p.desktop.path) uniquePaths(p.desktop.path);
    if (p.desktop.fonts) uniquePaths(p.desktop.fonts);
    for (const kind of ["shortcuts", "associations", "menus"])
      if (p.desktop[kind]) {
        requireThat(
          Array.isArray(p.desktop[kind]),
          "Invalid desktop declarations",
        );
        for (const v of p.desktop[kind]) {
          pathName(v.path);
          requireThat(
            !v.args ||
              (Array.isArray(v.args) &&
                v.args.every((a) => typeof a === "string")),
            "Invalid desktop arguments",
          );
        }
      }
  }
  return m;
}
export async function noSymlinks(root, file) {
  const rel = relative(root, file);
  requireThat(
    !rel.startsWith("..") &&
      !rel.startsWith("/") &&
      !rel.includes(":") &&
      resolve(root, rel) === resolve(file),
    "Path escapes source",
  );
  let p = root;
  requireThat(!(await lstat(p)).isSymbolicLink(), "Source root is a symlink");
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    p = join(p, part);
    requireThat(!(await lstat(p)).isSymbolicLink(), "Source path is a symlink");
  }
}
export async function loadCatalog(root) {
  root = resolve(root);
  await noSymlinks(root, join(root, "index.json"));
  const indexBytes = await readFile(join(root, "index.json"));
  const index = JSON.parse(indexBytes.toString("utf8"));
  keys(index, ["schemaVersion", "packages"], "index");
  requireThat(
    index.schemaVersion === 1 && object(index.packages),
    "Invalid index",
  );
  const manifests = new Map(),
    documents = new Map(),
    fileBytes = new Map(),
    indexed = new Set();
  for (const [name, entry] of Object.entries(index.packages)) {
    component(name);
    keys(entry, ["latest", "versions", "aliases", "runtime"], "index package");
    requireThat(
      object(entry.versions) && Object.hasOwn(entry.versions, entry.latest),
      "Missing latest manifest",
    );
    if (entry.aliases)
      for (const [alias, version] of Object.entries(entry.aliases)) {
        component(alias);
        requireThat(
          Object.hasOwn(entry.versions, version),
          "Alias points outside catalog",
        );
      }
    if (entry.runtime) {
      keys(entry.runtime, ["family", "distribution"], "runtime");
      component(entry.runtime.family);
      component(entry.runtime.distribution);
    }
    for (const [version, file] of Object.entries(entry.versions)) {
      component(version);
      requireThat(
        file === `packages/${name}/${version}.json` ||
          file === `packages/${name}/package.json`,
        "Noncanonical manifest path",
      );
      if (!documents.has(file)) {
        await noSymlinks(root, join(root, file));
        const bytes = await readFile(join(root, file));
        fileBytes.set(file, bytes);
        documents.set(file, JSON.parse(bytes.toString("utf8")));
      }
      const document = documents.get(file);
      requireThat(
        file !== `packages/${name}/package.json` ||
          document.schemaVersion === 2,
        "Shared package files require a template document",
      );
      const m = validateManifest(
        resolveManifestDocument(document, name, version),
        name,
        version,
      );
      manifests.set(name + "@" + version, m);
      indexed.add(file);
    }
  }
  for (const [file, document] of documents) {
    if (document.schemaVersion !== 2) continue;
    const entry = index.packages[document.name];
    requireThat(
      Object.keys(document.versions).length ===
        Object.values(entry.versions).filter((p) => p === file).length &&
        Object.keys(document.versions).every((v) => entry.versions[v] === file),
      "Template versions differ from index",
    );
    const used = new Set(
      Object.values(document.versions).map((row) => row.recipe),
    );
    requireThat(
      Object.keys(document.recipes).every((id) => used.has(id)),
      "Unreferenced template recipe",
    );
  }
  for (const folder of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    requireThat(
      folder.isDirectory() && !folder.isSymbolicLink(),
      "Unexpected package entry",
    );
    for (const file of await readdir(join(root, "packages", folder.name), {
      withFileTypes: true,
    }))
      requireThat(
        file.isFile() &&
          !file.isSymbolicLink() &&
          indexed.has(`packages/${folder.name}/${file.name}`),
        "Unindexed package manifest",
      );
  }
  return { root, index, manifests, indexBytes, documents, fileBytes };
}
export function validateRules(catalog, config) {
  requireThat(
    config.schemaVersion === 1 && object(config.packages),
    "Invalid updater rules",
  );
  requireThat(
    Object.keys(config.packages).length ===
      Object.keys(catalog.index.packages).length,
    "Every package needs an update policy",
  );
  for (const [name, rule] of Object.entries(config.packages)) {
    requireThat(
      Object.hasOwn(catalog.index.packages, name) && object(rule),
      "Unknown update package",
    );
    requireThat(
      [
        "github-release",
        "github-tags",
        "github-file",
        "node",
        "go",
        "nuget",
        "regex",
        "json",
        "redirect",
        "tabbit",
        "rustup",
        "manual",
      ].includes(rule.provider),
      "Unknown update provider",
    );
    if (rule.provider === "manual")
      requireThat(
        typeof rule.reason === "string" && rule.reason.length > 0,
        "Pinned packages need a reason",
      );
    if (rule.repo)
      requireThat(/^[\w.-]+\/[\w.-]+$/.test(rule.repo), "Invalid repository");
    for (const key of ["versionRegex", "assetRegex", "urlRegex"])
      if (rule[key]) new RegExp(rule[key]);
    if (rule.url) httpsURL(rule.url);
  }
  return config;
}
