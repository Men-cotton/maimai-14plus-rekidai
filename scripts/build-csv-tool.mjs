import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "bookmarklet", "maimai-rank1.js");

export async function buildCsvTool(outputDir) {
  const source = (await fs.readFile(sourcePath, "utf8")).trim();
  const bookmarklet = `javascript:${encodeURIComponent(source)}`;

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "maimai-rank1-bookmarklet.txt"), `${bookmarklet}\n`, "utf8");

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>maimai 14+ 1位取得ブックマークレット</title>
  <style>
    :root{font-family:system-ui,sans-serif;color:#2d1737;background:#f8f3fb}body{max-width:760px;margin:0 auto;padding:48px 22px;line-height:1.75}
    main{background:white;border:1px solid #e1d2e8;border-radius:24px;padding:34px;box-shadow:0 18px 50px #51296b1c}h1{line-height:1.25;margin-top:0}
    .bookmark{display:inline-block;margin:12px 0 22px;padding:14px 22px;border-radius:12px;background:#8e44ad;color:white;font-weight:700;text-decoration:none;box-shadow:0 6px 16px #6d2d8e42}
    code{background:#f1e9f5;padding:.15em .4em;border-radius:5px}.note{border-left:4px solid #d44d93;padding-left:14px;color:#694276}
  </style>
</head>
<body><main>
  <h1>maimai 14+ でらっくスコア1位取得</h1>
  <p>下の紫色ボタンをブックマークバーへドラッグしてください。</p>
  <a class="bookmark" href="${bookmarklet}">maimai 14+ 1位CSV</a>
  <ol>
    <li><code>maimaidx.jp</code> にログインします。</li>
    <li>maimai DX NET内の任意のページで、登録したブックマークを1回クリックします。</li>
    <li>MASTER / Re:MASTERのLEVEL 14+を自動取得し、CSVがダウンロードされます。</li>
  </ol>
  <p class="note">Cookieはブラウザ内の同一オリジン通信にだけ使われ、スクリプトやCSVには保存されません。</p>
</main></body></html>`;

  await fs.writeFile(path.join(outputDir, "index.html"), html, "utf8");
}
