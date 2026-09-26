/**
 * 独立参考实现（oracle）——刻意与 src/ 走不同的算法路线：
 *
 *  - 码表重建不做“逐条左移 + 递增”，而是：
 *      1) 整数 Kraft 校验 sum 2^(15-len) <= 2^15；
 *      2) 统计各码长的计数，用 DEFLATE 式递推
 *            next[len+1] = (next[len] + count[len]) << 1
 *         求每个长度的起始码字，同长度内按 UTF-8 字节序取码。
 *    对 Kraft < 1 的不完整表，这套偏移算法与 src 的逐条分配都应得到同一张表，
 *    而朴素“前序叶子贪心”会在不完整表上把短码字摆错——所以这里不用它。
 *
 *  - 解码不建二叉树：把有效位切成字符串，对每条码字做 startsWith 前缀匹配，
 *    逐层找出首个无码字共享的前缀（死前缀）。
 *
 * 测试只信赖两边在同一规格下结果一致。
 */
import type { CodeEntry, DecodedSymbol, SymbolEntry } from '../src/types.js';

const MAX_LEN = 15;

function compareUtf8(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = ba[i]! - bb[i]!;
    if (d !== 0) return d;
  }
  return ba.length - bb.length;
}

export class OracleTableError extends Error {}

/** 整数 Kraft 校验：sum 2^(15-len) 必须 <= 2^15（超额订码）。 */
export function kraftInteger(entries: SymbolEntry[]): number {
  return entries.reduce((sum, e) => sum + 2 ** (MAX_LEN - e.length), 0);
}

/** 独立的规范码重建：长度计数 -> 各长度起始码偏移 -> 组内按字节序分配。 */
export function oracleBuildTable(symbols: SymbolEntry[]): CodeEntry[] {
  if (symbols.length < 2) throw new OracleTableError('alphabet too small');
  if (kraftInteger(symbols) > 2 ** MAX_LEN) {
    throw new OracleTableError('kraft sum exceeds 1');
  }

  const byLength = new Map<number, string[]>();
  for (const s of symbols) {
    const list = byLength.get(s.length) ?? [];
    list.push(s.symbol);
    byLength.set(s.length, list);
  }

  const count = new Array<number>(MAX_LEN + 1).fill(0);
  for (const [len, list] of byLength) {
    list.sort(compareUtf8);
    count[len] = list.length;
  }

  // next[len] = 长度 len 的第一个码字（整数）。
  const next = new Array<number>(MAX_LEN + 1).fill(0);
  for (let len = 1; len < MAX_LEN; len++) {
    next[len + 1] = (next[len]! + count[len]!) << 1;
  }

  const table: CodeEntry[] = [];
  for (let len = 1; len <= MAX_LEN; len++) {
    const list = byLength.get(len);
    if (!list) continue;
    list.forEach((symbol, k) => {
      const code = next[len]! + k;
      if (code >= 1 << len) {
        throw new OracleTableError(`length ${len} code space exhausted`);
      }
      table.push({ symbol, length: len, code, bits: code.toString(2).padStart(len, '0') });
    });
  }
  return table;
}

export type OracleOutcome =
  | {
      ok: true;
      symbols: string[];
      trace: DecodedSymbol[];
      table: CodeEntry[];
    }
  | {
      ok: false;
      error: 'OVERSUBSCRIBED' | 'DEAD_PREFIX' | 'MISSING_EOS' | 'EXTRA_BITS' | 'BAD_PADDING';
      bitOffset: number;
    };

function bitsOf(blocks: string[]): string {
  const buf = Buffer.concat(blocks.map((h) => Buffer.from(h, 'hex')));
  let s = '';
  for (const byte of buf) s += byte.toString(2).padStart(8, '0');
  return s;
}

export function oracleDecode(input: {
  symbols: SymbolEntry[];
  blocks: string[];
  totalBits: number;
}): OracleOutcome {
  let table: CodeEntry[];
  try {
    table = oracleBuildTable(input.symbols);
  } catch {
    return { ok: false, error: 'OVERSUBSCRIBED', bitOffset: 0 };
  }

  const allBits = bitsOf(input.blocks);
  const valid = input.totalBits;
  const validBits = allBits.slice(0, valid);
  const leafAt = new Map<string, string>(table.map((t) => [t.bits, t.symbol]));

  const out: string[] = [];
  const trace: DecodedSymbol[] = [];
  let pos = 0;

  for (;;) {
    if (pos >= valid) {
      return { ok: false, error: 'MISSING_EOS', bitOffset: valid };
    }

    let matched: { symbol: string; length: number } | null = null;
    let deadAt: number | null = null;

    for (let len = 1; len <= MAX_LEN; len++) {
      const prefix = validBits.slice(pos, pos + len);
      if (prefix.length < len) break; // 有效位先耗尽
      const shared = table.some((t) => t.bits.startsWith(prefix));
      if (!shared) {
        deadAt = pos + len - 1;
        break;
      }
      const leaf = leafAt.get(prefix);
      if (leaf !== undefined) {
        matched = { symbol: leaf, length: len };
        break;
      }
    }

    if (matched === null) {
      return deadAt !== null
        ? { ok: false, error: 'DEAD_PREFIX', bitOffset: deadAt }
        : { ok: false, error: 'MISSING_EOS', bitOffset: valid };
    }

    const end = pos + matched.length;
    out.push(matched.symbol);
    trace.push({ symbol: matched.symbol, startBit: pos, endBit: end });

    if (matched.symbol === 'EOS') {
      if (end !== valid) {
        return { ok: false, error: 'EXTRA_BITS', bitOffset: end };
      }
      break;
    }
    pos = end;
  }

  const padEnd = Math.ceil(valid / 8) * 8;
  for (let p = valid; p < padEnd; p++) {
    if (allBits[p] === '1') {
      return { ok: false, error: 'BAD_PADDING', bitOffset: p };
    }
  }

  return { ok: true, symbols: out, trace, table };
}
