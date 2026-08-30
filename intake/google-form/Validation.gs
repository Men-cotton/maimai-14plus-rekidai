var MAIMAI_REQUIRED_HEADERS_ = [
  "難易度",
  "曲名",
  "譜面種別",
  "レベル",
  "1位でらっくスコア",
  "理論値",
  "理論値比率",
  "DXスター",
  "プレイヤー",
  "達成日時",
  "ランキング更新日時",
  "詳細URL",
  "取得状況"
];

var MAIMAI_FILE_PATTERN_ = /^maimai-14plus-dxscore-rank1-(\d{8})-(\d{4})\.csv$/;
// Google Forms adds the uploader's display name before the extension. Never
// use that untrusted suffix for identity, notifications, or public filenames.
var MAIMAI_FORM_UPLOAD_PATTERN_ = /^(maimai-14plus-dxscore-rank1-\d{8}-\d{4})(?: - ([^\u0000-\u001F\u007F/\\]{1,200}))?\.csv$/;
var MAIMAI_DATE_PATTERN_ = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;
var MAIMAI_FORMULA_PREFIX_ = /^[\s\uFEFF]*[=+@\-＝＋＠－]/;
var MAIMAI_CONTROL_CHARACTERS_ = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function validateMaimaiUpload_(fileName, csvText) {
  var errors = [];
  var warnings = [];
  var semanticRows = [];
  var normalizedRows = [];
  var canonicalFileName = canonicalMaimaiUploadFileName_(fileName);
  var generatedAt = generatedAtFromFileName_(canonicalFileName);
  if (!generatedAt) errors.push("CSVのファイル名が規定形式ではありません");

  var parsed;
  try {
    parsed = parseMaimaiCsv_(String(csvText || "").replace(/^\uFEFF/, ""));
  } catch (cause) {
    errors.push("CSVを解析できません: " + safeMessage_(cause && cause.message));
    return result_();
  }

  var headers = parsed.headers;
  var duplicateHeaders = headers.filter(function (header, index) { return headers.indexOf(header) !== index; });
  if (duplicateHeaders.length) errors.push("CSV見出しが重複しています");
  MAIMAI_REQUIRED_HEADERS_.forEach(function (header) {
    if (headers.indexOf(header) < 0) errors.push("必須のCSV見出しがありません: " + header);
  });
  headers.forEach(function (header) {
    if (MAIMAI_REQUIRED_HEADERS_.indexOf(header) < 0) warnings.push("未使用の列があります: " + safeMessage_(header));
  });
  if (errors.length) return result_();

  if (!parsed.records.length) errors.push("データ行がありません");
  if (parsed.records.length > 200) errors.push("データ行が200件を超えています");
  if (parsed.records.length !== 86) warnings.push("現在の86件と行数が異なります。譜面増減はPRで旧値が維持されます");

  var seen = {};
  parsed.records.forEach(function (record, index) {
    var line = index + 2;
    var difficulty = record["難易度"];
    var song = record["曲名"];
    var chartType = record["譜面種別"];
    var player = record["プレイヤー"];
    var score = integer_(record["1位でらっくスコア"]);
    var maxScore = integer_(record["理論値"]);
    var dxStar = integer_(record["DXスター"]);
    var rateText = String(record["理論値比率"] || "");
    var rate = /^\d{1,3}(?:\.\d{1,4})?%$/.test(rateText) ? Number(rateText.slice(0, -1)) : null;
    var achievedAt = parseMaimaiDate_(record["達成日時"]);
    var updatedAt = parseMaimaiDate_(record["ランキング更新日時"]);
    var key = difficulty + "|" + chartType + "|" + song;
    var normalized = {
      difficulty: difficulty,
      song: song,
      chartType: chartType,
      score: score,
      maxScore: maxScore,
      rate: rate,
      dxStar: dxStar,
      player: player,
      achievedAt: String(record["達成日時"] || ""),
      updatedAt: String(record["ランキング更新日時"] || ""),
      sourceUrl: String(record["詳細URL"] || "")
    };
    normalizedRows.push(normalized);
    semanticRows.push([key, score, dxStar, player, normalized.achievedAt]);

    if (difficulty !== "MASTER" && difficulty !== "Re:MASTER") errors.push(line + "行目: 難易度が不正です");
    if (chartType !== "DX" && chartType !== "STANDARD") errors.push(line + "行目: 譜面種別が不正です");
    if (record["レベル"] !== "14+") errors.push(line + "行目: レベルが14+ではありません");
    validateTextField_(song, "曲名", line, 200, errors);
    validateTextField_(player, "プレイヤー", line, 100, errors);
    if (seen[key]) errors.push(line + "行目: 譜面キーが重複しています");
    seen[key] = true;

    if (score === null || score < 0) errors.push(line + "行目: SCOREが0以上の整数ではありません");
    if (maxScore === null || maxScore <= 0 || maxScore % 3 !== 0) errors.push(line + "行目: 理論値が正の3の倍数ではありません");
    if (score !== null && maxScore !== null && score > maxScore) errors.push(line + "行目: SCOREが理論値を超えています");
    if (dxStar === null || dxStar < 0 || dxStar > 5) errors.push(line + "行目: DXスターが0〜5の整数ではありません");
    if (rate === null || rate < 0 || rate > 100) {
      errors.push(line + "行目: RATEが不正です");
    } else if (score !== null && maxScore > 0 && Math.abs(rate - roundedRate_(score, maxScore)) > 0.00005) {
      errors.push(line + "行目: RATEがSCORE÷理論値と一致しません");
    }

    if (achievedAt === null) errors.push(line + "行目: DATEの形式または実在日が不正です");
    if (updatedAt === null) errors.push(line + "行目: ランキング更新日時の形式または実在日が不正です");
    if (achievedAt !== null && updatedAt !== null && achievedAt > updatedAt) errors.push(line + "行目: DATEがランキング更新日時より未来です");
    if (String(record["取得状況"] || "").trim()) errors.push(line + "行目: 取得失敗が記録されています");
    validateRankingUrl_(record["詳細URL"], difficulty, line, errors);
  });

  return result_();

  function result_() {
    return {
      ok: errors.length === 0,
      errors: unique_(errors),
      warnings: unique_(warnings),
      fileName: canonicalFileName,
      generatedAt: generatedAt,
      rowCount: parsed && parsed.records ? parsed.records.length : 0,
      normalizedRows: errors.length ? [] : normalizedRows,
      semanticCanonical: errors.length ? "" : JSON.stringify(semanticRows.sort(function (left, right) {
        return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
      }))
    };
  }
}

