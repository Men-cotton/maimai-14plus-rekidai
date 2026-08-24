import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { escapeHtml as escape } from "./lib/html.mjs";
import { formatDiagnostics, replayRepository } from "./lib/repository.mjs";
import { chartKey, hasErrors } from "./lib/validation.mjs";

const root = resolve(import.meta.dirname, "..");
const result = await replayRepository(root);
if (hasErrors(result.diagnostics)) {
  for (const item of result.diagnostics.filter((entry) => entry.level === "error")) console.error(`ERROR [${item.code}] ${item.message}`);
  throw new Error("検証ERRORがあるためサイトを生成できません");
}

const data = result.payload;
const { chartVersions, chartConstants, remasterAudit, versionPeriods } = result.metadata;
const outputDir = resolve(root, "dist/site");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const number = new Intl.NumberFormat("ja-JP");
const versionOrder = ["maimai", "maimai PLUS", "GreeN", "GreeN PLUS", "ORANGE", "ORANGE PLUS", "PiNK", "PiNK PLUS", "MURASAKi", "MURASAKi PLUS", "MiLK", "MiLK PLUS", "FiNALE", "maimaiでらっくす", "maimaiでらっくす PLUS", "Splash", "Splash PLUS", "UNiVERSE", "UNiVERSE PLUS", "FESTiVAL", "FESTiVAL PLUS", "BUDDiES", "BUDDiES PLUS", "PRiSM", "PRiSM PLUS", "CiRCLE", "CiRCLE PLUS"];
const versionPalette = {
  "maimai": "cyan", "maimai PLUS": "lightblue",
  "GreeN": "lightgreen", "GreeN PLUS": "lime",
  "ORANGE": "orange", "ORANGE PLUS": "chocolate",
  "PiNK": "pink", "PiNK PLUS": "lightpink",
  "MURASAKi": "orchid", "MURASAKi PLUS": "mediumorchid",
  "MiLK": "snow", "MiLK PLUS": "azure",
  "FiNALE": "gray",
  "maimaiでらっくす": "skyblue", "maimaiでらっくす PLUS": "#cee7ff",
  "Splash": "#7BE0B6", "Splash PLUS": "#6989FF",
  "UNiVERSE": "#53abff", "UNiVERSE PLUS": "#8dc7ff",
  "FESTiVAL": "#ff9bb7", "FESTiVAL PLUS": "#ff8ae7",
  "BUDDiES": "#d58507", "BUDDiES PLUS": "#d18f23",
  "PRiSM": "#99ffdd", "PRiSM PLUS": "#66ffcc",
  "CiRCLE": "#ff00cc", "CiRCLE PLUS": "#ff4bda",
};
const releaseListUrls = {
  "MURASAKi PLUS": "https://gamerch.com/maimai/533416",
  "MiLK PLUS": "https://gamerch.com/maimai/533415",
  "FiNALE": "https://gamerch.com/maimai/533573",
  "UNiVERSE PLUS": "https://gamerch.com/maimai/533949",
};
const versionLabels = {
  "maimaiでらっくす": "でらっくす",
  "maimaiでらっくす PLUS": "でらっくす PLUS",
};
const versionAt = (dateTime) => {
  const day = String(dateTime).slice(0, 10).replaceAll("-", "/");
  return versionPeriods.periods.find(({ start, end }) => day >= start && (!end || day <= end))?.version;
};

const rows = data.rows.map((row) => {
  const key = chartKey(row);
  const audit = remasterAudit[key];
  const rawVersion = chartVersions[key];
  const version = escape(versionLabels[rawVersion] ?? rawVersion ?? "—");
  const versionBg = versionPalette[rawVersion] ?? "#fff";
  const constant = chartConstants[key];
  const constantValue = Number.isFinite(constant) ? constant.toFixed(1) : "—";
  const dateVersion = versionAt(row.achievedAt);
  const dateBg = versionPalette[dateVersion] ?? "#fff";
  const releaseUrl = releaseListUrls[rawVersion];
  const versionCell = audit && releaseUrl
    ? `<a href="${escape(releaseUrl)}" title="Re:MAS追加: ${escape(audit.addedAt)}">${version}</a>`
    : version;
  return `<tr data-score="${row.score}" data-gap="${row.maxScore - row.score}" data-notes="${row.maxScore / 3}" data-rate="${row.rate}" data-date="${escape(row.achievedAt)}" data-version="${versionOrder.indexOf(rawVersion)}" data-constant="${Number.isFinite(constant) ? constant : ""}">
<td class="c ${row.difficulty === "Re:MASTER" ? "remas" : "master"}">${row.difficulty === "Re:MASTER" ? "Re:MAS" : "MASTER"}</td>
<td class="c${row.chartType === "STANDARD" ? " st" : ""}">${row.chartType === "STANDARD" ? "ST" : escape(row.chartType)}</td>
<td class="version" style="background-color:${escape(versionBg)}">${versionCell}</td>
<td class="c">${constantValue}</td>
<th scope="row" class="song" title="${escape(row.song)}"><a href="${escape(row.sourceUrl)}">${escape(row.song)}</a></th>
<td class="n">${number.format(row.score)}</td>
<td class="gap">MAX-${number.format(row.maxScore - row.score)}</td>
<td class="c">${Number(row.rate).toFixed(2)}%</td>
<td class="n">${number.format(row.maxScore / 3)}</td>
<td>${escape(row.player)}</td>
<td class="date" style="background-color:${escape(dateBg)}" title="達成時: ${escape(versionLabels[dateVersion] ?? dateVersion ?? "不明")}"><time>${escape(row.achievedAt)}</time></td>
</tr>`;
}).join("\n");

