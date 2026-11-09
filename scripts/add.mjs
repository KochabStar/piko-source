// One-command package scaffolding.
//
// Adding a package used to mean: find the download URL by hand, guess the
// archive format, download it, write the manifest and the update rule, build an
// explicit file map from scratch (752 entries for the CloudDrive2 bundle), then
// run the whole check suite to find out whether any of it was right.
//
// This script does the mechanical half: fetch, sniff the real container format,
// derive the file list, and verify with the same checkLayout the updater uses.
// Nothing is published unless that verification passes, and nothing is guessed
// silently — every inferred value is printed with the evidence behind it.
//
// Usage:
//   node scripts/add.mjs probe <name> <release-page-or-asset-url> [--version <v>]
//   node scripts/add.mjs apply <name> --dry-run | --yes
//
// Typical flow:
//   node scripts/add.mjs probe codex https://github.com/openai/codex/releases
//   # review automation/drafts/codex.json, fill in bin/desktop
//   node scripts/add.mjs apply codex --dry-run
//   node scripts/add.mjs apply codex --yes

import { open, readFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { requireThat, GiB, MiB } from "./lib/catalog.mjs";
import {
  burnPayloadChain,
  checkLayout,
  innoEntries,
  listing,
  resolveBurnPayload,
} from "./lib/layout.mjs";
import { readMsiPlan } from "./lib/msi.mjs";
import { network } from "./lib/net.mjs";
import { compareVersions } from "./lib/providers.mjs";
import { Tools, capture } from "./lib/tools.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const draftPath = (name) => join(root, "automation/drafts", name + ".json");

async function head(file, bytes = 64) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Positive structural tests in priority order. A failed probe is not an error:
// a zip simply is not an MSI. The file name is never trusted, because publishers
// ship .exe files that are bundles, installers or plain programs.
export async function sniffFormat(file, tools) {
  const magic = await head(file, 8);
  const text = magic.toString("latin1");
  const hex = magic.toString("hex");

  if (text.startsWith("PK\u0003\u0004")) return { format: "zip" };
  if (hex.startsWith("377abcaf271c")) return { format: "7z" };
  if (text.startsWith("\u001f\u008b")) return { format: "tar.gz" };

  // An MSI is an OLE compound document, not a PE image. Asking lessmsi is the
  // only reliable test: the header alone is shared with every Installer DB.
  if (hex.startsWith("d0cf11e0")) {
    const msi = await tryMsi(file, tools);
    if (msi) return { format: "msi", msi };
    return undefined;
  }

  if (text.startsWith("MZ")) {
    // A Burn bundle is a PE image followed by MSCF cabinets whose first
    // container carries BurnManifest.xml. Ask the real resolver rather than
    // pattern-matching the bytes.
    const burn = await tryBurn(file, tools);
    if (burn) return { format: "burn", burn };
    const inno = await tryInno(file, tools);
    if (inno) return { format: "inno", inno };
    return { format: "pe" };
  }

  const tarName = await tryTar(file, tools);
  if (tarName) return { format: tarName };
  return undefined;
}

async function tryMsi(file, tools) {
  const reader = await tools.get("lessmsi");
  // Some vendor MSIs install the same path twice under different components
  // (WinFsp ships both x64 and x86 driver copies). Probing only needs to know
  // that the file is an installer, so fall back to the variant-tolerant read and
  // let the manifest's explicit map decide which copy survives.
  for (const allowVariants of [false, true]) {
    try {
      const plan = await readMsiPlan(reader, file, allowVariants);
      return { ...plan, variants: allowVariants };
    } catch {
      // Try the next tolerance level.
    }
  }
  return undefined;
}

async function tryInno(file, tools) {
  try {
    const listing = await capture(await tools.get("inno"), [
      "-v",
      "-a",
      "-b",
      "-h",
      "-o",
      "-u",
      "-n",
      file,
    ]);
    return innoEntries(listing);
  } catch {
    return undefined;
  }
}

// 7-Zip reports the container type from the bytes, so a mislabelled download is
// still identified correctly.
async function tryTar(file, tools) {
  for (const type of ["tar", "gzip"]) {
    try {
      const entries = await listing(tools, file, type);
      if (entries.length) return type === "tar" ? "tar" : "tar.gz";
    } catch {
      // Not this container type.
    }
  }
  return undefined;
}

// Burn bundles chain several MSIs (a driver plus the application). Probing lists
// every chained payload so the draft shows the choice instead of picking one.
async function tryBurn(file, tools) {
  const scratch = await mkdtemp(join(tmpdir(), "sniff-burn-"));
  try {
    const chain = await burnPayloadChain(tools, file, scratch, 0);
    return { chain: chain.map((p) => ({ id: p.id, filePath: p.filePath, size: p.size })) };
  } catch {
    return undefined;
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
  }
}


// The path list a human would otherwise type by hand. MSI paths must be resolved
// through the Directory table and Inno paths carry an {app} prefix, so this
// reuses the same resolvers the verifier uses. A Burn bundle resolves the
// chained payloads first, then reads the MSI the draft selects.
export async function deriveEntries(file, sniffed, tools) {
  const { format, msi, inno, burn, payload } = sniffed;
  if (burn) {
    requireThat(
      payload,
      "Burn probing needs a payload id; choose one of: " +
        burn.chain.map((p) => p.id).join(", "),
    );
    const scratch = await mkdtemp(join(tmpdir(), "add-burn-"));
    try {
      const resolved = await resolveBurnPayload(tools, file, payload, scratch, 0);
      const plan = await tryMsi(resolved.file, tools);
      requireThat(plan, "Burn payload is not an MSI");
      return plan.files.map((f) => ({ path: f.path, size: f.size }));
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
    }
  }
  if (msi) return msi.files.map((f) => ({ path: f.path, size: f.size }));
  if (inno) return inno.map((e) => ({ path: e.path, size: e.size }));
  const type = format === "zip" ? "zip" : format === "7z" ? "7z" : "tar";
  return (await listing(tools, file, type))
    .filter((e) => !e.directory)
    .map((e) => ({ path: e.path, size: e.size }));
}

function usage() {
  return [
    "Usage:",
    "  node scripts/add.mjs probe <name> <release-page-or-asset-url> [--version <v>]",
    "  node scripts/add.mjs apply <name> --dry-run | --yes",
    "",
    "probe writes automation/drafts/<name>.json and prints what it inferred.",
    "apply verifies the draft with checkLayout and, with --yes, writes the manifest.",
  ].join("\n");
}

async function main() {
  const [mode, name, ...rest] = process.argv.slice(2);
  requireThat(
    mode === "probe" || mode === "apply",
    usage(),
  );
  requireThat(
    name && /^[a-z0-9][a-z0-9-]*$/.test(name),
    "Package name required: " + usage(),
  );
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2),
      next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  if (mode === "probe") return await probe(name, positional[0], flags);
  return await apply(name, flags);
}

