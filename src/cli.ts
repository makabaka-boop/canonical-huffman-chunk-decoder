#!/usr/bin/env node
import { HuffError } from './errors.js';
import { run } from './run.js';
import type { HuffErrorInfo } from './types.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function fail(info: HuffErrorInfo): never {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: info.error,
      message: info.message,
      bitOffset: info.bitOffset,
    }) + '\n',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const raw = await readStdin();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail({
      error: 'INVALID_INPUT',
      message: `stdin is not valid JSON: ${(err as Error).message}`,
      bitOffset: 0,
    });
  }

  try {
    const result = run(parsed);
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
  } catch (err) {
    if (err instanceof HuffError) {
      fail({ error: err.code, message: err.message, bitOffset: err.bitOffset });
    }
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`internal error: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
});
