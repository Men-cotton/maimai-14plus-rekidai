import { parseCsv } from "./csv.mjs";

export const UPDATE_FILE_PATTERN = /^maimai-14plus-dxscore-rank1-(\d{8})-(\d{4})\.csv$/;
const DATE_TIME_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const FORMULA_PREFIX = /^[\s\uFEFF]*[=+@\-＝＋＠－]/u;
const ALLOWED_DIFFICULTIES = new Set(["MASTER", "Re:MASTER"]);
const ALLOWED_CHART_TYPES = new Set(["DX", "STANDARD"]);

export const chartKey = (row) => `${row.difficulty}|${row.chartType}|${row.song}`;
export const roundRate = (score, maxScore) => Math.round((score / maxScore) * 1_000_000) / 10_000;

export function timestampFromFilename(filename) {
  const match = filename.match(UPDATE_FILE_PATTERN);
  if (!match) return null;
  const [, day, time] = match;
  const text = `${day.slice(0, 4)}/${day.slice(4, 6)}/${day.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}`;
  const value = parseDateTime(text);
  return value === null ? null : { value, text: text.replaceAll("/", "-") };
}

export function parseDateTime(value) {
  const match = String(value).match(DATE_TIME_PATTERN);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
  ) return null;
  return timestamp;
}

export function validateSeed(seed, source = "data/seed.json") {
  const diagnostics = [];
  if (!seed || typeof seed !== "object" || !Array.isArray(seed.rows)) {
    return { diagnostics: [error("seed-format", `${source}: rows配列がありません`)], rows: [] };
  }

  const rows = [];
  const seen = new Set();
  for (const [index, raw] of seed.rows.entries()) {
    const label = `${source}:${index + 1}`;
    const row = validateNormalizedRow(raw, label, diagnostics);
    if (!row) continue;
    const key = chartKey(row);
    if (seen.has(key)) diagnostics.push(error("duplicate-key", `${label}: 譜面キーが重複しています: ${safe(key)}`));
    seen.add(key);
    rows.push(row);
  }

  if (seed.counts) {
    const expected = countsFor(rows);
    for (const field of ["total", "master", "remaster"]) {
      if (seed.counts[field] !== expected[field]) {
        diagnostics.push(error("seed-count", `${source}: counts.${field} が実データと一致しません`));
      }
    }
  }
  if (!parseGeneratedAt(seed.generatedAt)) diagnostics.push(error("seed-date", `${source}: generatedAtの形式が不正です`));
  if (!UPDATE_FILE_PATTERN.test(seed.sourceFile ?? "")) diagnostics.push(error("seed-source", `${source}: sourceFileの形式が不正です`));

  return { diagnostics, rows };
}

