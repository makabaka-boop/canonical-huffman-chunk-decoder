import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HuffError } from '../src/errors.js';
import { run } from '../src/run.js';
import type { CodeEntry, DecoderInput, SymbolEntry } from '../src/types.js';
import { kraftInteger, oracleBuildTable, oracleDecode } from './oracle';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

type Outcome =
  | { ok: true; symbols: string[]; trace: { symbol: string; startBit: number; endBit: number }[] }
  | { ok: false; error: string; bitOffset: number };

function libRun(input: unknown): Outcome {
  try {
    const r = run(input);
    return { ok: true, symbols: r.symbols, trace: r.trace };
  } catch (e) {
    const he = e as HuffError;
    return { ok: false, error: he.code, bitOffset: he.bitOffset };
  }
}

function expectErr(input: unknown, code: string, bitOffset?: number): HuffError {
  try {
    run(input as DecoderInput);
  } catch (e) {
    expect(e).toBeInstanceOf(HuffError);
    const he = e as HuffError;
    expect(he.code).toBe(code);
    if (bitOffset !== undefined) expect(he.bitOffset).toBe(bitOffset);
    return he;
  }
  throw new Error(`expected ${code}, but decoding succeeded`);
}

const TABLE4: SymbolEntry[] = [
  { symbol: 'A', length: 2 },
  { symbol: 'B', length: 2 },
  { symbol: 'C', length: 3 },
  { symbol: 'EOS', length: 3 },
];
// TABLE4 的规范码字：A=00 B=01 C=100 EOS=101

describe('canonical table reconstruction', () => {
  it('assigns codes by length, then by UTF-8 byte order, matching the oracle', () => {
    const symbols: SymbolEntry[] = [
      { symbol: 'EOS', length: 3 },
      { symbol: 'A', length: 1 },
      { symbol: 'B', length: 3 },
      { symbol: 'C', length: 3 },
    ];
    // 该码表 A=0、EOS=110：0_110 = 0x60，恰好 4 个有效位。
    const r = run({ symbols, blocks: ['60'], totalBits: 4 });
    expect(r.symbols).toEqual(['A', 'EOS']);
    expect(r.table.map((t) => [t.symbol, t.bits])).toEqual([
      ['A', '0'],
      ['B', '100'],
      ['C', '101'],
      ['EOS', '110'],
    ]);
    const oracle = oracleDecode({ symbols, blocks: ['60'], totalBits: 4 });
    expect(oracle.ok).toBe(true);
    if (oracle.ok) {
      expect(oracle.table.map((t) => [t.symbol, t.bits])).toEqual(
        r.table.map((t) => [t.symbol, t.bits]),
      );
    }
  });

  it('accepts an incomplete-but-legal table (Kraft sum < 1)', () => {
    // 该不完整表：EOS=00 X=01；消息 X X EOS = 01 01 00 = 010100xx = 0x50，6 位。
    const symbols: SymbolEntry[] = [
      { symbol: 'X', length: 2 },
      { symbol: 'EOS', length: 2 },
    ];
    expect(kraftInteger(symbols)).toBe(2 * 2 ** 13);
    expect(kraftInteger(symbols)).toBeLessThan(2 ** 15);

    const r = run({ symbols, blocks: ['50'], totalBits: 6 });
    expect(r.symbols).toEqual(['X', 'X', 'EOS']);
    expect(r.table.map((t) => [t.symbol, t.bits])).toEqual([
      ['EOS', '00'],
      ['X', '01'],
    ]);
  });
});

