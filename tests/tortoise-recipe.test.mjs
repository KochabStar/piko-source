import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  tortoiseRecipe,
  applyTortoiseRecipe,
} from "../scripts/lib/tortoise-recipe.mjs";
import { nextManifest } from "../scripts/update.mjs";

const original = JSON.parse(
  await readFile(
    new URL("../packages/tortoise-svn/1.15.0.29830.json", import.meta.url),
    "utf8",
  ),
);
const revision = JSON.parse(
  await readFile(
    new URL(
      "../packages/tortoise-svn/1.15.0.29830-piko.1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const recipe = (m) =>
  m.platforms["windows-x64"].configFiles["piko-shell-extension.ps1"];
test("SVN recipe revision uses identical payload, version-specific registration and no shared overlay junction", async () => {
  const body = await tortoiseRecipe(original);
  assert.equal(recipe(revision), body);
  assert.equal(
    revision.platforms["windows-x64"].sha256,
    original.platforms["windows-x64"].sha256,
  );
  assert.equal(
    revision.platforms["windows-x64"].url,
    original.platforms["windows-x64"].url,
  );
  assert.equal(
    await tortoiseRecipe(revision),
    body,
    "recipe rebuild is idempotent",
  );
  assert.ok(body.includes("schemaVersion=2"));
  assert.ok(body.includes("Existing processes may use the old version"));
  assert.doesNotMatch(
    body.replace(/^\s*#.*$/gm, ""),
    /\$env:CommonProgramFiles|New-Item -ItemType Junction|Stop-Process|Restart-Computer|regsvr32|DeleteSubKeyTree/i,
  );
  const rows = JSON.parse(
    /\$values=ConvertFrom-Json @'\r?\n([\s\S]*?)\r?\n'@/.exec(body)[1],
  );
  assert.equal(
    rows.length,
    new Set(rows.map((r) => r.key.toLowerCase() + "|" + r.name)).size,
  );
  assert.ok(
    rows.some((r) =>
      r.value.includes(
        "{{root}}\\Common\\TortoiseOverlays\\TortoiseOverlays.dll",
      ),
    ),
  );
  assert.ok(
    rows.every(
      (r) =>
        !/Offline Files|Software\\Classes\\(?:\.diff|\.patch|unified_diff_file)(?:\\|$)/i.test(
          r.key,
        ),
    ),
  );
});
test("future SVN manifests inherit fixed recipe instead of reintroducing locked-junction behavior", async () => {
  const candidate = { version: "1.16.0.30000" };
  const next = nextManifest(revision, candidate, {});
  await applyTortoiseRecipe(next);
  assert.equal(recipe(next), recipe(revision));
  assert.equal(next.version, candidate.version);
  assert.equal(next.platforms["windows-x64"].admin.install.args[1], "{root}");
  assert.equal(
    recipe(original).includes("New-Item -ItemType Junction"),
    true,
    "immutable old manifest unchanged",
  );
});
test(
  "real PowerShell recipe switches versions with retryable ownership, never deleting loaded old payloads",
  { skip: process.platform !== "win32" },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "piko-svn-recipe-"));
    const key = "Software\\PikoSourceRecipeTests\\" + randomUUID();
    const prefix = key + "\\";
    const ps =
      process.env.SystemRoot +
      "/System32/WindowsPowerShell/v1.0/powershell.exe";
    const shell = (script, extra = {}) =>
      execFileSync(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(
            "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
              script,
            "utf16le",
          ).toString("base64"),
        ],
        {
          env: { ...process.env, ...extra },
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    try {
      const v1 = join(temp, "old version"),
        v2 = join(temp, "new version"),
        data = join(temp, "persist");
      for (const root of [v1, v2])
        for (const file of [
          "bin/TortoiseStub.dll",
          "bin/TortoiseSVN.dll",
          "bin/TSVNCache.exe",
          "Common/TortoiseOverlays/TortoiseOverlays.dll",
        ]) {
          await mkdir(join(root, file, ".."), { recursive: true });
          await writeFile(join(root, file), "fixture image kept");
        }
      // Test-only source transformation confines every registry operation to HKCU.
      // There is no production flag or environment switch for redirecting ownership.
      let body = recipe(revision).replaceAll(
        "[Microsoft.Win32.Registry]::LocalMachine",
        "[Microsoft.Win32.Registry]::CurrentUser",
      );
      body = body.replaceAll(
        "OpenSubKey($entry.key",
        "OpenSubKey(('" + prefix + "'+$entry.key)",
      );
      body = body.replaceAll(
        "CreateSubKey($entry.key",
        "CreateSubKey(('" + prefix + "'+$entry.key)",
      );
      const file = join(temp, "recipe.ps1");
      await writeFile(file, body);
      const invoke = (action, root) =>
        shell(
          "& $env:RECIPE -Action $env:ACTION -Root $env:ROOT -Data $env:DATA",
          { RECIPE: file, ACTION: action, ROOT: root, DATA: data },
        );
      const receipt = async () =>
        JSON.parse(
          await readFile(join(data, "shell-registration.json"), "utf8"),
        );
      invoke("install", v1);
      assert.equal((await receipt()).state, "installed");
      invoke("install", v1);
      assert.equal((await receipt()).root, v1);
      assert.throws(() => invoke("install", v2), /remove it first/);
      const before = await receipt();
      const server = before.entries.find(
        (e) => e.key.endsWith("InProcServer32") && e.name === "",
      );
      // The owned-path value is changed in the isolated namespace, not on the host.
      shell(
        "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:KEY,$true);try{$k.SetValue('','foreign path')}finally{$k.Dispose()}",
        { KEY: prefix + server.key },
      );
      assert.throws(() => invoke("remove", v1), /External registry drift/);
      shell(
        "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:KEY,$true);try{$k.SetValue('',$env:VALUE)}finally{$k.Dispose()}",
        { KEY: prefix + server.key, VALUE: server.after.value },
      );
      invoke("remove", v1);
      assert.equal((await receipt()).state, "removed");
      invoke("remove", v1); // Tombstone allows idempotent retry.
      invoke("install", v2);
      assert.equal((await receipt()).state, "installed");
      assert.equal((await receipt()).root, v2);
      const pathValue = shell(
        "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:KEY);try{$k.GetValue('')}finally{$k.Dispose()}",
        { KEY: prefix + server.key },
      ).trim();
      assert.ok(pathValue.startsWith(v2));
      assert.equal(
        await readFile(join(v1, "bin/TortoiseStub.dll"), "utf8"),
        "fixture image kept",
      );
      // A crash halfway through unregister is completed by comparing both snapshots.
      const pending = await receipt();
      pending.state = "removing";
      await writeFile(
        join(data, "shell-registration.json"),
        JSON.stringify(pending),
      );
      shell(
        "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:KEY,$true);try{$k.DeleteValue('',$false)}finally{$k.Dispose()}",
        { KEY: prefix + server.key },
      );
      invoke("remove", v2);
      assert.equal((await receipt()).state, "removed");
    } finally {
      shell(
        "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:KEY,$false)",
        { KEY: key },
      );
      await rm(temp, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
