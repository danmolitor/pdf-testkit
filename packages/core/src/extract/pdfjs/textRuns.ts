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
    // Skip whitespace-only items. Some producers (react-pdf, PDFKit, Chrome)
    // emit inter-column space glyphs; if kept, mergeRuns chains through them
    // (word + spaces + word), collapsing a whole table row into one run and
    // erasing the columns table detection needs. Real word spacing is still
    // reconstructed from the inter-run gap below.
    if (it.str.trim().length === 0) continue;
    const t = it.transform;
    const x = t[4] ?? 0;
    const yBottom = t[5] ?? 0;
    const fontSize = Math.hypot(t[2] ?? 0, t[3] ?? 0) || Math.abs(t[3] ?? 0) || it.height || 0;
    const height = it.height || fontSize;
    const width = it.width || 0;
    const fontName = sanitizeFontName(it.fontName ?? '');
    const text = collapseTracked(it.str);
    raw.push({
      x,
      y: viewport.height - (yBottom + height),
      width,
      height,
      text,
      fontSize,
      fontName,
      bold: BOLD_RE.test(fontName),
      italic: ITALIC_RE.test(fontName),
      charCount: text.length,
    });
  }

  return { runs: mergeRuns(raw), width: viewport.width, height: viewport.height };
}

/**
 * pdfjs writes a space into an item wherever two glyphs sit further apart
 * than it expects, so a tracked label arrives as "N O R T H M O O R" in ONE
 * item, spaces included, and no glyph positions survive to tell a letter gap
 * from a word gap. When nearly every space-separated token of an item is a
 * single character (a kerned pair or triple allowed: "A S AT", "S TAT E M E N T"),
 * the spaces are tracking,
 * and the item is the word without them. The cost, accepted: a tracked
 * multi-word label that a producer emits as one item loses its word break
 * ("INDUSTRIAL GROUP" reads "INDUSTRIALGROUP"); it is at least the same on
 * both sides of a diff, which is what node identity needs. (Extraction-
 * fidelity experiment, 2026-09-09, finding P6.)
 */
export function collapseTracked(str: string): string {
  const tokens = str.trim().split(' ');
  if (tokens.length < 3) return str;
  const single = tokens.filter((t) => t.length === 1).length;
  const longest = Math.max(...tokens.map((t) => t.length));
  if (single / tokens.length < 0.6 || longest > 3) return str;
  return tokens.join('');
}

/**
 * Merge same-line, same-size, adjacent items into runs. Two spacing rules:
 *
 * Plain text: a gap above 0.2em between items is a word space.
 *
 * Tracked text: a producer that positions glyphs individually for
 * letter-spacing (Chromium print-to-PDF, takumi-pdf, Forme's tracked labels)
 * hands pdfjs one item per glyph, and the plain rule joined them as
 * "N O R T H M O O R" (extraction-fidelity experiment, 2026-09-09, finding
 * P6). When both sides of a join are short items (one glyph, or a kerned
 * pair), the run's own letter rhythm is the reference: the first such gap
 * under 0.4em sets it, later gaps within it are letters of one word, and a
 * gap well above it (1.8× the rhythm, and at least 0.2em more) is the space
 * between words. A one-letter word before a full word ("a cat") is not a
 * tracked join and keeps the plain rule.
 */
export function mergeRuns(items: PdfTextRun[]): PdfTextRun[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: PdfTextRun[] = [];
  const rhythm = new Map<PdfTextRun, { lastLen: number; gaps: number[] }>();
  for (const it of sorted) {
    const prev = out[out.length - 1];
    const sameLine = prev && Math.abs(prev.y - it.y) <= Math.max(1, prev.height * 0.4);
    const sameFont = prev && Math.abs(prev.fontSize - it.fontSize) <= 0.5;
    const gap = prev ? it.x - (prev.x + prev.width) : Infinity;
    const adjacent = prev && gap <= prev.fontSize * 0.6 && it.x >= prev.x - 0.5;
    if (prev && sameLine && sameFont && adjacent) {
      const r = rhythm.get(prev)!;
      let space: boolean;
      if (r.lastLen <= 2 && it.charCount <= 2) {
        if (r.gaps.length === 0) {
          space = gap > prev.fontSize * 0.4;
        } else {
          const ref = median(r.gaps);
          space = gap > Math.max(ref * 1.8, ref + prev.fontSize * 0.2);
        }
        if (!space) r.gaps.push(gap);
      } else {
        space = gap > prev.fontSize * 0.2;
      }
      prev.text += (space ? ' ' : '') + it.text;
      prev.width = it.x + it.width - prev.x;
      prev.charCount += it.charCount;
      prev.bold = prev.bold || it.bold;
      r.lastLen = it.charCount;
    } else {
      const copy = { ...it };
      out.push(copy);
      rhythm.set(copy, { lastLen: it.charCount, gaps: [] });
    }
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
