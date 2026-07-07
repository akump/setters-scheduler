// Chrome-extension entry point for the "tournament night" schedule format.
// Renders each page to a canvas to sample fill color per text run (red vs.
// black can't be told apart from text alone — see parser-tourney-core.js),
// then hands positioned+colored rows to the pure parsing logic.

import * as pdfjsLib from "./lib/pdf.min.mjs";
import { groupIntoRows } from "./parser-core.js";
import { parseTourneySchedule } from "./parser-tourney-core.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdf.worker.min.mjs"
);

function classifyPixel(r, g, b) {
  // Red legend text is a solid, fairly saturated red; body text is near
  // black. Require a clear red dominance to avoid misclassifying
  // anti-aliased edges between the two.
  return r > 110 && r - g > 40 && r - b > 40 ? "red" : "black";
}

function isBackground(r, g, b) {
  return r > 240 && g > 240 && b > 240;
}

// A single fixed sample point can land in the gap between two glyphs (e.g.
// a narrow letter or a kerning gap) and read as background, misclassifying
// an otherwise-red run as black. Sample a grid of points across the run's
// width and cap-height instead and take a majority vote over actual ink
// (non-background) hits.
function classifyItemColor(pixelAt, m, heightPx, pixelWidth) {
  const dxFracs = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85];
  const dyFracs = [-0.2, -0.3, -0.4, -0.5];
  let redVotes = 0;
  let blackVotes = 0;
  for (const fx of dxFracs) {
    for (const fy of dyFracs) {
      const [r, g, b] = pixelAt(m[4] + pixelWidth * fx, m[5] + heightPx * fy);
      if (isBackground(r, g, b)) continue;
      if (classifyPixel(r, g, b) === "red") redVotes++;
      else blackVotes++;
    }
  }
  return redVotes > blackVotes ? "red" : "black";
}

async function extractColoredRows(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const rows = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const scale = 2;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    function pixelAt(px, py) {
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(px)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(py)));
      const i = (y * canvas.width + x) * 4;
      return [imageData[i], imageData[i + 1], imageData[i + 2]];
    }

    const content = await page.getTextContent();
    const items = content.items
      .map((it) => {
        const str = it.str.trim();
        if (!str) return null;
        const m = pdfjsLib.Util.transform(viewport.transform, it.transform);
        const heightPx = Math.hypot(m[2], m[3]) || 10;
        const pixelWidth = it.width * scale;
        return {
          str,
          x: it.transform[4],
          y: it.transform[5],
          width: it.width,
          color: classifyItemColor(pixelAt, m, heightPx, pixelWidth),
        };
      })
      .filter(Boolean);
    rows.push(...groupIntoRows(items, pageNum));
  }
  return rows;
}

export async function parseTourneyPdf(arrayBuffer) {
  const rows = await extractColoredRows(arrayBuffer);
  return parseTourneySchedule(rows);
}
