import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { network } from "../scripts/lib/net.mjs";
import { discover } from "../scripts/lib/providers.mjs";
import { QQDownloadSession } from "../scripts/lib/qq-download.mjs";

const endpoint =
  "https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign";
const url =
  "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe";
const signed = (secret = "a".repeat(32)) =>
  url + "?sign=" + secret + "&t=1793580150";
const success = (u = signed()) =>
  Response.json({ retcode: 0, data: { url: u } });
const rule = { provider: "qqnt", versionFromPE: true };

test("QQ metadata discovery uses only the official unsigned version-bound x64 channel", async () => {
  const candidate = await discover(
    rule,
    {},
    {
      json: async (target) => {
        assert.equal(
          target,
          "https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json",
        );
        return { Windows: { version: "9.9.36", ntDownloadX64Url: url } };
      },
    },
  );
  assert.equal(candidate.url, url);
  assert.equal(candidate.version, "9.9.36");
  assert.equal(candidate.versionFromPE, true);
  for (const invalid of [
    url.replace("qqdl.gtimg.cn", "evil.example"),
    url.replace("_x64_", "_arm64_"),
    url.replace("_9.9.36_", "_9.9.35_"),
    signed(),
    url.replace("https:", "http:"),
  ])
    await assert.rejects(() =>
      discover(
        rule,
        {},
        {
          json: async () => ({
            Windows: { version: "9.9.36", ntDownloadX64Url: invalid },
          }),
        },
      ),
    );
});

test("source downloads get fresh official authorization while preserving immutable URL, SHA256 and credentials boundary", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "piko-qq-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "artifact");
  const bytes = Buffer.from("MZpublisher fixture");
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const targets = [];
  const net = network({
    token: "GITHUB_SECRET",
    fetcher: async (target, options) => {
      target = String(target);
      targets.push(target);
      assert.equal(new Headers(options.headers).get("Authorization"), null);
      if (target === endpoint) {
        assert.equal(options.method, "POST");
        assert.equal(options.redirect, "manual");
        assert.equal(options.credentials, "omit");
        assert.deepEqual(JSON.parse(options.body), { url });
        return success();
      }
      assert.equal(target, signed());
      return new Response(bytes);
    },
  });
  const result = await net.download(url, file, { sha256, maxBytes: 1024 });
  assert.equal(result.url, url);
  assert.equal(result.sha256, sha256);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(targets, [endpoint, signed()]);
});

test("source signature requests share in-flight work and refresh once after a forbidden download", async () => {
  let signatures = 0,
    downloads = 0;
  const fetcher = async (target) => {
    if (String(target) === endpoint) {
      signatures++;
      return success(signed((signatures === 1 ? "a" : "b").repeat(32)));
    }
    downloads++;
    return downloads === 1
      ? new Response(null, { status: 403 })
      : new Response("ok");
  };
  const session = new QQDownloadSession(url, fetcher);
  await Promise.all([session.resolve(), session.resolve(), session.resolve()]);
  assert.equal(signatures, 1);
  signatures = downloads = 0;
  assert.equal(await network({ fetcher }).text(url), "ok");
  assert.equal(signatures, 2);
  assert.equal(downloads, 2);
});

test("source signing rejects malicious host/path, auth errors, oversized metadata and redirects without exposing signatures", async () => {
  const cases = [
    () => success(signed().replace("qqdl.gtimg.cn", "evil.example")),
    () => success(signed().replace("e8e54bbb", "other")),
    () => success(signed() + "&other=1"),
    () => success(signed().replace("https:", "http:")),
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/?secret=PRIVATE" },
      }),
    () => new Response("PRIVATE".repeat(12000)),
    () => Response.json({ retcode: 1, error: { message: "PRIVATE" } }),
    () => {
      throw Error("PRIVATE " + signed());
    },
  ];
  for (const response of cases) {
    let calls = 0;
    await assert.rejects(
      () =>
        network({
          fetcher: async (target) => {
            calls++;
            assert.equal(String(target), endpoint);
            return response();
          },
        }).text(url),
      (error) =>
        /authorization failed/.test(error.message) &&
        !error.message.includes("PRIVATE") &&
        !error.message.includes("sign="),
    );
    assert.equal(calls, 1);
  }
});

test("source signing retains checksum/size bounds and leaves old channels untouched", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "piko-qq-bounds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const net = network({
    fetcher: async (target) =>
      String(target) === endpoint ? success() : new Response("MZtampered"),
  });
  await assert.rejects(
    () =>
      net.download(url, join(dir, "bad-hash"), {
        sha256: "0".repeat(64),
        maxBytes: 100,
      }),
    /SHA256 mismatch/,
  );
  await assert.rejects(
    () => net.download(url, join(dir, "too-large"), { maxBytes: 2 }),
    /limit/,
  );
  await assert.rejects(() => stat(join(dir, "never-created")), /ENOENT/);
  const old = url.replace("QQNTV2", "QQNT");
  assert.equal(
    await network({
      fetcher: async (target) => {
        assert.equal(String(target), old);
        return new Response("old");
      },
    }).text(old),
    "old",
  );
});
