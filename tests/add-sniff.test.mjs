import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sniffFormat, deriveEntries } from "../scripts/add.mjs";
import { Tools } from "../scripts/lib/tools.mjs";
import { network } from "../scripts/lib/net.mjs";

// The probe side of scripts/add.mjs, exercised against payloads that are already
// on disk: the parts that used to be hand work are format identification and
// rebuilding the explicit file map.
const root = "D:/code/work/piko/piko-source/";
const tools = new Tools(root, network());
const fixture = process.env.PIKO_FIXTURE_MSI;
const bundle = process.env.PIKO_FIXTURE_BURN;

if (!fixture || !bundle) {
  console.log("skipped: set PIKO_FIXTURE_MSI and PIKO_FIXTURE_BURN");
  process.exit(0);
}

// A bare MSI: recognised by its compound-document header, never by its name.
const msi = await sniffFormat(fixture, tools);
assert.equal(msi.format, "msi");
const msiEntries = await deriveEntries(fixture, msi, tools);
assert.ok(msiEntries.length > 0);
assert.ok(msiEntries.every((e) => !e.path.includes("\\")));

// A Burn bundle: recognised by its chained manifest, not by the .exe suffix,
// and the payload has to be named before a file list exists.
const burn = await sniffFormat(bundle, tools);
assert.equal(burn.format, "burn");
assert.ok(burn.burn.chain.length >= 2, "bundle chains several packages");
await assert.rejects(
  () => deriveEntries(bundle, burn, tools),
  /needs a payload id/,
);
const chosen = burn.burn.chain.at(-1).id;
const burnEntries = await deriveEntries(
  bundle,
  { ...burn, payload: chosen },
  tools,
);
assert.ok(burnEntries.length > 100);
// The selected payload's own tree, not the driver MSI's.
assert.ok(
  burnEntries.some((e) => /\.exe$/i.test(e.path)),
  "payload contains an executable",
);

console.log(
  JSON.stringify(
    {
      msi: { entries: msiEntries.length },
      burn: { payloads: burn.burn.chain.map((p) => p.id), chosen, entries: burnEntries.length },
    },
    null,
    2,
  ),
);