export function validateCandidateCsv(text, filename, currentRows) {
  const diagnostics = [];
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (cause) {
    return { diagnostics: [error("csv-format", `${filename}: ${cause.message}`)], effectiveRows: currentRows };
  }

  for (const header of parsed.extraHeaders) {
    diagnostics.push(warning("extra-column", `${filename}: 未使用の列があります: ${safe(header)}`));
  }
  if (!parsed.records.length) diagnostics.push(error("empty-update", `${filename}: データ行がありません`));

  const candidateRows = [];
  const seen = new Set();
  for (const [index, record] of parsed.records.entries()) {
    const label = `${filename}:${index + 2}`;
    const row = validateCsvRecord(record, label, diagnostics);
    if (!row) continue;
    const key = chartKey(row);
    if (seen.has(key)) diagnostics.push(error("duplicate-key", `${label}: 譜面キーが重複しています: ${safe(key)}`));
    seen.add(key);
    candidateRows.push(row);
  }

  const filenameTimestamp = timestampFromFilename(filename);
  if (!filenameTimestamp) diagnostics.push(error("filename", `${filename}: ファイル名の日時が不正です`));
  if (filenameTimestamp) {
    for (const row of candidateRows) {
      const updatedAt = parseDateTime(row.updatedAt);
      if (updatedAt !== null && updatedAt > filenameTimestamp.value + 10 * 60_000) {
        diagnostics.push(error("future-update", `${filename}: ${safe(chartKey(row))} のランキング更新日時がファイル作成日時より未来です`));
      }
    }
  }

  if (hasErrors(diagnostics)) return { diagnostics, effectiveRows: currentRows };

  const currentMap = new Map(currentRows.map((row) => [chartKey(row), row]));
  const candidateMap = new Map(candidateRows.map((row) => [chartKey(row), row]));
  const effectiveRows = [];
  const difference = Math.abs(candidateRows.length - currentRows.length);
  const abruptThreshold = Math.max(5, Math.ceil(currentRows.length * 0.05));
  if (difference >= abruptThreshold) {
    diagnostics.push(warning("row-count", `${filename}: 行数が前回の${currentRows.length}件から${candidateRows.length}件へ大きく変化しています`));
  }

  for (const previous of currentRows) {
    const key = chartKey(previous);
    const candidate = candidateMap.get(key);
    if (!candidate) {
      diagnostics.push(warning("chart-removed", `${filename}: 譜面がCSVから消えています。旧値を維持します: ${safe(key)}`));
      effectiveRows.push(previous);
      continue;
    }

    if (candidate.maxScore !== previous.maxScore) {
      diagnostics.push(warning("max-score-change", `${filename}: 理論値が ${previous.maxScore} → ${candidate.maxScore} に変化しています。譜面変更として旧値を維持します: ${safe(key)}`));
      effectiveRows.push(previous);
      continue;
    }

    if (candidate.score < previous.score) {
      diagnostics.push(error("score-decrease", `${filename}: SCOREが ${previous.score} → ${candidate.score} に減少しています: ${safe(key)}`));
      effectiveRows.push(previous);
      continue;
    }

    const previousDate = parseDateTime(previous.achievedAt);
    const candidateDate = parseDateTime(candidate.achievedAt);
    if (candidate.score === previous.score && candidateDate !== previousDate) {
      diagnostics.push(error("date-changed-with-same-score", `${filename}: SCOREが同一なのにDATEが ${previous.achievedAt} → ${candidate.achievedAt} に変化しています: ${safe(key)}`));
      effectiveRows.push(previous);
      continue;
    }
    if (candidate.score > previous.score && candidateDate <= previousDate) {
      diagnostics.push(error("new-score-without-newer-date", `${filename}: SCOREが増加したのにDATEが前回より後ではありません: ${safe(key)}`));
      effectiveRows.push(previous);
      continue;
    }

    if (candidate.player !== previous.player) {
      diagnostics.push(warning("player-change", `${filename}: プレイヤー名が変化しています: ${safe(key)}`));
    }
    effectiveRows.push(candidate);
  }

  for (const candidate of candidateRows) {
    const key = chartKey(candidate);
    if (!currentMap.has(key)) {
      diagnostics.push(warning("chart-added", `${filename}: 新規譜面です。手動反映まで表示には追加しません: ${safe(key)}`));
    }
  }

  if (hasErrors(diagnostics)) return { diagnostics, effectiveRows: currentRows };
  return { diagnostics, effectiveRows };
}

export function validateMetadata(rows, metadata) {
  const diagnostics = [];
  const keys = new Set(rows.map(chartKey));
  const versions = metadata.chartVersions ?? {};
  const constants = metadata.chartConstants ?? {};
  const remasterAudit = metadata.remasterAudit ?? {};
  const versionPeriods = metadata.versionPeriods ?? {};

  for (const key of keys) {
    if (typeof versions[key] !== "string" || !versions[key]) {
      diagnostics.push(warning("missing-version", `初出バージョンが未登録です: ${safe(key)}`));
    }
    const constant = constants[key];
    if (!Number.isFinite(constant) || constant < 14.6 || constant > 14.9) {
      diagnostics.push(warning("missing-constant", `定数が未登録または14+の範囲外です: ${safe(key)}`));
    }
    if (key.startsWith("Re:MASTER|") && !remasterAudit[key]) {
      diagnostics.push(warning("missing-remaster-audit", `Re:MAS追加日の根拠が未登録です: ${safe(key)}`));
    }
  }

  for (const key of Object.keys(versions)) if (!keys.has(key)) diagnostics.push(warning("orphan-version", `表示対象にない初出バージョン定義です: ${safe(key)}`));
  for (const key of Object.keys(constants)) if (!keys.has(key)) diagnostics.push(warning("orphan-constant", `表示対象にない定数定義です: ${safe(key)}`));
  for (const [key, audit] of Object.entries(remasterAudit)) {
    if (!key.startsWith("Re:MASTER|")) diagnostics.push(error("remaster-key", `Re:MAS監査キーが不正です: ${safe(key)}`));
    if (!keys.has(key)) diagnostics.push(warning("orphan-remaster", `表示対象にないRe:MAS監査定義です: ${safe(key)}`));
    if (parseDateOnly(audit?.addedAt) === null) diagnostics.push(error("remaster-date", `Re:MAS追加日が不正です: ${safe(key)}`));
    if (!isAllowedReferenceUrl(audit?.sourceUrl)) diagnostics.push(error("remaster-source", `Re:MAS根拠URLが不正です: ${safe(key)}`));
  }

  const periods = versionPeriods.periods;
  if (!Array.isArray(periods) || !periods.length) {
    diagnostics.push(error("version-periods", "バージョン期間の一覧がありません"));
  } else {
    const chronological = [...periods].reverse();
    let previousEnd = null;
    for (const period of chronological) {
      const start = parseDateOnly(period.start);
      const end = period.end === null ? Number.POSITIVE_INFINITY : parseDateOnly(period.end);
      if (!period.version || start === null || end === null || end < start) {
        diagnostics.push(error("version-period", `バージョン期間が不正です: ${safe(period.version ?? "(名称なし)")}`));
        continue;
      }
      if (previousEnd !== null && start > previousEnd + 86_400_000) {
        diagnostics.push(error("version-gap", `バージョン期間に空白があります: ${safe(period.version)}`));
      }
      if (previousEnd !== null && start < previousEnd) {
        diagnostics.push(error("version-overlap", `バージョン期間が重複しています: ${safe(period.version)}`));
      } else if (previousEnd !== null && start === previousEnd) {
        diagnostics.push(warning("version-boundary", `バージョン境界日が前バージョンの終了日と同日です: ${safe(period.version)}`));
      }
      previousEnd = end;
    }
  }
  return diagnostics;
}

