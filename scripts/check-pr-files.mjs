import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const baseSha = process.argv[2];
const actor = process.argv[3] ?? "";
if (!/^[0-9a-f]{40}$/i.test(baseSha ?? "")) throw new Error("PRのbase SHAが不正です");

const root = resolve(import.meta.dirname, "..");
const output = execFileSync("git", ["diff", "--name-status", "--no-renames", `${baseSha}...HEAD`], { cwd: root, encoding: "utf8" });
const changes = output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const [status, ...parts] = line.split("\t");
  return { status, path: parts.join("\t") };
});
const updateChanges = changes.filter(({ path }) => path.startsWith("data/updates/"));

if (!updateChanges.length) {
  if (!["men-cotton", "dependabot[bot]"].includes(actor.toLowerCase())) {
    throw new Error("一般のPRでは data/updates/ にCSVを1件だけ追加できます");
  }
  console.log("Maintainer PR: repository tests and build will validate the changes.");
  process.exit(0);
}

if (changes.length !== 1 || updateChanges.length !== 1) {
  throw new Error("CSV更新PRでは、data/updates/ のCSV 1件以外を変更できません");
}
const change = updateChanges[0];
if (change.status !== "A") throw new Error("CSV更新PRでは既存ファイルの変更・削除はできません");
if (!/^data\/updates\/maimai-14plus-dxscore-rank1-\d{8}-\d{4}\.csv$/.test(change.path)) {
  throw new Error("CSVのファイル名が規定形式ではありません");
}
console.log(`Accepted update file scope: ${change.path}`);
