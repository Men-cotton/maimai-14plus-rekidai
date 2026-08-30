import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { rowsToCsv } from "../scripts/lib/csv.mjs";
import { validateCandidateCsv } from "../scripts/lib/validation.mjs";

const validation = await readFile(new URL("../intake/google-form/Validation.gs", import.meta.url), "utf8");
const code = await readFile(new URL("../intake/google-form/Code.gs", import.meta.url), "utf8");
const canonical = "maimai-14plus-dxscore-rank1-20260830-2245.csv";
const uploaded = canonical.replace(".csv", " - 山田 太郎.csv");
const previous = {
  difficulty: "MASTER", song: "Test Song", chartType: "DX", score: 297, maxScore: 300,
  rate: 99, dxStar: 5, player: "PLAYER", achievedAt: "2026/08/20 12:00",
  updatedAt: "2026/08/30 22:00",
  sourceUrl: "https://maimaidx.jp/maimai-mobile/ranking/musicRankingDetail/?idx=test&scoreType=1&rankingType=99&diff=3",
};
const candidate = { ...previous, score: 300, rate: 100, achievedAt: "2026/08/30 21:00" };

test("Google Formsの表示名を取り除き、取得時刻・照合情報は元のCSVと同じ", () => {
  const { ctx } = fixture();
  const original = ctx.validateMaimaiUpload_(canonical, rowsToCsv([candidate]));
  for (const suffix of ["", " - 山田 太郎", " - A. Example-Smith (個人用)", " - 名前 - 別名"]) {
    const result = ctx.validateMaimaiUpload_(canonical.replace(".csv", `${suffix}.csv`), rowsToCsv([candidate]));
    assert.equal(result.ok, true);
    assert.equal(result.fileName, canonical);
    assert.equal(result.generatedAt, "2026-08-30 22:45");
    assert.equal(result.semanticCanonical, original.semanticCanonical);
  }
});

test("緩和は既知のsuffixだけ：日時・拡張子・パス・制御文字は拒否", () => {
  const { ctx } = fixture();
  for (const name of [
    "other-20260830-2245 - 名前.csv", uploaded.replace("20260830", "20260230"),
    uploaded.replace("2245", "2460"), `${uploaded}.exe`, `${uploaded}\n`,
    canonical.replace(".csv", " - .csv"), canonical.replace(".csv", " -   .csv"),
    canonical.replace(".csv", " - a/b.csv"), canonical.replace(".csv", " - a\\b.csv"),
    canonical.replace(".csv", " - a\nb.csv"), canonical.replace(".csv", " - a\tb.csv"),
    canonical.replace(".csv", " - a\u0000b.csv"), canonical.replace(".csv", ` - ${"a".repeat(201)}.csv`),
  ]) {
    const result = ctx.validateMaimaiUpload_(name, rowsToCsv([candidate]));
    assert.equal(result.ok, false, JSON.stringify(name));
    assert.equal(result.fileName, "");
    assert.ok(result.errors.some((error) => error.includes("ファイル名")));
  }
});

test("suffix付きでもSCORE・RATE・DATE・URL・式注入検証を維持", () => {
  const { ctx } = fixture();
  for (const patch of [
    { score: 301 }, { rate: 98 }, { achievedAt: "2026/02/30 12:00" },
    { sourceUrl: "https://example.com/" }, { player: "=HYPERLINK(1)" },
  ]) {
    assert.equal(ctx.validateMaimaiUpload_(uploaded, rowsToCsv([{ ...candidate, ...patch }])).ok, false);
  }
  assert.ok(validateCandidateCsv(rowsToCsv([candidate]), uploaded, [previous]).diagnostics.some((d) => d.code === "filename"));
});

test("受付結果・通知用情報には元のファイル名を残さない", () => {
  for (const fileName of [uploaded, "invalid - 山田 太郎.csv"]) {
    const { ctx, sheet } = fixture({ fileName });
    const result = ctx.validateResponseRow_(sheet, 2, false);
    assert.equal(result.fileName, fileName === uploaded ? canonical : "");
    assert.equal(JSON.stringify(result).includes("山田"), false);
  }
  const { ctx, sheet } = fixture();
  ctx.DriveApp.getFileById = () => { throw new Error(`Cannot read ${uploaded}`); };
  assert.equal(JSON.stringify(ctx.validateResponseRow_(sheet, 2, false)).includes("山田"), false);
});

