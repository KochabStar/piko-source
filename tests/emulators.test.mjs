import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  validateManifest,
  validateRules,
} from "../scripts/lib/catalog.mjs";
import { discover } from "../scripts/lib/providers.mjs";
import { nextManifest } from "../scripts/update.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = await loadCatalog(root);
const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);
const platform = (name) =>
  catalog.manifests.get(
    name + "@" + catalog.index.packages[name].latest,
  ).platforms["windows-x64"];
const manifest = (name) =>
  catalog.manifests.get(name + "@" + catalog.index.packages[name].latest);

test("emulator and editor packages declare portable Windows x64 payloads only", () => {
  validateRules(catalog, rules);
  for (const name of [
    "retroarch",
    "ares",
    "mgba",
    "medusa",
    "shadps4",
    "vscode",
  ]) {
    const p = platform(name);
    validateManifest(manifest(name), name, catalog.index.packages[name].latest);
    assert.match(p.sha256, /^[a-f0-9]{64}$/, name);
    assert.equal(new URL(p.url).protocol, "https:", name);
    assert.equal(new URL(p.url).search, "", name);
    // No package runs an installer, service, driver or bootstrap step.
    for (const key of ["shell", "bootstrap", "admin", "depends", "env"])
      assert.equal(p[key], undefined, name + " " + key);
  }
});

test("retroarch redirects every data directory into its persistent tree", () => {
  const p = platform("retroarch");
  assert.equal(p.format, "7z");
  assert.equal(p.stripPrefix, "RetroArch-Win64");
  assert.deepEqual(p.bin, { retroarch: "retroarch.exe" });
  // RetroArch resolves saves/states/screenshots/system relative to the
  // application directory (`:\saves` and friends), so those directories must
  // be links into persist or an upgrade would strand the user's data.
  for (const dir of [
    "saves",
    "states",
    "screenshots",
    "system",
    "cores",
    "playlists",
    "thumbnails",
  ])
    assert.ok(p.persist.includes(dir), dir);
  const cfg = p.configTemplates["retroarch.cfg"].text;
  // The generated config points at the persistent tree, and RetroArch rewrites
  // it in place on exit (config_save_on_exit defaults to true). The shipped
  // info/ metadata stays in the payload: persisting it would shadow the core
  // info of every later version with the previous release's files.
  for (const key of [
    "savefile_directory",
    "savestate_directory",
    "screenshot_directory",
    "system_directory",
    "libretro_directory",
    "playlist_directory",
    "thumbnails_directory",
  ])
    assert.match(cfg, new RegExp('^' + key + ' = "\\{\\{persist\\}\\}/', "m"));
});

test("ares keeps user firmware and settings in the package tree", () => {
  const p = platform("ares");
  assert.equal(p.stripPrefix, "ares-v" + catalog.index.packages.ares.latest);
  assert.deepEqual(p.bin, { ares: "ares.exe" });
  // ares resolves settings.bml from the executable directory and writes it
  // with fopen("wb+"), which truncates in place; a hardlink therefore survives
  // the rewrite. Systems/ holds user-dumped firmware and lives beside it.
  assert.deepEqual(
    p.persist.map((v) => (typeof v === "string" ? v : v.path)),
    ["Systems", "settings.bml"],
  );
  assert.equal(p.persist[1].mode, "hardlink");
});

test("mgba keeps config.ini linked but leaves Qt state to the application", () => {
  const p = platform("mgba");
  assert.equal(
    p.stripPrefix,
    "mGBA-" + catalog.index.packages.mgba.latest + "-win64",
  );
  assert.deepEqual(p.bin, {
    mgba: "mGBA.exe",
    "mgba-sdl": "mgba-sdl.exe",
  });
  // The archive ships an empty portable.ini, so mGBA stores config.ini next to
  // the executable. ConfigurationWrite() truncates the file in place, which
  // keeps a hardlink valid. qt.ini is QSettings output written through a
  // temporary rename, so it must stay outside persist.
  assert.deepEqual(
    p.persist.map((v) => (typeof v === "string" ? v : v.path)),
    ["savestates", "screenshots", "cheats", "config.ini"],
  );
  assert.equal(p.persist.at(-1).mode, "hardlink");
  assert.equal(
    p.persist.some((v) => typeof v !== "string" && v.path === "qt.ini"),
    false,
  );
});

