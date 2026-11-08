import { open, mkdir, readFile, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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
async function listing(tools, file, type, names) {
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
      ...(names ?? []),
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
// WiX Burn bundles append their payload after the PE image as cabinets: the UX
// container (BurnManifest.xml plus theme/licence assets) and the attached
// container holding the chained packages as members a0, a1, ... Neither the
// .wixburn section layout (it differs between Burn versions) nor cabinet
// chaining (Burn pads between containers) locates them reliably, so containers
// are found by their MSCF signature and then proven against the size and
// SHA-512 digest the manifest records.
const burnSignature = Buffer.from("MSCF", "ascii");
function burnAttribute(xml, name) {
  return new RegExp(`${name}="([^"]*)"`, "i").exec(xml)?.[1];
}
function peOverlayOffset(image, fileSize) {
  requireThat(
    image.length >= 0x40 && image.toString("ascii", 0, 2) === "MZ",
    "Burn bundle is not a PE executable",
  );
  const peOffset = image.readUInt32LE(0x3c);
  requireThat(
    peOffset + 24 <= image.length &&
      image.toString("ascii", peOffset, peOffset + 4) === "PE\0\0",
    "Burn PE header is invalid",
  );
  requireThat(
    image.readUInt16LE(peOffset + 4) === 0x8664,
    "Burn bundle is not an x64 image",
  );
  const sections = image.readUInt16LE(peOffset + 6),
    optionalSize = image.readUInt16LE(peOffset + 20),
    optional = peOffset + 24,
    sectionTable = optional + optionalSize;
  requireThat(
    image.readUInt16LE(optional) === 0x20b,
    "Burn bundle is not a PE32+ image",
  );
  requireThat(
    sections <= 96 && sectionTable + sections * 40 <= image.length,
    "Burn PE section table is invalid",
  );
  let end = sectionTable + sections * 40;
  for (let n = 0; n < sections; n++) {
    const entry = sectionTable + n * 40,
      rawSize = image.readUInt32LE(entry + 16),
      rawOffset = image.readUInt32LE(entry + 20);
    if (!rawSize) continue;
    requireThat(
      rawOffset + rawSize <= fileSize,
      "Burn PE section escapes the image",
    );
    end = Math.max(end, rawOffset + rawSize);
  }
  return end;
}
async function scanBurnCabinets(file, start, fileSize) {
  const chunk = 4 * MiB,
    handle = await open(file, "r"),
    buffer = Buffer.alloc(Math.min(chunk, Math.max(fileSize - start, 1))),
    found = [];
  try {
    let position = start;
    while (position + 36 <= fileSize) {
      const length = Math.min(buffer.length, fileSize - position),
        { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      const window = buffer.subarray(0, bytesRead);
      for (let index = window.indexOf(burnSignature); index >= 0; ) {
        const offset = position + index,
          size = index + 36 <= bytesRead ? window.readUInt32LE(index + 8) : 0;
        if (size >= 36 && offset + size <= fileSize && found.length < 4096)
          found.push({ offset, size });
        index = window.indexOf(burnSignature, index + 4);
      }
      position += bytesRead - Math.min(3, bytesRead);
    }
  } finally {
    await handle.close();
  }
  requireThat(found.length > 0, "Burn bundle contains no appended container");
  return found;
}
async function burnRange(file, range, target) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(range.size),
      { bytesRead } = await handle.read(buffer, 0, range.size, range.offset);
    requireThat(bytesRead === range.size, "Burn cabinet is truncated");
    const output = await open(target, "wx");
    try {
      await output.write(buffer);
    } finally {
      await output.close();
    }
  } finally {
    await handle.close();
  }
}
async function burnDigest(file) {
  const handle = await open(file, "r"),
    digest = createHash("sha512"),
    buffer = Buffer.alloc(4 * MiB);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}
function parseBurnManifest(xml) {
  requireThat(
    /<BurnManifest\b[^>]*\bWin64="yes"/i.test(xml),
    "Unsupported Burn manifest",
  );
  const containers = [],
    named = new Set();
  for (const match of xml.matchAll(/<Container\b([^>]*)\/?>/gi)) {
    const body = match[1],
      id = burnAttribute(body, "Id");
    if (!id) continue;
    const size = Number(burnAttribute(body, "FileSize") ?? ""),
      sha512 = burnAttribute(body, "Hash") ?? "";
    requireThat(
      Number.isSafeInteger(size) && size > 0 && /^[0-9a-f]{128}$/i.test(sha512),
      "Burn container size or digest is missing",
    );
    named.add(id);
    containers.push({ size, sha512 });
  }
  const chain = [],
    seen = new Set();
  for (const match of xml.matchAll(/<Payload\b([^>]*)\/?>/gi)) {
    const body = match[1],
      id = burnAttribute(body, "Id"),
      sourcePath = burnAttribute(body, "SourcePath"),
      filePath = burnAttribute(body, "FilePath"),
      container = burnAttribute(body, "Container");
    if (!id || !sourcePath || !filePath || !container) continue;
    requireThat(named.has(container), "Burn payload references no container");
    requireThat(/^a\d+$/.test(sourcePath), "Unexpected Burn payload member");
    requireThat(!seen.has(id.toLowerCase()), "Duplicate Burn payload");
    seen.add(id.toLowerCase());
    const size = Number(burnAttribute(body, "FileSize") ?? ""),
      sha512 = burnAttribute(body, "Hash") ?? "";
    requireThat(
      Number.isSafeInteger(size) && size > 0 && /^[0-9a-f]{128}$/i.test(sha512),
      "Burn payload size or digest is missing",
    );
    chain.push({ id, filePath, member: sourcePath, size, sha512 });
  }
  requireThat(chain.length > 0, "Burn bundle declares no chained payload");
  chain.sort((a, b) => Number(a.member.slice(1)) - Number(b.member.slice(1)));
  return { chain, containers };
}
// Extract one manifest-declared payload out of a Burn bundle as an MSI.
async function resolveBurnPayload(tools, file, payloadId, temp, serial) {
  requireThat(
    typeof payloadId === "string" && payloadId.length > 0,
    "Burn payload selection is missing",
  );
  const info = await stat(file),
    head = Buffer.alloc(Math.min(info.size, 64 * 1024)),
    reader = await open(file, "r");
  try {
    const { bytesRead } = await reader.read(head, 0, head.length, 0);
    requireThat(bytesRead === head.length, "Burn bundle is truncated");
  } finally {
    await reader.close();
  }
  const candidates = await scanBurnCabinets(
      file,
      peOverlayOffset(head, info.size),
      info.size,
    ),
    uxPath = join(temp, "burn-ux-" + serial + ".cab");
  await burnRange(file, candidates[0], uxPath);
  let manifest;
  for (const entry of await listing(tools, uxPath, "Cab")) {
    if (entry.directory || !entry.size || entry.size > 4 * MiB) continue;
    const member = join(temp, "burn-manifest-" + serial++);
    await extractEntry(tools, uxPath, "Cab", entry, member, 4 * MiB);
    const text = (await readFile(member, "utf8")).toString();
    if (text.includes("<BurnManifest")) {
      manifest = text;
      break;
    }
  }
  requireThat(manifest, "Burn UX container has no BurnManifest.xml");
  const { chain, containers } = parseBurnManifest(manifest),
    payload = chain.find((p) => p.id === payloadId);
  requireThat(
    payload,
    `Burn bundle has no payload ${payloadId} (available: ${chain.map((p) => p.id).join(", ")})`,
  );
  let attached;
  for (const candidate of candidates.slice(1)) {
    if (!containers.some((c) => c.size === candidate.size)) continue;
    const cab = join(temp, "burn-attached-" + serial++ + ".cab");
    await burnRange(file, candidate, cab);
    const digest = await burnDigest(cab);
    if (
      containers.some(
        (c) => c.size === candidate.size && c.sha512.toLowerCase() === digest,
      )
    ) {
      attached = cab;
      break;
    }
  }
  requireThat(
    attached,
    "Burn attached container declared by the manifest is missing",
  );
  const members = await listing(tools, attached, "Cab"),
    member = members.find((m) => m.path === payload.member);
  requireThat(member && !member.directory, "Burn attached member is missing");
  requireThat(
    member.size === payload.size,
    "Burn attached container size disagrees with its manifest",
  );
  const target = join(temp, "burn-payload-" + serial++ + ".msi");
  await extractEntry(tools, attached, "Cab", member, target, 2 * GiB);
  requireThat(
    (await burnDigest(target)) === payload.sha512.toLowerCase(),
    "Burn attached payload does not match its declared digest",
  );
  return { file: target, serial };
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
export function peFileVersion(info, expected) {
  const versions = [
    ...new Set(
      [...info.matchAll(/^FileVersion:\s*([0-9]+(?:\.[0-9]+)+)\s*$/gm)].map(
        (m) => m[1],
      ),
    ),
  ];
  requireThat(versions.length > 0, "Application PE file version missing");
  if (expected) {
    requireThat(
      versions.includes(expected),
      "Application PE version differs from upstream release hint",
    );
    return expected;
  }
  requireThat(
    versions.length === 1,
    "Ambiguous application PE versions; explicit upstream version required",
  );
  return versions[0];
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
    if (type === "burn") {
      // WiX Burn bundle: the selected chained MSI is the artifact under
      // verification, exactly as the client extracts it.
      const resolved = await resolveBurnPayload(tools, file, d.payload, temp, serial);
      file = resolved.file;
      serial = resolved.serial;
      type = "msi";
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
      if (rule.layout === "epic")
        // Keep the launcher application only: DirectX/GameInput
        // redistributable installers, system-directory VC++ runtimes and
        // ProgramData-targeted EMS configuration are not application files.
        effective.files = d.files = Object.fromEntries(
          plan.files
            .filter(
              (f) =>
                !/^(?:Epic Games\/(?:DirectXRedist|GameInputRedist)\/|Epic\/EpicGamesLauncher\/|Win\/System(?:64)?\/|System(?:64)?\/)/.test(
                  f.path,
                ),
            )
            .map((f) => [f.path, f.path]),
        );
      entries = mapped(
        plan.files.map((f) => ({ ...f, directory: false })),
        effective,
        { msi: true },
      );
      // List each embedded cabinet stream by name: MSI storages such as
      // embedded transforms expose no size and cannot be parsed as files.
      let cabinetBytes = 0;
      for (const cabinet of plan.cabinets) {
        const wanted = entries.filter((e) => e.cabinet === cabinet.name);
        if (!wanted.length) continue;
        const stream = (
          await listing(tools, file, "Compound", [cabinet.name])
        ).find((e) => e.path === cabinet.name);
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
      if (rule.layout === "wecom" || rule.layout === "baidu")
        effective.files = d.files = Object.fromEntries(
          entries
            .filter(
              (e) =>
                !e.directory &&
                !e.path.startsWith("$") &&
                !(rule.layout === "wecom"
                  ? /^uninstall\.exe$/i
                  : /^uninst\.exe$/i
                ).test(e.path),
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
  if (rule.layout === "qqnt") {
    // The fixed payload must contain a single complete native Electron app.
    const packages = [...outputs.values()].filter((e) =>
      /^versions\/\d+\.\d+\.\d+-\d+\/resources\/app\/package\.json$/.test(
        e.target,
      ),
    );
    requireThat(
      packages.length === 1,
      "QQ application package layout is ambiguous or missing",
    );
    const prefix = packages[0].target.split("/resources/")[0];
    for (const file of [
      "resources/app/package.json",
      "QQNT.dll",
      "chrome_100_qq.pak",
      "resources.pak",
      "icudtl.dat",
    ])
      requireThat(
        outputs.has((prefix + "/" + file).toLowerCase()),
        "QQ application resource missing: " + file,
      );
  }
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
    version = peFileVersion(
      info,
      rule.verifyPEVersion ? manifest.version : undefined,
    );
  }
  if (rule.signature) {
    // Check the official signed distribution itself, never run its entrypoint.
    // Container distributions anchor their bytes with a publisher digest;
    // a string declaration names the signed payload extracted from it.
    let image = artifacts[0].file;
    if (typeof rule.signature === "string") {
      const entry = outputs.get(rule.signature.toLowerCase());
      requireThat(entry?.peek, "Declared signature payload is missing");
      image = await entry.peek();
    }
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
