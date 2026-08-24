import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { replayRepository, formatDiagnostics } from "./lib/repository.mjs";
import { hasErrors } from "./lib/validation.mjs";

const root = resolve(import.meta.dirname, "..");
const result = await replayRepository(root);
const report = formatDiagnostics(result.diagnostics);
await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/validation-report.md"), report, "utf8");

for (const item of result.diagnostics) {
  const prefix = item.level === "error" ? "ERROR" : "WARN";
  console.log(`${prefix} [${item.code}] ${item.message}`);
}
console.log(`Validated ${result.payload.rows.length} charts across ${result.updateFiles.length} update file(s).`);
if (hasErrors(result.diagnostics)) process.exitCode = 1;
