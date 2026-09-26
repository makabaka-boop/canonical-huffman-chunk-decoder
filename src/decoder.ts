import { bitAt, parseHexBlocks } from "./bitstream.js";
import { DecodeFailure, fail, type ErrorInfo } from "./errors.js";
import {
  EOS,
  MAX_LENGTH,
  MAX_SYMBOLS,
  MIN_LENGTH,
  MIN_SYMBOLS,
  buildCodeTable,
  isValidSymbolName,
  type CodeEntry,
  type SymbolLength,
} from "./symbols.js";

/** 一个符号在比特流中的位置：[start, end)，end 为开区间（= start + 码长）。 */
export interface Span {
  symbol: string;
  start: number;
  end: number;
}

export interface CodeTableEntry {
  symbol: string;
  length: number;
  code: string;
}

export interface DecodeSuccess {
  ok: true;
  /** 解码出的符号序列，最后一个必为 EOS */
  symbols: string[];
  /** 每个符号的起止全局位偏移 [start, end) */
  spans: Span[];
  /** 按规范顺序重建的码表 */
  codeTable: CodeTableEntry[];
  totalBits: number;
}

export interface DecodeErrorResult {
  ok: false;
  error: ErrorInfo;
}

export type DecodeResult = DecodeSuccess | DecodeErrorResult;

interface ParsedInput {
  symbols: SymbolLength[];
  blocks: unknown;
  totalBits: unknown;
}

/** 解码入口：任何失败都以 { ok: false, error } 整份返回，绝不部分输出。 */
export function decode(input: unknown): DecodeResult {
  try {
    return decodeOrThrow(input);
  } catch (err) {
    if (err instanceof DecodeFailure) return { ok: false, error: err.info };
    throw err;
  }
}

function decodeOrThrow(input: unknown): DecodeSuccess {
  const spec = parseInput(input);

  // 1. 码表：缺 EOS、超额订码在解码前检出（全局位偏移记 0）。
  const table = buildCodeTable(spec.symbols);

  // 2. 比特流结构：块拼接、声明的有效总位数不得超过实际传输位数。
  const bytes = parseHexBlocks(spec.blocks);
  const capacity = bytes.length * 8;
  const totalBits = spec.totalBits;
  if (typeof totalBits !== "number" || !Number.isInteger(totalBits) || totalBits < 0) {
    fail("INVALID_INPUT", '"bitstream.totalBits" must be a non-negative integer', null);
  }
  if (totalBits > capacity) {
    fail(
      "BITSTREAM_TOO_SHORT",
      `declared totalBits ${totalBits} exceeds the ${capacity} transmitted bits`,
      capacity,
    );
  }

  // 3. 跨块连续解码，直到唯一的 EOS 或有效位耗尽。
  const spans = decodeSpans(bytes, totalBits, table);

  // 4. EOS 必须恰好落在有效位末端。
  const last = spans.at(-1);
  if (last === undefined || last.symbol !== EOS) {
    fail(
      "MISSING_EOS",
      `valid bits exhausted at offset ${totalBits} before any EOS codeword was decoded`,
      totalBits,
    );
  }
  if (last.end !== totalBits) {
    fail(
      "EXTRA_BITS",
      `EOS ends at bit ${last.end} but ${totalBits - last.end} extra valid bit(s) remain`,
      last.end,
    );
  }

  // 5. 以上全部通过后，末字节无效填充位必须全为零。
  checkPadding(bytes, totalBits);

  return {
    ok: true,
    symbols: spans.map((s) => s.symbol),
    spans,
    codeTable: table.map(({ symbol, length, code }) => ({ symbol, length, code })),
    totalBits,
  };
}

