import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { diffSnapshots, groupEvents, serializeSnapshot, type DiffOptions } from '@pdf-testkit/core';
import { loadAsSnapshot } from './load.js';
import { formatHuman, shouldFail, type FailOn } from './format.js';

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
    .version('0.1.0');

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

  return program;
}

function normalizeFailOn(value: string | undefined): FailOn {
  return value === 'warn' || value === 'any' ? value : 'error';
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}