const playerCounts = new Map();
for (const row of data.rows) playerCounts.set(row.player, (playerCounts.get(row.player) ?? 0) + 1);
const playerRows = [...playerCounts]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
  .map(([player, count]) => `<tr><th scope="row">${escape(player)}</th><td class="n">${count}</td><td class="n">${(count / data.rows.length * 100).toFixed(2)}%</td></tr>`)
  .join("\n");

const html = `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>maimai 14+ でらっくスコア歴代表</title>
<meta name="description" content="maimai 難易度14+の、でらっくスコア歴代表">
<meta property="og:title" content="maimai 14+ でらっくスコア歴代表">
<meta property="og:description" content="maimai 難易度14+の、でらっくスコア歴代表">
<style>
*{box-sizing:border-box}html{--song-width:420px;font:14px/1.45 ui-monospace,SFMono-Regular,Consolas,"Noto Sans Mono CJK JP",monospace;color:#111;background:#fff}body{margin:0}main{max-width:1540px;margin:auto;padding:16px}h1{font:700 20px/1.2 inherit;margin:0 0 6px}h2{font:700 15px/1.2 inherit;margin:16px 0 6px}p,footer{margin:0;color:#444}.wrap{overflow-x:auto;margin:16px 0}.players{width:auto;min-width:380px}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{padding:6px 8px;border:1px solid #bbb;text-align:left}thead th{position:sticky;top:0;color:#fff;background:#111;border-color:#111}tbody th{font-weight:400}.n{text-align:right;font-variant-numeric:tabular-nums}.c,.gap{text-align:center;font-variant-numeric:tabular-nums}.song{width:var(--song-width);max-width:var(--song-width);overflow:hidden}.song a{display:block;width:100%;overflow:hidden;white-space:nowrap}.version{color:#111}.master{color:#fff;background:#c346e7}.remas{color:#c346e7;background:#fff}.st{color:#fff;background:#45aeff}a{color:#04c;text-decoration:underline}button{padding:0;border:0;color:inherit;background:none;font:inherit;font-weight:700;cursor:pointer}button:hover,button:focus{text-decoration:underline}footer{font-size:12px}@media(max-width:640px){main{padding:10px}th,td{padding:5px 7px}.players{min-width:100%}}
</style>
<main>
<header><h1>maimai 14+ でらっくスコア歴代表</h1><p>${escape(data.generatedAt)} 取得 / 全${data.counts.total}枠 / MASTER ${data.counts.master} / Re:MASTER ${data.counts.remaster}</p></header>
<h2>プレイヤー別 歴代数</h2>
<table class="players"><thead><tr><th>プレイヤー</th><th class="n">歴代数</th><th class="n">割合</th></tr></thead><tbody>${playerRows}</tbody></table>
<div class="wrap"><table id="ranking-table">
<thead><tr><th class="c">難易度</th><th class="c">種別</th><th><button data-sort="version">VERSION</button></th><th class="c"><button data-sort="constant">定数</button></th><th class="song">曲名</th><th class="n"><button data-sort="score">SCORE</button></th><th class="gap"><button data-sort="gap">MAX差</button></th><th class="c"><button data-sort="rate">RATE</button></th><th class="n"><button data-sort="notes">NOTES</button></th><th>プレイヤー</th><th><button data-sort="date">DATE</button></th></tr></thead>
<tbody id="ranking">${rows}</tbody>
</table></div>
<footer>ランキング: <a href="https://maimaidx.jp/">maimai DX NET</a> / 初出バージョン: <a href="https://github.com/realtvop/SaltMeta">SaltMeta</a> / 定数: <a href="https://gamerch.com/maimai/">maimai　攻略wiki</a> / 参考: <a href="https://docs.google.com/spreadsheets/d/1badmnhvsFKU8C1LydrvaaCC-L3fETIZ3PRfPV_qFrUk/preview">IIDX SP☆12歴代表</a> / 開発者: <a href="https://x.com/men_cotton">men_cotton</a></footer>
</main>
<script>
const body=document.getElementById("ranking"),buttons=document.querySelectorAll("[data-sort]");let active="",ascending=false;
for(const button of buttons)button.addEventListener("click",()=>{const key=button.dataset.sort;ascending=active===key?!ascending:false;active=key;const rows=[...body.rows];rows.sort((a,b)=>{const av=a.dataset[key]||"",bv=b.dataset[key]||"";const result=key==="date"?av.localeCompare(bv):Number(av)-Number(bv);return ascending?result:-result});body.append(...rows)});
const fitSongColumn=()=>{const table=document.getElementById("ranking-table"),headers=[...table.tHead.rows[0].cells],allRows=[...table.rows];let fixed=0;headers.forEach((header,index)=>{if(header.classList.contains("song"))return;fixed+=Math.max(...allRows.map(row=>row.cells[index]?.scrollWidth||0))+1});const available=Math.max(120,Math.min(520,window.innerWidth-32-fixed));document.documentElement.style.setProperty("--song-width",available+"px")};
fitSongColumn();addEventListener("resize",fitSongColumn,{passive:true});
</script>
</html>`;

await writeFile(resolve(outputDir, "index.html"), html, "utf8");
await writeFile(resolve(outputDir, "data.json"), `${JSON.stringify(data)}\n`, "utf8");
await writeFile(resolve(outputDir, "validation-report.md"), formatDiagnostics(result.diagnostics), "utf8");
console.log(`Generated ${data.rows.length} rows in ${outputDir}`);
