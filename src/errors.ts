/**
 * 错误码。除 INVALID_INPUT 外均对应题目要求的整份报错类别；
 * bitOffset 为「首次出错的全局位偏移」（0 起始，跨块连续计数）：
 *  - OVERSUBSCRIBED     码表超额订码，解码尚未开始，记 0
 *  - MISSING_EOS        码表缺 EOS 记 0；有效位耗尽仍未见 EOS 记 totalBits
 *  - NO_VALID_PREFIX    读到该位后已无任何可能的前缀，记该位偏移
 *  - EXTRA_BITS         EOS 之后仍有有效位，记 EOS 结束位（即第一个多余位）
 *  - BAD_PADDING        末字节填充位非零，记第一个为 1 的填充位偏移
 *  - BITSTREAM_TOO_SHORT 声明的有效位超过实际传输位，记实际可用位数
 *  - INVALID_INPUT      输入 JSON 结构非法，与比特流无关，记 null
 */
export type ErrorCode =
  | "INVALID_INPUT"
  | "OVERSUBSCRIBED"
  | "MISSING_EOS"
  | "NO_VALID_PREFIX"
  | "EXTRA_BITS"
  | "BAD_PADDING"
  | "BITSTREAM_TOO_SHORT";

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  bitOffset: number | null;
}

export class DecodeFailure extends Error {
  readonly info: ErrorInfo;

  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = "DecodeFailure";
    this.info = info;
  }
}

export function fail(code: ErrorCode, message: string, bitOffset: number | null): never {
  throw new DecodeFailure({ code, message, bitOffset });
}