test("旧ファイル名誤判定を一度だけ取り消し、通常の差分保留・加点へ進む", () => {
  const { ctx, sheet, email } = fixture();
  const report = ctx.repairMaimaiFilenameRejectionsUnlocked_(sheet);
  assert.equal(report.length, 1);
  assert.equal(report[0].ok, true);
  assert.equal(report[0].status, "差分照合待ち");
  assert.equal(report[0].pending, 1);
  assert.equal(report[0].confirmed, 0);
  assert.equal(ctx.submitterReputation_(email), 1);
  assert.equal(JSON.stringify(report).includes(email), false);
  assert.equal(ctx.repairMaimaiFilenameRejectionsUnlocked_(sheet).length, 0);
  assert.equal(ctx.submitterReputation_(email), 1);
});

test("再検証で内容が不正なら通常どおり失敗：内容検証を迂回しない", () => {
  const { ctx, sheet, email } = fixture({ record: { ...candidate, rate: 98 } });
  const report = ctx.repairMaimaiFilenameRejectionsUnlocked_(sheet);
  assert.equal(report[0].ok, false);
  assert.equal(report[0].status, "形式検証失敗");
  assert.equal(ctx.submitterReputation_(email), -1);
  assert.equal(ctx.repairMaimaiFilenameRejectionsUnlocked_(sheet).length, 0);
});

test("他の投稿・BAN・信頼点・PR・ファイル改変がある場合は自動補正しない", () => {
  for (const mutate of [
    ({ sheet }) => sheet.rows.push([...sheet.rows[1]]),
    ({ ctx, email }) => ctx.banSubmitter_(email, "test"),
    ({ ctx, email }) => ctx.updateSubmitterReputation_(email, 1, "other history"),
    ({ sheet }) => { sheet.rows[1][8] = "https://github.com/example/pull/1"; },
    ({ sheet }) => { sheet.rows[1][5] = "0".repeat(64); },
    ({ ctx }) => { ctx.DriveApp.getFileById = () => ({ getName: () => canonical, getBlob: () => ({ getBytes: () => [] }) }); },
    ({ sheet }) => { sheet.rows[1][6] = 1; },
  ]) {
    const f = fixture();
    mutate(f);
    const before = f.ctx.submitterReputation_(f.email);
    f.ctx.repairMaimaiFilenameRejectionsUnlocked_(f.sheet);
    assert.equal(f.ctx.submitterReputation_(f.email), before);
    assert.equal(f.sheet.rows[1][3], "形式検証失敗");
  }
});

test("中断した補正を再実行しても二重取消・二重加点しない", () => {
  const { ctx, sheet, email, properties } = fixture();
  ctx.processResponseRow_ = () => { throw new Error("interrupted"); };
  assert.throws(() => ctx.repairMaimaiFilenameRejectionsUnlocked_(sheet), /interrupted/);
  assert.equal(ctx.submitterReputation_(email), 0);
  assert.ok(properties.get("FILENAME_REJECTION_REPAIRS_V1").includes("started"));
  // Even if a maintainer restores the old reputation, the persisted journal blocks replay.
  ctx.updateSubmitterReputation_(email, -1, "形式検証失敗");
  ctx.repairMaimaiFilenameRejectionsUnlocked_(sheet);
  assert.equal(ctx.submitterReputation_(email), -1);
});

test("確認済み日時で欠落だけを補正し、原本ハッシュ・二者照合を維持して誤減点取消", () => {
  const { ctx, sheet, email } = fixture({ record: { ...candidate, achievedAt: "" } });
  sheet.rows[1][4] = "ERROR: 2行目: DATEの形式または実在日が不正です";
  const hash = sheet.rows[1][5];
  const result = ctx.repairMaimaiMissingDate_(sheet, 2, hash, candidate);
  assert.equal(result.ok, true);
  assert.equal(result.status, "差分照合待ち");
  assert.equal(result.pending, 1);
  assert.equal(result.confirmed, 0);
  assert.equal(ctx.submitterReputation_(email), 1);
  assert.equal(sheet.rows[1][5], hash);
  assert.match(sheet.rows[1][4], /原本CSVは保持/);
  assert.throws(() => ctx.repairMaimaiMissingDate_(sheet, 2, hash, candidate), /既に開始済み/);
  assert.equal(ctx.submitterReputation_(email), 1);
});