function parseInput(input: unknown): ParsedInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_INPUT", "input must be a JSON object", null);
  }
  const root = input as Record<string, unknown>;

  const rawSymbols = root["symbols"];
  if (!Array.isArray(rawSymbols)) {
    fail("INVALID_INPUT", '"symbols" must be an array', null);
  }
  if (rawSymbols.length < MIN_SYMBOLS || rawSymbols.length > MAX_SYMBOLS) {
    fail(
      "INVALID_INPUT",
      `"symbols" must contain ${MIN_SYMBOLS}..${MAX_SYMBOLS} entries, got ${rawSymbols.length}`,
      null,
    );
  }
  const seen = new Set<string>();
  const symbols: SymbolLength[] = rawSymbols.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail("INVALID_INPUT", `symbols[${i}] must be an object`, null);
    }
    const entry = raw as Record<string, unknown>;
    const symbol = entry["symbol"];
    if (!isValidSymbolName(symbol)) {
      fail(
        "INVALID_INPUT",
        `symbols[${i}].symbol must be a single ASCII character or the reserved name "EOS"`,
        null,
      );
    }
    if (seen.has(symbol)) {
      fail("INVALID_INPUT", `duplicate symbol ${JSON.stringify(symbol)}`, null);
    }
    seen.add(symbol);
    const length = entry["length"];
    if (typeof length !== "number" || !Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
      fail(
        "INVALID_INPUT",
        `symbols[${i}].length must be an integer in ${MIN_LENGTH}..${MAX_LENGTH}`,
        null,
      );
    }
    return { symbol, length };
  });
  if (!seen.has(EOS)) {
    fail("MISSING_EOS", 'symbol table must contain the reserved "EOS" symbol', 0);
  }

  const bitstream = root["bitstream"];
  if (typeof bitstream !== "object" || bitstream === null || Array.isArray(bitstream)) {
    fail("INVALID_INPUT", '"bitstream" must be an object', null);
  }
  const bs = bitstream as Record<string, unknown>;
  return { symbols, blocks: bs["blocks"], totalBits: bs["totalBits"] };
}

/**
 * 在整条比特流上连续解码（绝不按块重启查表，否则跨块边界的码字
 * 会被误判成另一个符号）。逐位累积当前码字，每读一位：
 *  - 命中某个完整码字 → 记一个符号，重新累积；
 *  - 否则若已不再是任何码字的前缀 → NO_VALID_PREFIX，报当前位；
 *  - 有效位在码字中途耗尽 → 退出循环，由上层报 MISSING_EOS。
 */
function decodeSpans(bytes: Uint8Array, totalBits: number, table: CodeEntry[]): Span[] {
  const maxLength = Math.max(...table.map((e) => e.length));
  const codewords = new Map<string, string>();
  const prefixes = new Set<string>();
  for (const e of table) {
    codewords.set(`${e.length}:${e.value}`, e.symbol);
    for (let l = 1; l <= e.length; l++) {
      prefixes.add(`${l}:${e.value >> (e.length - l)}`);
    }
  }

  const spans: Span[] = [];
  let pos = 0;
  while (pos < totalBits) {
    const start = pos;
    let value = 0;
    let length = 0;
    let matched: string | undefined;
    while (pos < totalBits && length < maxLength) {
      value = (value << 1) | bitAt(bytes, pos);
      length += 1;
      pos += 1;
      const hit = codewords.get(`${length}:${value}`);
      if (hit !== undefined) {
        matched = hit;
        break;
      }
      if (!prefixes.has(`${length}:${value}`)) {
        fail(
          "NO_VALID_PREFIX",
          `no codeword starts with the ${length} bit(s) read from global offset ${start} ` +
            `(impossible after bit ${pos - 1})`,
          pos - 1,
        );
      }
    }
    if (matched === undefined) break; // 有效位在码字中途耗尽
    spans.push({ symbol: matched, start, end: pos });
    if (matched === EOS) break;
  }
  return spans;
}

function checkPadding(bytes: Uint8Array, totalBits: number): void {
  const capacity = bytes.length * 8;
  for (let pos = totalBits; pos < capacity; pos++) {
    if (bitAt(bytes, pos) !== 0) {
      fail(
        "BAD_PADDING",
        `padding bit at global offset ${pos} is 1; all bits beyond totalBits must be zero`,
        pos,
      );
    }
  }
}
