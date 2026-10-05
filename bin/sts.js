#!/usr/bin/env node
import { main } from '../dist/cli.js';
// A downstream consumer closing a pipe is not a reason to print a stack trace.
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(0);
  console.error(`sts: stdout failed: ${error.message}`);
  process.exit(1);
});
process.exitCode = await main(process.argv);
