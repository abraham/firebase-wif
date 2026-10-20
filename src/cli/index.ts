#!/usr/bin/env node
import { main } from './main.js';

const controller = new AbortController();
process.once('SIGINT', () => {
  controller.abort();
  process.once('SIGINT', () => process.exit(130));
});

process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
