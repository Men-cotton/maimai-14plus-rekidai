import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { rowsToCsv } from "../scripts/lib/csv.mjs";
import { escapeHtml } from "../scripts/lib/html.mjs";
import { chartKey, hasErrors, validateCandidateCsv, validateMetadata, validateSeed } from "../scripts/lib/validation.mjs";

const base = Object.freeze({
  difficulty: "MASTER",
  song: "Test Song",
  chartType: "DX",
  score: 297,
  maxScore: 300,
  rate: 99,
  dxStar: 5,
  player: "PLAYER",
  achievedAt: "2026/08/20 12:00",
  updatedAt: "2026/08/24 21:00",
  sourceUrl: "https://maimaidx.jp/maimai-mobile/ranking/musicRankingDetail/?idx=test&scoreType=1&rankingType=99&diff=3",
});
const filename = "maimai-14plus-dxscore-rank1-20260824-2115.csv";
const candidate = (rows) => validateCandidateCsv(rowsToCsv(rows), filename, [base]);
const codes = (result) => result.diagnostics.map(({ code }) => code);

test("同じSCORE・同じDATEは正常", () => {
  const result = candidate([{ ...base, updatedAt: "2026/08/24 21:14" }]);
  assert.equal(hasErrors(result.diagnostics), false);
  assert.equal(result.effectiveRows[0].updatedAt, "2026/08/24 21:14");
});

test("SCORE同一・DATE増加は失敗", () => {
  const result = candidate([{ ...base, achievedAt: "2026/08/21 12:00" }]);
  assert.equal(hasErrors(result.diagnostics), true);
  assert.ok(codes(result).includes("date-changed-with-same-score"));
});

test("SCORE増加・DATE増加は正常", () => {
  const result = candidate([{ ...base, score: 300, rate: 100, achievedAt: "2026/08/21 12:00" }]);
  assert.equal(hasErrors(result.diagnostics), false);
  assert.equal(result.effectiveRows[0].score, 300);
});

test("SCORE減少は失敗", () => {
  const result = candidate([{ ...base, score: 294, rate: 98 }]);
  assert.ok(codes(result).includes("score-decrease"));
});

test("SCORE増加・DATE据え置きは失敗", () => {
  const result = candidate([{ ...base, score: 300, rate: 100 }]);
  assert.ok(codes(result).includes("new-score-without-newer-date"));
});

test("新規譜面はWARNとして無視", () => {
  const added = { ...base, song: "Added Song", sourceUrl: base.sourceUrl.replace("idx=test", "idx=added") };
  const result = candidate([base, added]);
  assert.equal(hasErrors(result.diagnostics), false);
  assert.ok(codes(result).includes("chart-added"));
  assert.deepEqual(result.effectiveRows.map(chartKey), [chartKey(base)]);
});

test("削除譜面はWARNとして旧値を維持", () => {
  const second = { ...base, song: "Second Song", sourceUrl: base.sourceUrl.replace("idx=test", "idx=second") };
  const result = validateCandidateCsv(rowsToCsv([base]), filename, [base, second]);
  assert.equal(hasErrors(result.diagnostics), false);
  assert.ok(codes(result).includes("chart-removed"));
  assert.deepEqual(result.effectiveRows.map(chartKey), [chartKey(base), chartKey(second)]);
});

test("理論値変更はWARNとして旧値を維持", () => {
  const result = candidate([{ ...base, maxScore: 303, score: 300, rate: 99.0099 }]);
  assert.equal(hasErrors(result.diagnostics), false);
  assert.ok(codes(result).includes("max-score-change"));
  assert.equal(result.effectiveRows[0].maxScore, 300);
});

test("RATE再計算不一致は失敗", () => {
  const result = candidate([{ ...base, rate: 98.5 }]);
  assert.ok(codes(result).includes("rate-mismatch"));
});

test("SCOREが理論値を超えると失敗", () => {
  const result = candidate([{ ...base, score: 303, rate: 101 }]);
  assert.ok(codes(result).includes("score-over-max"));
});

test("Re:MASTERのdiff不一致は失敗", () => {
  const remaster = { ...base, difficulty: "Re:MASTER", sourceUrl: base.sourceUrl };
  const current = { ...remaster };
  const result = validateCandidateCsv(rowsToCsv([remaster]), filename, [current]);
  assert.ok(codes(result).includes("ranking-query"));
});

test("許可外URLは失敗", () => {
  const result = candidate([{ ...base, sourceUrl: "https://example.com/" }]);
  assert.ok(codes(result).includes("ranking-url"));
});

test("取得失敗行は失敗", () => {
  const csv = rowsToCsv([base]).replace(',""\r\n', ',"timeout"\r\n');
  const result = validateCandidateCsv(csv, filename, [base]);
  assert.ok(codes(result).includes("download-failure"));
});

test("譜面キー重複は失敗", () => {
  const result = validateCandidateCsv(rowsToCsv([base, base]), filename, [base]);
  assert.ok(codes(result).includes("duplicate-key"));
});

test("表計算式として危険なプレイヤー名は失敗", () => {
  const result = candidate([{ ...base, player: "=HYPERLINK(\"https://example.com\")" }]);
  assert.ok(codes(result).includes("formula-injection"));
});

test("HTML特殊文字は出力時にエスケープ", () => {
  assert.equal(escapeHtml('<script data-x="1">&'), "&lt;script data-x=&quot;1&quot;&gt;&amp;");
});

test("seedの件数不一致を検出", () => {
  const seed = {
    generatedAt: "2026-08-24 21:15",
    sourceFile: filename,
    counts: { total: 2, master: 1, remaster: 0 },
    rows: [base],
  };
  assert.ok(validateSeed(seed).diagnostics.some(({ code }) => code === "seed-count"));
});

test("メタデータ欠落はWARN", () => {
  const diagnostics = validateMetadata([base], {
    chartVersions: {},
    chartConstants: {},
    remasterAudit: {},
    versionPeriods: { periods: [{ version: "CiRCLE PLUS", start: "2026/03/19", end: null }] },
  });
  assert.ok(diagnostics.some(({ code, level }) => code === "missing-version" && level === "warning"));
  assert.ok(diagnostics.some(({ code, level }) => code === "missing-constant" && level === "warning"));
});

test("実データ86件を再検証できる", async () => {
  const root = resolve(import.meta.dirname, "..");
  const seed = JSON.parse(await readFile(resolve(root, "data/seed.json"), "utf8"));
  const raw = await readFile(resolve(root, "data/archive/maimai-14plus-dxscore-rank1-20260824-2115.csv"), "utf8");
  const fixed = raw.replace(',"","2026/08/24 21:14","https://maimaidx.jp/maimai-mobile/ranking/musicRankingDetail/?idx=b686', ',"2026/08/24 03:18","2026/08/24 21:14","https://maimaidx.jp/maimai-mobile/ranking/musicRankingDetail/?idx=b686');
  assert.notEqual(fixed, raw, "End Timeの既知の欠番をテスト用に補正できること");
  const result = validateCandidateCsv(fixed, "maimai-14plus-dxscore-rank1-20260824-2116.csv", seed.rows);
  assert.deepEqual(result.diagnostics.filter(({ level }) => level === "error"), []);
  assert.equal(result.effectiveRows.length, 86);
});
