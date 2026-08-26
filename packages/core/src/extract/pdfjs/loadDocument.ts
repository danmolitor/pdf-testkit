/**
 * The single most fragile integration point in the codebase: loading pdfjs in a
 * Node context without a worker or DOM. Kept deliberately small and isolated so
 * the rest of the extractor never touches pdfjs internals. `pdfjs-dist` is an
 * optional peer dep, loaded lazily via a non-literal specifier so consumers that
 * only diff FormePDF `LayoutInfo` never need it installed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPdfjs = any;

let cached: AnyPdfjs | undefined;

async function getPdfjs(): Promise<AnyPdfjs> {
  if (cached) return cached;
  const candidates = ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist'];
  let lastErr: unknown;
  for (const spec of candidates) {
    try {
      // Non-literal specifier: keeps TS from statically resolving an optional dep.
      const mod = (await import(/* @vite-ignore */ spec)) as AnyPdfjs;
      cached = mod.getDocument ? mod : mod.default;
      if (cached?.getDocument) return cached;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    'pdf-testkit: could not load "pdfjs-dist". Install it to diff non-FormePDF PDFs ' +
      `(npm i pdfjs-dist). Original error: ${String(lastErr)}`,
  );
}

export interface LoadedPdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface LoadedPdf {
  numPages: number;
  getPage(pageNumber: number): Promise<LoadedPdfPage>;
}

export async function loadDocument(data: Uint8Array): Promise<LoadedPdf> {
  const pdfjs = await getPdfjs();
  // In Node, the legacy build runs on the main thread via a built-in fake
  // worker when workerSrc is left unset — so we deliberately don't touch
  // GlobalWorkerOptions here (setting it to undefined fails pdfjs's validation).
  const task = pdfjs.getDocument({
    // pdfjs transfers (detaches) the `data` buffer to its worker; copy so the
    // caller's Uint8Array stays usable and re-extraction never crashes.
    data: data.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0, // errors only
  });
  return (await task.promise) as LoadedPdf;
}
