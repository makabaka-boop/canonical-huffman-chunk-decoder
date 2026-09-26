import { describe, expect, it } from 'vitest';
// 复用主测试文件里的 RNG/生成器不现实，这里直接内联一份精简对拍循环。
import type { SymbolEntry } from '../src/types';
import { kraftInteger, oracleBuildTable, oracleDecode } from './oracle';
import { run } from '../src/run';

function rng32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describe('stress: 20k random tables × streams agree with the independent oracle', () => {
  it('matches outcomes and first-failing offsets', () => {
    const rng = rng32(987654321);
    let valid = 0;
    let errors: Record<string, number> = {};
    for (let iter = 0; iter < 60000 && valid < 20000; iter++) {
      const n = 2 + Math.floor(rng() * 10);
      const chars = new Set<string>();
      while (chars.size < n - 1) chars.add(CHARS[Math.floor(rng() * CHARS.length)]!);
      const symbols: SymbolEntry[] = [...chars].map((c) => ({
        symbol: c,
        length: 1 + Math.floor(rng() * 8),
      }));
      symbols.push({ symbol: 'EOS', length: 1 + Math.floor(rng() * 8) });
      if (kraftInteger(symbols) > 2 ** 15) continue;

      const table = oracleBuildTable(symbols);
      const m = new Map(table.map((t) => [t.symbol, t.bits]));
      const nonEos = symbols.filter((s) => s.symbol !== 'EOS');
      const msg = [
        ...Array.from({ length: Math.floor(rng() * 14) }, () =>
          nonEos[Math.floor(rng() * nonEos.length)]!.symbol,
        ),
        'EOS',
      ];
      let bits = msg.map((s) => m.get(s)!).join('');
      let totalBits = bits.length;

      // 突变：截断 / 填错 / 追加杂位 / 翻数据位
      const kind = rng();
      const bytes: number[] = [];
      if (kind < 0.18) totalBits = Math.max(1, totalBits - 1 - Math.floor(rng() * 5));
      if (kind >= 0.18 && kind < 0.34) bits += Array.from({ length: 1 + Math.floor(rng() * 7) }, () =>
        rng() < 0.5 ? '1' : '0',
      ).join('');
      if (kind >= 0.34 && kind < 0.52) totalBits = bits.length; // 把附加位声明为有效
      const pad = (8 - (bits.length % 8)) % 8;
      const full = bits + '0'.repeat(pad);
      for (let i = 0; i < full.length; i += 8) bytes.push(parseInt(full.slice(i, i + 8), 2));
      if (kind >= 0.52 && kind < 0.72 && totalBits > 1) {
        const p = Math.floor(rng() * (totalBits - 1));
        bytes[p >> 3]! ^= 1 << (7 - (p & 7));
      }
      if (kind >= 0.82 && totalBits % 8 !== 0) {
        const pEnd = Math.ceil(totalBits / 8) * 8;
        const p = totalBits + Math.floor(rng() * (pEnd - totalBits));
        bytes[p >> 3]! ^= 1 << (7 - (p & 7));
      }

      // 随机字节切块（强制至少一次切成两个块）
      let blocks: string[];
      if (bytes.length > 1 && rng() < 0.8) {
        const cut = 1 + Math.floor(rng() * (bytes.length - 1));
        blocks = [
          Buffer.from(bytes.slice(0, cut)).toString('hex'),
          Buffer.from(bytes.slice(cut)).toString('hex'),
        ];
      } else {
        blocks = [Buffer.from(bytes).toString('hex')];
      }

      let lib: unknown;
      try {
        const r = run({ symbols, blocks, totalBits });
        lib = { ok: true, symbols: r.symbols, trace: r.trace };
      } catch (e) {
        const he = e as { code: string; bitOffset: number };
        lib = { ok: false, error: he.code, bitOffset: he.bitOffset };
        errors[he.code] = (errors[he.code] ?? 0) + 1;
      }
      const o = oracleDecode({ symbols, blocks, totalBits });
      const oracleView = o.ok
        ? { ok: true, symbols: o.symbols, trace: o.trace }
        : { ok: false, error: o.error, bitOffset: o.bitOffset };
      expect(lib).toEqual(oracleView);
      if (o.ok) valid++;
    }
    // 防御：突变确实覆盖了各类错误，不能只是“合法流对拍”。
    expect(valid).toBeGreaterThan(15000);
    expect(errors['DEAD_PREFIX'] ?? 0).toBeGreaterThan(50);
    expect(errors['MISSING_EOS'] ?? 0).toBeGreaterThan(20);
    expect(errors['EXTRA_BITS'] ?? 0).toBeGreaterThan(20);
    expect(errors['BAD_PADDING'] ?? 0).toBeGreaterThan(20);
  }, 120_000);
});
