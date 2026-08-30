import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../bookmarklet/maimai-rank1.js", import.meta.url), "utf8");
const song = { songName: "End Time", difficulty: "MASTER", chartType: "STANDARD", level: "14+", detailUrl: "https://maimaidx.jp/example" };

test("通常・1日以内・7日以内の日時クラスをすべて取得する", async () => {
  for (const dateClass of ["ranking_music_date", "ranking_music_date_1day", "ranking_music_date_7day"]) {
    const result = await parse({ dateClass });
    assert.equal(result.achievedAt, "2026/08/24 03:18");
    assert.equal(result.updatedAt, "2026/08/30 23:11");
    assert.equal(result.score, 2799);
    assert.equal(result.maxScore, 2847);
    assert.equal(result.player, "TEST PLAYER");
    assert.equal(result.error, "");
  }
});

test("先頭の日時が欠けても2位・同率の次プレイヤーの日付を流用しない", async () => {
  const result = await parse({ dateClass: "missing" });
  assert.equal(result.achievedAt, "");
  assert.match(result.error, /1位の達成日時/);
});

test("日時の空欄・不正形式・実在しない日時を取得失敗として報告", async () => {
  for (const date of ["", "2026-08-24 03:18", "2026/02/30 03:18", "2026/08/24 24:18"]) {
    assert.match((await parse({ date })).error, /1位の達成日時/);
  }
  for (const updated of ["", "2026/02/30 03:18 更新"]) {
    assert.match((await parse({ updated })).error, /ランキング更新日時/);
  }
});

test("取得失敗は既存の再試行・CSV取得状況・完了時の失敗件数へ伝わる", async () => {
  const result = await parse({ date: "" });
  assert.ok(result.error);
  assert.match(source, /if \(!lastRow\.error\) return lastRow/);
  assert.match(source, /rows\.filter\(\(row\) => row\.error\)/);
  assert.match(source, /\["error", "取得状況"\]/);
});

// A small DOM test double evaluates class selector lists against the actual
// class tokens instead of hard-coding the new selector's return value.
async function parse({ dateClass = "ranking_music_date_7day", date = "2026/08/24 03:18", updated = "2026/08/30 23:11 更新" } = {}) {
  const dates = [{ className: `${dateClass} f_r t_c`, textContent: date }];
  const findDate = (selector, nodes) => nodes.find((node) => selector.split(",").some((part) => {
    const token = part.trim();
    return token.startsWith(".") && node.className.split(/\s+/).includes(token.slice(1));
  })) ?? null;
  const first = { querySelector: (selector) => {
    if (selector === ".p_15.p_r_10.p_b_0.f_r.t_r.f_16.f_b") return { textContent: "2,799" };
    if (selector === ".f_l.p_t_10.p_l_10.f_15") return { textContent: "TEST PLAYER" };
    if (selector === 'img[src*="music_icon_dxstar_"]') return { getAttribute: () => "music_icon_dxstar_5.png" };
    return findDate(selector, dates);
  } };
  const doc = { querySelector: (selector) => {
    if (selector === ".ranking_top_block") return first;
    if (selector === '[class*="music_"][class*="_score_back"]') return { textContent: "あなたのスコア ―／2,847" };
    if (selector === ".ranking_title_block span") return { textContent: updated };
    return findDate(selector, [...dates, { className: "ranking_music_date", textContent: "2024/07/01 19:10" }]);
  } };
  const context = {
    location: { hostname: "maimaidx.jp" }, document: { getElementById: () => null },
    DOMParser: class { parseFromString() { return doc; } },
  };
  const api = await vm.runInNewContext(source.replace("  const ui = createStatusPanel();", "  return { parseFirstPlace };\n  const ui = createStatusPanel();"), context);
  return api.parseFirstPlace("fixture", song);
}
