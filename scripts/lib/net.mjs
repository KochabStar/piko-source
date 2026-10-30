import { createWriteStream, createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { httpsURL, requireThat, GiB } from "./catalog.mjs";
export async function fileDigest(file, algorithm = "sha256") {
  const h = createHash(algorithm);
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
export async function request(
  url,
  {
    fetcher = fetch,
    method = "GET",
    body,
    token = process.env.GITHUB_TOKEN,
    headers = {},
    maxRedirects = 8,
  } = {},
) {
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const u = httpsURL(url),
      h = { "User-Agent": "piko-source-updater/1", ...headers };
    // Never forward the repository token to assets/CDNs or redirect hosts.
    if (u.hostname === "api.github.com" && token) {
      h.Authorization = "Bearer " + token;
      h.Accept = "application/vnd.github+json";
      h["X-GitHub-Api-Version"] = "2022-11-28";
    }
    const response = await fetcher(u, {
      method,
      headers: h,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      requireThat(
        method === "GET" || method === "HEAD",
        "Refusing to redirect a write request",
      );
      requireThat(location, "Redirect has no location");
      url = new URL(location, u).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        "HTTP " + response.status + " from " + u.origin + u.pathname,
      );
    }
    return response;
  }
  throw new Error("Redirect limit exceeded");
}
export function network(options = {}) {
  const cache = new Map();
  return {
    async text(url) {
      if (!cache.has(url))
        cache.set(
          url,
          (async () => {
            const r = await request(url, options);
            const chunks = [];
            let n = 0;
            for await (const b of r.body) {
              n += b.length;
              if (n > 16 * 1024 * 1024) throw Error("Metadata exceeds limit");
              chunks.push(b);
            }
            return Buffer.concat(chunks).toString("utf8");
          })(),
        );
      return cache.get(url);
    },
    async json(url) {
      return JSON.parse(await this.text(url));
    },
    async redirect(url) {
      const r = await request(url, options);
      const resolved = r.url;
      await r.body?.cancel();
      return resolved;
    },
    async download(
      url,
      file,
      { sha256, sha512, md5, maxBytes = 2 * GiB } = {},
    ) {
      requireThat(
        Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 2 * GiB,
        "Invalid download limit",
      );
      const r = await request(url, options);
      requireThat(
        !r.headers.get("content-type")?.includes("text/html"),
        "Publisher returned HTML instead of an application",
      );
      const length = r.headers.get("content-length");
      if (length)
        requireThat(
          Number(length) <= maxBytes,
          "Download exceeds declared limit",
        );
      await mkdir(dirname(file), { recursive: true });
      let bytes = 0;
      const h = createHash("sha256"),
        h512 = sha512 ? createHash("sha512") : null,
        hm = md5 ? createHash("md5") : null;
      const bounded = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes)
            return callback(Error("Download exceeds limit"));
          h.update(chunk);
          h512?.update(chunk);
          hm?.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(r.body),
        bounded,
        createWriteStream(file, { flags: "wx" }),
      );
      requireThat(bytes > 0, "Empty distribution");
      const actual = h.digest("hex");
      if (sha256)
        requireThat(
          actual.toLowerCase() === sha256.toLowerCase(),
          "Publisher SHA256 mismatch",
        );
      if (sha512) {
        const hex = h512.digest();
        requireThat(
          sha512 === hex.toString("hex") || sha512 === hex.toString("base64"),
          "Publisher SHA512 mismatch",
        );
      }
      if (md5)
        requireThat(
          hm.digest("hex").toLowerCase() === md5.toLowerCase(),
          "Publisher MD5 mismatch",
        );
      return { file, sha256: actual, bytes, url };
    },
  };
}
