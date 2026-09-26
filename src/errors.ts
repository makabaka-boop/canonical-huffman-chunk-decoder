import type { ErrorCode } from './types.js';

/**
 * 所有解码器错误都携带“首次出错的全局位偏移”。
 * 码表级错误（输入格式 / 超额订码）发生在任何比特之前，偏移为 0。
 */
export class HuffError extends Error {
  readonly code: ErrorCode;
  readonly bitOffset: number;

  constructor(code: ErrorCode, message: string, bitOffset: number) {
    super(message);
    this.name = 'HuffError';
    this.code = code;
    this.bitOffset = bitOffset;
  }
}
