import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { buildCsvTool } from "../scripts/build-csv-tool.mjs";

test("CSV取得ページは独立した静的ページとして同じブックマークレットを提供する", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "maimai-csv-tool-"));
  try {
    await buildCsvTool(outputDir);
    const html = await readFile(join(outputDir, "index.html"), "utf8");
    const text = await readFile(join(outputDir, "maimai-rank1-bookmarklet.txt"), "utf8");
    const source = (await readFile(resolve(import.meta.dirname, "../bookmarklet/maimai-rank1.js"), "utf8")).trim();
    const href = html.match(/class="bookmark" href="([^"]+)"/)?.[1];
    assert.ok(href?.startsWith("javascript:"));
    assert.equal(href, text.trim());
    assert.equal(decodeURIComponent(href.slice("javascript:".length)), source);
    assert.doesNotThrow(() => new Script(source));
    assert.match(html, /ブックマークバーへドラッグ/);
    assert.doesNotMatch(html, /chatgpt\.site|Firefox|<script\b/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
