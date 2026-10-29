import { open, mkdir, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { capture } from "./tools.mjs";
import { readMsiPlan } from "./msi.mjs";
import { pathName, requireThat, GiB, MiB, downloads } from "./catalog.mjs";
export function parseListing(text, type) {
  const entries = [],
    seen = new Set();
  for (const block of text
    .replace(/[\r\n]+$/, "")
    .split(/\r?\n\r?\n/)
    .filter(Boolean)) {
    const f = new Map();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(" = ");
      requireThat(
        at >= 0 && !f.has(line.slice(0, at)),
        "Ambiguous archive metadata",
      );
      f.set(line.slice(0, at), line.slice(at + 3));
    }
    const raw = f.get("Path");
    requireThat(
      typeof raw === "string" && !/[\0\r\n]/.test(raw),
      "Archive path missing",
    );
    let path = raw.replaceAll("\\", "/");
    while (path.startsWith("./")) path = path.slice(2);
    const attrs = f.get("Attributes") ?? "",
      mode = f.get("Mode") ?? "";
    const directory =
      attrs.startsWith("D") || f.get("Folder") === "+" || mode.startsWith("d");
    if ((path === "." || path === "") && directory) continue;
    pathName(path);
    requireThat(
      !/[Ll]/.test(attrs) &&
        ![...f].some(
          ([k, v]) => /link|reparse|alternate|stream/i.test(k) && v !== "",
        ) &&
        (!f.has("Encrypted") || f.get("Encrypted") === "-"),
      "Archive has links, streams or encryption",
    );
    if (type === "tar")
      requireThat(
        /^[d-][rwxstST-]{9}$/.test(mode),
        "Unsupported TAR entry type",
      );
    requireThat(
      !seen.has(path.toLowerCase()),
      "Duplicate/case-colliding archive entry",
    );
    seen.add(path.toLowerCase());
    requireThat(seen.size <= 100000, "Archive entry limit exceeded");
    const value = f.get("Size");
    const size =
      value === undefined || value === "" ? undefined : Number(value);
    requireThat(
      size === undefined
        ? type === "nsis"
        : /^\d+$/.test(value) && Number.isSafeInteger(size) && size >= 0,
      "Invalid archive entry size",
    );
    entries.push({ raw, path, directory, size });
  }
  requireThat(entries.length > 0, "Archive contains no usable metadata");
  return entries;
}
export function innoEntries(text) {
  const entries = [],
    seen = new Set();
  let opened = false,
    closed = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^-{10,}$/.test(line)) {
      if (opened) closed = true;
      else opened = true;
      continue;
    }
    if (!opened || !line.trim()) continue;
    requireThat(!closed, "Unexpected Inno metadata");
    const m =
      /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/.exec(
        line,
      );
    requireThat(m, "Unsupported Inno metadata");
    const path = m[2].replaceAll("\\", "/");
    pathName(path);
    requireThat(!seen.has(path.toLowerCase()), "Duplicate Inno identity");
    seen.add(path.toLowerCase());
    requireThat(seen.size <= 100000, "Inno entry limit exceeded");
    const size = Number(m[1]);
    requireThat(Number.isSafeInteger(size), "Invalid Inno size");
    entries.push({ raw: m[2], path, size, directory: false });
  }
  requireThat(opened && closed && entries.length, "No Inno file metadata");
  return entries;
}
async function listing(tools, file, type) {
  return parseListing(
    await capture(await tools.get("sevenzip"), [
      "l",
      "-t" + type,
      "-slt",
      "-ba",
      "-sccUTF-8",
      "-pPIKO_NO_PASSWORD",
      "--",
      file,
    ]),
    type,
  );
}
async function extractEntry(tools, file, type, entry, target, limit) {
  requireThat(
    !entry.directory && (entry.size === undefined || entry.size <= limit),
    "Selected archive payload exceeds limit",
  );
  await capture(
    await tools.get("sevenzip"),
    [
      "x",
      "-t" + type,
      "-so",
      "-spd",
      "-y",
      "-bd",
      "-bb0",
      "-pPIKO_NO_PASSWORD",
      "--",
      file,
      entry.raw,
    ],
    { file: target, limit },
  );
  const size = (await stat(target)).size;
  requireThat(
    size <= limit && (entry.size === undefined || entry.size === size),
    "Archive output size differs",
  );
  return target;
}
function mapped(entries, d, { inno = false, msi = false } = {}) {
  const files = [],
    matched = new Set(),
    seen = new Map();
  let prefix = d.stripPrefix;
  if (inno)
    prefix =
      !prefix || prefix === "{app}"
        ? "{app}"
        : prefix.startsWith("{app}/")
          ? prefix
          : "{app}/" + prefix;
  for (const e of entries) {
    let p = e.path;
    if (prefix) {
      if (p === prefix && e.directory) continue;
      if (!p.startsWith(prefix + "/")) {
        if (inno || msi) continue;
        throw Error("Archive entry is outside stripPrefix");
      }
      p = p.slice(prefix.length + 1);
    }
    if (d.files) {
      const selector =
        msi && Object.hasOwn(d.files, "#" + e.id) ? "#" + e.id : p;
      if (!Object.hasOwn(d.files, selector)) continue;
      matched.add(selector);
      p = d.files[selector];
    } else if (inno)
      requireThat(
        !/(?:,\d+$|,\d+\.[^/]+$)/.test(p),
        "Inno variants require explicit mapping",
      );
    if (d.into) p = d.into + "/" + p;
    pathName(p);
    requireThat(
      p.split("/")[0].toLowerCase() !== ".piko-install.json",
      "Reserved installation receipt path",
    );
    const parts = p.split("/");
    for (let n = 1; n <= parts.length; n++) {
      const name = parts.slice(0, n).join("/"),
        key = name.toLowerCase(),
        dir = n < parts.length || e.directory,
        prior = seen.get(key);
      requireThat(
        !prior || (prior.name === name && prior.dir && dir),
        "Duplicate/overlapping output path",
      );
      seen.set(key, { name, dir });
    }
    files.push({ ...e, target: p });
  }
  requireThat(
    !d.files || matched.size === Object.keys(d.files).length,
    "Explicit mapping entry disappeared",
  );
  return files;
}
export async function checkLayout(manifest, artifacts, rule, tools, temp) {
  const p = manifest.platforms["windows-x64"],
    outputs = new Map(),
    limit = p.maxExpandedBytes ?? 2 * GiB;
  let total = 0,
    count = 0,
    serial = 0;
  const charge = (entries, maxFile) => {
    for (const e of entries) {
      requireThat(++count <= 100000, "Expanded entry count exceeded");
      if (!e.directory && e.size !== undefined) {
        requireThat(e.size <= maxFile, "Expanded file exceeds size limit");
        total += e.size;
        requireThat(total <= limit, "Shared expanded quota exceeded");
      }
    }
  };
  const namespace = new Map();
  const add = (entries) => {
    charge(entries, 512 * MiB);
    for (const e of entries) {
      const parts = e.target.split("/");
      for (let n = 1; n <= parts.length; n++) {
        const name = parts.slice(0, n).join("/"),
          key = name.toLowerCase(),
          directory = n < parts.length || e.directory,
          previous = namespace.get(key);
        requireThat(
          !previous ||
            (previous.name === name && previous.directory && directory),
          "Combined downloads collide or overwrite a file",
        );
        namespace.set(key, { name, directory });
      }
      if (!e.directory) outputs.set(e.target.toLowerCase(), e);
    }
  };
  const ds = downloads(p);
  for (let n = 0; n < ds.length; n++) {
    const d = ds[n],
      artifact = artifacts[n];
    let file = artifact.file,
      type = d.format;
    if (type === "file") {
      if (/\.exe$/i.test(d.file)) {
        const handle = await open(file, "r");
        try {
          const head = Buffer.alloc(2);
          await handle.read(head, 0, 2, 0);
          requireThat(
            head.toString("ascii") === "MZ",
            "Native file is not a PE executable",
          );
        } finally {
          await handle.close();
        }
      }
      pathName(d.file);
      const target = d.into ? d.into + "/" + d.file : d.file;
      add([
        {
          path: d.file,
          target,
          size: artifact.bytes,
          directory: false,
          peek: async () => file,
        },
      ]);
      continue;
    }
    if (d.nested) {
      for (const step of d.nested) {
        const actual = type === "pe" ? "PE" : type,
          entries = await listing(tools, file, actual);
        if (
          rule.layout === "tabbit" &&
          step.path.includes("/mini_installer.exe")
        ) {
          const choices = entries.filter((e) =>
            /^bin\/Offline\/\{[a-f0-9-]{36}\}\/\{[a-f0-9-]{36}\}\/mini_installer\.exe$/i.test(
              e.path,
            ),
          );
          requireThat(
            choices.length === 1,
            "Tabbit offline installer GUID path is ambiguous",
          );
          step.path = choices[0].path;
        }
        const entry = entries.find((e) => e.path === step.path);
        requireThat(entry, "Declared nested payload disappeared");
        // The runtime charges all expanded intermediate files for ZIP/7z, but
        // only the selected payload for PE/NSIS resource containers.
        if (["PE", "nsis"].includes(actual)) charge([entry], 2 * GiB);
        else charge(entries, 2 * GiB);
        const target = join(temp, "layer-" + serial++);
        const previous = file;
        await extractEntry(
          tools,
          previous,
          actual,
          entry,
          target,
          Math.min(2 * GiB, limit - (total - (entry.size ?? 0))),
        );
        if (entry.size === undefined) {
          total += (await stat(target)).size;
          requireThat(total <= limit, "Shared expanded quota exceeded");
        }
        file = target;
        type = step.format;
      }
    }
    if (type === "tar.gz" || type === "tar.xz") {
      const target = join(temp, "tar-" + serial++);
      await capture(
        await tools.get("sevenzip"),
        [
          "x",
          "-t" + (type === "tar.gz" ? "gzip" : "xz"),
          "-so",
          "-y",
          "-bd",
          "-bb0",
          "--",
          file,
        ],
        { file: target, limit: 2 * GiB },
      );
      file = target;
      type = "tar";
    }
    const prefix = d.nested?.at(-1)?.stripPrefix;
    const effective = { ...d, stripPrefix: d.nested ? prefix : d.stripPrefix };
    let entries;
    if (type === "inno") {
      entries = innoEntries(
        await capture(await tools.get("inno"), [
          "-v",
          "-a",
          "-b",
          "-h",
          "-o",
          "-u",
          "-n",
          file,
        ]),
      );
      entries = mapped(entries, effective, { inno: true });
      for (const e of entries)
        e.peek = async () => {
          const folder = join(temp, "inno-" + serial++);
          await mkdir(folder);
          await capture(
            await tools.get("inno"),
            [
              "-e",
              "-a",
              "-b",
              "-q",
              "-h",
              "-o",
              "-u",
              "-n",
              "-d" + folder,
              file,
              e.raw,
            ],
            { limit: MiB },
          );
          const names = await readdir(folder);
          requireThat(
            names.length === 1 &&
              names[0] === e.raw.replaceAll("\\", "/").split("/").at(-1),
            "Unexpected Inno output",
          );
          const path = join(folder, names[0]);
          requireThat(
            (await stat(path)).isFile() && (await stat(path)).size === e.size,
            "Inno output differs",
          );
          return path;
        };
    } else if (type === "msi") {
      requireThat(
        !d.cabinets,
        "External CAB updates require a dedicated recipe",
      );
      const plan = await readMsiPlan(
        await tools.get("lessmsi"),
        file,
        !!d.files,
      );
      entries = mapped(
        plan.files.map((f) => ({ ...f, directory: false })),
        effective,
        { msi: true },
      );
      const streams = await listing(tools, file, "Compound");
      let cabinetBytes = 0;
      for (const cabinet of plan.cabinets) {
        const wanted = entries.filter((e) => e.cabinet === cabinet.name);
        if (!wanted.length) continue;
        const stream = streams.find((e) => e.path === cabinet.name);
        requireThat(
          stream && !stream.directory && stream.size !== undefined,
          "Embedded MSI cabinet stream missing",
        );
        cabinetBytes += stream.size;
        requireThat(
          cabinetBytes <= 2 * GiB && ++count <= 100000,
          "MSI intermediate cabinet budget exceeded",
        );
        const cab = join(temp, "cab-" + serial++);
        await extractEntry(tools, file, "Compound", stream, cab, 2 * GiB);
        const members = await listing(tools, cab, "Cab"),
          declared = new Map(
            plan.files
              .filter((e) => e.cabinet === cabinet.name)
              .map((e) => [e.id, e]),
          );
        for (const member of members)
          requireThat(
            !member.directory &&
              !member.path.includes("/") &&
              declared.get(member.path)?.size === member.size,
            "MSI cabinet and File table disagree",
          );
        for (const target of wanted) {
          const member = members.find((e) => e.path === target.id);
          requireThat(member, "MSI file missing from cabinet");
          target.peek = async () =>
            extractEntry(
              tools,
              cab,
              "Cab",
              member,
              join(temp, "peek-" + serial++),
              512 * MiB,
            );
        }
      }
    } else {
      entries = await listing(tools, file, type);
      if (rule.layout === "wecom")
        effective.files = d.files = Object.fromEntries(
          entries
            .filter(
              (e) =>
                !e.directory &&
                !e.path.startsWith("$") &&
                !/^uninstall\.exe$/i.test(e.path),
            )
            .map((e) => [e.path, e.path]),
        );
      entries = mapped(entries, effective);
      const archive = file,
        codec = type;
      for (const e of entries)
        e.peek = async () => {
          const target = join(temp, "peek-" + serial++);
          return extractEntry(tools, archive, codec, e, target, 512 * MiB);
        };
    }
    add(entries);
  }
  const generated = new Set(
    [
      ...Object.keys(p.configFiles ?? {}),
      ...Object.keys(p.configTemplates ?? {}),
    ].map((k) => k.toLowerCase()),
  );
  const required = [];
  for (const b of Object.values(p.bin)) {
    if (typeof b === "string") required.push(b);
    else if (!b.data) required.push(b.path);
  }
  for (const kind of ["shortcuts", "fonts", "associations", "menus"])
    for (const e of p.desktop?.[kind] ?? [])
      required.push(typeof e === "string" ? e : e.path);
  if (p.bootstrap) required.push(p.bootstrap.path);
  if (p.admin) required.push(p.admin.install.path, p.admin.remove.path);
  required.push(...(rule.required ?? []));
  for (const file of required)
    requireThat(
      outputs.has(file.toLowerCase()) || generated.has(file.toLowerCase()),
      "Required application entry missing: " + file,
    );
  let version;
  if (rule.versionFromPE || rule.verifyPEVersion) {
    const bin = Object.values(p.bin)
        .map((b) => (typeof b === "string" ? b : b.path))
        .find((b) => b.endsWith(".exe")),
      entry = outputs.get(bin.toLowerCase());
    requireThat(entry?.peek, "Cannot read native application version");
    const image = await entry.peek();
    const info = await capture(await tools.get("sevenzip"), [
      "l",
      "-tPE",
      "-slt",
      "-sccUTF-8",
      image,
    ]);
    version = info.match(/(?:^|\n)FileVersion:\s*([0-9]+(?:\.[0-9]+)+)/)?.[1];
    requireThat(version, "Application PE file version missing");
    if (rule.verifyPEVersion)
      requireThat(
        version === manifest.version,
        "Application PE version differs from upstream release hint",
      );
  }
  if (rule.signature) {
    // Check the official signed distribution itself, never run its entrypoint.
    const image = artifacts[0].file;
    const script =
      "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; if((Get-AuthenticodeSignature -LiteralPath $env:PIKO_SOURCE_SIGNATURE_FILE).Status -ne 'Valid'){throw 'Distribution signature is not Valid'}";
    await capture(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        limit: MiB,
        env: { ...process.env, PIKO_SOURCE_SIGNATURE_FILE: image },
      },
    );
  }
  return {
    version,
    files: outputs.size,
    knownExpandedBytes: total,
    unknownSizeFiles: [...outputs.values()].filter((e) => e.size === undefined)
      .length,
    reviewSensitive: !!(p.admin || p.bootstrap || p.shell),
  };
}
