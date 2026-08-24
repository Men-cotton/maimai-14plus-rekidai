var INTAKE_COLUMNS_ = {
  status: "処理状態", result: "検証結果", sha256: "SHA-256",
  pending: "新規保留差分", confirmed: "今回確定差分", pullRequest: "GitHub PR"
};
var QUEUE_SHEET_NAME_ = "差分キュー";
var QUEUE_COLUMNS_ = ["譜面キー", "候補指紋", "候補JSON", "確認者JSON", "状態", "最初の回答行", "最後の回答行", "GitHub PR", "更新日時", "備考"];
var QUEUE_STATE_ = {
  pending: "pending", confirmed: "confirmed", submitted: "submitted", accepted: "accepted",
  rejected: "rejected", superseded: "superseded", failed: "failed"
};
var BANNED_SUBMITTERS_PROPERTY_ = "BANNED_SUBMITTERS_V1";
var BAN_SECRET_PROPERTY_ = "SUBMITTER_BAN_SECRET_V1";

function onOpen() {
  SpreadsheetApp.getUi().createMenu("maimai更新")
    .addItem("初期設定・トリガー作成", "setupMaimaiIntake")
    .addItem("差分キューを今すぐ処理", "syncMaimaiIntakeQueue")
    .addSeparator()
    .addItem("選択行の送信者をBAN", "banSelectedSubmitter")
    .addItem("BANを解除", "unbanSubmitterPrompt").addToUi();
}

function setupMaimaiIntake() {
  var sheet = responseSheet_();
  ensureIntakeColumns_(sheet);
  ensureQueueSheet_();
  ensureSubmitterBanSecret_();
  var config = intakeConfig_();
  var headers = headerMap_(sheet);
  [config.timestampHeader, config.emailHeader, config.csvHeader].forEach(function (header) {
    if (!headers[header]) throw new Error("Googleフォームの回答列がありません: " + header);
  });
  var spreadsheetId = sheet.getParent().getId();
  var triggers = ScriptApp.getProjectTriggers();
  var hasFormTrigger = triggers.some(function (trigger) {
    return trigger.getHandlerFunction() === "handleMaimaiFormSubmit" && trigger.getTriggerSourceId() === spreadsheetId;
  });
  var hasSyncTrigger = triggers.some(function (trigger) { return trigger.getHandlerFunction() === "syncMaimaiIntakeQueue"; });
  if (!hasFormTrigger) ScriptApp.newTrigger("handleMaimaiFormSubmit").forSpreadsheet(spreadsheetId).onFormSubmit().create();
  if (!hasSyncTrigger) ScriptApp.newTrigger("syncMaimaiIntakeQueue").timeBased().atHour(0).everyDays(1).create();
  try {
    SpreadsheetApp.getUi().alert("設定完了", "フォーム受付と1日ごとのキュー処理を設定しました。差分は異なる確認済みGoogleアカウントが同じ値を送るまで公開されません。", SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (_cause) {
    console.log("設定完了: フォーム受付と1日ごとのキュー処理を設定しました");
  }
}

function handleMaimaiFormSubmit(event) {
  if (!event || !event.range) throw new Error("フォーム回答イベントがありません");
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sheet = event.range.getSheet();
    ensureIntakeColumns_(sheet);
    var outcome = processResponseRow_(sheet, event.range.getRow(), true);
    notifyOwner_(sheet, event.range.getRow(), outcome);
  } finally { lock.releaseLock(); }
}

function syncMaimaiIntakeQueue() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try { return syncMaimaiIntakeQueueUnlocked_(); } finally { lock.releaseLock(); }
}

function processResponseRow_(sheet, row, enforceRateLimit) {
  var headers = headerMap_(sheet);
  var email = responseEmail_(sheet, row, headers, intakeConfig_());
  if (email && isSubmitterBanned_(email)) return discardBannedResponse_(sheet, row, headers, email);
  var outcome = validateResponseRow_(sheet, row, enforceRateLimit);
  if (!outcome.ok) return outcome;
  try {
    var canonical = fetchCanonicalSnapshot_();
    var queueSheet = ensureQueueSheet_();
    var reconciliation = reconcileQueue_(queueSheet, canonical);
    var entries = readQueueEntries_(queueSheet);
    var effectiveRows = effectiveRowsForQueue_(canonical.rows, entries);
    var comparison = compareMaimaiSnapshot_(effectiveRows, outcome.normalizedRows);
    outcome.warnings = outcome.warnings.concat(reconciliation.warnings, comparison.warnings);
    if (!comparison.ok) {
      outcome.ok = false;
      outcome.errors = outcome.errors.concat(comparison.errors);
      outcome.summary = formatOutcomeSummary_(outcome.errors, outcome.warnings);
      writeResponseOutcome_(sheet, row, headers, outcome, "差分検証失敗");
      return outcome;
    }
    var queued = applySnapshotToQueue_(queueSheet, entries, comparison, outcome.email, row);
    outcome.pendingCount = queued.pendingCount;
    outcome.confirmedCount = queued.confirmedCount;
    outcome.summary = formatOutcomeSummary_(outcome.errors, outcome.warnings);
    if (!comparison.differences.length && !queued.rejectedCount) outcome.summary += "\n正本との差分はありません。";
    if (queued.pendingCount) outcome.summary += "\n" + queued.pendingCount + "件を別アカウントの一致待ちとして保留しました。";
    if (queued.confirmedCount) outcome.summary += "\n" + queued.confirmedCount + "件が別アカウントの入力と一致し、確定しました。";
    if (queued.rejectedCount) outcome.summary += "\n前回と一致しなかった保留差分 " + queued.rejectedCount + "件を取り下げました。";
    var sync = syncMaimaiIntakeQueueUnlocked_(canonical);
    if (sync.pullRequestUrl) {
      outcome.pullRequestUrl = sync.pullRequestUrl;
      outcome.summary += "\n確定差分をPR化し、自動検証・自動マージを予約しました: " + sync.pullRequestUrl;
    } else if (sync.inFlight) {
      outcome.summary += "\n先行PRの反映後に、確定済みの次の差分を自動処理します。";
    }
    if (sync.systemError) {
      outcome.summary += "\nWARN: 自動PR処理は再試行待ちです: " + safeMessage_(sync.systemError);
      notifySystemFailure_(sync.systemError);
    }
    var status = queued.confirmedCount ? "差分確定" : queued.pendingCount ? "差分照合待ち" : "差分なし";
    if (sync.pullRequestUrl) status = "PR検証・自動マージ待ち";
    writeResponseOutcome_(sheet, row, headers, outcome, status);
    return outcome;
  } catch (cause) {
    outcome.ok = false;
    outcome.errors.push("受付処理に失敗しました: " + safeMessage_(cause && cause.message));
    outcome.summary = formatOutcomeSummary_(outcome.errors, outcome.warnings);
    writeResponseOutcome_(sheet, row, headers, outcome, "受付処理失敗");
    return outcome;
  }
}

