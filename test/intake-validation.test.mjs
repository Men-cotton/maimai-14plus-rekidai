import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { rowsToCsv } from "../scripts/lib/csv.mjs";
import { hasErrors, validateCandidateCsv } from "../scripts/lib/validation.mjs";

const root = resolve(import.meta.dirname, "..");
const validatorSource = await readFile(resolve(root, "intake/google-form/Validation.gs"), "utf8");
const codeSource = await readFile(resolve(root, "intake/google-form/Code.gs"), "utf8");
const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (name) => name === "CONSENSUS_QUORUM" ? "2" : null }),
  },
  Utilities: {
    formatDate: () => "2026/08/25 00:00:00",
  },
};
vm.createContext(sandbox);
vm.runInContext(validatorSource, sandbox, { filename: "Validation.gs" });
vm.runInContext(codeSource, sandbox, { filename: "Code.gs" });

const base = {
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
};

test("Googleフォーム受付コードを構文解析できる", () => {
  assert.doesNotThrow(() => new Function(codeSource));
  assert.doesNotThrow(() => JSON.parse(requireManifest()));
});

test("受付側でも正常なCSVを検証できる", () => {
  const result = sandbox.validateMaimaiUpload_("maimai-14plus-dxscore-rank1-20260824-2115.csv", rowsToCsv([base]));
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 1);
  assert.equal(result.normalizedRows.length, 1);
  assert.ok(result.semanticCanonical);
  assert.ok(result.warnings.some((message) => message.includes("86件")));
});

test("取得時刻とファイル名が違ってもランキング情報の指紋材料は同一", () => {
  const first = sandbox.validateMaimaiUpload_("maimai-14plus-dxscore-rank1-20260824-2115.csv", rowsToCsv([base]));
  const second = sandbox.validateMaimaiUpload_("maimai-14plus-dxscore-rank1-20260824-2215.csv", rowsToCsv([{ ...base, updatedAt: "2026/08/24 22:14" }]));
  assert.equal(first.semanticCanonical, second.semanticCanonical);
});

test("SCOREが違えばランキング情報の指紋材料も異なる", () => {
  const first = sandbox.validateMaimaiUpload_("maimai-14plus-dxscore-rank1-20260824-2115.csv", rowsToCsv([base]));
  const second = sandbox.validateMaimaiUpload_("maimai-14plus-dxscore-rank1-20260824-2215.csv", rowsToCsv([{ ...base, score: 300, rate: 100, achievedAt: "2026/08/24 22:00", updatedAt: "2026/08/24 22:14" }]));
  assert.notEqual(first.semanticCanonical, second.semanticCanonical);
});

test("取得時刻と詳細URLは譜面差分の一致判定から除外", () => {
  const changed = { ...base, updatedAt: "2026/08/24 22:14", sourceUrl: `${base.sourceUrl}&unused=ignored-in-this-unit` };
  assert.equal(sandbox.chartStateCanonical_(base), sandbox.chartStateCanonical_(changed));
});

test("譜面単位で A、A+B、B+C を順次確定できる", () => {
  const baseline = [
    { ...base, song: "A", score: 270, rate: 90 },
    { ...base, song: "B", score: 260, rate: 86.6667 },
    { ...base, song: "C", score: 250, rate: 83.3333 },
  ];
  const improvedA = { ...baseline[0], score: 273, rate: 91, achievedAt: "2026/08/21 12:00", updatedAt: "2026/08/24 22:00" };
  const improvedB = { ...baseline[1], score: 266, rate: 88.6667, achievedAt: "2026/08/22 12:00", updatedAt: "2026/08/24 22:10" };
  const improvedC = { ...baseline[2], score: 259, rate: 86.3333, achievedAt: "2026/08/23 12:00", updatedAt: "2026/08/24 22:20" };
  const sheet = new FakeQueueSheet(sandbox.QUEUE_COLUMNS_);

  const first = sandbox.compareMaimaiSnapshot_(baseline, [improvedA, baseline[1], baseline[2]]);
  sandbox.applySnapshotToQueue_(sheet, [], first, "one@example.com", 2);
  let entries = sandbox.readQueueEntries_(sheet);
  assert.deepEqual(queueStates(entries), { A: "pending" });

  const second = sandbox.compareMaimaiSnapshot_(baseline, [improvedA, improvedB, baseline[2]]);
  sandbox.applySnapshotToQueue_(sheet, entries, second, "two@example.com", 3);
  entries = sandbox.readQueueEntries_(sheet);
  assert.deepEqual(queueStates(entries), { A: "confirmed", B: "pending" });

  const effective = sandbox.effectiveRowsForQueue_(baseline, entries);
  const third = sandbox.compareMaimaiSnapshot_(effective, [improvedA, improvedB, improvedC]);
  sandbox.applySnapshotToQueue_(sheet, entries, third, "three@example.com", 4);
  entries = sandbox.readQueueEntries_(sheet);
  assert.deepEqual(queueStates(entries), { A: "confirmed", B: "confirmed", C: "pending" });
});

