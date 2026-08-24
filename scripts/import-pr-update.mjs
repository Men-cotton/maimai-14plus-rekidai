import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [baseSha, headRef, actor = ""] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/i.test(baseSha ?? "")) throw new Error("PRのbase SHAが不正です");
if (headRef !== "refs/remotes/origin/pr-validation") throw new Error("PRの参照名が不正です");

const root = resolve(import.meta.dirname, "..");
const output = execFileSync("git", ["diff", "--name-status", "--no-renames", `${baseSha}...${headRef}`], { cwd: root, encoding: "utf8" });
const changes = output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const [status, ...parts] = line.split("\t");
  return { status, path: parts.join("\t") };
});
const updateChanges = changes.filter(({ path }) => path.startsWith("data/updates/"));

if (!updateChanges.length) {
  const maintenanceActors = new Set(["men-cotton", "dependabot[bot]"]);
  if (!maintenanceActors.has(actor.toLowerCase())) throw new Error("一般のPRでは data/updates/ にCSVを1件だけ追加できます");
  console.log("Maintainer PR without a ranking CSV; trusted CSV check is not required.");
  process.exit(0);
}
if (changes.length !== 1 || updateChanges.length !== 1) throw new Error("CSV更新PRでは、data/updates/ のCSV 1件以外を変更できません");
const change = updateChanges[0];
if (change.status !== "A") throw new Error("CSV更新PRでは既存ファイルの変更・削除はできません");
if (!/^data\/updates\/maimai-14plus-dxscore-rank1-\d{8}-\d{4}\.csv$/.test(change.path)) throw new Error("CSVのファイル名が規定形式ではありません");

const csv = execFileSync("git", ["show", `${headRef}:${change.path}`], { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
if (Buffer.byteLength(csv, "utf8") > 1_000_000) throw new Error("CSVが1MBを超えています");
await writeFile(resolve(root, change.path), csv, "utf8");
console.log(`Imported untrusted data only: ${change.path}`);
