import { HuffError } from './errors.js';
import type { CodeEntry, SymbolEntry } from './types.js';

/** 比较两个字符串的 UTF-8 字节字典序（单字节 ASCII 时即字符序）。 */
export function compareUtf8(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (ba[i] ?? 0) - (bb[i] ?? 0);
    if (d !== 0) return d;
  }
  return ba.length - bb.length;
}

/**
 * 从码长表按规范（canonical）固定顺序重建 Huffman 码：
 *   1. 先按码长升序；码长相同按符号 UTF-8 字节序；
 *   2. 第一个码字从全 0 开始；
 *   3. 同长度内码字 +1；长度从 l 提升到 l' 时左移 (l' - l) 位。
 *
 * 若 Kraft 和 > 1（长度表超额订码），分配过程中 code 必然超过该长度
 * 能容纳的范围（code === 2^length 时仍需给该长度再分一个码字），
 * 在首次发生处抛 OVERSUBSCRIBED（偏移 0）。
 * code === 2^length 且恰好结束是 Kraft 和 == 1 的完整树，合法。
 */
export function buildCanonicalTable(symbols: SymbolEntry[]): CodeEntry[] {
  const sorted = [...symbols].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return compareUtf8(a.symbol, b.symbol);
  });

  const table: CodeEntry[] = [];
  let code = 0;
  let prevLen = 0;

  for (const entry of sorted) {
    code <<= entry.length - prevLen;
    if (code >= 1 << entry.length) {
      throw new HuffError(
        'OVERSUBSCRIBED',
        `length table is oversubscribed: no code of length ${entry.length} ` +
          `available for symbol ${JSON.stringify(entry.symbol)} (Kraft sum > 1)`,
        0,
      );
    }
    table.push({
      symbol: entry.symbol,
      length: entry.length,
      code,
      bits: code.toString(2).padStart(entry.length, '0'),
    });
    code++;
    prevLen = entry.length;
  }

  return table;
}
