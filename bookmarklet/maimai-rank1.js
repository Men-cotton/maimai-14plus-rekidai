(async () => {
  "use strict";

  const HOST = "maimaidx.jp";
  const BASE = "https://maimaidx.jp";
  const LIST_URLS = [
    `${BASE}/maimai-mobile/ranking/search/?search=L-22&scoreType=1&rankingType=99&diff=3`,
    `${BASE}/maimai-mobile/ranking/search/?search=L-22&scoreType=1&rankingType=99&diff=4`,
  ];
  const OVERLAY_ID = "maimai-rank1-exporter";

  if (location.hostname !== HOST) {
    alert("maimai DX NET（maimaidx.jp）にログインした状態で実行してください。");
    return;
  }
  if (document.getElementById(OVERLAY_ID)) return;

  const ui = createStatusPanel();

  try {
    setStatus("14+ の曲一覧を取得しています…", 0, 1);
    const listPages = [];
    for (const url of LIST_URLS) {
      listPages.push(await fetchHtml(url));
      await wait(700);
    }
    const songs = deduplicate(listPages.flatMap(parseSongList));
    if (!songs.length) {
      throw new Error("14+ の曲を取得できませんでした。検索条件またはログイン状態を確認してください。");
    }

    setStatus(`${songs.length}曲のランキングを取得します…`, 0, songs.length);
    let completed = 0;
    const rows = await mapWithConcurrency(songs, 1, async (song) => {
      try {
        return await fetchRankingWithRetry(song);
      } finally {
        completed += 1;
        setStatus(`${completed} / ${songs.length} 曲を取得中…`, completed, songs.length);
        await wait(completed % 20 === 0 ? 3000 : 700);
      }
    });

    const failures = rows.filter((row) => row.error);
    rows.sort(compareRows);
    downloadCsv(rows);
    setStatus(
      failures.length
        ? `完了：${rows.length - failures.length}曲取得、${failures.length}曲失敗（CSVに理由を記録）`
        : `完了：${rows.length}曲のCSVをダウンロードしました。`,
      songs.length,
      songs.length,
      failures.length ? "warning" : "success",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`取得失敗：${message}`, 0, 1, "error");
    alert(message);
  }

  function createStatusPanel() {
    const panel = document.createElement("section");
    panel.id = OVERLAY_ID;
    panel.setAttribute("role", "status");
    panel.style.cssText = [
      "position:fixed", "z-index:2147483647", "inset:18px 18px auto auto",
      "width:min(390px,calc(100vw - 36px))", "box-sizing:border-box",
      "padding:16px", "border:2px solid #6b2fa0", "border-radius:14px",
      "background:#fff", "color:#24132f", "font:14px/1.55 system-ui,sans-serif",
      "box-shadow:0 12px 34px rgba(41,18,57,.28)",
    ].join(";");
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <strong style="font-size:16px;flex:1">maimai 14+ 1位取得</strong>
        <button type="button" aria-label="閉じる" style="border:0;background:#eee;border-radius:8px;padding:4px 9px;cursor:pointer">×</button>
      </div>
      <div data-status>準備中…</div>
      <div style="height:8px;margin-top:10px;border-radius:99px;background:#eee;overflow:hidden">
        <div data-progress style="height:100%;width:0;background:linear-gradient(90deg,#9c4dcc,#ef78b4);transition:width .2s"></div>
      </div>`;
    panel.querySelector("button").addEventListener("click", () => panel.remove());
    document.body.appendChild(panel);
    return panel;
  }

  function setStatus(message, done, total, state = "progress") {
    if (!ui.isConnected) return;
    const status = ui.querySelector("[data-status]");
    const progress = ui.querySelector("[data-progress]");
    status.textContent = message;
    status.style.color = state === "error" ? "#b42318" : state === "warning" ? "#8a4b00" : "#24132f";
    progress.style.width = `${Math.max(0, Math.min(100, total ? (done / total) * 100 : 0))}%`;
  }

  async function fetchHtml(url, retries = 1) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        if (html.includes("エラーコード：100001") || html.includes("再度ログインしてください")) {
          throw new Error("maimai DX NET のセッションが切れています。再ログインしてください。");
        }
        return html;
      } catch (error) {
        lastError = error;
        if (attempt < retries) await wait(600 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async function fetchRankingWithRetry(song) {
    let lastRow = { ...song, sourceUrl: song.detailUrl, error: "1位データなし" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const html = await fetchHtml(song.detailUrl, 1);
      lastRow = parseFirstPlace(html, song);
      if (!lastRow.error) return lastRow;
      if (attempt < 2) await wait(2500 * (attempt + 1));
    }
    return lastRow;
  }

  function parseSongList(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return [...doc.querySelectorAll('form[action*="/ranking/musicRankingDetail/"]')]
      .map((form) => {
        const card = form.closest('[class*="music_"][class*="_score_back"]');
        const songName = card?.querySelector(".music_name_block")?.textContent.trim();
        if (!card || !songName) return null;

        const params = new URLSearchParams();
        form.querySelectorAll("input[name]").forEach((input) => params.set(input.name, input.value));
        const difficultyIndex = params.get("diff");
        const action = new URL(form.getAttribute("action"), BASE);
        action.search = params.toString();
        const kindSrc = card.querySelector(".music_kind_icon")?.getAttribute("src") || "";
        return {
          songName,
          level: card.querySelector(".music_lv_block")?.textContent.trim() || "14+",
          difficulty: difficultyIndex === "3" ? "MASTER" : difficultyIndex === "4" ? "Re:MASTER" : difficultyIndex,
          chartType: /standard/i.test(kindSrc) ? "STANDARD" : "DX",
          detailUrl: action.href,
          idx: params.get("idx") || "",
        };
      })
      .filter(Boolean);
  }

  function deduplicate(songs) {
    const seen = new Set();
    return songs.filter((song) => {
      const key = `${song.idx}|${song.difficulty}|${song.chartType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseFirstPlace(html, song) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const first = doc.querySelector(".ranking_top_block");
    if (!first) {
      const errorCode = doc.body?.textContent.match(/エラーコード[：:]\s*([0-9]+)/)?.[1];
      return {
        ...song,
        sourceUrl: song.detailUrl,
        error: errorCode ? `maimai DX NET エラー ${errorCode}` : "1位データなし",
      };
    }

    const scoreCard = doc.querySelector('[class*="music_"][class*="_score_back"]');
    const maxScoreMatch = scoreCard?.textContent.match(/あなたのスコア[\s\S]*?／\s*([\d,]+)/);
    const scoreText = first.querySelector(".p_15.p_r_10.p_b_0.f_r.t_r.f_16.f_b")?.textContent.trim() || "";
    const maxScoreText = maxScoreMatch?.[1] || "";
    const score = toNumber(scoreText);
    const maxScore = toNumber(maxScoreText);
    const starSrc = first.querySelector('img[src*="music_icon_dxstar_"]')?.getAttribute("src") || "";
    const updatedText = doc.querySelector(".ranking_title_block span")?.textContent.trim() || "";

    return {
      ...song,
      player: first.querySelector(".f_l.p_t_10.p_l_10.f_15")?.textContent.trim() || "",
      score,
      maxScore,
      scoreRate: maxScore ? (score / maxScore) * 100 : null,
      dxStar: starSrc.match(/dxstar_(\d)/)?.[1] || "",
      achievedAt: first.querySelector(".ranking_music_date")?.textContent.trim() || "",
      updatedAt: updatedText.replace(/\s*更新\s*$/, ""),
      sourceUrl: song.detailUrl,
      error: "",
    };
  }

  async function mapWithConcurrency(items, limit, worker) {
    const output = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          output[index] = await worker(items[index]);
        } catch (error) {
          output[index] = {
            ...items[index],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }));
    return output;
  }

  function compareRows(a, b) {
    const difficultyOrder = { MASTER: 0, "Re:MASTER": 1 };
    return (difficultyOrder[a.difficulty] ?? 9) - (difficultyOrder[b.difficulty] ?? 9)
      || a.songName.localeCompare(b.songName, "ja");
  }

  function downloadCsv(rows) {
    const headers = [
      ["difficulty", "難易度"], ["songName", "曲名"], ["chartType", "譜面種別"],
      ["level", "レベル"], ["score", "1位でらっくスコア"], ["maxScore", "理論値"],
      ["scoreRate", "理論値比率"], ["dxStar", "DXスター"], ["player", "プレイヤー"],
      ["achievedAt", "達成日時"], ["updatedAt", "ランキング更新日時"],
      ["sourceUrl", "詳細URL"], ["error", "取得状況"],
    ];
    const lines = [headers.map(([, label]) => csvCell(label)).join(",")];
    rows.forEach((row) => {
      lines.push(headers.map(([key]) => {
        const value = key === "scoreRate" && Number.isFinite(row[key]) ? `${row[key].toFixed(4)}%` : row[key] ?? "";
        return csvCell(value);
      }).join(","));
    });
    const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `maimai-14plus-dxscore-rank1-${timestamp()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function csvCell(value) {
    let text = String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function toNumber(text) {
    const number = Number(String(text).replaceAll(",", "").trim());
    return Number.isFinite(number) ? number : null;
  }

  function timestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