test("medusa is the mGBA preview build and stays a single executable", () => {
  const p = platform("medusa");
  assert.equal(catalog.index.packages.medusa.latest, "a2");
  assert.equal(p.stripPrefix, "medusa-medusa-2017-04-26-win64");
  assert.deepEqual(p.bin, { medusa: "medusa.exe" });
  assert.equal(p.persist, undefined);
});

test("shadps4 publishes the SDL CLI and keeps its portable user directory", () => {
  const p = platform("shadps4");
  assert.equal(p.format, "zip");
  assert.equal(p.stripPrefix, undefined);
  assert.deepEqual(p.bin, { shadps4: "shadPS4.exe" });
  // shadPS4 treats a `user` directory beside the executable as its portable
  // root and creates every data subdirectory under it; declaring that root
  // persists settings, keys, patches and per-game configs together.
  assert.deepEqual(p.persist, ["user"]);
  // With no arguments the CLI only shows a message box, so the shortcut opens
  // Big Picture mode instead of a dead end.
  assert.deepEqual(p.desktop.shortcuts, [
    { name: "shadPS4", path: "shadPS4.exe", args: ["-b"] },
  ]);
});

test("vscode uses the portable ZIP with a data directory and a code shim", () => {
  const p = platform("vscode");
  assert.equal(p.format, "zip");
  assert.deepEqual(Object.keys(p.bin), ["code", "code-gui"]);
  // The ZIP carries only bin/code.cmd for the CLI, and Piko native mappings
  // must target .exe/.com, so `code` is a PowerShell entry point that forwards
  // to the shipped wrapper; `code-gui` launches the editor directly.
  assert.deepEqual(p.bin.code, { path: "piko-code.ps1", kind: "powershell" });
  assert.equal(p.bin["code-gui"], "Code.exe");
  assert.match(p.configFiles["piko-code.ps1"], /code\.cmd/);
  // Portable mode is enabled by the presence of a `data` directory; the ZIP
  // build has no auto update, so Piko owns the version.
  assert.deepEqual(p.persist, ["data"]);
});

test("retroarch discovery reads the official stable index", async () => {
  const rule = rules.packages.retroarch;
  assert.equal(rule.provider, "regex");
  const listing = [
    '<a href="/stable/1.22.1/">1.22.1</a>',
    '<a href="/stable/1.22.2/">1.22.2</a>',
    '<a href="/stable/1.21.0/">1.21.0</a>',
  ].join("\n");
  const candidate = await discover(rule, platform("retroarch"), {
    text: async (url) => {
      assert.equal(url, "https://buildbot.libretro.com/stable/");
      return listing;
    },
  });
  assert.equal(candidate.version, "1.22.2");
  assert.equal(
    candidate.url,
    "https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch.7z",
  );
});

test("ares discovery ignores the nightly pre-release channel", async () => {
  const rule = rules.packages.ares;
  assert.equal(rule.provider, "github-release");
  const asset = {
    name: "ares-windows-x64.zip",
    browser_download_url:
      "https://github.com/ares-emulator/ares/releases/download/v149/ares-windows-x64.zip",
    digest: "sha256:" + "a".repeat(64),
    size: 1,
  };
  const releases = [
    {
      tag_name: "nightly",
      draft: false,
      prerelease: true,
      assets: [asset],
    },
    {
      tag_name: "v149",
      draft: false,
      prerelease: false,
      assets: [asset],
    },
  ];
  const candidate = await discover(rule, platform("ares"), {
    json: async () => releases,
  });
  assert.equal(candidate.version, "149");
  assert.equal(
    candidate.url,
    "https://github.com/ares-emulator/ares/releases/download/v149/ares-windows-x64.zip",
  );
});

test("mgba discovery rejects the medusa and installer asset variants", async () => {
  const rule = rules.packages.mgba;
  const asset = {
    name: "mGBA-0.10.6-win64.7z",
    browser_download_url:
      "https://github.com/mgba-emu/mgba/releases/download/0.10.6/mGBA-0.10.6-win64.7z",
    digest: null,
    size: 1,
  };
  const candidate = await discover(rule, platform("mgba"), {
    json: async () => [
      {
        tag_name: "medusa-a2",
        draft: false,
        prerelease: true,
        assets: [asset],
      },
      { tag_name: "0.10.6", draft: false, prerelease: false, assets: [asset] },
    ],
  });
  assert.equal(candidate.version, "0.10.6");
  assert.equal(
    candidate.url,
    "https://github.com/mgba-emu/mgba/releases/download/0.10.6/mGBA-0.10.6-win64.7z",
  );
});

