/** 输入中的一个符号条目：符号本身及其规范码长度（1–15）。 */
export interface SymbolEntry {
  symbol: string;
  length: number;
}

/** stdin 接受的 JSON 结构。 */
export interface DecoderInput {
  /** 2～64 个唯一符号条目；符号为单字符 ASCII，必须恰好包含一个 EOS。 */
  symbols: SymbolEntry[];
  /** 十六进制字节块（如 "8b9f"），按数组顺序首尾相接形成连续比特流。 */
  blocks: string[];
  /** 声明的有效总位数；末字节其余位是必须为 0 的填充位。 */
  totalBits: number;
}

/** 输出序列中的一个解码事件（EOS 也包含在内）。 */
export interface DecodedSymbol {
  symbol: string;
  /** 码字首比特的全局偏移（从 0 起）。 */
  startBit: number;
  /** 码字末比特之后的全局偏移，即下一比特偏移。 */
  endBit: number;
}

/** 重建出的规范 Huffman 码表条目，按长度、符号字节序排列。 */
export interface CodeEntry {
  symbol: string;
  length: number;
  /** 码字的整数值（MSB 在前，按 length 位解读）。 */
  code: number;
  /** MSB 在前的二进制码字字符串。 */
  bits: string;
}

export interface DecodeResult {
  symbols: string[];
  trace: DecodedSymbol[];
  table: CodeEntry[];
}

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'OVERSUBSCRIBED'
  | 'DEAD_PREFIX'
  | 'MISSING_EOS'
  | 'EXTRA_BITS'
  | 'BAD_PADDING';

export interface HuffErrorInfo {
  error: ErrorCode;
  message: string;
  /** 首次出错的全局位偏移（从 0 起）；码表类错误为 0。 */
  bitOffset: number;
}