test("同じGoogleアカウントの再提出だけでは確定しない", () => {
  const baseline = [{ ...base, score: 270, rate: 90 }];
  const candidate = [{ ...base, score: 273, rate: 91, achievedAt: "2026/08/21 12:00" }];
  const comparison = sandbox.compareMaimaiSnapshot_(baseline, candidate);
  const sheet = new FakeQueueSheet(sandbox.QUEUE_COLUMNS_);
  sandbox.applySnapshotToQueue_(sheet, [], comparison, "same@example.com", 2);
  const entries = sandbox.readQueueEntries_(sheet);
  sandbox.applySnapshotToQueue_(sheet, entries, comparison, "same@example.com", 3);
  const current = sandbox.readQueueEntries_(sheet).find((entry) => entry.state === "pending");
  assert.ok(current);
  assert.equal(current.voters.length, 1);
});

test("確定差分から合成するCSVはGitHub側の検証にも合格する", () => {
  const candidate = { ...base, score: 300, rate: 100, achievedAt: "2026/08/24 22:00", updatedAt: "2026/08/24 22:10" };
  const csv = sandbox.rowsToMaimaiCsv_([candidate]);
  const result = validateCandidateCsv(csv, "maimai-14plus-dxscore-rank1-20260825-0000.csv", [base]);
  assert.equal(hasErrors(result.diagnostics), false, JSON.stringify(result.diagnostics));
  assert.equal(result.effectiveRows[0].score, 300);
});

test("受付側でもRATE不一致を拒否", () => {
  const result = sandbox.validateMaimaiUpload_("maimai-14plus-dxscore-rank1-20260824-2115.csv", rowsToCsv([{ ...base, rate: 98 }]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("RATE")));
});

test("受付側でも式注入を拒否", () => {
  const result = sandbox.validateMaimaiUpload_("maimai-14plus-dxscore-rank1-20260824-2115.csv", rowsToCsv([{ ...base, player: "=HYPERLINK(1)" }]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("危険な文字")));
});

function requireManifest() {
  return `{
    "timeZone": "Asia/Tokyo",
    "runtimeVersion": "V8"
  }`;
}

function queueStates(entries) {
  return Object.fromEntries(entries
    .filter((entry) => ["pending", "confirmed"].includes(entry.state))
    .map((entry) => [entry.candidate.song, entry.state]));
}

class FakeQueueSheet {
  constructor(headers) {
    this.rows = [[...headers]];
  }

  getLastRow() {
    return this.rows.length;
  }

  getRange(row, column, rowCount, columnCount) {
    return {
      getDisplayValues: () => Array.from({ length: rowCount }, (_, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnOffset) =>
          String(this.rows[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ""))),
      setValues: (values) => {
        values.forEach((valuesRow, rowOffset) => {
          const target = row - 1 + rowOffset;
          if (!this.rows[target]) this.rows[target] = [];
          valuesRow.forEach((value, columnOffset) => {
            this.rows[target][column - 1 + columnOffset] = value;
          });
        });
        return this;
      },
    };
  }
}