test("medusa discovery follows the official downloads page", async () => {
  const rule = rules.packages.medusa;
  assert.equal(rule.provider, "regex");
  const page =
    '<a href="https://buildbot.libretro.com/assets/cores/medusa-a2-win64.7z">a2</a>' +
    '<a href="https://buildbot.libretro.com/assets/cores/medusa-build-latest-win64.7z">latest</a>';
  const candidate = await discover(rule, platform("medusa"), {
    text: async (url) => {
      assert.equal(url, "https://mgba.io/downloads.html");
      return page;
    },
  });
  assert.equal(candidate.version, "a2");
  assert.equal(
    candidate.url,
    "https://github.com/mgba-emu/mgba/releases/download/medusa-a2/medusa-a2-win64.7z",
  );
});

test("shadps4 discovery accepts only stable v.<version> tags", async () => {
  const rule = rules.packages.shadps4;
  const asset = {
    name: "shadps4-win64-sdl-0.22.0.zip",
    browser_download_url:
      "https://github.com/shadps4-emu/shadPS4/releases/download/v.0.22.0/shadps4-win64-sdl-0.22.0.zip",
    digest: null,
    size: 1,
  };
  const candidate = await discover(rule, platform("shadps4"), {
    json: async () => [
      {
        tag_name: "Pre-release-shadPS4-2026-11-07",
        draft: false,
        prerelease: true,
        assets: [asset],
      },
      { tag_name: "v.0.22.0", draft: false, prerelease: false, assets: [asset] },
    ],
  });
  assert.equal(candidate.version, "0.22.0");
  assert.equal(
    candidate.url,
    "https://github.com/shadps4-emu/shadPS4/releases/download/v.0.22.0/shadps4-win64-sdl-0.22.0.zip",
  );
});

test("vscode discovery follows the official update API", async () => {
  const rule = rules.packages.vscode;
  assert.equal(rule.provider, "json");
  const candidate = await discover(rule, platform("vscode"), {
    json: async (url) => {
      assert.equal(
        url,
        "https://update.code.visualstudio.com/api/update/win32-x64-archive/stable/latest",
      );
      return { productVersion: "1.146.0", sha256hash: "b".repeat(64) };
    },
  });
  assert.equal(candidate.version, "1.146.0");
  assert.equal(
    candidate.url,
    "https://update.code.visualstudio.com/1.146.0/win32-x64-archive/stable",
  );
});

test("version updates retarget only the versioned path fragments", () => {
  const ares = nextManifest(
    manifest("ares"),
    {
      version: "149",
      url: "https://github.com/ares-emulator/ares/releases/download/v149/ares-windows-x64.zip",
      sha256: "c".repeat(64),
    },
    rules.packages.ares,
  );
  const ap = ares.platforms["windows-x64"];
  assert.equal(ap.stripPrefix, "ares-v149");
  assert.deepEqual(ap.bin, { ares: "ares.exe" });
  assert.deepEqual(
    ap.persist.map((v) => (typeof v === "string" ? v : v.path)),
    ["Systems", "settings.bml"],
  );
  validateManifest(ares, "ares", "149");

  const mgba = nextManifest(
    manifest("mgba"),
    {
      version: "0.10.6",
      url: "https://github.com/mgba-emu/mgba/releases/download/0.10.6/mGBA-0.10.6-win64.7z",
      sha256: "d".repeat(64),
    },
    rules.packages.mgba,
  );
  const mp = mgba.platforms["windows-x64"];
  assert.equal(mp.stripPrefix, "mGBA-0.10.6-win64");
  assert.equal(mp.persist.at(-1).mode, "hardlink");
  validateManifest(mgba, "mgba", "0.10.6");

  // RetroArch and VS Code keep every path fragment across versions, and the
  // generated configuration must not be rewritten by a version bump.
  for (const [name, version] of [
    ["retroarch", "1.23.0"],
    ["vscode", "1.146.0"],
  ]) {
    const next = nextManifest(
      manifest(name),
      {
        version,
        url: "https://example.invalid/" + version,
        sha256: "e".repeat(64),
      },
      rules.packages[name],
    );
    assert.equal(
      JSON.stringify(next.platforms["windows-x64"].configTemplates),
      JSON.stringify(manifest(name).platforms["windows-x64"].configTemplates),
      name,
    );
    validateManifest(next, name, version);
  }
});
