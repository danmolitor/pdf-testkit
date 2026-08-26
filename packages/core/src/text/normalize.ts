/**
 * Text normalization used both when building snapshots (`normText`) and when
 * matching nodes across snapshots. Collapsing whitespace + lowercasing is what
 * makes trivial whitespace/case edits read as *unchanged* — a core promise of
 * the tool (see the negative-direction diff tests).
 */
export function normalizeText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  return collapsed.length === 0 ? null : collapsed;
}

/** Short single-line preview of a node's text for event messages. */
export function textPreview(raw: string | null | undefined, max = 40): string {
  if (!raw) return '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

/**
 * Similarity in [0,1] between two normalized strings, using token-set Jaccard
 * blended with a length-normalized Levenshtein ratio. Used by the fuzzy match
 * stage to treat a minor text edit (a changed number) as a modification of the
 * same node rather than remove+add.
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const jac = jaccard(tokens(a), tokens(b));
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(0, 0.5 * jac + 0.5 * lev);
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] as number) + 1;
      const ins = (curr[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] as number;
}
