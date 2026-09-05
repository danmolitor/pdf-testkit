import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '@pdf-testkit/core';
import { node, snapshot } from './helpers';

/**
 * Found on element-moved's first CI run (forme, 2026-09-06): the dogfood
 * invoice's root container grew 112pt taller with its origin pinned at
 * (54,54), and the event reported "container moved 56pt on page 1" —
 * centerDistance reads half the height delta as movement. A resize and a
 * move are different findings: one says content grew, the other says
 * layout shifted. Telling the wrong story is worse than telling none.
 */
describe('resize vs move discrimination', () => {
  it('a pure resize is element-resized, not element-moved', () => {
    // The dogfood shape: origin fixed, height +112.
    const a = snapshot([node({ id: '0:container:0', role: 'container', text: null, bbox: { x: 54, y: 54, width: 487.3, height: 223.2 } })]);
    const b = snapshot([node({ id: '0:container:0', role: 'container', text: null, bbox: { x: 54, y: 54, width: 487.3, height: 335.2 } })]);
    const r = diffSnapshots(a, b);
    const resized = r.events.find((e) => e.type === 'element-resized');
    expect(resized).toBeDefined();
    expect(resized!.message).toMatch(/grew 112pt taller on page 1/);
    expect(r.events.some((e) => e.type === 'element-moved')).toBe(false);
  });

  it('a pure move stays element-moved', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'band', bbox: { x: 216, y: 13, width: 163, height: 13 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'band', bbox: { x: 216, y: 38, width: 163, height: 13 } })]);
    const r = diffSnapshots(a, b);
    expect(r.events.some((e) => e.type === 'element-moved')).toBe(true);
    expect(r.events.some((e) => e.type === 'element-resized')).toBe(false);
  });

  it('an element that both moves and resizes reports both', () => {
    const a = snapshot([node({ id: '0:container:0', role: 'container', text: null, bbox: { x: 54, y: 54, width: 200, height: 100 } })]);
    const b = snapshot([node({ id: '0:container:0', role: 'container', text: null, bbox: { x: 154, y: 54, width: 200, height: 250 } })]);
    const r = diffSnapshots(a, b);
    expect(r.events.some((e) => e.type === 'element-moved')).toBe(true);
    expect(r.events.some((e) => e.type === 'element-resized')).toBe(true);
  });

  it('shrinking narrower reads as shrank/narrower', () => {
    const a = snapshot([node({ id: '0:cell:0', role: 'cell', text: '$30', bbox: { x: 218, y: 100, width: 158, height: 27 } })]);
    const b = snapshot([node({ id: '0:cell:0', role: 'cell', text: '$30', bbox: { x: 218, y: 100, width: 121, height: 27 } })]);
    const r = diffSnapshots(a, b);
    const ev = r.events.find((e) => e.type === 'element-resized');
    expect(ev).toBeDefined();
    expect(ev!.message).toMatch(/shrank 37pt narrower/);
  });

  it('sub-threshold size jitter does not fire', () => {
    const a = snapshot([node({ id: '0:text:0', text: 'x', bbox: { x: 40, y: 40, width: 100, height: 14 } })]);
    const b = snapshot([node({ id: '0:text:0', text: 'x', bbox: { x: 40, y: 40, width: 108, height: 14 } })]);
    const r = diffSnapshots(a, b);
    expect(r.events.some((e) => e.type === 'element-resized')).toBe(false);
  });
});