export function countsFor(rows) {
  return {
    total: rows.length,
    master: rows.filter((row) => row.difficulty === "MASTER").length,
    remaster: rows.filter((row) => row.difficulty === "Re:MASTER").length,
  };
}

export const hasErrors = (diagnostics) => diagnostics.some((item) => item.level === "error");
export const error = (code, message) => ({ level: "error", code, message });
export const warning = (code, message) => ({ level: "warning", code, message });

function validateCsvRecord(record, label, diagnostics) {
  if (String(record["取得状況"] ?? "").trim()) {
    diagnostics.push(error("download-failure", `${label}: 取得失敗が記録されています: ${safe(record["取得状況"])}`));
  }

  const score = parseInteger(record["1位でらっくスコア"]);
  const maxScore = parseInteger(record["理論値"]);
  const dxStar = parseInteger(record["DXスター"]);
  const rateText = String(record["理論値比率"] ?? "");
  const rate = /^\d{1,3}(?:\.\d{1,4})?%$/.test(rateText) ? Number(rateText.slice(0, -1)) : null;
  const row = {
    difficulty: String(record["難易度"] ?? ""),
    song: String(record["曲名"] ?? ""),
    chartType: String(record["譜面種別"] ?? ""),
    score,
    maxScore,
    rate,
    dxStar,
    player: String(record["プレイヤー"] ?? ""),
    achievedAt: String(record["達成日時"] ?? ""),
    updatedAt: String(record["ランキング更新日時"] ?? ""),
    sourceUrl: String(record["詳細URL"] ?? ""),
  };

  if (record["レベル"] !== "14+") diagnostics.push(error("level", `${label}: レベルが14+ではありません`));
  validateRowFields(row, label, diagnostics);
  return row;
}

function validateNormalizedRow(raw, label, diagnostics) {
  if (!raw || typeof raw !== "object") {
    diagnostics.push(error("row-format", `${label}: 行データがオブジェクトではありません`));
    return null;
  }
  const row = {
    difficulty: raw.difficulty,
    song: raw.song,
    chartType: raw.chartType,
    score: raw.score,
    maxScore: raw.maxScore,
    rate: raw.rate,
    dxStar: raw.dxStar ?? 5,
    player: raw.player,
    achievedAt: raw.achievedAt,
    updatedAt: raw.updatedAt,
    sourceUrl: raw.sourceUrl,
  };
  validateRowFields(row, label, diagnostics);
  return row;
}