describe('cross-block codewords', () => {
  // 消息 B B A C EOS，比特 01 01 00 100 101 共 12 位：
  //   01010010 | 0101.... = 0x52 0x50。
  // C=100 跨字节边界（位 6,7 在块 0；位 8 在块 1），EOS 随后结束在有效末端。
  const input: DecoderInput = { symbols: TABLE4, blocks: ['52', '50'], totalBits: 12 };

  it('decodes a codeword straddling the block/byte boundary', () => {
    const r = run(input);
    expect(r.symbols).toEqual(['B', 'B', 'A', 'C', 'EOS']);
    expect(r.trace).toEqual([
      { symbol: 'B', startBit: 0, endBit: 2 },
      { symbol: 'B', startBit: 2, endBit: 4 },
      { symbol: 'A', startBit: 4, endBit: 6 },
      { symbol: 'C', startBit: 6, endBit: 9 },
      { symbol: 'EOS', startBit: 9, endBit: 12 },
    ]);
    const c = r.trace.find((t) => t.symbol === 'C')!;
    expect(c.startBit).toBe(6);
    expect(c.endBit - 1).toBe(8); // 末比特确实落在第二个块
  });

  it('byte-boundary block splits (and empty blocks) do not change the result', () => {
    // 仅在字节边界切块；空块不影响拼接结果。
    const variants: string[][] = [
      ['5250'],
      ['52', '50'],
      ['', '52', '', '50', ''],
      ['5250', ''],
    ];
    for (const blocks of variants) {
      const v = { symbols: TABLE4, blocks, totalBits: 12 };
      expect(libRun(v)).toEqual(libRun(input));
      const oracle = oracleDecode(v);
      expect(oracle).toMatchObject({ ok: true, symbols: ['B', 'B', 'A', 'C', 'EOS'] });
    }
  });

  it('EOS itself straddling the boundary is found exactly at the valid end', () => {
    // 构造跨块 EOS：需要 EOS=101 占据位 7 与位 8（跨字节）。
    // B C EOS = 01 100 101 = 01100101（8 位，不跨）；
    // 前面补 1 个一位对齐：取消息 B B C EOS = 01 01 100 101 =
    //   01011001 | 01...... = 0x59 0x40，10 个有效位，EOS 位 7（块0）、8..9（块1）。
    const v: DecoderInput = { symbols: TABLE4, blocks: ['59', '40'], totalBits: 10 };
    const r = run(v);
    expect(r.symbols).toEqual(['B', 'B', 'C', 'EOS']);
    const eos = r.trace[3]!;
    expect(eos.startBit).toBe(7);
    expect(eos.endBit).toBe(10);
    expect(eos.startBit < 8).toBe(true);
    expect(eos.endBit - 1 >= 8).toBe(true); // EOS 末两个比特落在块 1
  });
});