async function probe(name, source, flags) {
  requireThat(source, "probe needs a release page or asset URL");
  const net = network(),
    tools = new Tools(root, net),
    work = await mkdtemp(join(tmpdir(), "add-" + name + "-"));
  try {
    let version = typeof flags.version === "string" ? flags.version : undefined,
      url = source,
      page;
    if (!/\.(?:zip|7z|msi|exe|tar|gz|tgz)$/i.test(new URL(source).pathname)) {
      page = await net.text(source);
      const links = [...page.matchAll(/href="([^"]+\.(?:zip|7z|msi|exe))"/gi)]
        .map((m) => m[1])
        .filter((link) => link.toLowerCase().includes(name));
      requireThat(
        links.length > 0,
        "No asset on that page mentions " +
          name +
          "; pass the asset URL directly with --version",
      );
      const preferred =
        links.find((l) => /(?:x64|win64|windows)/i.test(l)) ?? links[0];
      url = new URL(preferred, source).href;
      version ??= url.match(/(\d+\.\d+(?:\.\d+)*(?:-\d+)?)/)?.[1];
    }
    requireThat(version, "Version could not be inferred; pass --version <v>");

    const artifact = await net.download(url, join(work, "artifact"), {
      maxBytes: 2 * GiB,
    });
    const sniffed = await sniffFormat(artifact.file, tools);
    requireThat(sniffed, "Unrecognised distribution format: " + url);

    // A bundle must say which chained package it means before any file list
    // exists; the probe reports the alternatives instead of picking one.
    const payload =
      typeof flags.payload === "string" ? flags.payload : undefined;
    const entries = await deriveEntries(
      artifact.file,
      { ...sniffed, payload },
      tools,
    );
    const exes = entries.filter((e) => /\.exe$/i.test(e.path));

    const draft = {
      name,
      version,
      source: url,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      format: sniffed.format,
      ...(payload ? { payload, payloadCandidates: sniffed.burn?.chain } : {}),
      ...(sniffed.burn && !payload
        ? { payloadCandidates: sniffed.burn.chain }
        : {}),
      entryCount: entries.length,
      executableCandidates: exes.slice(0, 40).map((e) => e.path),
      entrySample: entries.slice(0, 40).map((e) => e.path),
      next: [
        "review the candidates above",
        "add bin (and desktop/persist) to this draft",
        "node scripts/add.mjs apply " + name + " --dry-run",
      ],
    };
    await mkdir(dirname(draftPath(name)), { recursive: true });
    await writeFile(draftPath(name), JSON.stringify(draft, null, 2) + "\n");
    console.log(JSON.stringify(draft, null, 2));
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 10 });
  }
}