test("日時補正は原本・スコア・プレイヤー・実在日時が合わなければ拒否", () => {
  for (const patch of [{ score: 299 }, { player: "OTHER" }, { maxScore: 303 }, { dxStar: 4 }, { achievedAt: "2026/02/30 12:00" }]) {
    const { ctx, sheet, email } = fixture({ record: { ...candidate, achievedAt: "" } });
    assert.throws(() => ctx.repairMaimaiMissingDate_(sheet, 2, sheet.rows[1][5], { ...candidate, ...patch }));
    assert.equal(ctx.submitterReputation_(email), -1);
  }
  for (const record of [candidate, { ...candidate, achievedAt: "", rate: 98 }]) {
    const { ctx, sheet, email } = fixture({ record });
    assert.throws(() => ctx.repairMaimaiMissingDate_(sheet, 2, sheet.rows[1][5], candidate));
    assert.equal(ctx.submitterReputation_(email), -1);
  }
});

test("他の投稿・BAN・公開済み候補・ハッシュ不一致では日時補正しない", () => {
  for (const mutate of [
    ({ sheet }) => sheet.rows.push([...sheet.rows[1]]),
    ({ ctx, email }) => ctx.banSubmitter_(email, "test"),
    ({ sheet }) => { sheet.rows[1][5] = "0".repeat(64); },
    ({ sheet }) => { sheet.rows[1][6] = 1; },
    ({ sheet }) => { sheet.rows[1][8] = "https://github.com/example/pull/1"; },
  ]) {
    const f = fixture({ record: { ...candidate, achievedAt: "" } });
    mutate(f);
    assert.throws(() => f.ctx.repairMaimaiMissingDate_(f.sheet, 2, f.sheet.rows[1][5], candidate));
    assert.equal(f.ctx.submitterReputation_(f.email), -1);
  }
});

function fixture({ fileName = uploaded, record = candidate } = {}) {
  const properties = new Map();
  const ctx = {
    LockService: { getDocumentLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, String(value)),
    }) },
    Utilities: {
      formatDate: () => "2026/08/30 23:00:00", getUuid: () => "test-secret",
      Charset: { UTF_8: "UTF-8" }, DigestAlgorithm: { SHA_256: "sha256" },
      computeHmacSha256Signature: (value, key) => [...createHmac("sha256", key).update(value).digest()],
      computeDigest: (_algorithm, bytes) => [...createHash("sha256").update(Buffer.from(bytes)).digest()],
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(validation + "\n" + code, ctx);
  const bytes = [...Buffer.from(rowsToCsv([record]))];
  ctx.DriveApp = { getFileById: () => ({ getName: () => fileName, getBlob: () => ({ getBytes: () => bytes }) }) };
  const email = "example@example.com";
  const sheet = new FakeResponseSheet([
    ["タイムスタンプ", "メールアドレス", "CSVファイル", ...Object.values(ctx.INTAKE_COLUMNS_)],
    ["2026/08/30 22:46:00", email, "https://drive.google.com/open?id=abcdefghijklmnopqrstuvwxyz", "形式検証失敗",
      "ERROR: CSVのファイル名が規定形式ではありません", ctx.sha256Hex_(bytes), 0, 0, ""],
  ]);
  ctx.updateSubmitterReputation_(email, -1, "形式検証失敗");
  ctx.fetchCanonicalSnapshot_ = () => ({ rows: [previous] });
  ctx.ensureQueueSheet_ = () => ({});
  ctx.reconcileQueue_ = () => ({ warnings: [] });
  ctx.readQueueEntries_ = () => [];
  ctx.applySnapshotToQueue_ = (_sheet, _entries, comparison, submitter) => {
    assert.equal(submitter, email);
    return { pendingCount: comparison.differences.length, confirmedCount: 0, rejectedCount: 0 };
  };
  ctx.syncMaimaiIntakeQueueUnlocked_ = () => ({});
  return { ctx, sheet, email, properties };
}

class FakeResponseSheet {
  constructor(rows) { this.rows = rows; }
  getLastColumn() { return this.rows[0].length; }
  getLastRow() { return this.rows.length; }
  getSheetId() { return 123; }
  getRange(row, column, rows = 1, columns = 1) {
    return {
      getDisplayValue: () => String(this.rows[row - 1]?.[column - 1] ?? ""),
      getDisplayValues: () => Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => String(this.rows[row + y - 1]?.[column + x - 1] ?? ""))),
      getRichTextValue: () => null,
      setValue: (value) => { this.rows[row - 1][column - 1] = value; },
    };
  }
}