function chartKeyForRow_(row) {
  return row.difficulty + "|" + row.chartType + "|" + row.song;
}

function chartStateCanonical_(row) {
  return JSON.stringify([row.score, row.dxStar, row.player, row.achievedAt]);
}

function compareMaimaiSnapshot_(baselineRows, incomingRows) {
  var errors = [];
  var warnings = [];
  var differences = [];
  var unchangedKeys = [];
  var ignoredKeys = [];
  var baselineMap = {};
  var incomingMap = {};

  baselineRows.forEach(function (row) { baselineMap[chartKeyForRow_(row)] = row; });
  incomingRows.forEach(function (row) { incomingMap[chartKeyForRow_(row)] = row; });
  var difference = Math.abs(incomingRows.length - baselineRows.length);
  var abruptThreshold = Math.max(5, Math.ceil(baselineRows.length * 0.05));
  if (difference >= abruptThreshold) warnings.push("行数が正本の" + baselineRows.length + "件から" + incomingRows.length + "件へ大きく変化しています");

  baselineRows.forEach(function (previous) {
    var key = chartKeyForRow_(previous);
    var candidate = incomingMap[key];
    if (!candidate) {
      warnings.push("譜面がCSVから消えています。保留中の差分は変更しません: " + safeMessage_(key));
      ignoredKeys.push(key);
      return;
    }
    if (candidate.maxScore !== previous.maxScore) {
      warnings.push("理論値が " + previous.maxScore + " → " + candidate.maxScore + " に変化しています。手動更新まで旧値を維持します: " + safeMessage_(key));
      ignoredKeys.push(key);
      return;
    }
    if (chartStateCanonical_(candidate) === chartStateCanonical_(previous)) {
      unchangedKeys.push(key);
      return;
    }
    if (candidate.score < previous.score) {
      errors.push("SCOREが " + previous.score + " → " + candidate.score + " に減少しています: " + safeMessage_(key));
      return;
    }
    var previousDate = parseMaimaiDate_(previous.achievedAt);
    var candidateDate = parseMaimaiDate_(candidate.achievedAt);
    if (candidate.score === previous.score && candidateDate !== previousDate) {
      errors.push("SCOREが同一なのにDATEが " + previous.achievedAt + " → " + candidate.achievedAt + " に変化しています: " + safeMessage_(key));
      return;
    }
    if (candidate.score > previous.score && candidateDate <= previousDate) {
      errors.push("SCOREが増加したのにDATEが前回より後ではありません: " + safeMessage_(key));
      return;
    }
    if (candidate.player !== previous.player) warnings.push("プレイヤー名が変化しています: " + safeMessage_(key));
    differences.push({
      key: key,
      fingerprint: chartStateCanonical_(candidate),
      previous: previous,
      candidate: candidate
    });
  });

  incomingRows.forEach(function (candidate) {
    var key = chartKeyForRow_(candidate);
    if (!baselineMap[key]) {
      warnings.push("新規譜面です。手動更新まで追加しません: " + safeMessage_(key));
      ignoredKeys.push(key);
    }
  });

  return {
    ok: errors.length === 0,
    errors: unique_(errors),
    warnings: unique_(warnings),
    differences: differences,
    unchangedKeys: unique_(unchangedKeys),
    ignoredKeys: unique_(ignoredKeys)
  };
}

