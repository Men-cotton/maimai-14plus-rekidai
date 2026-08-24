export const REQUIRED_HEADERS = Object.freeze([
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
  "取得状況",
]);

export function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/, "");
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field) throw new Error(`CSVの引用符が不正です（${matrix.length + 1}行目）`);
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((cell) => cell !== "")) matrix.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSVの引用符が閉じられていません");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((cell) => cell !== "")) matrix.push(row);
  }
  if (!matrix.length) throw new Error("CSVが空です");

  const headers = matrix.shift();
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length) throw new Error(`CSV見出しが重複しています: ${[...new Set(duplicateHeaders)].join(", ")}`);

  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length) throw new Error(`必須のCSV見出しがありません: ${missingHeaders.join(", ")}`);

  const records = matrix.map((cells, index) => {
    if (cells.length !== headers.length) {
      throw new Error(`CSVの列数が一致しません（${index + 2}行目: ${cells.length}列、見出し: ${headers.length}列）`);
    }
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });

  return {
    headers,
    extraHeaders: headers.filter((header) => !REQUIRED_HEADERS.includes(header)),
    records,
  };
}

export function quoteCsv(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function rowsToCsv(rows) {
  const lines = [REQUIRED_HEADERS.map(quoteCsv).join(",")];
  for (const row of rows) {
    const values = [
      row.difficulty,
      row.song,
      row.chartType,
      "14+",
      row.score,
      row.maxScore,
      `${Number(row.rate).toFixed(4)}%`,
      row.dxStar ?? 5,
      row.player,
      row.achievedAt,
      row.updatedAt,
      row.sourceUrl,
      "",
    ];
    lines.push(values.map(quoteCsv).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