function validateResponseRow_(sheet, row, enforceRateLimit) {
  ensureIntakeColumns_(sheet);
  var config = intakeConfig_();
  var headers = headerMap_(sheet);
  var errors = [];
  var warnings = [];
  var email = responseEmail_(sheet, row, headers, config);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Google確認済みメールアドレスが取得できません");
  if (enforceRateLimit && email && exceedsSubmissionRate_(sheet, row, headers, config, email)) errors.push("同じGoogleアカウントからの提出回数が上限を超えています");
  var fileId;
  var bytes = [];
  var fileName = "";
  try {
    fileId = uploadedFileId_(sheet.getRange(row, requiredColumn_(headers, config.csvHeader)));
    var file = DriveApp.getFileById(fileId);
    fileName = file.getName();
    bytes = file.getBlob().getBytes();
    if (bytes.length > config.maxBytes) errors.push("CSVが" + config.maxBytes + "バイトを超えています");
  } catch (cause) { errors.push("アップロードされたCSVを読み取れません: " + safeMessage_(cause && cause.message)); }
  var validation = { errors: [], warnings: [], generatedAt: "", rowCount: 0, normalizedRows: [] };
  var sha256 = "";
  if (bytes.length && !errors.length) {
    var text = Utilities.newBlob(bytes).getDataAsString("UTF-8");
    if (text.indexOf("\uFFFD") >= 0) errors.push("CSVをUTF-8として読み取れません");
    validation = validateMaimaiUpload_(fileName, text);
    errors = errors.concat(validation.errors);
    warnings = warnings.concat(validation.warnings);
    sha256 = sha256Hex_(bytes);
    if (hasPriorHash_(sheet, row, headers, sha256)) warnings.push("同一バイト列のCSVが以前にも提出されています");
  }
  var outcome = {
    ok: errors.length === 0, errors: errors, warnings: warnings, summary: formatOutcomeSummary_(errors, warnings),
    email: email, fileId: fileId, fileName: fileName, sha256: sha256, generatedAt: validation.generatedAt,
    rowCount: validation.rowCount, normalizedRows: validation.normalizedRows || [], responseRow: row
  };
  writeResponseOutcome_(sheet, row, headers, outcome, outcome.ok ? "形式検証OK" : "形式検証失敗");
  return outcome;
}

function applySnapshotToQueue_(queueSheet, entries, comparison, email, responseRow) {
  var pendingByKey = {};
  entries.filter(function (entry) { return entry.state === QUEUE_STATE_.pending; }).forEach(function (entry) {
    if (pendingByKey[entry.key]) updateQueueEntry_(queueSheet, pendingByKey[entry.key], { state: QUEUE_STATE_.rejected, note: "重複した保留行を整理" });
    pendingByKey[entry.key] = entry;
  });
  var pendingCount = 0;
  var confirmedCount = 0;
  var rejectedCount = 0;
  comparison.unchangedKeys.forEach(function (key) {
    var pending = pendingByKey[key];
    if (!pending) return;
    updateQueueEntry_(queueSheet, pending, { state: QUEUE_STATE_.rejected, note: "次の有効な入力で再現されなかった" });
    delete pendingByKey[key];
    rejectedCount += 1;
  });
  comparison.differences.forEach(function (difference) {
    var pending = pendingByKey[difference.key];
    if (pending && pending.fingerprint !== difference.fingerprint) {
      updateQueueEntry_(queueSheet, pending, { state: QUEUE_STATE_.rejected, note: "次の有効な入力が別の差分だった" });
      delete pendingByKey[difference.key];
      pending = null;
      rejectedCount += 1;
    }
    if (!pending) {
      appendQueueEntry_(queueSheet, {
        key: difference.key, fingerprint: difference.fingerprint, candidate: difference.candidate, voters: [email],
        state: QUEUE_STATE_.pending, firstResponseRow: responseRow, lastResponseRow: responseRow,
        pullRequestUrl: "", note: "別アカウントの一致待ち"
      });
      pendingCount += 1;
      return;
    }
    var voters = unique_(pending.voters.concat([email]));
    var state = voters.length >= intakeConfig_().consensusQuorum ? QUEUE_STATE_.confirmed : QUEUE_STATE_.pending;
    updateQueueEntry_(queueSheet, pending, {
      candidate: difference.candidate, voters: voters, state: state, lastResponseRow: responseRow,
      note: state === QUEUE_STATE_.confirmed ? "異なる確認済みGoogleアカウントで一致" : "別アカウントの一致待ち"
    });
    if (state === QUEUE_STATE_.confirmed) confirmedCount += 1;
    else pendingCount += 1;
  });
  return { pendingCount: pendingCount, confirmedCount: confirmedCount, rejectedCount: rejectedCount };
}

