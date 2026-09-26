/**
 * 独立参考实现，用于与主解码器对拍。
 * 刻意采用完全不同的数据结构：
 *  - 建表用 zlib/puff 风格的 bl_count + next_code（主实现用移位累加）；
 *  - 比特流展开成 '0'/'1' 字符串（主实现用字节数组 + 位运算）；
 *  - 解码走显式二叉前缀树逐位下行（主实现用规范码前缀集合）。
 */

export interface RefSymbolLength {
  symbol: string;
  length: number;
}

export interface RefSpan {
  symbol: string;
  start: number;
  end: number;
}

export type RefResult =
  | { ok: true; spans: RefSpan[] }
  | { ok: false; code: string; bitOffset: number };

function compareSymbolNames(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** 规范码表：puff 风格 Kraft 检查 + next_code 顺序分配。 */
export function refBuildTable(entries: RefSymbolLength[]): Map<string, string> {
  const maxLen = Math.max(...entries.map((e) => e.length));
  const blCount = new Array<number>(maxLen + 1).fill(0);
  for (const e of entries) blCount[e.length]!++;

  let left = 1;
  for (let len = 1; len <= maxLen; len++) {
    left <<= 1;
    left -= blCount[len]!;
    if (left < 0) throw new Error("oversubscribed");
  }

  const nextCode = new Array<number>(maxLen + 1).fill(0);
  let code = 0;
  for (let len = 1; len <= maxLen; len++) {
    code = (code + blCount[len - 1]!) << 1;
    nextCode[len] = code;
  }

  const sorted = [...entries].sort(
    (p, q) => p.length - q.length || compareSymbolNames(p.symbol, q.symbol),
  );
  const table = new Map<string, string>();
  for (const e of sorted) {
    table.set(e.symbol, nextCode[e.length]!.toString(2).padStart(e.length, "0"));
    nextCode[e.length]!++;
  }
  return table;
}

interface Trie {
  kids: [Trie | null, Trie | null];
  symbol: string | null;
}

function newTrie(): Trie {
  return { kids: [null, null], symbol: null };
}

export function refDecode(
  entries: RefSymbolLength[],
  blocks: string[],
  totalBits: number,
): RefResult {
  let table: Map<string, string>;
  try {
    table = refBuildTable(entries);
  } catch {
    return { ok: false, code: "OVERSUBSCRIBED", bitOffset: 0 };
  }

  const bitString = blocks
    .map((block) =>
      [...block].map((h) => parseInt(h, 16).toString(2).padStart(4, "0")).join(""),
    )
    .join("");
  if (totalBits > bitString.length) {
    return { ok: false, code: "BITSTREAM_TOO_SHORT", bitOffset: bitString.length };
  }

  const root = newTrie();
  for (const [symbol, bits] of table) {
    let node = root;
    for (const ch of bits) {
      const idx = ch === "1" ? 1 : 0;
      node = node.kids[idx] ??= newTrie();
    }
    node.symbol = symbol;
  }

  const spans: RefSpan[] = [];
  let pos = 0;
  while (pos < totalBits) {
    let node = root;
    const start = pos;
    let matched: string | null = null;
    while (pos < totalBits) {
      const idx = bitString[pos] === "1" ? 1 : 0;
      const next = node.kids[idx];
      if (next === null) return { ok: false, code: "NO_VALID_PREFIX", bitOffset: pos };
      pos += 1;
      node = next;
      if (node.symbol !== null) {
        matched = node.symbol;
        break;
      }
    }
    if (matched === null) break;
    spans.push({ symbol: matched, start, end: pos });
    if (matched === "EOS") break;
  }

  const last = spans.at(-1);
  if (!last || last.symbol !== "EOS") {
    return { ok: false, code: "MISSING_EOS", bitOffset: totalBits };
  }
  if (last.end !== totalBits) {
    return { ok: false, code: "EXTRA_BITS", bitOffset: last.end };
  }
  for (let p = totalBits; p < bitString.length; p++) {
    if (bitString[p] === "1") return { ok: false, code: "BAD_PADDING", bitOffset: p };
  }
  return { ok: true, spans };
}
