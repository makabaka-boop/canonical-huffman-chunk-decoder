import { decode } from './decode.js';
import { validateInput } from './validate.js';
import type { DecodeResult } from './types.js';

/** 校验原始 JSON 并解码；所有错误都通过 HuffError 抛出。 */
export function run(raw: unknown): DecodeResult {
  return decode(validateInput(raw));
}
