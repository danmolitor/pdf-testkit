import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { diffSnapshots, groupEvents, serializeSnapshot, type DiffOptions } from '@pdf-testkit/core';
import { loadAsSnapshot } from './load.js';
import { formatHuman, shouldFail, type FailOn } from './format.js';
import { renderPagesToDir } from './renderPages.js';
import { checkDeterminism, formatDeterminism, parseClockOffset } from './determinism.js';
import { CLI_VERSION, runUpload } from './upload.js';
import { resolveContext } from './service/context.js';
import { EXIT } from './exit.js';

export { EXIT };

/**
 * Build the CLI program. `snapshot` extracts a structural snapshot; `diff`
 * compares two inputs (PDF or snapshot) and reports semantic events. Exit code
 * is the machine contract: 0 = clean (or below the fail gate), 1 = regression.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('pdf-testkit')
    .description('Semantic regression testing for generated PDFs')
    .version(CLI_VERSION);

  program
    .command('snapshot')
    .description('Extract a structural snapshot from a PDF (or convert a LayoutInfo JSON)')
    .argument('<input>', 'path to a .pdf or a LayoutInfo .json')
    .option('-o, --out <file>', 'write the snapshot JSON to a file instead of stdout')
    .option('--json', 'force JSON to stdout (default when --out is omitted)')
    .action(async (input: string, opts: { out?: string; json?: boolean }) => {
      const snapshot = await loadAsSnapshot(input);
      const json = serializeSnapshot(snapshot);
      if (opts.out) {
        await writeFile(opts.out, json + '\n', 'utf8');
        process.stderr.write(`wrote snapshot: ${opts.out}\n`);
      } else {
        process.stdout.write(json + '\n');
      }
    });

  program
    .command('diff')
    .description('Diff two inputs (each a .pdf or a snapshot/LayoutInfo .json)')
    .argument('<a>', 'baseline (.pdf or .json)')
    .argument('<b>', 'new run (.pdf or .json)')
    .option('--json', 'emit the DiffResult as JSON to stdout')
    .option('-v, --verbose', 'list every event instead of grouping related ones')
    .option('--min-confidence <n>', 'drop events below this confidence (0..1)', parseFloat)
    .option('--threshold <pts>', 'on-page movement (pts) that counts as a move', parseFloat)
    .option('--fail-on <level>', 'error | warn | any', 'error')
    .action(
      async (
        a: string,
        b: string,
        opts: { json?: boolean; verbose?: boolean; minConfidence?: number; threshold?: number; failOn?: string },
      ) => {
        const [sa, sb] = await Promise.all([loadAsSnapshot(a), loadAsSnapshot(b)]);
        const diffOpts: DiffOptions = {};
        if (opts.minConfidence != null) diffOpts.minConfidence = opts.minConfidence;
        if (opts.threshold != null) diffOpts.positionThresholdPts = opts.threshold;
        const result = diffSnapshots(sa, sb, diffOpts);

        // --json stays the full per-element list unconditionally: it is the
        // machine contract, and grouping is presentation.
        if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        else {
          const groups = opts.verbose ? null : groupEvents(sa, sb, result.events, diffOpts);
          process.stdout.write(formatHuman(result, a, b, groups) + '\n');
        }

        const failOn = normalizeFailOn(opts.failOn);
        if (shouldFail(result, failOn)) process.exitCode = 1;
      },
    );

  program
    .command('render-pages')
    .description('Render every page of a PDF to WebP images (for upload to the review service)')
    .argument('<pdf>', 'path to a .pdf')
    .requiredOption('-o, --out <dir>', 'directory to write page-<n>.webp into')
    .option('--dpi <n>', 'render resolution, 72..300', (v) => parseInt(v, 10), 150)
    .option('--quality <n>', 'WebP quality, 1..100', (v) => parseInt(v, 10), 80)
    .option('--json', 'print the page manifest as JSON to stdout')
    .action(async (pdf: string, opts: { out: string; dpi: number; quality: number; json?: boolean }) => {
      let manifest;
      try {
        manifest = await renderPagesToDir(pdf, opts.out, { dpi: opts.dpi, quality: opts.quality });
      } catch (err) {
        process.stderr.write(`pdf-testkit: ${(err as Error).message}\n`);
        process.exitCode = EXIT.config;
        return;
      }
      if (opts.json) process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
      else {
        process.stderr.write(`rendered ${manifest.pages.length} page(s) at ${manifest.dpi} dpi with ${manifest.rendererId} → ${opts.out}\n`);
      }
    });

  program
    .command('check-determinism')
    .description('Render a fixture twice via your own command and report any node whose extracted value differs')
    .argument('<output>', 'the .pdf (or LayoutInfo/snapshot .json) your command writes')
    .requiredOption('--cmd <command>', 'shell command that renders the fixture to <output>')
    .option('--clock-offset <duration>', 'shift the second render\'s clock, e.g. 26h (Node producers only)')
    .option('--json', 'emit the report as JSON to stdout')
    .action(async (output: string, opts: { cmd: string; clockOffset?: string; json?: boolean }) => {
      let clockOffsetMs = 0;
      try {
        if (opts.clockOffset) clockOffsetMs = parseClockOffset(opts.clockOffset);
      } catch (err) {
        process.stderr.write(`pdf-testkit: ${(err as Error).message}\n`);
        process.exitCode = EXIT.config;
        return;
      }
      let report;
      try {
        report = await checkDeterminism({ cmd: opts.cmd, outPath: output, clockOffsetMs });
      } catch (err) {
        process.stderr.write(`pdf-testkit: ${(err as Error).message}\n`);
        process.exitCode = EXIT.config;
        return;
      }
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else process.stdout.write(formatDeterminism(report, opts.cmd) + '\n');
      if (!report.deterministic) process.exitCode = EXIT.gate;
    });

  program
    .command('upload')
    .description('Report this CI run\'s documents to the pdf-testkit review service (PROTOCOL.md)')
    .argument('<documents...>', 'paths to the .pdf files (or LayoutInfo/snapshot .json) this job produced')
    .option('--service-url <url>', 'service base URL (or PDF_TESTKIT_SERVICE_URL)')
    .option('--token <token>', 'per-repository CI token (or PDF_TESTKIT_TOKEN)')
    .option('--dpi <n>', 'page image resolution, 72..300', (v) => parseInt(v, 10), 150)
    .option('--no-images', 'upload structure only; render no page images')
    .option('--fail-on <level>', 'also fail THIS command when the outcome is blocked at error | warn | any (default: the service check is the gate)')
    .option('--require-service', 'fail (exit 3) instead of passing when the service is unreachable')
    .option('--repo <owner/name>', 'override the repository (auto on GitHub Actions)')
    .option('--commit <sha>', 'override the head commit')
    .option('--branch <name>', 'override the branch')
    .option('--pr <number>', 'override the pull request number', (v) => parseInt(v, 10))
    .option('--pr-base <branch>', 'the PR base branch when --pr is given')
    .option('--run-id <id>', 'override the CI run id')
    .option('--run-attempt <n>', 'override the CI run attempt', (v) => parseInt(v, 10))
    .option('--actor <login>', 'override the triggering actor')
    .option('--json', 'print the upload result as JSON to stdout')
    .action(async (documents: string[], opts: Record<string, unknown>) => {
      const serviceUrl = (opts.serviceUrl as string | undefined) ?? process.env.PDF_TESTKIT_SERVICE_URL;
      const token = (opts.token as string | undefined) ?? process.env.PDF_TESTKIT_TOKEN;
      if (!serviceUrl || !token) {
        process.stderr.write('pdf-testkit: --service-url and --token are required (or PDF_TESTKIT_SERVICE_URL / PDF_TESTKIT_TOKEN)\n');
        process.exitCode = EXIT.config;
        return;
      }
      const failOnRaw = opts.failOn as string | undefined;
      if (failOnRaw && !['error', 'warn', 'any'].includes(failOnRaw)) {
        process.stderr.write(`pdf-testkit: --fail-on must be error | warn | any (got ${failOnRaw})\n`);
        process.exitCode = EXIT.config;
        return;
      }
      let context;
      try {
        context = resolveContext(process.env, {
          repo: opts.repo as string | undefined,
          commit: opts.commit as string | undefined,
          branch: opts.branch as string | undefined,
          pr: opts.pr as number | undefined,
          prBase: opts.prBase as string | undefined,
          runId: opts.runId as string | undefined,
          runAttempt: opts.runAttempt as number | undefined,
          actor: opts.actor as string | undefined,
        });
      } catch (err) {
        process.stderr.write(`pdf-testkit: ${(err as Error).message}\n`);
        process.exitCode = EXIT.config;
        return;
      }
      const result = await runUpload({
        documents,
        serviceUrl,
        token,
        context,
        dpi: opts.dpi as number,
        images: opts.images !== false,
        failOn: (failOnRaw as 'error' | 'warn' | 'any' | undefined) ?? null,
        requireService: Boolean(opts.requireService),
      });
      if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.exitCode;
    });

  return program;
}

function normalizeFailOn(value: string | undefined): FailOn {
  return value === 'warn' || value === 'any' ? value : 'error';
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}
