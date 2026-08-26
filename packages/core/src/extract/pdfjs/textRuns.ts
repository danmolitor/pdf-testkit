import type { LoadedPdfPage, PdfTextItem } from './loadDocument.js';

/** A merged text run with top-left coordinates and inferred font attributes. */
export interface PdfTextRun {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  charCount: number;
}

const BOLD_RE = /bold|black|semibold|heavy/i;
const ITALIC_RE = /italic|oblique/i;

/**
 * pdfjs names loaded fonts `g_d{docId}_f{n}`, where `docId` is a process-global
 * counter that increments on every `getDocument` call — so the raw name differs
 * between two loads of the same file and would make snapshots non-deterministic.
 * Strip the volatile doc-id segment, keeping the stable per-document font index.
 */
function sanitizeFontName(name: string): string {
  return name.replace(/^g_d\d+_/, 'g_');
}

/**
 * Extract merged text runs from a pdfjs page, converting bottom-left PDF
 * coordinates to the top-left origin the rest of the model uses. pdfjs emits
 * per-glyph-cluster items, so adjacent items on the same baseline are merged
 * into runs to stabilize node identity.
 */
export async function extractTextRuns(
  page: LoadedPdfPage,
): Promise<{ runs: PdfTextRun[]; width: number; height: number }> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items.filter((it): it is PdfTextItem => typeof it?.str === 'string');

  const raw: PdfTextRun[] = [];
  for (const it of items) {
    if (it.str.length === 0) continue;
    const t = it.transform;
    const x = t[4] ?? 0;
    const yBottom = t[5] ?? 0;
    const fontSize = Math.hypot(t[2] ?? 0, t[3] ?? 0) || Math.abs(t[3] ?? 0) || it.height || 0;
    const height = it.height || fontSize;
    const width = it.width || 0;
    const fontName = sanitizeFontName(it.fontName ?? '');
    raw.push({
      x,
      y: viewport.height - (yBottom + height),
      width,
      height,
      text: it.str,
      fontSize,
      fontName,
      bold: BOLD_RE.test(fontName),
      italic: ITALIC_RE.test(fontName),
      charCount: it.str.length,
    });
  }

  return { runs: mergeRuns(raw), width: viewport.width, height: viewport.height };
}

function mergeRuns(items: PdfTextRun[]): PdfTextRun[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: PdfTextRun[] = [];
  for (const it of sorted) {
    const prev = out[out.length - 1];
    const sameLine = prev && Math.abs(prev.y - it.y) <= Math.max(1, prev.height * 0.4);
    const sameFont = prev && Math.abs(prev.fontSize - it.fontSize) <= 0.5;
    const gap = prev ? it.x - (prev.x + prev.width) : Infinity;
    const adjacent = prev && gap <= prev.fontSize * 0.6 && it.x >= prev.x - 0.5;
    if (prev && sameLine && sameFont && adjacent) {
      prev.text += (gap > prev.fontSize * 0.2 ? ' ' : '') + it.text;
      prev.width = it.x + it.width - prev.x;
      prev.charCount += it.charCount;
      prev.bold = prev.bold || it.bold;
    } else {
      out.push({ ...it });
    }
  }
  return out;
}