function validateRowFields(row, label, diagnostics) {
  if (!ALLOWED_DIFFICULTIES.has(row.difficulty)) diagnostics.push(error("difficulty", `${label}: 難易度がMASTER/Re:MASTERではありません`));
  if (!ALLOWED_CHART_TYPES.has(row.chartType)) diagnostics.push(error("chart-type", `${label}: 譜面種別がDX/STANDARDではありません`));
  validateText(row.song, "曲名", label, diagnostics, 200);
  validateText(row.player, "プレイヤー", label, diagnostics, 100);

  if (!Number.isInteger(row.score) || row.score < 0) diagnostics.push(error("score", `${label}: SCOREが0以上の整数ではありません`));
  if (!Number.isInteger(row.maxScore) || row.maxScore <= 0 || row.maxScore % 3 !== 0) diagnostics.push(error("max-score", `${label}: 理論値が正の3の倍数ではありません`));
  if (Number.isInteger(row.score) && Number.isInteger(row.maxScore) && row.score > row.maxScore) diagnostics.push(error("score-over-max", `${label}: SCOREが理論値を超えています`));
  if (!Number.isInteger(row.dxStar) || row.dxStar < 0 || row.dxStar > 5) diagnostics.push(error("dx-star", `${label}: DXスターが0〜5の整数ではありません`));
  if (!Number.isFinite(row.rate) || row.rate < 0 || row.rate > 100) {
    diagnostics.push(error("rate", `${label}: RATEが0〜100の数値ではありません`));
  } else if (Number.isInteger(row.score) && Number.isInteger(row.maxScore) && row.maxScore > 0 && Math.abs(row.rate - roundRate(row.score, row.maxScore)) > 0.00005) {
    diagnostics.push(error("rate-mismatch", `${label}: RATEがSCORE÷理論値と一致しません`));
  }

  const achievedAt = parseDateTime(row.achievedAt);
  const updatedAt = parseDateTime(row.updatedAt);
  if (achievedAt === null) diagnostics.push(error("achieved-date", `${label}: DATEの形式または実在日が不正です`));
  if (updatedAt === null) diagnostics.push(error("updated-date", `${label}: ランキング更新日時の形式または実在日が不正です`));
  if (achievedAt !== null && updatedAt !== null && achievedAt > updatedAt) diagnostics.push(error("date-order", `${label}: DATEがランキング更新日時より未来です`));
  validateRankingUrl(row.sourceUrl, row.difficulty, label, diagnostics);
}

function validateText(value, field, label, diagnostics, maxLength) {
  if (typeof value !== "string" || !value.trim()) diagnostics.push(error("required-text", `${label}: ${field}が空です`));
  if (String(value).length > maxLength) diagnostics.push(error("text-length", `${label}: ${field}が長すぎます`));
  if (CONTROL_CHARACTERS.test(String(value))) diagnostics.push(error("control-character", `${label}: ${field}に制御文字があります`));
  if (FORMULA_PREFIX.test(String(value))) diagnostics.push(error("formula-injection", `${label}: ${field}が表計算式として解釈される危険な文字で始まっています`));
}

function validateRankingUrl(value, difficulty, label, diagnostics) {
  let url;
  try {
    url = new URL(value);
  } catch {
    diagnostics.push(error("ranking-url", `${label}: 詳細URLがURLではありません`));
    return;
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "maimaidx.jp"
    || url.pathname !== "/maimai-mobile/ranking/musicRankingDetail/"
    || url.username
    || url.password
    || url.hash
  ) diagnostics.push(error("ranking-url", `${label}: 詳細URLが許可されたmaimai DX NETのURLではありません`));

  const expected = { scoreType: "1", rankingType: "99", diff: difficulty === "Re:MASTER" ? "4" : "3" };
  for (const [name, expectedValue] of Object.entries(expected)) {
    const values = url.searchParams.getAll(name);
    if (values.length !== 1 || values[0] !== expectedValue) diagnostics.push(error("ranking-query", `${label}: 詳細URLの${name}が不正です`));
  }
  if (url.searchParams.getAll("idx").length !== 1 || !url.searchParams.get("idx")) diagnostics.push(error("ranking-idx", `${label}: 詳細URLのidxがありません`));
  const allowed = new Set(["idx", "scoreType", "rankingType", "diff"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) diagnostics.push(error("ranking-query-extra", `${label}: 詳細URLに未許可のパラメータがあります: ${safe(key)}`));
}

function parseInteger(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : null;
}

function parseGeneratedAt(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!match) return null;
  return parseDateTime(`${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`);
}

function parseDateOnly(value) {
  const match = String(value ?? "").match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return null;
  return parseDateTime(`${match[1]}/${match[2]}/${match[3]} 00:00`);
}

function isAllowedReferenceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["gamerch.com", "x.com"].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function safe(value) {
  return String(value).replace(/[\r\n\t]/g, " ").slice(0, 240);
}
