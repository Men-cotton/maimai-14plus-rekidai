import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { replayRepository } from "./lib/repository.mjs";
import { hasErrors } from "./lib/validation.mjs";

const root = resolve(import.meta.dirname, "..");
if (process.env.CI) throw new Error("baseline:roll は保守者がローカルで実行する手動処理です");
const result = await replayRepository(root);
if (hasErrors(result.diagnostics)) throw new Error("検証ERRORがあるため基準値を更新できません");

await writeFile(resolve(root, "data/seed.json"), `${JSON.stringify(result.payload, null, 2)}\n`, "utf8");
await mkdir(resolve(root, "data/archive"), { recursive: true });
for (const filename of result.updateFiles) {
  await rename(resolve(root, "data/updates", filename), resolve(root, "data/archive", filename));
}
console.log(`Rolled ${result.updateFiles.length} update file(s) into data/seed.json.`);