function parseMaimaiCsv_(text) {
  var matrix = [];
  var row = [];
  var field = "";
  var quoted = false;
  for (var index = 0; index < text.length; index += 1) {
    var character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field) throw new Error("引用符の位置が不正です");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some(function (cell) { return cell !== ""; })) matrix.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("引用符が閉じられていません");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some(function (cell) { return cell !== ""; })) matrix.push(row);
  }
  if (!matrix.length) throw new Error("CSVが空です");
  var headers = matrix.shift();
  var records = matrix.map(function (cells, index) {
    if (cells.length !== headers.length) throw new Error((index + 2) + "行目の列数が一致しません");
    var record = {};
    headers.forEach(function (header, column) { record[header] = cells[column]; });
    return record;
  });
  return { headers: headers, records: records };
}

function validateTextField_(value, name, line, maxLength, errors) {
  var text = String(value || "");
  if (!text.trim()) errors.push(line + "行目: " + name + "が空です");
  if (text.length > maxLength) errors.push(line + "行目: " + name + "が長すぎます");
  if (MAIMAI_CONTROL_CHARACTERS_.test(text)) errors.push(line + "行目: " + name + "に制御文字があります");
  if (MAIMAI_FORMULA_PREFIX_.test(text)) errors.push(line + "行目: " + name + "が危険な文字で始まっています");
}

function validateRankingUrl_(value, difficulty, line, errors) {
  var text = String(value || "");
  var prefix = "https://maimaidx.jp/maimai-mobile/ranking/musicRankingDetail/?";
  if (text.indexOf(prefix) !== 0 || text.indexOf("#") >= 0) {
    errors.push(line + "行目: 詳細URLが許可されたmaimai DX NETのURLではありません");
    return;
  }
  var query = {};
  text.slice(prefix.length).split("&").forEach(function (part) {
    var pieces = part.split("=");
    var key = decodeURIComponent(pieces.shift() || "");
    var valuePart = decodeURIComponent(pieces.join("=").replace(/\+/g, "%20"));
    if (Object.prototype.hasOwnProperty.call(query, key)) query[key] = null;
    else query[key] = valuePart;
  });
  var expectedDiff = difficulty === "Re:MASTER" ? "4" : "3";
  if (!query.idx) errors.push(line + "行目: 詳細URLのidxがありません");
  if (query.scoreType !== "1" || query.rankingType !== "99" || query.diff !== expectedDiff) errors.push(line + "行目: 詳細URLのパラメータが不正です");
  Object.keys(query).forEach(function (key) {
    if (["idx", "scoreType", "rankingType", "diff"].indexOf(key) < 0) errors.push(line + "行目: 詳細URLに未許可のパラメータがあります");
  });
}

function canonicalMaimaiUploadFileName_(fileName) {
  var name = String(fileName || "");
  var match = name.match(MAIMAI_FORM_UPLOAD_PATTERN_);
  // Full equality also rejects a trailing newline (JavaScript's $ allows one).
  if (!match || match[0] !== name || (match[2] !== undefined && !match[2].trim())) return "";
  var canonical = match[1] + ".csv";
  return generatedAtFromFileName_(canonical) ? canonical : "";
}

function generatedAtFromFileName_(fileName) {
  var match = String(fileName || "").match(MAIMAI_FILE_PATTERN_);
  if (!match) return "";
  var day = match[1];
  var time = match[2];
  var display = day.slice(0, 4) + "/" + day.slice(4, 6) + "/" + day.slice(6, 8) + " " + time.slice(0, 2) + ":" + time.slice(2, 4);
  return parseMaimaiDate_(display) === null ? "" : display.replace(/\//g, "-");
}

function parseMaimaiDate_(value) {
  var match = String(value || "").match(MAIMAI_DATE_PATTERN_);
  if (!match) return null;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var timestamp = Date.UTC(year, month - 1, day, hour, minute);
  var date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) return null;
  return timestamp;
}

function integer_(value) {
  return /^\d+$/.test(String(value || "")) ? Number(value) : null;
}

function roundedRate_(score, maxScore) {
  return Math.round((score / maxScore) * 1000000) / 10000;
}

function unique_(values) {
  return values.filter(function (value, index) { return values.indexOf(value) === index; });
}

function safeMessage_(value) {
  return String(value || "").replace(/[\r\n\t]/g, " ").slice(0, 160);
}