describe('whole-input errors carry the first failing global bit offset', () => {
  it('OVERSUBSCRIBED (Kraft sum > 1) is a table error at offset 0', () => {
    const symbols: SymbolEntry[] = [
      { symbol: 'A', length: 1 },
      { symbol: 'B', length: 1 },
      { symbol: 'C', length: 1 },
      { symbol: 'EOS', length: 2 },
    ];
    expect(kraftInteger(symbols)).toBeGreaterThan(2 ** 15);
    expectErr({ symbols, blocks: ['00'], totalBits: 1 }, 'OVERSUBSCRIBED', 0);
    expect(oracleDecode({ symbols, blocks: ['00'], totalBits: 1 })).toMatchObject({
      ok: false,
      error: 'OVERSUBSCRIBED',
      bitOffset: 0,
    });
  });

  it('DEAD_PREFIX reports the first bit that makes a prefix impossible', () => {
    // EOS 之前就走入死前缀：00 00 11… = A A 然后 11。
    // 0x30 = 00110000，valid=8：位 2=1 仍与 100/101 相容，位 3=1 坐实 11 死亡。
    const v: DecoderInput = { symbols: TABLE4, blocks: ['30'], totalBits: 8 };
    expectErr(v, 'DEAD_PREFIX', 3);
    expect(oracleDecode(v)).toMatchObject({ ok: false, error: 'DEAD_PREFIX', bitOffset: 3 });

    // 死前缀跨越块边界：00 00 00 0 | 11xx = 0x01 0xc0，valid=10。
    // A A A（位0..5）；位 7 与块 1 首位（位 8）的 1 拼成 11：
    // 位 8 读入后前缀 1 仍与 100/101 相容，位 9 的第二个 1 才坐实死亡，
    // 而这条码字的首比特位于块 0、致命比特位于块 1。
    const v2: DecoderInput = { symbols: TABLE4, blocks: ['01', 'c0'], totalBits: 10 };
    expectErr(v2, 'DEAD_PREFIX', 9);
    expect(oracleDecode(v2)).toMatchObject({ ok: false, error: 'DEAD_PREFIX', bitOffset: 9 });

    // 不完整表（EOS=00 X=01）：整个 1* 子树都是空洞，首比特 1 即走入缺失分支。
    const small: SymbolEntry[] = [
      { symbol: 'X', length: 2 },
      { symbol: 'EOS', length: 2 },
    ];
    expectErr({ symbols: small, blocks: ['80'], totalBits: 2 }, 'DEAD_PREFIX', 0);
  });

  it('MISSING_EOS reports the end of the valid region', () => {
    // B A 之后只剩孤立的 1 位（10 未完）：01001... 0x48，5 个有效位。
    expectErr({ symbols: TABLE4, blocks: ['48'], totalBits: 5 }, 'MISSING_EOS', 5);
    expectErr({ symbols: TABLE4, blocks: ['00'], totalBits: 0 }, 'MISSING_EOS', 0);
  });

  it('EXTRA_BITS reports the position right after the early EOS', () => {
    // EOS=101 后还有 5 个声明有效的位：10100000 = 0xa0。
    expectErr({ symbols: TABLE4, blocks: ['a0'], totalBits: 8 }, 'EXTRA_BITS', 3);
  });

  it('BAD_PADDING reports the first nonzero padding bit', () => {
    // B A EOS = 01 00 101 共 7 个有效位；字节其余 1 位（位 7）必须为 0。
    // 0x4a = 01001010：填充位 7 = 0，合法。
    expect(run({ symbols: TABLE4, blocks: ['4a'], totalBits: 7 }).symbols).toEqual([
      'B', 'A', 'EOS',
    ]);
    // 0x4b = 01001011：填充位 7 = 1，非法。
    expectErr({ symbols: TABLE4, blocks: ['4b'], totalBits: 7 }, 'BAD_PADDING', 7);
    // 小表 EOS=00 X=01：X X EOS = 010100xx，valid=6；
    // 合法字节 01010000 = 0x50；把填充首位置 1 => 01010010 = 0x52，非法位 6。
    const small: SymbolEntry[] = [
      { symbol: 'X', length: 2 },
      { symbol: 'EOS', length: 2 },
    ];
    expect(run({ symbols: small, blocks: ['50'], totalBits: 6 }).symbols).toEqual([
      'X', 'X', 'EOS',
    ]);
    expectErr({ symbols: small, blocks: ['52'], totalBits: 6 }, 'BAD_PADDING', 6);

    // 跨块：BBAC EOS 共 12 位（0x52 0x50），块 1 末半字节是填充：
    // 翻位 12：0x50 ^ 0x08 = 0x58；只翻最后一个填充位 15：0x50 ^ 0x01 = 0x51。
    expectErr({ symbols: TABLE4, blocks: ['52', '58'], totalBits: 12 }, 'BAD_PADDING', 12);
    expectErr({ symbols: TABLE4, blocks: ['52', '51'], totalBits: 12 }, 'BAD_PADDING', 15);
  });
});

