import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { discover } from "../scripts/lib/providers.mjs";

const rules = JSON.parse(
  await readFile(new URL("../automation/rules.json", import.meta.url), "utf8"),
);

test("innounp discovers the upstream version and downloads its official archive", async () => {
  const rule = rules.packages.innounp;
  const candidate = await discover(rule, {}, {
    text: async (url) => {
      assert.equal(
        url,
        "https://raw.githubusercontent.com/jrathlev/InnoUnpacker-Windows-GUI/master/innounp-2/docs/innounp.htm",
      );
      return "<h2>Version 2.71.3 - Unicode</h2>\n<b>2.71.2</b> (previous release)";
    },
  });

  assert.equal(candidate.version, "2.71.3");
  assert.equal(
    candidate.url,
    "https://raw.githubusercontent.com/jrathlev/InnoUnpacker-Windows-GUI/master/innounp-2/bin/innounp-2.zip",
  );
});

test("DingTalk uses the community build only as a version hint and keeps the domestic full ZIP URL", async () => {
  const rule = rules.packages.dingtalk;
  const candidate = await discover(rule, {}, {
    text: async (url) => {
      assert.equal(
        url,
        "https://www.mydown.com/soft/452/725797952.shtml",
      );
      return JSON.stringify({
        data: {
          category: "Office",
          version: "9.0.2.261013001",
        },
        international: "9.0.3-Release.261023001",
      });
    },
  });

  assert.equal(candidate.version, "9.0.2.261013001");
  assert.equal(
    candidate.url,
    "https://dtapp-pub.dingtalk.com/dingtalk-desktop/win_updater/Release/DingTalkUpdate_v9.0.2.261013001.zip",
  );
  assert.equal(candidate.url.includes("mydown.com"), false);
});
