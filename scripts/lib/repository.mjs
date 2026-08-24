import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  countsFor,
  hasErrors,
  timestampFromFilename,
  validateCandidateCsv,
  validateMetadata,
  validateSeed,
} from "./validation.mjs";

export async function replayRepository(root) {
  const seed = await readJson(resolve(root, "data/seed.json"));
  const seedResult = validateSeed(seed);
  const diagnostics = [...seedResult.diagnostics];
  let rows = seedResult.rows;
  let generatedAt = seed.generatedAt;
  let sourceFile = seed.sourceFile;

  const updateDir = resolve(root, "data/updates");
  const updateFiles = (await readdir(updateDir))
    .filter((name) => name.toLowerCase().endsWith(".csv"))
    .sort();

  let previousTimestamp = timestampFromFilename(sourceFile)?.value ?? Number.NEGATIVE_INFINITY;
  for (const filename of updateFiles) {
    const timestamp = timestampFromFilename(filename);
    if (!timestamp) {
      diagnostics.push({ level: "error", code: "filename", message: `${filename}: ファイル名が規定形式ではありません` });
      break;
    }
    if (timestamp.value <= previousTimestamp) {
      diagnostics.push({ level: "error", code: "update-order", message: `${filename}: 前回以前の日時のCSVです` });
      break;
    }

    const text = await readFile(resolve(updateDir, filename), "utf8");
    const result = validateCandidateCsv(text, filename, rows);
    diagnostics.push(...result.diagnostics);
    if (hasErrors(result.diagnostics)) break;
    rows = result.effectiveRows;
    generatedAt = timestamp.text;
    sourceFile = filename;
    previousTimestamp = timestamp.value;
  }

  const metadata = {
    chartVersions: await readJson(resolve(root, "metadata/chart-versions.json")),
    chartConstants: await readJson(resolve(root, "metadata/chart-constants.json")),
    remasterAudit: await readJson(resolve(root, "metadata/remaster-audit.json")),
    versionPeriods: await readJson(resolve(root, "metadata/version-periods.json")),
  };
  diagnostics.push(...validateMetadata(rows, metadata));

  return {
    payload: { generatedAt, sourceFile, counts: countsFor(rows), rows },
    metadata,
    diagnostics,
    updateFiles,
  };
}

export function formatDiagnostics(diagnostics) {
  const errors = diagnostics.filter((item) => item.level === "error");
  const warnings = diagnostics.filter((item) => item.level === "warning");
  const lines = [
    "# 検証結果",
    "",
    `- ERROR: ${errors.length}`,
    `- WARN: ${warnings.length}`,
    "",
  ];
  for (const item of diagnostics) {
    lines.push(`- **${item.level.toUpperCase()} [${escapeMarkdown(item.code)}]** ${escapeMarkdown(item.message)}`);
  }
  if (!diagnostics.length) lines.push("異常はありません。");
  return `${lines.join("\n")}\n`;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}[\]()<>#+.!|\r\n]/g, (character) => `\\${character}`);
}