describe('INVALID_INPUT', () => {
  const good: SymbolEntry[] = [
    { symbol: 'A', length: 2 },
    { symbol: 'EOS', length: 2 },
  ];

  it.each([
    ['fewer than 2 symbols', { symbols: [{ symbol: 'EOS', length: 1 }], blocks: ['00'], totalBits: 1 }],
    [
      'more than 64 symbols',
      {
        symbols: [
          ...Array.from({ length: 64 }, (_, i) => ({
            symbol: String.fromCharCode(33 + i),
            length: 10,
          })),
          { symbol: 'EOS', length: 10 },
        ],
        blocks: ['00'],
        totalBits: 1,
      },
    ],
    ['non-ASCII symbol', { symbols: [...good, { symbol: '€', length: 2 }], blocks: ['00'], totalBits: 1 }],
    ['two-character symbol other than EOS', { symbols: [...good, { symbol: 'AB', length: 2 }], blocks: ['00'], totalBits: 1 }],
    ['length 0', { symbols: [{ symbol: 'A', length: 0 }, { symbol: 'EOS', length: 1 }], blocks: ['00'], totalBits: 1 }],
    ['length 16', { symbols: [{ symbol: 'A', length: 16 }, { symbol: 'EOS', length: 1 }], blocks: ['00'], totalBits: 1 }],
    ['no EOS', { symbols: [{ symbol: 'A', length: 1 }, { symbol: 'B', length: 1 }], blocks: ['00'], totalBits: 1 }],
    ['two EOS', { symbols: [{ symbol: 'A', length: 1 }, { symbol: 'EOS', length: 1 }, { symbol: 'EOS', length: 2 }], blocks: ['00'], totalBits: 1 }],
    ['duplicate symbol', { symbols: [...good, { symbol: 'A', length: 3 }], blocks: ['00'], totalBits: 1 }],
    ['odd-length hex', { symbols: good, blocks: ['abc'], totalBits: 1 }],
    ['bad hex char', { symbols: good, blocks: ['xy'], totalBits: 1 }],
    ['empty blocks array', { symbols: good, blocks: [], totalBits: 1 }],
    ['totalBits beyond stream', { symbols: good, blocks: ['00'], totalBits: 9 }],
    ['negative totalBits', { symbols: good, blocks: ['00'], totalBits: -1 }],
  ])('rejects %s', (_name, input) => {
    expectErr(input, 'INVALID_INPUT', 0);
  });
});

// ---------------- 随机对拍 ----------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRINTABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';

function randomValidTable(rng: () => number): SymbolEntry[] | null {
  const n = 2 + Math.floor(rng() * 8);
  const chars = new Set<string>();
  while (chars.size < n - 1) {
    chars.add(PRINTABLE[Math.floor(rng() * PRINTABLE.length)]!);
  }
  const symbols: SymbolEntry[] = [...chars].map((s) => ({
    symbol: s,
    length: 1 + Math.floor(rng() * 5),
  }));
  symbols.push({ symbol: 'EOS', length: 1 + Math.floor(rng() * 5) });

  if (kraftInteger(symbols) > 2 ** 15) return null;
  return symbols;
}

function encode(table: CodeEntry[], message: string[]): string {
  const m = new Map(table.map((t) => [t.symbol, t.bits]));
  return message.map((s) => m.get(s)!).join('');
}

/** 按字节边界随机切块，空块也允许；零字节时返回单个空块。 */
function splitBlocks(bytes: number[], rng: () => number): string[] {
  if (bytes.length === 0) return [''];
  const blocks: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (rng() < 0.15) blocks.push('');
    const take = 1 + Math.floor(rng() * Math.min(3, bytes.length - i));
    blocks.push(Buffer.from(bytes.slice(i, i + take)).toString('hex'));
    i += take;
  }
  return blocks;
}

function bytesOf(bits: string): number[] {
  const pad = (8 - (bits.length % 8)) % 8;
  const full = bits + '0'.repeat(pad);
  const out: number[] = [];
  for (let i = 0; i < full.length; i += 8) out.push(parseInt(full.slice(i, i + 8), 2));
  return out;
}