function syncMaimaiIntakeQueueUnlocked_(knownCanonical) {
  var queueSheet = ensureQueueSheet_();
  var canonical = knownCanonical || fetchCanonicalSnapshot_();
  var reconciliation;
  try { reconciliation = reconcileQueue_(queueSheet, canonical); }
  catch (cause) { return { inFlight: true, systemError: cause && cause.message, pullRequestUrl: "" }; }
  if (reconciliation.inFlight) return { inFlight: true, systemError: "", pullRequestUrl: "" };
  var confirmed = readQueueEntries_(queueSheet).filter(function (entry) { return entry.state === QUEUE_STATE_.confirmed; });
  if (!confirmed.length) return { inFlight: false, systemError: "", pullRequestUrl: "" };
  var latestByKey = {};
  confirmed.forEach(function (entry) {
    if (latestByKey[entry.key]) updateQueueEntry_(queueSheet, latestByKey[entry.key], { state: QUEUE_STATE_.superseded, note: "同じ譜面の後続確定差分へ集約" });
    latestByKey[entry.key] = entry;
  });
  var selected = Object.keys(latestByKey).map(function (key) { return latestByKey[key]; });
  var rowMap = {};
  canonical.rows.forEach(function (row) { rowMap[chartKeyForRow_(row)] = row; });
  selected.forEach(function (entry) { rowMap[entry.key] = entry.candidate; });
  var effectiveRows = canonical.rows.map(function (row) { return rowMap[chartKeyForRow_(row)]; });
  var finalValidation = compareMaimaiSnapshot_(canonical.rows, effectiveRows);
  if (!finalValidation.ok) {
    selected.forEach(function (entry) { updateQueueEntry_(queueSheet, entry, { state: QUEUE_STATE_.failed, note: finalValidation.errors.join(" / ").slice(0, 1000) }); });
    var validationMessage = "確定差分を正本へ合成できません: " + finalValidation.errors.join(" / ");
    notifySystemFailure_(validationMessage);
    return { inFlight: false, systemError: validationMessage, pullRequestUrl: "" };
  }
  var generated = nextSubmissionIdentity_(canonical, effectiveRows);
  var csv = rowsToMaimaiCsv_(effectiveRows);
  var submission = {
    generatedAt: generated.generatedAt, fileName: generated.fileName,
    bytes: Utilities.newBlob(csv, "text/csv", generated.fileName).getBytes(),
    chartKeys: selected.map(function (entry) { return entry.key; }), quorum: intakeConfig_().consensusQuorum
  };
  try {
    var pullRequest = createGitHubPullRequest_(submission);
    selected.forEach(function (entry) {
      updateQueueEntry_(queueSheet, entry, { state: QUEUE_STATE_.submitted, pullRequestUrl: pullRequest.htmlUrl, note: "PR検証・自動マージ待ち" });
    });
    markResponseRowsForPullRequest_(selected, pullRequest.htmlUrl);
    return { inFlight: true, systemError: "", pullRequestUrl: pullRequest.htmlUrl };
  } catch (cause) { return { inFlight: false, systemError: safeMessage_(cause && cause.message), pullRequestUrl: "" }; }
}

function reconcileQueue_(queueSheet, canonical) {
  var warnings = [];
  var liveMap = {};
  canonical.rows.forEach(function (row) { liveMap[chartKeyForRow_(row)] = row; });
  var submitted = readQueueEntries_(queueSheet).filter(function (entry) { return entry.state === QUEUE_STATE_.submitted; });
  submitted.forEach(function (entry) {
    var live = liveMap[entry.key];
    if (live && entry.fingerprint === chartStateCanonical_(live)) updateQueueEntry_(queueSheet, entry, { state: QUEUE_STATE_.accepted, note: "公開正本への反映を確認" });
  });
  submitted = readQueueEntries_(queueSheet).filter(function (entry) { return entry.state === QUEUE_STATE_.submitted; });
  if (!submitted.length) return { inFlight: false, warnings: warnings };
  var groups = {};
  submitted.forEach(function (entry) { var url = entry.pullRequestUrl || ""; if (!groups[url]) groups[url] = []; groups[url].push(entry); });
  var config = githubConfig_();
  var token = githubInstallationToken_(config);
  var failed = false;
  Object.keys(groups).forEach(function (url) {
    var match = url.match(/^https:\/\/github\.com\/Men-cotton\/maimai-14plus-rekidai\/pull\/(\d+)$/);
    if (!match) {
      groups[url].forEach(function (entry) { updateQueueEntry_(queueSheet, entry, { state: QUEUE_STATE_.failed, note: "PR URLが不正" }); });
      failed = true;
      return;
    }
    var prefix = "/repos/" + encodeURIComponent(config.owner) + "/" + encodeURIComponent(config.repository);
    var pull = githubRequest_("get", prefix + "/pulls/" + match[1], null, token);
    if (pull.state === "closed" && !pull.merged_at) {
      groups[url].forEach(function (entry) { updateQueueEntry_(queueSheet, entry, { state: QUEUE_STATE_.failed, note: "PRがマージされず終了" }); });
      failed = true;
    }
  });
  if (failed) {
    readQueueEntries_(queueSheet).forEach(function (entry) {
      if (entry.state === QUEUE_STATE_.pending || entry.state === QUEUE_STATE_.confirmed) updateQueueEntry_(queueSheet, entry, { state: QUEUE_STATE_.rejected, note: "先行PR失敗のため正本から再照合が必要" });
    });
    warnings.push("先行PRが失敗したため、後続の未公開差分を安全側で取り下げました");
  }
  var stillSubmitted = readQueueEntries_(queueSheet).some(function (entry) { return entry.state === QUEUE_STATE_.submitted; });
  return { inFlight: stillSubmitted, warnings: warnings };
}

