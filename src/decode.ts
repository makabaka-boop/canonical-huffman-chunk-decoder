import { buildCanonicalTable } from './canonical.js';
import { HuffError } from './errors.js';
import type { CodeEntry, DecodedSymbol, DecoderInput, DecodeResult } from './types.js';

const EOS = 'EOS';

interface TrieNode {
  symbol?: string;
  /** children[0] / children[1]，按 MSB-first 的下一比特索引。 */
  children: [TrieNode | null, TrieNode | null];
}

/** 把十六进制块拼成一段连续字节缓冲 —— 块只是物理切分，逻辑上没有边界。 */
function flattenBlocks(blocks: string[]): Buffer {
  const bufs = blocks.map((h) => Buffer.from(h, 'hex'));
  return Buffer.concat(bufs);
}

function buildTrie(table: CodeEntry[]): TrieNode {
  const root: TrieNode = { children: [null, null] };

  for (const entry of table) {
    let node = root;
    for (let i = entry.length - 1; i >= 0; i--) {
      const bit = (entry.code >> i) & 1;
      let next = node.children[bit] ?? null;
      if (next === null) {
        next = { children: [null, null] };
        node.children[bit] = next;
      }
      if (next.symbol !== undefined) {
        // 理论上不可达：规范分配保证前缀自由；仅作防御。
        throw new HuffError(
          'OVERSUBSCRIBED',
          `code ${entry.bits} passes through an existing leaf`,
          0,
        );
      }
      node = next;
    }
    if (node.children[0] !== null || node.children[1] !== null) {
      throw new HuffError('OVERSUBSCRIBED', `code ${entry.bits} is a prefix of another code`, 0);
    }
    node.symbol = entry.symbol;
  }

  return root;
}

function readBit(buf: Buffer, pos: number): number {
  return (buf[pos >> 3]! >> (7 - (pos & 7))) & 1;
}

/**
 * 从全局位偏移 pos 沿树下行，返回命中的符号与结束偏移。
 * 途中若走出所有可能前缀（到达缺失分支），在首次死亡比特的位置
 * 抛 DEAD_PREFIX；若有效位先耗尽，在 EOS 本应出现的位置抛 MISSING_EOS。
 */
function decodeSymbol(
  buf: Buffer,
  root: TrieNode,
  pos: number,
  validBits: number,
): { symbol: string; end: number } {
  let node = root;
  let p = pos;

  while (node.symbol === undefined) {
    if (p >= validBits) {
      throw new HuffError(
        'MISSING_EOS',
        `bit stream ended at ${p} before an EOS symbol was reached`,
        p,
      );
    }
    const bit = readBit(buf, p);
    const next = node.children[bit] ?? null;
    if (next === null) {
      throw new HuffError(
        'DEAD_PREFIX',
        `no codeword can begin with the prefix read at global bit ${p} ` +
          `(bit ${bit} leads nowhere); first undecodable bit is ${p}`,
        p,
      );
    }
    node = next;
    p++;
  }

  return { symbol: node.symbol, end: p };
}

export function decode(input: DecoderInput): DecodeResult {
  const table = buildCanonicalTable(input.symbols);
  const trie = buildTrie(table);
  const buf = flattenBlocks(input.blocks);
  const validBits = input.totalBits;

  const symbols: string[] = [];
  const trace: DecodedSymbol[] = [];
  let pos = 0;

  for (;;) {
    const start = pos;
    const { symbol, end } = decodeSymbol(buf, trie, pos, validBits);
    symbols.push(symbol);
    trace.push({ symbol, startBit: start, endBit: end });
    pos = end;

    if (symbol === EOS) {
      if (pos !== validBits) {
        throw new HuffError(
          'EXTRA_BITS',
          `EOS ended at bit ${pos} but ${validBits - pos} declared-valid bit(s) remain; ` +
            `EOS must land exactly on the end of the valid region`,
          pos,
        );
      }
      break;
    }
  }

  // 末字节的无效填充位（validBits 之后、最后一个包含有效位的字节之内）必须全为 0。
  const padEnd = Math.ceil(validBits / 8) * 8;
  for (let p = validBits; p < padEnd; p++) {
    if (readBit(buf, p) !== 0) {
      throw new HuffError(
        'BAD_PADDING',
        `padding bit at global offset ${p} is 1; all trailing padding bits must be zero`,
        p,
      );
    }
  }

  return { symbols, trace, table };
}