describe('differential fuzz vs the independent oracle', () => {
  it('agrees on valid streams, splits, and injected errors', () => {
    const rng = mulberry32(20260926);
    let validCount = 0;

    for (let iter = 0; iter < 1500 && validCount < 300; iter++) {
      const symbols = randomValidTable(rng);
      if (!symbols) continue;

      const built = oracleBuildOrThrow(symbols);
      const nonEos = symbols.filter((s) => s.symbol !== 'EOS');
      const message = [
        ...Array.from({ length: Math.floor(rng() * 10) }, () =>
          nonEos[Math.floor(rng() * nonEos.length)]!.symbol,
        ),
        'EOS',
      ];
      const payload = encode(built, message);

      let bits = payload;
      let declared = payload.length;
      const roll = rng();
      if (roll < 0.2) {
        // EOS 后注入 1–7 个杂位，全部声明为有效 => EXTRA_BITS。
        const junk = Array.from({ length: 1 + Math.floor(rng() * 7) }, () =>
          rng() < 0.5 ? '1' : '0',
        ).join('');
        bits = payload + junk;
        declared = bits.length;
      } else if (roll < 0.4) {
        // 保持声明长度不变，翻转中间某一位，制造 DEAD_PREFIX / 其它符号。
        const bytes = bytesOf(bits).map((b) => b);
        const target = Math.floor(rng() * declared);
        const bi = target >> 3;
        const mask = 1 << (7 - (target & 7));
        if (bytes[bi] !== undefined) bytes[bi] ^= mask;
        const blocks = splitBlocks(bytes, rng);
        const input = { symbols, blocks, totalBits: declared };
        assertAgrees(input);
        continue;
      } else if (roll < 0.55) {
        // 截掉几个有效位（声明也缩短），通常 MISSING_EOS。
        const cut = 1 + Math.floor(rng() * Math.max(1, payload.length - 1));
        bits = payload.slice(0, Math.max(1, payload.length - cut));
        declared = bits.length;
      }
      // 其余为合法流（含零填充），部分码表是不完整但合法的。

      const bytes = bytesOf(bits);
      let blocks = splitBlocks(bytes, rng);

      if (rng() < 0.15 && bytes.length > 0) {
        // 翻转一个填充位（在声明长度之后）=> BAD_PADDING。
        const padStart = declared;
        const padEnd = Math.ceil(declared / 8) * 8;
        if (padEnd > padStart) {
          const target = padStart + Math.floor(rng() * (padEnd - padStart));
          const bi = target >> 3;
          const mask = 1 << (7 - (target & 7));
          bytes[bi]! ^= mask;
          blocks = splitBlocks(bytes, rng);
        }
      }

      const input = { symbols, blocks, totalBits: declared };
      const outcome = assertAgrees(input);
      if (outcome === 'valid') validCount++;
    }

    expect(validCount).toBeGreaterThan(200);
  }, 30_000);
});

function oracleBuildOrThrow(symbols: SymbolEntry[]): CodeEntry[] {
  try {
    return oracleBuildTable(symbols);
  } catch {
    throw new Error('oracle rejected a table assumed valid');
  }
}

function assertAgrees(input: { symbols: SymbolEntry[]; blocks: string[]; totalBits: number }): string {
  const lib = libRun(input);
  const oracle = oracleDecode(input);
  if (!oracle.ok) {
    expect(lib).toEqual({ ok: false, error: oracle.error, bitOffset: oracle.bitOffset });
    return oracle.error;
  }
  expect(lib).toEqual({ ok: true, symbols: oracle.symbols, trace: oracle.trace });
  return 'valid';
}

// ---------------- CLI 端到端 ----------------

describe('CLI stdin protocol', () => {
  const runCli = (payload: unknown) =>
    execFileSync(process.execPath, ['--import', 'tsx', CLI], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });

  it('prints symbols, bit ranges and the canonical table on success', () => {
    const out = JSON.parse(runCli({ symbols: TABLE4, blocks: ['52', '50'], totalBits: 12 }));
    expect(out.ok).toBe(true);
    expect(out.symbols).toEqual(['B', 'B', 'A', 'C', 'EOS']);
    expect(out.trace[3]).toEqual({ symbol: 'C', startBit: 6, endBit: 9 });
    expect(out.table).toContainEqual({ symbol: 'EOS', length: 3, code: 5, bits: '101' });
  });

  it('prints an error object with the first failing offset and exits nonzero', () => {
    // 0x30 = 0011：A 之后前缀 11 在第 3 位首次坐实为死前缀。
    const payload = { symbols: TABLE4, blocks: ['30'], totalBits: 4 };
    expect(() => runCli(payload)).toThrow();
    try {
      runCli(payload);
    } catch (e) {
      const err = e as { stdout: string; status: number };
      const body = JSON.parse(err.stdout);
      expect(body).toMatchObject({ ok: false, error: 'DEAD_PREFIX', bitOffset: 3 });
      expect(err.status).toBe(1);
      return;
    }
    throw new Error('CLI should have exited nonzero');
  });
});
