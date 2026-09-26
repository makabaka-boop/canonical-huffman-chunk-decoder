#!/usr/bin/env node
import { decode } from "./decoder.js";

const USAGE = `canonical-huffman-decoder — 从标准输入读取 JSON，解码规范 Huffman 比特流。

用法:
  node dist/cli.js < input.json
  docker compose run --rm -T huff < input.json

输入 JSON:
  {
    "symbols":  [ { "symbol": "A", "length": 1 }, ..., { "symbol": "EOS", "length": L } ],
    "bitstream": { "blocks": ["0a", "ff", ...], "totalBits": 13 }
  }

  symbols           2..64 个唯一符号：单个 ASCII 字符或保留名 "EOS"（必须出现一次）
  length            码长，整数 1..15；码字按 (码长, 符号 UTF-8 字节序) 依次分配
  bitstream.blocks  十六进制字节块，拼接后 MSB-first 连续解读（块边界对解码不可见）
  bitstream.totalBits 声明的有效总位数；其后到末字节末尾的填充位必须全为 0

输出: 成功时 { ok, symbols, spans, codeTable, totalBits }，失败时 { ok: false, error }，
error.bitOffset 为首次出错的全局位偏移（0 起始）。退出码：成功 0，失败 1。
`;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const raw = await readStdin();
  let result;
  try {
    result = decode(JSON.parse(raw));
  } catch (err) {
    if (err instanceof SyntaxError) {
      result = {
        ok: false as const,
        error: { code: "INVALID_INPUT", message: `stdin is not valid JSON: ${err.message}`, bitOffset: null },
      };
    } else {
      throw err;
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

await main();
