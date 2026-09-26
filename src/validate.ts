import { HuffError } from './errors.js';
import type { DecoderInput, SymbolEntry } from './types.js';

const EOS = 'EOS';
const MIN_SYMBOLS = 2;
const MAX_SYMBOLS = 64;
const MIN_LENGTH = 1;
const MAX_LENGTH = 15;

function isSingleAscii(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length === 1 &&
    s.charCodeAt(0) >= 0x20 &&
    s.charCodeAt(0) <= 0x7e
  );
}

function validateSymbols(raw: unknown): SymbolEntry[] {
  if (!Array.isArray(raw)) {
    throw new HuffError('INVALID_INPUT', '"symbols" must be an array', 0);
  }
  if (raw.length < MIN_SYMBOLS || raw.length > MAX_SYMBOLS) {
    throw new HuffError(
      'INVALID_INPUT',
      `"symbols" must contain ${MIN_SYMBOLS}–${MAX_SYMBOLS} entries, got ${raw.length}`,
      0,
    );
  }

  const entries: SymbolEntry[] = [];
  const seen = new Set<string>();
  let eosCount = 0;

  raw.forEach((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new HuffError('INVALID_INPUT', `symbols[${i}] must be an object`, 0);
    }
    const { symbol, length } = item as Record<string, unknown>;

    if (symbol === EOS) {
      eosCount++;
    } else if (!isSingleAscii(symbol)) {
      throw new HuffError(
        'INVALID_INPUT',
        `symbols[${i}].symbol must be a single printable ASCII character ` +
          `(space–~); the only multi-character symbol allowed is "EOS"`,
        0,
      );
    }

    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < MIN_LENGTH ||
      length > MAX_LENGTH
    ) {
      throw new HuffError(
        'INVALID_INPUT',
        `symbols[${i}].length must be an integer in ${MIN_LENGTH}–${MAX_LENGTH}, got ${String(length)}`,
        0,
      );
    }

    if (seen.has(symbol as string)) {
      throw new HuffError(
        'INVALID_INPUT',
        `duplicate symbol ${JSON.stringify(symbol)} at symbols[${i}]`,
        0,
      );
    }
    seen.add(symbol as string);
    entries.push({ symbol: symbol as string, length });
  });

  if (eosCount !== 1) {
    throw new HuffError(
      'INVALID_INPUT',
      `exactly one symbol must be "EOS", found ${eosCount}`,
      0,
    );
  }

  return entries;
}

function validateBlocks(raw: unknown): { blocks: string[]; totalStreamBits: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HuffError('INVALID_INPUT', '"blocks" must be a non-empty array of hex strings', 0);
  }

  let totalBytes = 0;
  const blocks: string[] = [];
  raw.forEach((b, i) => {
    if (typeof b !== 'string' || !/^[0-9a-fA-F]*$/.test(b) || b.length % 2 !== 0) {
      throw new HuffError(
        'INVALID_INPUT',
        `blocks[${i}] must be an even-length hex string (e.g. "8b9f")`,
        0,
      );
    }
    blocks.push(b);
    totalBytes += b.length / 2;
  });

  return { blocks, totalStreamBits: totalBytes * 8 };
}

/** 校验并归一化 stdin JSON；任何格式问题一律以 INVALID_INPUT（偏移 0）报出。 */
export function validateInput(raw: unknown): DecoderInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HuffError('INVALID_INPUT', 'input must be a JSON object', 0);
  }
  const obj = raw as Record<string, unknown>;

  const symbols = validateSymbols(obj.symbols);
  const { blocks, totalStreamBits } = validateBlocks(obj.blocks);

  const totalBits = obj.totalBits;
  if (
    typeof totalBits !== 'number' ||
    !Number.isInteger(totalBits) ||
    totalBits < 0
  ) {
    throw new HuffError(
      'INVALID_INPUT',
      '"totalBits" must be a non-negative integer',
      0,
    );
  }
  if (totalBits > totalStreamBits) {
    throw new HuffError(
      'INVALID_INPUT',
      `totalBits (${totalBits}) exceeds the stream size (${totalStreamBits} bits)`,
      0,
    );
  }

  return { symbols, blocks, totalBits };
}
