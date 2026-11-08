import { component, requireThat, httpsURL } from "./catalog.mjs";
export function compareVersions(a, b) {
  const x = String(a).match(/\d+/g)?.map(Number) ?? [],
    y = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let n = 0; n < Math.max(x.length, y.length); n++) {
    if ((x[n] ?? 0) !== (y[n] ?? 0)) return (x[n] ?? 0) > (y[n] ?? 0) ? 1 : -1;
  }
  return 0;
}
export function render(template, values) {
  const parts = String(values.version ?? "").split(".");
  const v = {
    ...values,
    compact: String(values.version ?? "").replaceAll(".", ""),
    version3: parts.slice(0, 3).join("."),
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    build: String(values.version ?? "")
      .split("-")
      .at(-1),
  };
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key) => {
    requireThat(v[key] !== undefined, "Unresolved URL template " + key);
    return String(v[key]);
  });
}
const at = (value, path) => path.split(".").reduce((v, k) => v?.[k], value);
function fromMatch(match) {
  return match.groups?.version ?? match[1];
}
function best(values) {
  requireThat(values.length > 0, "No matching stable upstream version");
  values.forEach(component);
  return values.sort((a, b) => compareVersions(b, a))[0];
}
function steamKV(text) {
  // Minimal Valve KV reader: top-level "key" "value" pairs and "key" { … }
  // blocks, no escapes or comments in the bootstrap manifest channel.
  let pos = 0;
  const skip = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  };
  const string = () => {
    requireThat(text[pos] === '"', "Steam manifest string expected");
    const end = text.indexOf('"', pos + 1);
    requireThat(end > pos, "Steam manifest string is truncated");
    const value = text.slice(pos + 1, end);
    pos = end + 1;
    return value;
  };
  const body = (top) => {
    const values = new Map(),
      blocks = new Map();
    for (;;) {
      skip();
      if (pos >= text.length) {
        requireThat(top, "Steam manifest KV is truncated");
        return { values, blocks };
      }
      if (text[pos] === "}") {
        requireThat(!top, "Steam manifest KV has stray closing braces");
        pos++;
        return { values, blocks };
      }
      const key = string();
      skip();
      requireThat(
        !values.has(key) && !blocks.has(key),
        "Duplicate Steam manifest key: " + key,
      );
      if (text[pos] === "{") {
        pos++;
        blocks.set(key, body(false));
      } else values.set(key, string());
    }
  };
  return body(true);
}
export async function discover(rule, current, net) {
  if (rule.provider === "manual") return { manual: true, reason: rule.reason };
  const api = "https://api.github.com/repos/";
  let version,
    url,
    sha256,
    md5,
    extra = {},
    provenance = rule.url;
  if (rule.provider === "github-release") {
    let releases;
    try {
      const latest = await net.json(api + rule.repo + "/releases/latest");
      releases = [latest];
    } catch {
      releases = [];
    }
    const pattern = new RegExp(rule.versionRegex),
      stable = (r) => !r.draft && !r.prerelease && pattern.test(r.tag_name);
    if (!releases.some(stable))
      releases = await net.json(api + rule.repo + "/releases?per_page=30");
    requireThat(Array.isArray(releases), "Invalid GitHub release response");
    const matched = releases.filter(stable).map((r) => ({
      r,
      match: new RegExp(rule.versionRegex).exec(r.tag_name),
    }));
    requireThat(matched.length, "No matching stable GitHub release");
    matched.sort((a, b) =>
      compareVersions(
        fromMatch(b.match).replaceAll("_", "."),
        fromMatch(a.match).replaceAll("_", "."),
      ),
    );
    const { r, match } = matched[0];
    version = fromMatch(match).replaceAll("_", ".");
    const assets = r.assets.filter((a) =>
      new RegExp(rule.assetRegex).test(a.name),
    );
    requireThat(
      assets.length === 1,
      "Missing or ambiguous Windows release asset",
    );
    const asset = assets[0];
    const assetMatch = new RegExp(rule.assetRegex).exec(asset.name);
    if (rule.versionFrom === "asset") version = assetMatch.groups.version;
    if (rule.versionFrom === "aria2")
      version = assetMatch.groups.version + "-" + assetMatch.groups.build;
    url = asset.browser_download_url;
    const u = httpsURL(url);
    requireThat(
      u.hostname === "github.com" &&
        u.pathname.startsWith("/" + rule.repo + "/releases/download/"),
      "Release asset escaped its official repository",
    );
    if (asset.digest) {
      requireThat(
        /^sha256:[a-f0-9]{64}$/i.test(asset.digest),
        "Unsupported GitHub asset digest",
      );
      sha256 = asset.digest.slice(7);
    }
    provenance =
      "https://github.com/" +
      rule.repo +
      "/releases/tag/" +
      encodeURIComponent(r.tag_name);
    extra.assetBytes = asset.size;
    if (rule.stripPrefixFromAsset)
      extra.stripPrefix = asset.name.replace(/\.zip$/i, "");
  } else if (rule.provider === "github-tags") {
    const tags = await net.json(api + rule.repo + "/tags?per_page=100");
    const found = tags
      .filter((t) => new RegExp(rule.versionRegex).test(t.name))
      .map((t) => ({
        t,
        version: fromMatch(new RegExp(rule.versionRegex).exec(t.name)),
      }));
    requireThat(found.length, "No stable upstream tags");
    found.sort((a, b) => compareVersions(b.version, a.version));
    const t = found[0];
    version = t.version;
    requireThat(/^[a-f0-9]{40}$/.test(t.t.commit.sha), "Invalid tag commit");
    url =
      "https://github.com/" + rule.repo + "/archive/" + t.t.commit.sha + ".zip";
    extra.stripPrefix = rule.repo.split("/")[1] + "-" + t.t.commit.sha;
    provenance = "https://github.com/" + rule.repo + "/tree/" + t.t.commit.sha;
  } else if (rule.provider === "github-file") {
    const commits = await net.json(
      api +
        rule.repo +
        "/commits?path=" +
        encodeURIComponent(rule.path) +
        "&per_page=1",
    );
    const c = commits[0];
    requireThat(c && /^[a-f0-9]{40}$/.test(c.sha), "Invalid file commit");
    const date = c.commit.committer.date.slice(0, 10);
    requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date), "Invalid commit date");
    version = current.platforms["windows-x64"].url.includes(c.sha)
      ? current.version
      : "0." + date.replaceAll("-", ".") + "-" + c.sha.slice(0, 8);
    url =
      "https://raw.githubusercontent.com/" +
      rule.repo +
      "/" +
      c.sha +
      "/" +
      rule.path;
    extra.commitChanged = !current.platforms["windows-x64"].url.includes(c.sha);
    provenance = "https://github.com/" + rule.repo + "/commit/" + c.sha;
  } else if (rule.provider === "claude-code") {
    const base = "https://downloads.claude.ai/claude-code-releases";
    version = (await net.text(base + "/latest")).trim();
    requireThat(
      /^\d+\.\d+\.\d+$/.test(version),
      "Invalid Claude Code stable version",
    );
    const manifestURL = base + "/" + version + "/manifest.json";
    const manifest = await net.json(manifestURL);
    const platform = manifest.platforms?.["win32-x64"];
    requireThat(
      manifest.version === version &&
        platform?.binary === "claude.exe" &&
        /^[a-f0-9]{64}$/i.test(platform.checksum ?? "") &&
        Number.isSafeInteger(platform.size) &&
        platform.size > 0 &&
        platform.size <= 2 * 1024 * 1024 * 1024,
      "Invalid Claude Code Windows x64 manifest",
    );
    sha256 = platform.checksum;
    url = base + "/" + version + "/win32-x64/claude.exe";
    extra.assetBytes = platform.size;
    provenance = manifestURL;
  } else if (rule.provider === "node") {
    const releases = await net.json("https://nodejs.org/dist/index.json");
    const r = releases
      .filter(
        (r) =>
          /^v\d+\.\d+\.\d+$/.test(r.version) && r.files.includes("win-x64-zip"),
      )
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    requireThat(r, "No official Windows Node release");
    version = r.version.slice(1);
    const file = "node-v" + version + "-win-x64.zip";
    url = "https://nodejs.org/dist/v" + version + "/" + file;
    const sums = await net.text(
      "https://nodejs.org/dist/v" + version + "/SHASUMS256.txt",
    );
    sha256 = sums
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[1] === file)?.[0];
    requireThat(/^[a-f0-9]{64}$/i.test(sha256), "Official Node SHA256 missing");
    provenance = "https://nodejs.org/dist/index.json";
  } else if (rule.provider === "go") {
    const releases = await net.json("https://go.dev/dl/?mode=json");
    const r = releases
        .filter((r) => r.stable && /^go\d+\.\d+\.\d+$/.test(r.version))
        .sort((a, b) => compareVersions(b.version, a.version))[0],
      f = r?.files.find(
        (f) =>
          f.os === "windows" &&
          f.arch === "amd64" &&
          f.kind === "archive" &&
          f.filename.endsWith(".zip"),
      );
    requireThat(f, "No official Windows Go release");
    version = r.version.slice(2);
    sha256 = f.sha256;
    url = "https://dl.google.com/go/" + f.filename;
    provenance = "https://go.dev/dl/?mode=json";
  } else if (rule.provider === "nuget") {
    let page = rule.url;
    const pages = new Set(),
      entries = [];
    while (page) {
      requireThat(
        !pages.has(page) && pages.size < 10,
        "Gallery pagination exceeded limit",
      );
      pages.add(page);
      const xml = await net.text(page);
      entries.push(
        ...[...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]),
      );
      const next = xml.match(/<link[^>]*rel="next"[^>]*href="([^"]+)"/);
      page = next ? next[1].replaceAll("&amp;", "&") : null;
      if (page)
        requireThat(
          httpsURL(page).origin === httpsURL(rule.url).origin &&
            httpsURL(page).pathname === httpsURL(rule.url).pathname,
          "Gallery pagination escaped publisher API",
        );
    }
    version = best(
      entries
        .map(
          (e) => e.match(/<d:Version>([0-9]+(?:\.[0-9]+)+)<\/d:Version>/)?.[1],
        )
        .filter(Boolean),
    );
    const entry = entries.find((e) =>
      e.includes("<d:Version>" + version + "</d:Version>"),
    );
    const algorithm = entry.match(
        /<d:PackageHashAlgorithm>([^<]+)<\/d:PackageHashAlgorithm>/,
      )?.[1],
      hash = entry.match(/<d:PackageHash>([^<]+)<\/d:PackageHash>/)?.[1];
    if (algorithm === "SHA512" && hash) extra.sha512 = hash;
    url = render(rule.urlTemplate, { version });
  } else if (rule.provider === "rustup") {
    const toml = await net.text(rule.url);
    version = toml.match(/^version\s*=\s*['"]([0-9.]+)['"]/m)?.[1];
    requireThat(version, "Rustup stable version missing");
    url = render(rule.urlTemplate, { version });
    sha256 = (await net.text(url + ".sha256")).match(/^[a-f0-9]{64}/i)?.[0];
    requireThat(sha256, "Rustup publisher SHA256 missing");
  } else if (rule.provider === "regex") {
    const text = (await net.text(rule.url))
      .replaceAll("&amp;", "&")
      .replaceAll("\\u002F", "/")
      .replaceAll("\\/", "/");
    const matches = [...text.matchAll(new RegExp(rule.versionRegex, "g"))];
    version = best(matches.map(fromMatch));
    const chosen = matches.find((m) => fromMatch(m) === version),
      groups = { ...chosen.groups, version };
    // A channel that numbers builds separately from the application version
    // (app-v1.1.3-24 publishing 1.1.3-3-windows-x64.exe) needs both parts in
    // the registered version, or a newer build of the same series would look
    // already indexed.
    if (rule.versionTemplate) version = render(rule.versionTemplate, groups);
    url = render(rule.urlTemplate, { ...groups, version });
  } else if (rule.provider === "qqnt") {
    const configURL =
      "https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json";
    const data = await net.json(configURL);
    const windows = data.Windows;
    requireThat(
      typeof windows?.ntDownloadX64Url === "string",
      "QQ Windows x64 download missing",
    );
    const official = httpsURL(windows.ntDownloadX64Url);
    const match =
      /^\/qqfile\/QQNTV2\/(?<version>\d+\.\d+\.\d+)\/release\/[a-f0-9]+\/QQ_\k<version>_\d{6}_x64_\d+\.exe$/.exec(
        official.pathname,
      );
    requireThat(
      official.origin === "https://qqdl.gtimg.cn" &&
        !official.search &&
        !!match &&
        windows.version === match.groups.version,
      "QQ download escaped the official version-bound Windows x64 channel",
    );
    version = windows.version;
    url = official.href;
    provenance = configURL;
  } else if (rule.provider === "json") {
    const data = await net.json(rule.url);
    const raw = at(data, rule.versionPath);
    requireThat(
      typeof raw === "string" || typeof raw === "number",
      "Invalid upstream version field",
    );
    version = (rule.versionPrefix ?? "") + raw;
    if (rule.md5Path) md5 = at(data, rule.md5Path);
    url = render(rule.urlTemplate, { version });
  } else if (rule.provider === "redirect") {
    const resolved = await net.redirect(rule.url),
      match = new RegExp(rule.versionRegex).exec(resolved);
    requireThat(match, "Upstream redirect does not identify an exact release");
    version = fromMatch(match);
    url = rule.urlTemplate ? render(rule.urlTemplate, { version }) : resolved;
  } else if (rule.provider === "tabbit") {
    const data = await net.json(rule.url);
    const releases = Array.isArray(data) ? data : data.versions;
    requireThat(Array.isArray(releases), "Invalid Tabbit release list");
    // Preserve the CN full-payload channel. The public Windows release is
    // only a hint: the full CN artifact and its actual PE version must verify.
    version = best(
      releases
        .filter(
          (r) =>
            r.platform === "windows" &&
            ["x86_64", "amd64", "x64"].includes(r.arch?.toLowerCase()) &&
            /^\d+(?:\.\d+){3}$/.test(r.version ?? r.short_version_string),
        )
        .map((r) => r.version ?? r.short_version_string),
    );
    url = render(rule.urlTemplate, { version });
  } else if (rule.provider === "steam") {
    // The signed bootstrap manifest pins every client package by content
    // hash; only the international "row" bootstrapper zip is packaged. The
    // channel timestamp advances for any package, so a new version is only
    // reported when the bootstrapper payload itself changes.
    const channel = steamKV(await net.text(rule.url)).blocks.get("win32");
    requireThat(channel, "Steam win32 bootstrap channel missing");
    const stamp = channel.values.get("version");
    requireThat(
      /^\d+$/.test(stamp ?? "") &&
        Number(stamp) > 1600000000 &&
        Number(stamp) * 1000 < Date.now() + 86400000,
      "Steam bootstrap channel version is not a current timestamp",
    );
    const bootstrapper = channel.blocks.get("steam_win32");
    const file = bootstrapper?.values.get("file");
    const row = bootstrapper?.blocks.get("steamrow");
    sha256 = bootstrapper?.values.get("sha2");
    requireThat(
      /^steam_win32\.zip\.[0-9a-f]{40}$/.test(file ?? "") &&
        /^[0-9a-f]{64}$/i.test(sha256 ?? "") &&
        bootstrapper.values.get("IsBootstrapperPackage") === "1" &&
        row?.values.get("IsBootstrapperPackage") === "1" &&
        row?.values.get("file")?.split(".").at(-1) === file.split(".").at(-1) &&
        row?.values.get("sha2")?.toLowerCase() === sha256.toLowerCase(),
      "Steam bootstrapper is not the pinned international row payload",
    );
    url = new URL(file, rule.url).href;
    const pinned = current?.platforms?.["windows-x64"]?.url;
    version = pinned === url ? current?.version : stamp;
    requireThat(version, "Steam channel version cannot be derived");
    provenance = rule.url;
  } else throw Error("Unsupported provider");
  component(version);
  httpsURL(url);
  return {
    version,
    url,
    sha256,
    md5,
    provenance,
    ...extra,
    versionFromPE: !!rule.versionFromPE,
  };
}
