import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchConformanceToDocuments, parseConformanceReport } from '@pdf-testkit/core';

const fx = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/conformance/${name}`, import.meta.url)), 'utf8');

/**
 * Real veraPDF 1.30.2 output, not hand-written: a passing UA-1 file, a failing
 * one, a PDF/A-2b failure, a parse error, a directory report, in XML and JSON.
 * The parser records what the validator said, attributed to it; it never
 * validates, and it never rejects a profile it does not recognise.
 */
describe('veraPDF reports', () => {
  it('a passing file: verdict pass, profile normalised to its short name, tool and version from the report', () => {
    const r = parseConformanceReport(fx('verapdf-ua1-pass.xml'), { file: 'ua1.xml' });
    expect(r.format).toBe('verapdf-mrr-xml');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ path: 'dist/review/statement-ua.pdf', result: { profile: 'PDF/UA-1', verdict: 'pass', tool: { name: 'veraPDF', version: '1.30.2' }, failure_count: 0, failures: [], source: { format: 'verapdf-mrr-xml', file: 'ua1.xml' } } });
    expect(r.items[0]!.result.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a failing file: verdict fail, one failure per failed rule with clause, test, count and description', () => {
    const r = parseConformanceReport(fx('verapdf-ua1-fail.xml'), { file: 'ua1.xml' });
    const res = r.items[0]!.result;
    expect(res.verdict).toBe('fail');
    expect(res.failure_count).toBe(7);
    expect(res.failures).toHaveLength(7);
    expect(res.failures[0]).toMatchObject({ clause: '7.2', test: 34, count: 38 });
    expect(res.failures[0]!.description.length).toBeGreaterThan(10);
  });

  it('the JSON format carries the same facts', () => {
    const xml = parseConformanceReport(fx('verapdf-ua1-fail.xml')).items[0]!.result;
    const json = parseConformanceReport(fx('verapdf-ua1-fail.json')).items[0]!.result;
    expect(json.verdict).toBe(xml.verdict);
    expect(json.profile).toBe(xml.profile);
    expect(json.failure_count).toBe(xml.failure_count);
    expect(json.failures.map((f) => f.clause).sort()).toEqual(xml.failures.map((f) => f.clause).sort());
    expect(json.source.format).toBe('verapdf-json');
  });

  it('a file the validator could not parse is an error, not a fail', () => {
    const r = parseConformanceReport(fx('verapdf-ua1-error.xml'));
    expect(r.items[0]).toMatchObject({ path: 'dist/review/broken.pdf', result: { verdict: 'error', failure_count: 0 } });
    expect(r.items[0]!.result.failures).toEqual([]);
  });

  it('a directory report is many items, each with its own verdict', () => {
    const r = parseConformanceReport(fx('verapdf-ua1-multi.xml'));
    const byPath = Object.fromEntries(r.items.map((i) => [i.path, i.result.verdict]));
    expect(byPath).toEqual({ 'dist/review/pdfkit-invoice.pdf': 'fail', 'dist/review/statement-ua.pdf': 'pass', 'dist/review/broken.pdf': 'error' });
  });

  it('other profiles: PDF/A-2b comes out as its short name', () => {
    expect(parseConformanceReport(fx('verapdf-2b-fail.xml')).items[0]!.result.profile).toBe('PDF/A-2b');
  });

  it('a profile it does not recognise is recorded as reported, not rejected', () => {
    const xml = fx('verapdf-ua1-pass.xml').replace('profileName="PDF/UA-1 validation profile"', 'profileName="WTPDF 1.0 validation profile"');
    expect(parseConformanceReport(xml).items[0]!.result.profile).toBe('WTPDF 1.0');
  });

  it('failures are capped at 200 with the count uncapped, descriptions at 300 characters', () => {
    const one = '<rule specification="x" clause="9.9" testNumber="1" status="failed" failedChecks="1" tags="t"><description>' + 'd'.repeat(500) + '</description></rule>';
    const xml = fx('verapdf-ua1-fail.xml').replace('<details ', '<details data-x="1" ').replace(/<rule\b[\s\S]*?<\/rule>/g, '').replace('</details>', one.repeat(250) + '</details>');
    const res = parseConformanceReport(xml).items[0]!.result;
    expect(res.failure_count).toBe(250);
    expect(res.failures).toHaveLength(200);
    expect(res.failures[0]!.description).toHaveLength(300);
  });
});

describe('the documented JSON shape (the escape hatch for every other validator)', () => {
  it('is accepted verbatim and attributed to the tool it names', () => {
    const doc = { format: 'forme-review-conformance/1', documents: { 'docs/invoice.pdf': [{ profile: 'EN 16931', verdict: 'fail', tool: { name: 'Mustang', version: '2.16.0' }, ran_at: null, source: { format: 'mustang-adapter', file: null }, failure_count: 1, failures: [{ clause: 'BR-CO-10', test: null, count: 1, description: 'Sum of line net amounts does not match' }] }] } };
    const r = parseConformanceReport(JSON.stringify(doc), { file: 'conformance.json' });
    expect(r.format).toBe('forme-review-conformance/1');
    expect(r.items).toEqual([{ path: 'docs/invoice.pdf', result: { ...doc.documents['docs/invoice.pdf']![0], source: { format: 'mustang-adapter', file: 'conformance.json' } } }]);
  });
});

describe('malformed input', () => {
  it('neither veraPDF nor the documented shape is a configuration error with a reason', () => {
    expect(() => parseConformanceReport('<html>nope</html>')).toThrow(/not a veraPDF report or a Forme Review conformance file/);
    expect(() => parseConformanceReport('{"format":"forme-review-conformance/1","documents":{"a.pdf":[{"profile":"x"}]}}')).toThrow(/verdict/);
  });
});

describe('matching results to uploaded documents', () => {
  it('exact path first, then basename, and names what it could not match', () => {
    const items = parseConformanceReport(fx('verapdf-ua1-multi.xml')).items;
    const m = matchConformanceToDocuments(items, ['dist/review/pdfkit-invoice.pdf', 'out/statement-ua.pdf', 'docs/other.pdf']);
    expect(Object.keys(m.byDocument).sort()).toEqual(['dist/review/pdfkit-invoice.pdf', 'out/statement-ua.pdf']);
    expect(m.unmatched).toEqual(['dist/review/broken.pdf']);
  });
});
