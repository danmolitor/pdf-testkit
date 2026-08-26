import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { FORME_ROLE_BY_NODE_TYPE, FORME_INTENTIONALLY_UNMAPPED } from '@pdf-testkit/core';

/**
 * Sibling tripwire to FormePDF's own ElementNodeType coverage test. Every value
 * of @formepdf/core's `ElementNodeType` union must be given a deliberate
 * disposition in fromFormeLayout — either a role in FORME_ROLE_BY_NODE_TYPE or a
 * reasoned entry in FORME_INTENTIONALLY_UNMAPPED. Nothing may rely on the silent
 * `container` fallthrough.
 *
 * This is a STATIC list check — no rendered document needed. Because pdf-testkit
 * consumes @formepdf/core as an external package (not a shared repo), the union
 * is pinned here as a literal list rather than imported.
 *
 * ⚠️ PINNED against @formepdf/core 0.13.0. This list is now AUTO-VERIFIED against
 * the installed @formepdf/core in the "matches the installed package" test below,
 * so a dependency bump that changes the union fails the build and names exactly
 * what changed — you no longer have to remember to check by hand. Keep the
 * version in this comment in sync when you update the list.
 */
const FORMEPDF_ELEMENT_NODE_TYPES = [
  // Structural containers
  'View',
  'Text',
  'TextLine',
  // Semantic headings (discrete per tag)
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  // Table primitives — no 'Table' wrapper node
  'TableRow',
  'TableCell',
  // Lists
  'List',
  'ListItem',
  'Lbl',
  // Fixed regions
  'FixedHeader',
  'FixedFooter',
  // Navigation marker (zero-height; only emitted when the bookmarked
  // container overflows a page)
  'Bookmark',
  // Media
  'Image',
  'Svg',
  'QrCode',
  'Barcode',
  'Canvas',
  'Watermark',
  // Charts
  'BarChart',
  'LineChart',
  'PieChart',
  'AreaChart',
  'DotPlot',
  // Form fields
  'TextField',
  'Checkbox',
  'Dropdown',
  'RadioButton',
] as const;

describe('FormePDF ElementNodeType coverage', () => {
  it('gives every ElementNodeType a deliberate disposition (mapped or allow-listed)', () => {
    const undispositioned = FORMEPDF_ELEMENT_NODE_TYPES.filter(
      (t) => !(t in FORME_ROLE_BY_NODE_TYPE) && !FORME_INTENTIONALLY_UNMAPPED.has(t),
    );
    expect(
      undispositioned,
      `These @formepdf/core nodeType(s) have no disposition: [${undispositioned.join(', ')}]. ` +
        `Add each to FORME_ROLE_BY_NODE_TYPE with a role, OR to FORME_INTENTIONALLY_UNMAPPED ` +
        `with a one-line reason. Do not let them fall through to the container default.`,
    ).toEqual([]);
  });

  it('has no stale allow-list entries (every unmapped entry is a real union member)', () => {
    const union = new Set<string>(FORMEPDF_ELEMENT_NODE_TYPES);
    const stale = [...FORME_INTENTIONALLY_UNMAPPED].filter((t) => !union.has(t));
    expect(stale, `Allow-listed nodeType(s) not in the pinned union: [${stale.join(', ')}]`).toEqual([]);
  });

  it('pins exactly the expected union size (guards against silent list edits)', () => {
    expect(FORMEPDF_ELEMENT_NODE_TYPES).toHaveLength(32);
  });
});

/**
 * Automatic drift check: read the ACTUAL `ElementNodeType` union from the
 * installed @formepdf/core (a devDependency) and compare it to the pinned list.
 * This turns the version pins (this list, the comment, the shape guard's
 * comment) from "someone must remember to re-check on a bump" into "the build
 * fails and tells you exactly what changed" — the same manual→automatic move
 * used elsewhere (e.g. the coverage test above).
 */