function effectiveRowsForQueue_(canonicalRows, entries) {
  var rowMap = {};
  canonicalRows.forEach(function (row) { rowMap[chartKeyForRow_(row)] = row; });
  [QUEUE_STATE_.submitted, QUEUE_STATE_.confirmed].forEach(function (state) {
    entries.filter(function (entry) { return entry.state === state; }).sort(function (left, right) { return left.sheetRow - right.sheetRow; }).forEach(function (entry) {
      if (rowMap[entry.key]) rowMap[entry.key] = entry.candidate;
    });
  });
  return canonicalRows.map(function (row) { return rowMap[chartKeyForRow_(row)]; });
}

function fetchCanonicalSnapshot_() {
  var url = intakeConfig_().canonicalDataUrl + "?t=" + Date.now();
  var response = UrlFetchApp.fetch(url, { method: "get", followRedirects: true, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error("公開正本を取得できません (HTTP " + response.getResponseCode() + ")");
  var data;
  try { data = JSON.parse(response.getContentText()); } catch (cause) { throw new Error("公開正本のJSONを解析できません"); }
  if (!data || !Array.isArray(data.rows) || !MAIMAI_FILE_PATTERN_.test(String(data.sourceFile || ""))) throw new Error("公開正本の形式が不正です");
  if (!data.rows.length || data.rows.length > 200) throw new Error("公開正本の譜面数が不正です");
  var seen = {};
  data.rows.forEach(function (row) { var key = chartKeyForRow_(row); if (seen[key]) throw new Error("公開正本の譜面キーが重複しています"); seen[key] = true; });
  return { generatedAt: data.generatedAt, sourceFile: data.sourceFile, rows: data.rows };
}

function nextSubmissionIdentity_(canonical, rows) {
  var currentWallText = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm");
  var timestamp = parseMaimaiDate_(currentWallText);
  var sourceMatch = String(canonical.sourceFile || "").match(MAIMAI_FILE_PATTERN_);
  if (sourceMatch) {
    var sourceText = sourceMatch[1].slice(0, 4) + "/" + sourceMatch[1].slice(4, 6) + "/" + sourceMatch[1].slice(6, 8) + " " + sourceMatch[2].slice(0, 2) + ":" + sourceMatch[2].slice(2, 4);
    timestamp = Math.max(timestamp, parseMaimaiDate_(sourceText) + 60000);
  }
  rows.forEach(function (row) { var updatedAt = parseMaimaiDate_(row.updatedAt); if (updatedAt !== null) timestamp = Math.max(timestamp, updatedAt); });
  var parts = utcWallParts_(timestamp);
  return { generatedAt: parts.dayDashed + " " + parts.time, fileName: "maimai-14plus-dxscore-rank1-" + parts.dayCompact + "-" + parts.timeCompact + ".csv" };
}

function utcWallParts_(timestamp) {
  var date = new Date(timestamp);
  var year = String(date.getUTCFullYear()).padStart(4, "0");
  var month = String(date.getUTCMonth() + 1).padStart(2, "0");
  var day = String(date.getUTCDate()).padStart(2, "0");
  var hour = String(date.getUTCHours()).padStart(2, "0");
  var minute = String(date.getUTCMinutes()).padStart(2, "0");
  return { dayDashed: year + "-" + month + "-" + day, dayCompact: year + month + day, time: hour + ":" + minute, timeCompact: hour + minute };
}

function rowsToMaimaiCsv_(rows) {
  var lines = [MAIMAI_REQUIRED_HEADERS_.map(quoteCsvCell_).join(",")];
  rows.forEach(function (row) {
    var values = [row.difficulty, row.song, row.chartType, "14+", row.score, row.maxScore,
      roundedRate_(row.score, row.maxScore).toFixed(4) + "%", row.dxStar === undefined ? 5 : row.dxStar,
      row.player, row.achievedAt, row.updatedAt, row.sourceUrl, ""];
    lines.push(values.map(quoteCsvCell_).join(","));
  });
  return lines.join("\r\n") + "\r\n";
}
function quoteCsvCell_(value) { return '"' + String(value === null || value === undefined ? "" : value).replace(/"/g, '""') + '"'; }

function ensureQueueSheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(QUEUE_SHEET_NAME_);
  if (!sheet) sheet = spreadsheet.insertSheet(QUEUE_SHEET_NAME_);
  var headers = sheet.getRange(1, 1, 1, QUEUE_COLUMNS_.length).getDisplayValues()[0];
  if (!headers.some(function (value) { return String(value || "").trim(); })) {
    sheet.getRange(1, 1, 1, QUEUE_COLUMNS_.length).setValues([QUEUE_COLUMNS_]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  } else if (headers.join("\u0000") !== QUEUE_COLUMNS_.join("\u0000")) throw new Error("差分キューの見出しが変更されています");
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function readQueueEntries_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, QUEUE_COLUMNS_.length).getDisplayValues().map(function (record, index) {
    var candidate = {};
    var voters = [];
    try { candidate = JSON.parse(record[2] || "{}"); } catch (ignoredCandidate) {}
    try { voters = JSON.parse(record[3] || "[]"); } catch (ignoredVoters) {}
    return {
      sheetRow: index + 2, key: record[0], fingerprint: record[1], candidate: candidate,
      voters: Array.isArray(voters) ? voters : [], state: record[4], firstResponseRow: Number(record[5] || 0),
      lastResponseRow: Number(record[6] || 0), pullRequestUrl: record[7], updatedAt: record[8], note: record[9]
    };
  }).filter(function (entry) { return entry.key; });
}
function appendQueueEntry_(sheet, entry) { writeQueueEntry_(sheet, sheet.getLastRow() + 1, entry); }
function updateQueueEntry_(sheet, existing, changes) {
  Object.keys(changes).forEach(function (key) { existing[key] = changes[key]; });
  writeQueueEntry_(sheet, existing.sheetRow, existing);
}
function writeQueueEntry_(sheet, row, entry) {
  sheet.getRange(row, 1, 1, QUEUE_COLUMNS_.length).setValues([[
    entry.key, entry.fingerprint, JSON.stringify(entry.candidate || {}), JSON.stringify(entry.voters || []), entry.state,
    entry.firstResponseRow || "", entry.lastResponseRow || "", entry.pullRequestUrl || "",
    Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss"), entry.note || ""
  ]]);
}

function purgeSubmitterVotesFromQueue_(queueSheet, email) {
  var canonicalEmail = canonicalSubmitterEmail_(email);
  var quorum = intakeConfig_().consensusQuorum;
  var result = { changed: 0, rejected: 0, downgraded: 0, submittedPullRequests: [] };
  readQueueEntries_(queueSheet).forEach(function (entry) {
    if ([QUEUE_STATE_.pending, QUEUE_STATE_.confirmed].indexOf(entry.state) < 0) {
      if (entry.state === QUEUE_STATE_.submitted && entry.voters.some(function (voter) { return canonicalSubmitterEmail_(voter) === canonicalEmail; }) && entry.pullRequestUrl) {
        result.submittedPullRequests.push(entry.pullRequestUrl);
      }
      return;
    }
    var voters = entry.voters.filter(function (voter) { return canonicalSubmitterEmail_(voter) !== canonicalEmail; });
    if (voters.length === entry.voters.length) return;
    var state = voters.length >= quorum ? QUEUE_STATE_.confirmed : voters.length ? QUEUE_STATE_.pending : QUEUE_STATE_.rejected;
    updateQueueEntry_(queueSheet, entry, {
      voters: voters, state: state,
      note: state === QUEUE_STATE_.rejected ? "BAN対象の確認票を除外したため取下げ" : "BAN対象の確認票を除外して再照合待ち"
    });
    result.changed += 1;
    if (state === QUEUE_STATE_.rejected) result.rejected += 1;
    else if (state === QUEUE_STATE_.pending) result.downgraded += 1;
  });
  result.submittedPullRequests = unique_(result.submittedPullRequests);
  return result;
}

function cancelSubmittedPullRequests_(queueSheet, pullRequestUrls) {
  var result = { closed: 0, merged: 0, errors: [] };
  if (!pullRequestUrls.length) return result;
  var config = githubConfig_();
  var token = githubInstallationToken_(config);
  var prefix = "/repos/" + encodeURIComponent(config.owner) + "/" + encodeURIComponent(config.repository);
  pullRequestUrls.forEach(function (url) {
    try {
      var match = String(url || "").match(/^https:\/\/github\.com\/Men-cotton\/maimai-14plus-rekidai\/pull\/(\d+)$/);
      if (!match) throw new Error("PR URLが不正です");
      var pull = githubRequest_("get", prefix + "/pulls/" + match[1], null, token);
      if (pull.merged_at) { result.merged += 1; return; }
      if (pull.state === "open") githubRequest_("patch", prefix + "/pulls/" + match[1], { state: "closed" }, token);
      readQueueEntries_(queueSheet).filter(function (entry) { return entry.pullRequestUrl === url; }).forEach(function (entry) {
        updateQueueEntry_(queueSheet, entry, { state: QUEUE_STATE_.failed, note: "BANによりPRを停止" });
      });
      result.closed += 1;
    } catch (cause) { result.errors.push(url + ": " + safeMessage_(cause && cause.message)); }
  });
  return result;
}

function markResponseRowsForPullRequest_(entries, pullRequestUrl) {
  var sheet = responseSheet_();
  ensureIntakeColumns_(sheet);
  var headers = headerMap_(sheet);
  unique_(entries.map(function (entry) { return entry.lastResponseRow; }).filter(function (row) { return row >= 2; })).forEach(function (row) {
    sheet.getRange(row, headers[INTAKE_COLUMNS_.status]).setValue("PR検証・自動マージ待ち");
    sheet.getRange(row, headers[INTAKE_COLUMNS_.pullRequest]).setValue(pullRequestUrl);
  });
}
function writeResponseOutcome_(sheet, row, headers, outcome, status) {
  sheet.getRange(row, headers[INTAKE_COLUMNS_.status]).setValue(status);
  sheet.getRange(row, headers[INTAKE_COLUMNS_.result]).setValue(String(outcome.summary || "").slice(0, 45000));
  sheet.getRange(row, headers[INTAKE_COLUMNS_.sha256]).setValue(outcome.sha256 || "");
  sheet.getRange(row, headers[INTAKE_COLUMNS_.pending]).setValue(outcome.pendingCount || 0);
  sheet.getRange(row, headers[INTAKE_COLUMNS_.confirmed]).setValue(outcome.confirmedCount || 0);
  if (outcome.pullRequestUrl) sheet.getRange(row, headers[INTAKE_COLUMNS_.pullRequest]).setValue(outcome.pullRequestUrl);
}
function formatOutcomeSummary_(errors, warnings) {
  var parts = [];
  if (errors.length) parts.push(errors.map(function (message) { return "ERROR: " + message; }).join("\n"));
  if (warnings.length) parts.push(unique_(warnings).map(function (message) { return "WARN: " + message; }).join("\n"));
  if (!parts.length) parts.push("形式・値・URLの検証に合格しました。");
  return parts.join("\n").slice(0, 45000);
}

function responseSheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var config = intakeConfig_();
  var match = spreadsheet.getSheets().filter(function (sheet) {
    if (sheet.getName() === QUEUE_SHEET_NAME_) return false;
    var headers = headerMap_(sheet);
    return headers[config.timestampHeader] && headers[config.emailHeader] && headers[config.csvHeader];
  })[0];
  if (!match) throw new Error("Googleフォーム回答のSheetが見つかりません");
  return match;
}
function ensureIntakeColumns_(sheet) {
  var headers = headerMap_(sheet);
  Object.keys(INTAKE_COLUMNS_).forEach(function (key) {
    var name = INTAKE_COLUMNS_[key];
    if (!headers[name]) { var column = sheet.getLastColumn() + 1; sheet.getRange(1, column).setValue(name).setFontWeight("bold"); headers[name] = column; }
  });
}
function headerMap_(sheet) {
  var values = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  var map = {};
  values.forEach(function (value, index) { var header = String(value || "").trim(); if (header && !map[header]) map[header] = index + 1; });
  return map;
}
function requiredColumn_(headers, name) { if (!headers[name]) throw new Error("回答列がありません: " + name); return headers[name]; }

function responseEmail_(sheet, row, headers, config) {
  return canonicalSubmitterEmail_(sheet.getRange(row, requiredColumn_(headers, config.emailHeader)).getDisplayValue());
}

function discardBannedResponse_(sheet, row, headers, email) {
  var config = intakeConfig_();
  try {
    var fileId = uploadedFileId_(sheet.getRange(row, requiredColumn_(headers, config.csvHeader)));
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (ignored) {}
  var outcome = {
    ok: true, blocked: true, errors: [], warnings: [], summary: "送信を受け付けました。",
    email: email, fileId: "", fileName: "", sha256: "", generatedAt: "", rowCount: 0,
    normalizedRows: [], responseRow: row, pendingCount: 0, confirmedCount: 0
  };
  writeResponseOutcome_(sheet, row, headers, outcome, "受付対象外");
  return outcome;
}

function canonicalSubmitterEmail_(email) { return String(email || "").trim().toLowerCase(); }

function ensureSubmitterBanSecret_() {
  var properties = PropertiesService.getScriptProperties();
  var secret = properties.getProperty(BAN_SECRET_PROPERTY_);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    properties.setProperty(BAN_SECRET_PROPERTY_, secret);
  }
  return secret;
}

function submitterBanHash_(email) {
  var canonicalEmail = canonicalSubmitterEmail_(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(canonicalEmail)) throw new Error("メールアドレスが不正です");
  return bytesToHex_(Utilities.computeHmacSha256Signature(canonicalEmail, ensureSubmitterBanSecret_(), Utilities.Charset.UTF_8));
}

function readBannedSubmitters_() {
  var raw = PropertiesService.getScriptProperties().getProperty(BANNED_SUBMITTERS_PROPERTY_) || "{}";
  var parsed;
  try { parsed = JSON.parse(raw); } catch (cause) { throw new Error("BAN設定を読み取れません"); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("BAN設定の形式が不正です");
  return parsed;
}

function isSubmitterBanned_(email) { return Boolean(readBannedSubmitters_()[submitterBanHash_(email)]); }

function banSubmitter_(email, reason) {
  var registry = readBannedSubmitters_();
  var hash = submitterBanHash_(email);
  registry[hash] = {
    addedAt: Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss"),
    reason: String(reason || "").slice(0, 500)
  };
  PropertiesService.getScriptProperties().setProperty(BANNED_SUBMITTERS_PROPERTY_, JSON.stringify(registry));
  return hash;
}

function unbanSubmitter_(email) {
  var registry = readBannedSubmitters_();
  var hash = submitterBanHash_(email);
  if (!registry[hash]) return false;
  delete registry[hash];
  PropertiesService.getScriptProperties().setProperty(BANNED_SUBMITTERS_PROPERTY_, JSON.stringify(registry));
  return true;
}

function banSelectedSubmitter() {
  var ui = SpreadsheetApp.getUi();
  var range = SpreadsheetApp.getActiveRange();
  if (!range || range.getRow() < 2) return ui.alert("Googleフォームの回答行を1行選択してください。");
  var sheet = range.getSheet();
  var headers = headerMap_(sheet);
  var config = intakeConfig_();
  var email = responseEmail_(sheet, range.getRow(), headers, config);
  if (!email) return ui.alert("選択行からメールアドレスを取得できません。");
  if (ui.alert("送信者をBAN", email + " をBANしますか？", ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    banSubmitter_(email, "回答行 " + range.getRow());
    var queueSheet = ensureQueueSheet_();
    var purged = purgeSubmitterVotesFromQueue_(queueSheet, email);
    var cancelled = cancelSubmittedPullRequests_(queueSheet, purged.submittedPullRequests);
    var message = "BANしました。以後の提出は処理されません。\nキュー更新: " + purged.changed + "件 / 停止PR: " + cancelled.closed + "件";
    if (cancelled.merged) message += "\n既にマージ済みのPR: " + cancelled.merged + "件";
    if (cancelled.errors.length) message += "\nWARN: " + cancelled.errors.join("\n");
    ui.alert(message);
  } finally { lock.releaseLock(); }
}

function unbanSubmitterPrompt() {
  var ui = SpreadsheetApp.getUi();
  var prompt = ui.prompt("BANを解除", "Googleアカウントのメールアドレス", ui.ButtonSet.OK_CANCEL);
  if (prompt.getSelectedButton() !== ui.Button.OK) return;
  var email = canonicalSubmitterEmail_(prompt.getResponseText());
  ui.alert(unbanSubmitter_(email) ? "BANを解除しました。" : "該当するBANはありません。");
}

function uploadedFileId_(range) {
  var links = [];
  var rich = range.getRichTextValue();
  if (rich) rich.getRuns().forEach(function (run) { var link = run.getLinkUrl(); if (link) links.push(link); });
  var text = range.getDisplayValue();
  if (/https?:\/\//.test(text)) links.push(text);
  var ids = [];
  links.forEach(function (link) {
    var match = String(link).match(/\/d\/([A-Za-z0-9_-]{20,})/) || String(link).match(/[?&]id=([A-Za-z0-9_-]{20,})/) || String(link).match(/([A-Za-z0-9_-]{25,})/);
    if (match && ids.indexOf(match[1]) < 0) ids.push(match[1]);
  });
  if (ids.length !== 1) throw new Error("CSVファイルは1件だけアップロードしてください");
  return ids[0];
}
function exceedsSubmissionRate_(sheet, row, headers, config, email) {
  if (row <= 2) return false;
  var timestampColumn = requiredColumn_(headers, config.timestampHeader);
  var emailColumn = requiredColumn_(headers, config.emailHeader);
  var values = sheet.getRange(2, 1, row - 2, Math.max(timestampColumn, emailColumn)).getValues();
  var cutoff = Date.now() - 60 * 60 * 1000;
  var count = values.filter(function (record) {
    var timestamp = record[timestampColumn - 1];
    return String(record[emailColumn - 1] || "").trim().toLowerCase() === email && timestamp instanceof Date && timestamp.getTime() >= cutoff;
  }).length;
  return count >= config.maxSubmissionsPerHour;
}
function hasPriorHash_(sheet, row, headers, sha256) {
  if (!sha256 || row <= 2) return false;
  return sheet.getRange(2, headers[INTAKE_COLUMNS_.sha256], row - 2, 1).getDisplayValues().some(function (record) { return record[0] === sha256; });
}

function notifyOwner_(sheet, row, outcome) {
  if (outcome.blocked) return;
  var recipient = intakeConfig_().ownerEmail;
  if (!recipient || (outcome.ok && !outcome.pullRequestUrl)) return;
  var subject = outcome.ok ? "[maimai歴代表] 確定差分のPRを作成しました" : "[maimai歴代表] CSV受付エラー";
  var body = ["回答行: " + row, "ファイル: " + outcome.fileName, "結果:", outcome.summary,
    outcome.pullRequestUrl ? "PR: " + outcome.pullRequestUrl : "", "", "回答Sheet: " + sheet.getParent().getUrl()].join("\n");
  MailApp.sendEmail({ to: recipient, subject: subject, body: body });
}
function notifySystemFailure_(message) {
  var config = intakeConfig_();
  if (!config.ownerEmail) return;
  var properties = PropertiesService.getScriptProperties();
  var marker = sha256Hex_(Utilities.newBlob(String(message || "")).getBytes());
  var previous = String(properties.getProperty("LAST_SYSTEM_ERROR") || "").split("|");
  if (previous[0] === marker && Date.now() - Number(previous[1] || 0) < 6 * 60 * 60 * 1000) return;
  properties.setProperty("LAST_SYSTEM_ERROR", marker + "|" + Date.now());
  MailApp.sendEmail({ to: config.ownerEmail, subject: "[maimai歴代表] 自動取込の再試行が必要です", body: String(message || "") });
}

function createGitHubPullRequest_(submission) {
  var config = githubConfig_();
  var token = githubInstallationToken_(config);
  var prefix = "/repos/" + encodeURIComponent(config.owner) + "/" + encodeURIComponent(config.repository);
  var baseRef = githubRequest_("get", prefix + "/git/ref/heads/" + encodeURIComponent(config.baseBranch), null, token);
  var stamp = String(submission.generatedAt || "update").replace(/[^0-9]/g, "").slice(0, 12);
  var branch = "submission/" + (stamp || "update") + "-" + Utilities.getUuid().slice(0, 8);
  githubRequest_("post", prefix + "/git/refs", { ref: "refs/heads/" + branch, sha: baseRef.object.sha }, token);
  try {
    var contentPath = "data/updates/" + submission.fileName;
    githubRequest_("put", prefix + "/contents/" + encodePath_(contentPath), {
      message: "Submit confirmed ranking differences " + submission.generatedAt,
      content: Utilities.base64Encode(submission.bytes), branch: branch
    }, token);
    var keyList = submission.chartKeys.slice(0, 20).map(function (key) { return "- `" + key.replace(/`/g, "") + "`"; }).join("\n");
    var pull = githubRequest_("post", prefix + "/pulls", {
      title: "Update confirmed ranking data: " + submission.generatedAt, head: branch, base: config.baseBranch,
      body: "Googleフォームで譜面ごとの差分を照合し、異なる確認済みGoogleアカウント " + submission.quorum + "件以上から一致した差分だけを合成しました。\n\nConfirmed charts: `" + submission.chartKeys.length + "`\n" + keyList + "\n\nGoogleアカウント情報は公開しません。"
    }, token);
    try { enablePullRequestAutoMerge_(pull.node_id, token); }
    catch (autoMergeCause) { try { githubRequest_("patch", prefix + "/pulls/" + pull.number, { state: "closed" }, token); } catch (ignoredClose) {} throw autoMergeCause; }
    return { number: pull.number, htmlUrl: pull.html_url };
  } catch (cause) {
    try { githubRequest_("delete", prefix + "/git/refs/" + encodePath_("heads/" + branch), null, token); } catch (ignored) {}
    throw cause;
  }
}
function enablePullRequestAutoMerge_(pullRequestNodeId, token) {
  var query = "mutation($pullRequestId:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,mergeMethod:SQUASH}){pullRequest{number}}}";
  var response = UrlFetchApp.fetch("https://api.github.com/graphql", {
    method: "post", contentType: "application/json",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    payload: JSON.stringify({ query: query, variables: { pullRequestId: pullRequestNodeId } }), muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var parsed = {};
  try { parsed = JSON.parse(response.getContentText()); } catch (ignored) {}
  if (code !== 200 || (parsed.errors && parsed.errors.length)) {
    var message = parsed.errors && parsed.errors[0] ? parsed.errors[0].message : "";
    throw new Error("PRの自動マージを予約できません (HTTP " + code + "): " + safeMessage_(message));
  }
}
function githubInstallationToken_(config) {
  var now = Math.floor(Date.now() / 1000);
  var header = base64UrlString_(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  var payload = base64UrlString_(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }));
  var signingInput = header + "." + payload;
  var jwt = signingInput + "." + Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(signingInput, config.privateKey)).replace(/=+$/, "");
  var response = UrlFetchApp.fetch("https://api.github.com/app/installations/" + encodeURIComponent(config.installationId) + "/access_tokens", {
    method: "post", headers: { Authorization: "Bearer " + jwt, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 201) throw new Error("GitHub Appの一時トークンを発行できません (HTTP " + response.getResponseCode() + ")");
  return JSON.parse(response.getContentText()).token;
}
function githubRequest_(method, path, body, token) {
  var options = { method: method, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, muteHttpExceptions: true };
  if (body !== null && body !== undefined) { options.contentType = "application/json"; options.payload = JSON.stringify(body); }
  var response = UrlFetchApp.fetch("https://api.github.com" + path, options);
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code < 200 || code >= 300) {
    var message = "";
    try { message = JSON.parse(text).message || ""; } catch (ignored) {}
    throw new Error("GitHub APIに拒否されました (HTTP " + code + "): " + safeMessage_(message));
  }
  return text ? JSON.parse(text) : {};
}

function intakeConfig_() {
  var properties = PropertiesService.getScriptProperties();
  return {
    timestampHeader: properties.getProperty("TIMESTAMP_COLUMN_HEADER") || "タイムスタンプ",
    emailHeader: properties.getProperty("EMAIL_COLUMN_HEADER") || "メールアドレス",
    csvHeader: properties.getProperty("CSV_COLUMN_HEADER") || "CSVファイル",
    ownerEmail: properties.getProperty("OWNER_EMAIL") || "", maxBytes: positiveInteger_(properties.getProperty("MAX_CSV_BYTES"), 200000, 1),
    maxSubmissionsPerHour: positiveInteger_(properties.getProperty("MAX_SUBMISSIONS_PER_HOUR"), 5, 1),
    consensusQuorum: positiveInteger_(properties.getProperty("CONSENSUS_QUORUM"), 2, 2),
    canonicalDataUrl: properties.getProperty("CANONICAL_DATA_URL") || "https://men-cotton.github.io/maimai-14plus-rekidai/data.json"
  };
}
function githubConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var config = {
    appId: properties.getProperty("GITHUB_APP_ID"), installationId: properties.getProperty("GITHUB_INSTALLATION_ID"),
    privateKey: String(properties.getProperty("GITHUB_APP_PRIVATE_KEY") || "").replace(/\\n/g, "\n"),
    owner: properties.getProperty("GITHUB_OWNER") || "Men-cotton", repository: properties.getProperty("GITHUB_REPOSITORY") || "maimai-14plus-rekidai",
    baseBranch: properties.getProperty("GITHUB_BASE_BRANCH") || "main"
  };
  if (!config.appId || !config.installationId || !config.privateKey) throw new Error("GitHub AppのScript Propertiesが未設定です");
  return config;
}
function base64UrlString_(text) { return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8).replace(/=+$/, ""); }
function encodePath_(path) { return String(path).split("/").map(encodeURIComponent).join("/"); }
function positiveInteger_(value, fallback, minimum) {
  var parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}
function sha256Hex_(bytes) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
}
function bytesToHex_(bytes) { return bytes.map(function (value) { return ((value + 256) % 256).toString(16).padStart(2, "0"); }).join(""); }
