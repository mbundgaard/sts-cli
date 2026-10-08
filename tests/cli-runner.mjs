// Test-only process entry point. Never packaged; production bin/sts.js always
// uses the OS user's application-data directory with no directory override.
import { main } from '../dist/cli.js';
import { StateStore } from '../dist/state.js';
import path from 'node:path';
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute isolated test directory is required');
process.exitCode = await main([process.execPath, 'sts', ...process.argv.slice(3)], new StateStore(directory), async () => {});