describe('FormePDF ElementNodeType — installed-vs-pinned drift check', () => {
  const installed = readInstalledElementNodeType();

  it('pinned union matches the installed @formepdf/core exactly', () => {
    const pinned = new Set<string>(FORMEPDF_ELEMENT_NODE_TYPES);
    const actual = new Set(installed.values);
    const addedUpstream = [...actual].filter((v) => !pinned.has(v)); // new in @formepdf/core
    const removedUpstream = [...pinned].filter((v) => !actual.has(v)); // gone from @formepdf/core
    expect(
      { addedUpstream, removedUpstream },
      `@formepdf/core@${installed.version} ElementNodeType has drifted from the pinned list.\n` +
        `  Added upstream (need a disposition):   [${addedUpstream.join(', ')}]\n` +
        `  Removed upstream (drop from the pin):  [${removedUpstream.join(', ')}]\n` +
        `Fix: update FORMEPDF_ELEMENT_NODE_TYPES + its version comment to ${installed.version}, ` +
        `give any new type a role in FORME_ROLE_BY_NODE_TYPE (or add it to ` +
        `FORME_INTENTIONALLY_UNMAPPED with a reason), then update the shape-guard version comment.`,
    ).toEqual({ addedUpstream: [], removedUpstream: [] });
  });
});

describe('drift-check parser fails loudly on @formepdf/core restructuring', () => {
  it('parses a valid single-line union', () => {
    expect(extractElementNodeType(`export type ElementNodeType = 'View' | 'Text' | 'H1';`, 'x')).toEqual([
      'View',
      'Text',
      'H1',
    ]);
  });

  it('parses a valid multi-line union', () => {
    expect(extractElementNodeType(`export type ElementNodeType =\n  | 'View'\n  | 'Text';`, 'x')).toEqual([
      'View',
      'Text',
    ]);
  });

  it('throws if the union is converted to an enum', () => {
    expect(() =>
      extractElementNodeType(`export enum ElementNodeType { View = 'View', Text = 'Text' }`, 'x'),
    ).toThrow(/Could not find/);
  });

  it('throws if the type is moved / only re-exported from index', () => {
    expect(() => extractElementNodeType(`export { ElementNodeType } from './model';`, 'x')).toThrow(
      /Could not find/,
    );
  });

  it('throws (never passes vacuously) if a format change yields zero literals', () => {
    // e.g. switched to double quotes — the outer regex still matches, but the
    // literal extractor finds nothing. Must be reported as a parser failure.
    expect(() =>
      extractElementNodeType(`export type ElementNodeType = "View" | "Text";`, 'x'),
    ).toThrow(/PARSER failure/);
  });
});

/**
 * Pure parser for the ElementNodeType union body (type-only in @formepdf/core, so
 * there's no runtime array to import). Kept separate + pure so its own failure
 * modes are unit-tested below — a drift-checker that can silently parse zero
 * types and pass vacuously is the exact failure shape this project hunts.
 *
 * Fails LOUDLY and specifically on: the type being renamed/moved/converted to an
 * enum (regex miss), and on a format change that yields zero literals (e.g. a
 * switch to double quotes) — the latter is a parser failure, NOT an empty union,
 * so it must not be mistaken for "@formepdf removed everything".
 */
export function extractElementNodeType(dts: string, sourceLabel: string): string[] {
  const m = /export type ElementNodeType\s*=\s*([\s\S]*?);/.exec(dts);
  if (!m) {
    throw new Error(
      `Could not find "export type ElementNodeType = ..." in ${sourceLabel}. It may have been ` +
        `renamed, moved to another file, or changed from a type alias (e.g. to an enum). Verify ` +
        `@formepdf/core manually and update this parser + the pinned list together.`,
    );
  }
  const values = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
  if (values.length === 0) {
    throw new Error(
      `Found "export type ElementNodeType" in ${sourceLabel} but parsed 0 string-literal members. ` +
        `This is a PARSER failure (likely a format change such as quote style), not an empty union. ` +
        `Verify @formepdf/core manually and update this parser.`,
    );
  }
  return values;
}

/** Read + parse the ElementNodeType union from the installed @formepdf/core. */
function readInstalledElementNodeType(): { version: string; values: string[] } {
  const require = createRequire(import.meta.url);
  let main: string;
  try {
    main = require.resolve('@formepdf/core');
  } catch {
    throw new Error(
      '@formepdf/core is not installed. It is a devDependency used to auto-verify the pinned ' +
        'ElementNodeType union against the real package. Run `npm install`.',
    );
  }
  const dtsPath = main.replace(/\.[cm]?js$/, '.d.ts');
  let dts: string;
  let pkg: { version: string };
  try {
    pkg = JSON.parse(readFileSync(join(dirname(dirname(main)), 'package.json'), 'utf8'));
    dts = readFileSync(dtsPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read @formepdf/core types at ${dtsPath} (${(err as Error).message}). The package ` +
        `layout may have changed; verify manually and update this parser.`,
    );
  }
  return { version: pkg.version, values: extractElementNodeType(dts, dtsPath) };
}
