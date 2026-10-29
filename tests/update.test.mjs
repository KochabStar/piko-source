import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runUpdate, nextManifest, markdownReport } from "../scripts/update.mjs";
import { checkSource } from "../scripts/check.mjs";
import {
  component,
  pathName,
  httpsURL,
  digest,
  loadCatalog,
  validateRules,
  MiB,
} from "../scripts/lib/catalog.mjs";
import { discover, compareVersions } from "../scripts/lib/providers.mjs";
import { network, request } from "../scripts/lib/net.mjs";
import {
  parseListing,
  innoEntries,
  checkLayout,
} from "../scripts/lib/layout.mjs";
import { msiTable } from "../scripts/lib/msi.mjs";
const source = fileURLToPath(new URL("../", import.meta.url));
const body = Buffer.from("new verified archive"),
  sha = digest(body);
const candidate = {
  version: "2.0.0",
  url: "https://vendor.example/demo-2.0.0.zip",
  sha256: sha,
  provenance: "https://vendor.example/releases",
};
const fixtureManifest = (name = "demo") => ({
  schemaVersion: 1,
  name,
  version: "1.0.0",
  platforms: {
    "windows-x64": {
      url: "https://vendor.example/" + name + "-1.0.0.zip",
      sha256: digest("old " + name),
      format: "zip",
      stripPrefix: name + "-1.0.0",
      bin: { [name]: name + ".exe" },
      persist: ["Data"],
      env: { DEMO_HOME: "{persist}/Data" },
      configFiles: { "owned.ps1": "unchanged configuration" },
      desktop: { shortcuts: [{ name: "Demo", path: name + ".exe" }] },
    },
  },
});
async function fixture(t, names = ["demo"]) {
  const root = await mkdtemp(join(tmpdir(), "piko-source-tests-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const index = { schemaVersion: 1, packages: {} },
    rules = { schemaVersion: 1, packages: {} };
  for (const name of names) {
    await mkdir(join(root, "packages", name), { recursive: true });
    const file = `packages/${name}/1.0.0.json`;
    index.packages[name] = { latest: "1.0.0", versions: { "1.0.0": file } };
    rules.packages[name] = {
      provider: "json",
      url: "https://vendor.example/latest.json",
      versionPath: "version",
      urlTemplate: "https://vendor.example/" + name + "-{version}.zip",
    };
    await writeFile(
      join(root, file),
      JSON.stringify(fixtureManifest(name), null, 2) + "\n",
    );
  }
  await mkdir(join(root, "automation"));
  await writeFile(join(root, "automation/rules.json"), JSON.stringify(rules));
  await writeFile(
    join(root, "index.json"),
    JSON.stringify(index, null, 2) + "\n",
  );
  return root;
}
const dependencies = {
  discoverer: async () => candidate,
  net: network({ token: undefined, fetcher: async () => new Response(body) }),
  verify: async (m, artifacts) => {
    assert.equal(m.platforms["windows-x64"].stripPrefix, m.name + "-2.0.0");
    assert.equal(digest(await readFile(artifacts[0].file)), sha);
    return { files: 1, unknownSizeFiles: 0, reviewSensitive: false };
  },
};

test("current source: every indexed package has a validated update policy", async () => {
  const r = await checkSource(source);
  assert.ok(r.packages >= 46);
  assert.equal(r.automatic + r.manual.length, r.packages);
  assert.deepEqual(r.manual, ["innounp", "dingtalk"]);
});
test("safe paths reject traversal, streams, absolute paths, device names and unsafe versions", () => {
  for (const p of [
    "../x",
    "x/../../z",
    "/etc/passwd",
    "C:/x",
    "x\\y",
    "x:ads",
    "NUL.txt",
    "a/COM1",
    "a.",
    "a//b",
    ".",
    "a/*",
  ])
    assert.throws(() => pathName(p), undefined, p);
  for (const p of [".cargo/bin/rustup.exe", "{app}/Bin/a.exe", "a b/test.dll"])
    assert.equal(pathName(p), p);
  for (const v of ["../v", "a/b", "a..b", "-v", "a b"])
    assert.throws(() => component(v));
  for (const u of [
    "http://example.com/x",
    "https://user:password@example.com/x",
    "https://example.com/x#hash",
  ])
    assert.throws(() => httpsURL(u));
});
test("numeric vendor/build versions are ordered without treating a fourth component as text", () => {
  assert.ok(compareVersions("4.2.0.10", "4.2.0.9") > 0);
  assert.ok(compareVersions("4-4216", "4-4215") > 0);
  assert.ok(compareVersions("1.37.0-2", "1.37.0-1") > 0);
  assert.equal(compareVersions("1.19.25", "1.19.25.0"), 0);
});
test("discovery never downloads a payload or edits the source", async (t) => {
  const root = await fixture(t),
    before = await readFile(join(root, "index.json"));
  let requested = false;
  const r = await runUpdate(root, {
    ...dependencies,
    mode: "discover",
    net: {
      download() {
        requested = true;
        throw Error("must not download");
      },
    },
  });
  assert.equal(r.results[0].status, "available");
  assert.equal(requested, false);
  assert.deepEqual(await readFile(join(root, "index.json")), before);
  assert.deepEqual(await readdir(join(root, "packages/demo")), ["1.0.0.json"]);
});
test("check verifies the real publisher checksum and leaves index/manifests byte-identical", async (t) => {
  const root = await fixture(t),
    before = await readFile(join(root, "index.json")),
    old = await readFile(join(root, "packages/demo/1.0.0.json"));
  const r = await runUpdate(root, { ...dependencies, mode: "check" });
  assert.equal(r.blocked, 0);
  assert.equal(r.changed, 0);
  assert.equal(r.results[0].status, "validated");
  assert.deepEqual(await readFile(join(root, "index.json")), before);
  assert.deepEqual(await readFile(join(root, "packages/demo/1.0.0.json")), old);
  assert.deepEqual(await readdir(join(root, "packages/demo")), ["1.0.0.json"]);
});
test("write appends the verified version, retains old bytes and preserves existing runtime/alias metadata", async (t) => {
  const root = await fixture(t),
    index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  index.packages.demo.runtime = { family: "demo", distribution: "official" };
  index.packages.demo.aliases = { stable: "1.0.0" };
  await writeFile(join(root, "index.json"), JSON.stringify(index));
  const before = await readFile(join(root, "packages/demo/1.0.0.json"));
  const r = await runUpdate(root, { ...dependencies, mode: "write" });
  assert.equal(r.changed, 1);
  const after = await loadCatalog(root);
  assert.equal(after.index.packages.demo.latest, "2.0.0");
  assert.deepEqual(
    after.index.packages.demo.runtime,
    index.packages.demo.runtime,
  );
  assert.deepEqual(
    after.index.packages.demo.aliases,
    index.packages.demo.aliases,
  );
  assert.deepEqual(
    await readFile(join(root, "packages/demo/1.0.0.json")),
    before,
  );
  const next = after.manifests.get("demo@2.0.0").platforms["windows-x64"];
  assert.equal(next.sha256, sha);
  assert.equal(next.configFiles["owned.ps1"], "unchanged configuration");
  assert.deepEqual(next.persist, ["Data"]);
});
test("publisher digest mismatch blocks promotion without losing the previous source", async (t) => {
  const root = await fixture(t);
  const r = await runUpdate(root, {
    ...dependencies,
    mode: "write",
    net: network({ fetcher: async () => new Response("tampered archive") }),
  });
  assert.equal(r.blocked, 1);
  assert.equal(r.changed, 0);
  assert.match(r.results[0].reason, /SHA256 mismatch/);
  assert.equal((await loadCatalog(root)).index.packages.demo.latest, "1.0.0");
});
test("same-version upstream replacement is refused rather than rewriting an immutable pin", async (t) => {
  const root = await fixture(t);
  const r = await runUpdate(root, {
    ...dependencies,
    mode: "write",
    discoverer: async () => ({ ...candidate, version: "1.0.0" }),
  });
  assert.equal(r.blocked, 1);
  assert.match(r.results[0].reason, /Same-version/);
  assert.deepEqual(await readdir(join(root, "packages/demo")), ["1.0.0.json"]);
});
test("older feeds cannot downgrade a source and manual policies perform no network requests", async (t) => {
  const root = await fixture(t, ["demo", "other"]);
  const r = await runUpdate(root, {
    ...dependencies,
    mode: "write",
    discoverer: async (_rule, current) =>
      current.name === "demo"
        ? { ...candidate, version: "0.9.0" }
        : { manual: true, reason: "audited pin" },
    net: {
      download() {
        throw Error("unexpected");
      },
    },
  });
  assert.deepEqual(
    r.results.map((v) => v.status),
    ["provider-behind", "manual"],
  );
  assert.equal(r.changed, 0);
  assert.equal(r.blocked, 0);
});
test("layout failures keep one package unchanged while independently valid packages are retained", async (t) => {
  const root = await fixture(t, ["demo", "other"]);
  const r = await runUpdate(root, {
    ...dependencies,
    mode: "write",
    verify: async (m) => {
      if (m.name === "demo") throw Error("entry disappeared");
      return { files: 1 };
    },
  });
  assert.equal(r.changed, 1);
  assert.equal(r.blocked, 1);
  const c = await loadCatalog(root);
  assert.equal(c.index.packages.demo.latest, "1.0.0");
  assert.equal(c.index.packages.other.latest, "2.0.0");
});
test("selection is validated before a network request", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    () => runUpdate(root, { ...dependencies, packages: ["does-not-exist"] }),
    /Unknown package/,
  );
});
test("version-bound approval/configuration code cannot be blindly rewritten", () => {
  const m = fixtureManifest();
  m.platforms["windows-x64"].configFiles["owned.ps1"] = "run version 1.0.0";
  assert.throws(() => nextManifest(m, candidate, {}), /manual recipe review/);
});
test("mutable marketing URLs require a newer native PE version before publishing", async (t) => {
  const root = await fixture(t);
  const r = await runUpdate(root, {
    ...dependencies,
    mode: "write",
    discoverer: async () => ({
      ...candidate,
      version: "1.0",
      versionFromPE: true,
    }),
    verify: async () => ({ files: 1, version: "1.0.0" }),
  });
  assert.equal(r.blocked, 1);
  assert.equal(r.changed, 0);
  assert.match(r.results[0].reason, /without a newer application version/);
});
test("mutable marketing URLs publish the inspected native version rather than the filename hint", async (t) => {
  const root = await fixture(t);
  const r = await runUpdate(root, {
    ...dependencies,
    mode: "write",
    discoverer: async () => ({
      ...candidate,
      version: "2.0",
      versionFromPE: true,
    }),
    verify: async () => ({ files: 1, version: "2.0.0.9" }),
  });
  assert.equal(r.changed, 1);
  assert.equal((await loadCatalog(root)).index.packages.demo.latest, "2.0.0.9");
});
test("GitHub assets must be unique, stable, from the configured repo, with matching published digests", async () => {
  const m = fixtureManifest(),
    rule = {
      provider: "github-release",
      repo: "owner/project",
      versionRegex: "^v(?<version>[0-9.]+)$",
      assetRegex: "^app-x64\\.zip$",
    };
  const release = {
    tag_name: "v2.0.0",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "app-x64.zip",
        browser_download_url:
          "https://github.com/owner/project/releases/download/v2.0.0/app-x64.zip",
        digest: "sha256:" + sha,
        size: body.length,
      },
    ],
  };
  let r = await discover(rule, m, { json: async () => release });
  assert.equal(r.sha256, sha);
  assert.equal(r.version, "2.0.0");
  await assert.rejects(
    () =>
      discover(rule, m, {
        json: async () => ({
          ...release,
          assets: [...release.assets, ...release.assets],
        }),
      }),
    /ambiguous/,
  );
  await assert.rejects(
    () =>
      discover(rule, m, {
        json: async () => ({
          ...release,
          assets: [
            {
              ...release.assets[0],
              browser_download_url:
                "https://github.com/other/project/releases/download/v2.0.0/app-x64.zip",
            },
          ],
        }),
      }),
    /escaped/,
  );
});
test("REST redirects never forward the GitHub repository token to the release CDN", async () => {
  const headers = [];
  const response = await request("https://api.github.com/start", {
    token: "test-token-not-a-real-secret",
    fetcher: async (u, o) => {
      headers.push({
        host: u.hostname,
        authorization: o.headers.Authorization,
      });
      return u.hostname === "api.github.com"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example.org/app.zip" },
          })
        : new Response("payload");
    },
  });
  assert.equal(await response.text(), "payload");
  assert.equal(headers[0].authorization, "Bearer test-token-not-a-real-secret");
  assert.equal(headers[1].authorization, undefined);
});
test("payload download is bounded, checks SHA256 and rejects HTTP/HTML/empty responses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piko-net-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let n = 0;
  for (const [bytes, options, message] of [
    [body, { maxBytes: 2 }, /limit/],
    [body, { sha256: "0".repeat(64) }, /SHA256/],
    [Buffer.alloc(0), {}, /Empty/],
  ]) {
    const net = network({ fetcher: async () => new Response(bytes) });
    await assert.rejects(
      () =>
        net.download(
          "https://vendor.example/app",
          join(root, String(n++)),
          options,
        ),
      message,
    );
  }
  await assert.rejects(
    () =>
      network({
        fetcher: async () =>
          new Response("<html>", { headers: { "content-type": "text/html" } }),
      }).download("https://vendor.example/app", join(root, "html")),
    /HTML/,
  );
});
test("archive metadata rejects traversal, links, encryption, case collisions and unsupported TAR types", () => {
  const row = (name, extra = "") =>
    `Path = ${name}\nSize = 4\nAttributes = A\n${extra}`;
  for (const text of [
    row("../escape"),
    row("safe", "Symbolic Link = target\n"),
    row("safe", "Encrypted = +\n"),
    row("App.exe") + "\n" + row("app.exe"),
  ])
    assert.throws(() => parseListing(text, "zip"));
  assert.throws(() => parseListing(row("fifo", "Mode = prw-r--r--\n"), "tar"));
  assert.equal(
    parseListing("Path = app.exe\nSize = \nAttributes = A\n", "nsis")[0].size,
    undefined,
  );
  assert.throws(() =>
    parseListing("Path = app.exe\nSize = \nAttributes = A\n", "zip"),
  );
  assert.equal(
    parseListing(row("data/file.txt"), "zip")[0].path,
    "data/file.txt",
  );
});
test("Inno variant identities and MSI CSV are parsed without installing either format", () => {
  const text =
    "metadata\n----------\n  123 2026-10-29 12:00 {app}\\program,2.exe\n----------\n";
  assert.equal(innoEntries(text)[0].path, "{app}/program,2.exe");
  assert.throws(() => innoEntries(text.replace("123 2026", "size 2026")));
  assert.deepEqual(
    msiTable('File,FileName\nA,"PROGRAM|name,with,commas.exe"\n', [
      "File",
      "FileName",
    ]),
    [{ File: "A", FileName: "PROGRAM|name,with,commas.exe" }],
  );
  assert.throws(() => msiTable("File,File\nA,B", ["File"]));
});
test("a native file is only inspected, never executed, and must have PE magic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piko-pe-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, "not-runnable.exe");
  await writeFile(image, "MZdeliberately-not-executable");
  const m = fixtureManifest(),
    p = m.platforms["windows-x64"];
  Object.assign(p, { format: "file", file: "demo.exe" });
  delete p.stripPrefix;
  const noTools = {
    get() {
      throw Error("Native application must not be executed");
    },
  };
  const r = await checkLayout(
    m,
    [{ file: image, bytes: 28 }],
    {},
    noTools,
    root,
  );
  assert.equal(r.files, 1);
  await writeFile(image, "HTML");
  await assert.rejects(
    () => checkLayout(m, [{ file: image, bytes: 4 }], {}, noTools, root),
    /not a PE/,
  );
});
test("git comparison rejects alteration or removal of any published manifest", async (t) => {
  const root = await fixture(t);
  const git = (args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git(["init", "--initial-branch=main"]);
  git(["add", "index.json", "packages", "automation"]);
  git([
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=" + join(root, "empty-hooks"),
    "commit",
    "-m",
    "fixture baseline",
  ]);
  const base = git(["rev-parse", "HEAD"]);
  await checkSource(root, { base });
  const file = join(root, "packages/demo/1.0.0.json");
  await writeFile(file, (await readFile(file, "utf8")) + "\n");
  await assert.rejects(() => checkSource(root, { base }), /manifest modified/);
});
test("concurrent index edits are detected before any new version is published", async (t) => {
  const root = await fixture(t),
    before = await readFile(join(root, "index.json")),
    userEdit = Buffer.concat([before, Buffer.from(" ")]);
  await assert.rejects(
    () =>
      runUpdate(root, {
        ...dependencies,
        mode: "write",
        verify: async () => {
          await writeFile(join(root, "index.json"), userEdit);
          return { files: 1 };
        },
      }),
    /changed during verification/,
  );
  assert.deepEqual(await readFile(join(root, "index.json")), userEdit);
  assert.deepEqual(await readdir(join(root, "packages/demo")), ["1.0.0.json"]);
});

test("Gallery pagination finds newer stable versions and retains the publisher SHA512", async () => {
  let calls = 0;
  const r = await discover(
    {
      provider: "nuget",
      url: "https://gallery.example/api/v2/feed",
      urlTemplate: "https://gallery.example/packages/psfzf.{version}.nupkg",
    },
    fixtureManifest("psfzf"),
    {
      text: async (url) => {
        calls++;
        return url.includes("skip")
          ? "<entry><d:Version>2.10.0</d:Version><d:PackageHashAlgorithm>SHA512</d:PackageHashAlgorithm><d:PackageHash>publisher-sha512</d:PackageHash></entry><entry><d:Version>3.0.0-alpha</d:Version></entry>"
          : '<entry><d:Version>2.9.0</d:Version></entry><link rel="next" href="https://gallery.example/api/v2/feed?skip=100" />';
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(r.version, "2.10.0");
  assert.equal(r.sha512, "publisher-sha512");
  await assert.rejects(
    () =>
      discover(
        {
          provider: "nuget",
          url: "https://gallery.example/api/v2/feed",
          urlTemplate: "https://gallery.example/{version}",
        },
        fixtureManifest(),
        {
          text: async () =>
            '<link rel="next" href="https://other.example/secret" />',
        },
      ),
    /escaped publisher/,
  );
});

test("official Rustup single-quoted TOML and publisher SHA256 are supported", async () => {
  const r = await discover(
    {
      provider: "rustup",
      url: "https://static.rust-lang.org/release.toml",
      urlTemplate:
        "https://static.rust-lang.org/archive/{version}/rustup-init.exe",
    },
    fixtureManifest(),
    {
      text: async (url) =>
        url.endsWith(".sha256")
          ? sha + "  rustup-init.exe"
          : "schema-version = '1'\nversion = '1.29.2'\n",
    },
  );
  assert.equal(r.version, "1.29.2");
  assert.equal(r.sha256, sha);
});

test("ToDesk stable links are read without evaluating Nuxt or selecting gray releases", async () => {
  const rule = {
    provider: "regex",
    url: "https://www.todesk.com/download.html",
    versionRegex:
      '\\bwin_link:\\s*"https://dl\\.todesk\\.com/irrigation/ToDesk_(?<version>[0-9.]+)\\.exe"',
    urlTemplate: "https://dl.todesk.com/irrigation/ToDesk_{version}.exe",
  };
  const r = await discover(rule, fixtureManifest(), {
    text: async () =>
      String.raw`win_link:"https:\u002F\u002Fdl.todesk.com\u002Firrigation\u002FToDesk_5.2.3.0.exe",win_link_gray:"https:\u002F\u002Fdl.todesk.com\u002Firrigation\u002FToDesk_5.3.0.0.exe"`,
  });
  assert.equal(r.version, "5.2.3.0");
});

test("Tabbit chooses the Windows x64 release while preserving the full CN payload", async () => {
  const r = await discover(
    {
      provider: "tabbit",
      url: "https://www.tabbit.ai/api/v0/upgrade/latest",
      urlTemplate:
        "https://releases.tabbit.com/upgrade/windows/stable_x64_cn/Tabbit%20Browser_stable_x64_cn_{version3}.exe",
    },
    fixtureManifest(),
    {
      json: async () => ({
        versions: [
          { platform: "linux", arch: "x86_64", version: "9.0.0.0" },
          { platform: "mac", arch: "ARM_64", version: "3.0.0.0" },
          { platform: "windows", arch: "x86_64", version: "2.0.1.0" },
        ],
      }),
    },
  );
  assert.equal(r.version, "2.0.1.0");
  assert.match(r.url, /stable_x64_cn_2\.0\.1\.exe$/);
});

test("combined download targets cannot collide with a file used as a parent directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piko-combined-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, "data.exe");
  await writeFile(image, "MZfixture");
  const m = fixtureManifest(),
    p = m.platforms["windows-x64"];
  for (const k of ["url", "sha256", "format", "stripPrefix"]) delete p[k];
  p.downloads = ["demo.exe", "demo.exe/child.exe"].map((file) => ({
    url: "https://vendor.example/data.exe",
    sha256: sha,
    format: "file",
    file,
  }));
  await assert.rejects(
    () =>
      checkLayout(
        m,
        p.downloads.map(() => ({ file: image, bytes: 9 })),
        {},
        null,
        root,
      ),
    /collide/,
  );
});

test("reports state blocked/manual packages and do not claim GUI or service certification", () => {
  const md = markdownReport({
    mode: "write",
    changed: 1,
    blocked: 1,
    results: [
      {
        name: "demo",
        current: "1.0.0",
        version: "2.0.0",
        status: "updated",
        sha256: sha,
      },
      { name: "other", status: "blocked", reason: "bad | input\nnext" },
    ],
  });
  assert.match(md, /no auto-merge/);
  assert.match(md, /Blocked: 1/);
  assert.match(md, /bad \\\| input next/);
  assert.match(md, /not GUI, service\/driver/);
});
