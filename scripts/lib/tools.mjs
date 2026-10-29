import { spawn } from "node:child_process";
import {
  readFile,
  mkdir,
  lstat,
  rename,
  rm,
  mkdtemp,
  readdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileDigest } from "./net.mjs";
import { requireThat, MiB } from "./catalog.mjs";
export async function capture(
  program,
  args,
  { file, limit = 32 * MiB, timeout = 120000, env = process.env } = {},
) {
  const child = spawn(program, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
  let timer;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  timer = setTimeout(() => child.kill(), timeout);
  timer.unref();
  let diagnostics = 0;
  const errors = (async () => {
    for await (const b of child.stderr) {
      diagnostics += b.length;
      if (diagnostics > 65536)
        throw Error("Unpacker diagnostics exceeded limit");
    }
  })();
  let size = 0;
  const chunks = [];
  const output = file
    ? pipeline(
        child.stdout,
        new Transform({
          transform(b, _e, cb) {
            size += b.length;
            if (size > limit) return cb(Error("Unpacker output exceeds limit"));
            cb(null, b);
          },
        }),
        createWriteStream(file, { flags: "wx" }),
      )
    : (async () => {
        for await (const b of child.stdout) {
          size += b.length;
          if (size > limit) throw Error("Unpacker output exceeds limit");
          chunks.push(b);
        }
      })();
  try {
    const [, , result] = await Promise.all([output, errors, exited]);
    requireThat(
      result.code === 0 && !result.signal && !diagnostics,
      "Unpacker failed; input is unsupported, corrupt or timed out",
    );
    return file ? { size, file } : Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    child.kill();
    await Promise.allSettled([output, errors, exited]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export class Tools {
  constructor(root, net) {
    this.root = root;
    this.net = net;
    this.pending = new Map();
  }
  async get(name) {
    if (!this.pending.has(name)) this.pending.set(name, this.prepare(name));
    return this.pending.get(name);
  }
  async prepare(name) {
    requireThat(
      process.platform === "win32",
      "Payload validation requires Windows x64; discovery/check-source is portable",
    );
    const config = JSON.parse(
        await readFile(join(this.root, "automation/tools.json"), "utf8"),
      ),
      spec = config[name];
    requireThat(spec, "Unknown trusted helper");
    const names = {
      sevenzip: "7z.exe",
      inno: "innounp.exe",
      lessmsi: "lessmsi.exe",
    };
    const override =
      process.env[
        "PIKO_SOURCE_" +
          { sevenzip: "7ZIP", inno: "INNOUNP", lessmsi: "LESSMSI" }[name]
      ];
    const verify = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true }))
        requireThat(
          entry.isFile() &&
            !entry.isSymbolicLink() &&
            (Object.hasOwn(spec.files, entry.name) ||
              [
                "receipt.json",
                "innounp.htm",
                "innounp.html",
                "readme.txt",
                "license.txt",
              ].includes(entry.name.toLowerCase())),
          "Unexpected helper content",
        );
      for (const [file, sha] of Object.entries(spec.files)) {
        const path = join(dir, file),
          info = await lstat(path);
        requireThat(
          info.isFile() &&
            !info.isSymbolicLink() &&
            (await fileDigest(path)) === sha,
          "Trusted helper checksum/type differs: " + name,
        );
      }
      return join(dir, names[name]);
    };
    if (override) return verify(dirname(override));
    const parent = join(this.root, ".cache/tools"),
      dir = join(parent, name + "-" + spec.version);
    await mkdir(parent, { recursive: true });
    try {
      await lstat(dir);
      return await verify(dir);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const stage = await mkdtemp(join(parent, name + "-stage-"));
    try {
      const archive = join(stage, "archive");
      await this.net.download(spec.url, archive, {
        sha256: spec.sha256,
        maxBytes: 64 * MiB,
      });
      let reader;
      if (name === "sevenzip") {
        reader = join(stage, "7zr.exe");
        await this.net.download(config.bootstrap.url, reader, {
          sha256: config.bootstrap.sha256,
          maxBytes: 4 * MiB,
        });
        requireThat(
          (await fileDigest(reader)) === config.bootstrap.sha256,
          "Bootstrap digest differs",
        );
      } else reader = await this.get("sevenzip");
      const out = join(stage, "out");
      await mkdir(out);
      for (const [file, sha] of Object.entries(spec.files)) {
        // Only verified unpackers run; downloaded application code never runs.
        const target = join(out, file);
        await capture(
          reader,
          [
            "x",
            name === "sevenzip" ? "-t7z" : "-tzip",
            "-so",
            "-spd",
            "-y",
            "-bd",
            "-bb0",
            "--",
            archive,
            file,
          ],
          { file: target, limit: 32 * MiB },
        );
        requireThat(
          (await fileDigest(target)) === sha,
          "Unpacked helper digest differs",
        );
      }
      await rename(out, dir);
      return await verify(dir);
    } finally {
      await rm(stage, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }
}
