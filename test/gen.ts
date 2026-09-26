import type { RefSymbolLength } from "./reference.js";

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PRINTABLE_ASCII: string[] = [];
for (let c = 0x20; c <= 0x7e; c++) PRINTABLE_ASCII.push(String.fromCharCode(c));

export function shuffled<T>(arr: readonly T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 随机合法码表（2..64 个符号，必含 EOS，码长 1..15，Kraft ≤ 1）。
 * 通过随机分裂前缀树叶子得到完备码，再随机删叶使其经常成为
 * 「不完整但合法」的码表。
 */
export function randomTable(rand: () => number): RefSymbolLength[] {
  const n = 2 + Math.floor(rand() * 63);
  const depths = [0];
  const target = n + Math.floor(rand() * 8);
  while (depths.length < target) {
    const candidates: number[] = [];
    depths.forEach((d, i) => {
      if (d < 15) candidates.push(i);
    });
    if (candidates.length === 0) break;
    const idx = candidates[Math.floor(rand() * candidates.length)]!;
    depths.splice(idx, 1, depths[idx]! + 1, depths[idx]! + 1);
  }
  while (depths.length > n) depths.splice(Math.floor(rand() * depths.length), 1);
  if (depths.length < n) return randomTable(rand); // 理论上到不了，保险重试

  const names = ["EOS", ...shuffled(PRINTABLE_ASCII, rand).slice(0, n - 1)];
  const lens = shuffled(depths, rand);
  return names.map((symbol, i) => ({ symbol, length: lens[i]! }));
}

/** 随机消息：0..24 个非 EOS 符号后跟一个 EOS。 */
export function randomMessage(rand: () => number, symbols: RefSymbolLength[]): string[] {
  const pool = symbols.map((s) => s.symbol).filter((s) => s !== "EOS");
  const len = Math.floor(rand() * 25);
  const msg: string[] = [];
  for (let i = 0; i < len; i++) msg.push(pool[Math.floor(rand() * pool.length)]!);
  msg.push("EOS");
  return msg;
}

/**
 * 用参考码表把消息编码成比特串，补零到字节边界后转十六进制，
 * 再随机切成 1..4 字节大小的块（充分制造跨块边界的码字）。
 */
export function encodeToBlocks(
  rand: () => number,
  table: Map<string, string>,
  message: string[],
): { blocks: string[]; totalBits: number } {
  const bits = message
    .map((s) => {
      const code = table.get(s);
      if (code === undefined) throw new Error(`no codeword for ${s}`);
      return code;
    })
    .join("");
  const totalBits = bits.length;
  const padded = bits.padEnd(Math.ceil(totalBits / 8) * 8, "0");
  let hex = "";
  for (let i = 0; i < padded.length; i += 8) {
    hex += parseInt(padded.slice(i, i + 8), 2).toString(16).padStart(2, "0");
  }
  const blocks: string[] = [];
  let i = 0;
  while (i < hex.length) {
    const remainingBytes = (hex.length - i) / 2;
    const take = 1 + Math.floor(rand() * Math.min(4, remainingBytes));
    blocks.push(hex.slice(i, i + take * 2));
    i += take * 2;
  }
  return { blocks, totalBits };
}

/** 翻转拼接后比特流中的某一位（保持原有分块大小）。 */
export function flipBit(blocks: string[], bitPos: number): string[] {
  const sizes = blocks.map((b) => b.length);
  const hex = blocks.join("");
  const nibbleIdx = bitPos >> 2;
  const nibble = parseInt(hex[nibbleIdx]!, 16) ^ (1 << (3 - (bitPos & 3)));
  const flipped = hex.slice(0, nibbleIdx) + nibble.toString(16) + hex.slice(nibbleIdx + 1);
  const out: string[] = [];
  let i = 0;
  for (const size of sizes) {
    out.push(flipped.slice(i, i + size));
    i += size;
  }
  return out;
}
