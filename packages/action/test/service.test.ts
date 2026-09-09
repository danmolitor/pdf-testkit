import { describe, expect, it } from 'vitest';
import { buildUploadArgs, describeExit } from '../src/service.js';

const base = { documents: 'dist/invoice.pdf\ndist/report.pdf', serviceUrl: 'https://api.example', serviceToken: 'ptk_x', dpi: '', images: '', failOn: '', requireService: '' };

describe('action service mode', () => {
  it('maps inputs to pdf-testkit upload arguments', () => {
    expect(buildUploadArgs(base)).toEqual(['upload', 'dist/invoice.pdf', 'dist/report.pdf', '--service-url', 'https://api.example', '--token', 'ptk_x']);
  });

  it('passes through dpi, no-images, fail-on and require-service', () => {
    expect(buildUploadArgs({ ...base, dpi: '120', images: 'false', failOn: 'warn', requireService: 'true' })).toEqual([
      'upload', 'dist/invoice.pdf', 'dist/report.pdf', '--service-url', 'https://api.example', '--token', 'ptk_x',
      '--dpi', '120', '--no-images', '--fail-on', 'warn', '--require-service',
    ]);
  });

  it('leaves the gate to the service when fail-on is unset', () => {
    expect(buildUploadArgs(base)).not.toContain('--fail-on');
  });

  it('refuses to run without documents or a service url', () => {
    expect(() => buildUploadArgs({ ...base, documents: ' \n' })).toThrow(/documents/);
    expect(() => buildUploadArgs({ ...base, serviceUrl: '' })).toThrow(/service-url/);
  });

  it('explains every exit code', () => {
    expect(describeExit(0)).toBeNull();
    expect(describeExit(1)).toMatch(/gate/);
    expect(describeExit(2)).toMatch(/configuration/);
    expect(describeExit(3)).toMatch(/unavailable/);
  });
});

describe('conformance reports', () => {
  it('passes each report path to --conformance', async () => {
    const { buildUploadArgs } = await import('../src/service.js');
    const args = buildUploadArgs({ documents: 'dist/a.pdf', serviceUrl: 'https://s', serviceToken: 't', dpi: '', images: '', failOn: '', requireService: '', conformance: 'reports/ua1.xml\nreports/*.json' });
    expect(args.slice(args.indexOf('--conformance'))).toEqual(['--conformance', 'reports/ua1.xml', 'reports/*.json']);
  });
});

describe('the Forme layout sidecar', () => {
  const base = { documents: 'dist/a.pdf', serviceUrl: 'https://s', serviceToken: 't', dpi: '', images: '', failOn: '', requireService: '' };
  it('is used by default: no flag', () => {
    expect(buildUploadArgs({ ...base })).not.toContain('--no-layout');
  });
  it('layout: false passes --no-layout', () => {
    expect(buildUploadArgs({ ...base, layout: 'false' })).toContain('--no-layout');
  });
});
