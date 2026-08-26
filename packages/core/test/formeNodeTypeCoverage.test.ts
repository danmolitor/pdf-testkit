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
 * ⚠️ PINNED against @formepdf/core 0.12.1. MANUALLY re-verify this list against
 * `ElementNodeType` in @formepdf/core's src/index.ts whenever the @formepdf/core
 * dependency version bumps — same discipline as the shape guard's version pin.
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
    expect(FORMEPDF_ELEMENT_NODE_TYPES).toHaveLength(31);
  });
});
