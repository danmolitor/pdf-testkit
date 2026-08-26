import type { FontInfo, StructuralSnapshot } from '../types.js';
import { finalize } from './finalize.js';
import type { RawNode, RawPage } from './raw.js';
import { loadDocument } from './pdfjs/loadDocument.js';
import { extractTextRuns, type PdfTextRun } from './pdfjs/textRuns.js';
import { buildHeadingModel } from './pdfjs/headings.js';
import { detectTables } from './pdfjs/tables.js';
import { buildOverflowModel, inferContentBox } from './pdfjs/overflow.js';

/**
 * General-producer extraction via pdfjs. Reliable for page-count, added/removed,
 * moved-to-page, and heading hierarchy; best-effort (lower confidence) for table
 * regions and overflow, since PDF carries neither a table nor a container concept.
 * Everything converges through `finalize`, so the diff engine / matcher / CLI are
 * identical to the FormePDF path.
 */
export async function fromPdf(
  bytes: Uint8Array,
  opts?: { source?: { name?: string }; createdAt?: string },
): Promise<StructuralSnapshot> {
  const doc = await loadDocument(bytes);

  const perPage: { runs: PdfTextRun[]; width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    perPage.push(await extractTextRuns(page));
  }

  // Heading model is doc-wide so levels are consistent across pages.
  const headingModel = buildHeadingModel(perPage.flatMap((p) => p.runs));

  const rawPages: RawPage[] = [];
  const rawNodes: RawNode[] = [];
  let counter = 0;
  const nextId = (): string => `p${counter++}`;

  perPage.forEach((pg, pageIndex) => {
    rawPages.push({
      index: pageIndex,
      width: pg.width,
      height: pg.height,
      contentBox: inferContentBox(pg.runs, pg.width, pg.height),
    });

    const overflowOf = buildOverflowModel(pg.runs, pg.width);
    const tables = detectTables(pg.runs);
    const consumed = new Set<PdfTextRun>();

    for (const table of tables) {
      const tableTempId = nextId();
      rawNodes.push({
        tempId: tableTempId,
        parentTempId: null,
        role: 'table',
        pageIndex,
        bbox: table.bbox,
        text: null,
        font: null,
        headingLevel: null,
        overflow: null,
        table: { rows: table.rows.length, cols: table.cols },
        confidence: 0.5,
      });
      for (const row of table.rows) {
        const rowTempId = nextId();
        rawNodes.push({
          tempId: rowTempId,
          parentTempId: tableTempId,
          role: 'row',
          pageIndex,
          bbox: row.bbox,
          text: null,
          font: null,
          headingLevel: null,
          overflow: null,
          confidence: 0.5,
        });
        for (const cell of row.cells) {
          for (const r of cell.runs) consumed.add(r);
          rawNodes.push({
            tempId: nextId(),
            parentTempId: rowTempId,
            role: 'cell',
            pageIndex,
            bbox: cell.bbox,
            text: cell.text,
            font: fontOf(cell.runs),
            headingLevel: null,
            overflow: null,
            confidence: 0.5,
          });
        }
      }
    }

    for (const r of pg.runs) {
      if (consumed.has(r)) continue;
      const heading = headingModel.isHeading(r);
      rawNodes.push({
        tempId: nextId(),
        parentTempId: null,
        role: heading ? 'heading' : 'text',
        pageIndex,
        bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
        text: r.text,
        font: {
          size: r.fontSize,
          weight: r.bold ? 700 : 400,
          family: r.fontName || null,
          italic: r.italic,
        },
        headingLevel: heading ? headingModel.levelOf(r) : null,
        overflow: overflowOf(r),
        confidence: heading ? headingModel.confidenceOf(r) : 0.9,
      });
    }
  });

  return finalize('pdfjs', rawPages, rawNodes, opts);
}

function fontOf(runs: PdfTextRun[]): FontInfo | null {
  if (runs.length === 0) return null;
  const dominant = [...runs].sort((a, b) => b.charCount - a.charCount)[0] as PdfTextRun;
  return {
    size: dominant.fontSize,
    weight: dominant.bold ? 700 : 400,
    family: dominant.fontName || null,
    italic: dominant.italic,
  };
}