async function apply(name, flags) {
  const file = draftPath(name);
  const source = await readFile(file, "utf8").catch(() => {
    throw new Error("No draft for " + name + "; run probe first");
  });
  const draft = JSON.parse(source);
  requireThat(draft.name === name, "Draft name differs");
  requireThat(
    draft.bin && typeof draft.bin === "object",
    "Draft has no bin map; add the commands to " + file,
  );

  const net = network(),
    tools = new Tools(root, net),
    work = await mkdtemp(join(tmpdir(), "apply-" + name + "-"));
  try {
    const artifact = await net.download(draft.source, join(work, "artifact"), {
      sha256: draft.sha256,
      maxBytes: 2 * GiB,
    });
    // MSI, Inno and Burn records cannot be extracted without an explicit map,
    // and writing that map by hand is the step that made adding a package slow.
    // Derive it from the same metadata the verifier reads, keeping the
    // stripPrefix the draft asked for.
    let files = draft.files;
    if (!files && ["msi", "inno", "burn"].includes(draft.format)) {
      const sniffed = await sniffFormat(artifact.file, tools);
      requireThat(sniffed, "Distribution format changed since probing");
      const entries = await deriveEntries(
        artifact.file,
        { ...sniffed, payload: draft.payload },
        tools,
      );
      const prefix = draft.stripPrefix;
      files = Object.fromEntries(
        entries
          .map((e) => e.path)
          .filter((path) => !prefix || path === prefix || path.startsWith(prefix + "/"))
          .map((path) => [
            path,
            prefix && path !== prefix ? path.slice(prefix.length + 1) : path,
          ]),
      );
      console.log(
        "Derived " + Object.keys(files).length + " explicit file entries",
      );
    }
    const manifest = {
      schemaVersion: 1,
      name,
      version: draft.version,
      platforms: {
        "windows-x64": {
          url: draft.urlTemplate ?? draft.source,
          sha256: draft.sha256,
          format: draft.format,
          bin: draft.bin,
          ...(draft.payload ? { payload: draft.payload } : {}),
          ...(draft.stripPrefix ? { stripPrefix: draft.stripPrefix } : {}),
          ...(files ? { files } : {}),
          ...(draft.desktop ? { desktop: draft.desktop } : {}),
          ...(draft.persist ? { persist: draft.persist } : {}),
          maxBytes: Math.ceil(artifact.bytes / MiB) * MiB + 8 * MiB,
        },
      },
    };
    const layout = await checkLayout(
      manifest,
      [artifact],
      draft.rule ?? {},
      tools,
      work,
    );
    console.log(
      JSON.stringify(
        { name, version: draft.version, format: draft.format, layout },
        null,
        2,
      ),
    );
    if (!flags.yes) {
      console.log("\nDry run only. Re-run with --yes to write the manifest.");
      return;
    }
    const id = recipeId(manifest);
    const document = {
      schemaVersion: 2,
      name,
      recipes: { [id]: template(manifest) },
      versions: {
        [draft.version]: {
          recipe: id,
          maxBytes: manifest.platforms["windows-x64"].maxBytes,
          sha256: draft.sha256,
        },
      },
    };
    await mkdir(join(root, "packages", name), { recursive: true });
    await writeFile(
      join(root, "packages", name, "package.json"),
      JSON.stringify(document, null, 2) + "\n",
    );

    // The index and the update rule are two one-line edits that are easy to get
    // wrong, so write them from the same verified draft.
    const indexPath = join(root, "index.json"),
      index = JSON.parse(await readFile(indexPath, "utf8")),
      relative = "packages/" + name + "/package.json";
    const entry = index.packages[name] ?? { latest: draft.version, versions: {} };
    entry.versions[draft.version] = relative;
    const latest = compareVersions(draft.version, entry.latest);
    entry.latest = latest > 0 ? draft.version : entry.latest;
    index.packages[name] = entry;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");

    const rulesPath = join(root, "automation/rules.json"),
      rules = JSON.parse(await readFile(rulesPath, "utf8"));
    if (draft.rule?.provider) {
      rules.packages[name] = draft.rule;
      await writeFile(rulesPath, JSON.stringify(rules, null, 2) + "\n");
    }
    console.log(
      "\nWrote packages/" +
        name +
        "/package.json, updated index.json" +
        (draft.rule?.provider ? " and automation/rules.json" : "") +
        ".\nRun: node scripts/check.mjs && node scripts/update.mjs --check --packages " +
        name,
    );
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 10 });
  }
}

function recipeId(manifest) {
  return (
    "r" +
    createHash("sha256")
      .update(JSON.stringify(manifest.platforms["windows-x64"]))
      .digest("hex")
      .slice(0, 16)
  );
}

// Only the version spelling may vary in a recipe; anything else would stop
// tracking upstream silently.
function template(manifest) {
  const m = structuredClone(manifest);
  const sub = (value) =>
    typeof value === "string"
      ? value.split(manifest.version).join("{version}")
      : value;
  m.version = "{version}";
  const p = m.platforms["windows-x64"];
  for (const key of ["url", "file", "into", "stripPrefix"])
    if (p[key]) p[key] = sub(p[key]);
  p.sha256 = "{sha256}";
  p.maxBytes = "{maxBytes}";
  return m;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
