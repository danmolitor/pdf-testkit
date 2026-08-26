#!/usr/bin/env node
import { main } from '../dist/cli.js';

main(process.argv).catch((err) => {
  process.stderr.write(`pdf-testkit: ${err?.message ?? err}\n`);
  process.exit(1);
});
