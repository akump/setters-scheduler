// Chrome-extension entry point: extracts positioned text from a PDF using
// pdf.js, then hands the rows to parser-core.js for the actual table
// reconstruction (roster + schedule).

import * as pdfjsLib from "./lib/pdf.min.mjs";
import { groupIntoRows, parseSchedulePdfRows } from "./parser-core.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdf.worker.min.mjs"
);

async function extractPositionedRows(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const rows = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items
      .map((it) => ({
        str: it.str.trim(),
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
      }))
      .filter((it) => it.str.length > 0);
    rows.push(...groupIntoRows(items, pageNum));
  }
  return rows;
}

export async function parseSchedulePdf(arrayBuffer) {
  const rows = await extractPositionedRows(arrayBuffer);
  return parseSchedulePdfRows(rows);
}
