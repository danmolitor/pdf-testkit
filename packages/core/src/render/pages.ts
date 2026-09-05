/**
 * Page-image rendering for the hosted review screen. This is the ONLY place
 * pdf-testkit rasterizes anything, and it runs in the customer's CI: the
 * service never renders a PDF (baseline storage spec §6).
 *
 * pdfjs renders into a canvas; in Node that canvas comes from `@napi-rs/canvas`
 * (prebuilt binaries, no native toolchain), which also encodes WebP. Both are
 * optional peer dependencies loaded lazily, so consumers that never upload
 * images never need them installed.
 */
import { createRequire } from 'node:module';
import { getPdfjs } from '../extract/pdfjs/loadDocument.js';

export interface RenderPagesOptions {
  /** 72..300; the protocol clamps to this range. Default 150. */
  dpi?: number;
  /** WebP quality 1..100. Default 80. */
  quality?: number;
}

export interface RenderedPage {
  /** 0-based, matches `StructuralSnapshot.pages[i].index`. */
  index: number;
  widthPx: number;
  heightPx: number;
  bytes: Uint8Array;
}

export interface RenderedPages {
  /** `pdfjs-<ver>+napi-canvas-<ver>`: two image sets are pixel-comparable only when this matches. */
  rendererId: string;
  dpi: number;
  format: 'image/webp';
  pages: RenderedPage[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCanvasModule = any;
let canvasModule: AnyCanvasModule | undefined;

async function getCanvas(): Promise<AnyCanvasModule> {
  if (canvasModule) return canvasModule;
  try {
    canvasModule = await import(/* @vite-ignore */ '@napi-rs/canvas');
    return canvasModule;
  } catch (err) {
    throw new Error(
      'pdf-testkit: could not load "@napi-rs/canvas", needed to render page images ' +
        `(npm i -D @napi-rs/canvas). Original error: ${String(err)}`,
    );
  }
}

const require = createRequire(import.meta.url);

function packageVersion(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** Where pdfjs finds the 14 standard fonts when a PDF does not embed them. */
function standardFontDataUrl(): string {
  const pkg = require.resolve('pdfjs-dist/package.json');
  return pkg.slice(0, -'package.json'.length) + 'standard_fonts/';
}

export async function renderPages(bytes: Uint8Array, opts: RenderPagesOptions = {}): Promise<RenderedPages> {
  const dpi = opts.dpi ?? 150;
  if (!Number.isInteger(dpi) || dpi < 72 || dpi > 300) {
    throw new Error(`pdf-testkit: dpi must be an integer between 72 and 300 (got ${dpi})`);
  }
  const quality = opts.quality ?? 80;
  const pdfjs = await getPdfjs();
  const { createCanvas } = await getCanvas();

  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    // Rendering, unlike extraction, wants glyphs. Node has no font registry
    // for pdfjs to load faces into, so `disableFontFace: true` makes pdfjs
    // draw every glyph as a vector path from the font program itself —
    // embedded fonts as shipped, non-embedded standard fonts from pdfjs's
    // bundled Foxit set — so output never depends on what the runner has
    // installed. (With faces enabled, Node draws notdef boxes for everything.)
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  }).promise;

  const scale = dpi / 72;
  const pages: RenderedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const widthPx = Math.round(viewport.width);
    const heightPx = Math.round(viewport.height);
    const canvas = createCanvas(widthPx, heightPx);
    const ctx = canvas.getContext('2d');
    // Paper is white; pdfjs paints only what the PDF draws.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, widthPx, heightPx);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const encoded: Buffer = await canvas.encode('webp', quality);
    pages.push({ index: i - 1, widthPx, heightPx, bytes: new Uint8Array(encoded) });
    page.cleanup();
  }
  await doc.destroy();

  return {
    rendererId: `pdfjs-${packageVersion('pdfjs-dist')}+napi-canvas-${packageVersion('@napi-rs/canvas')}`,
    dpi,
    format: 'image/webp',
    pages,
  };
}
