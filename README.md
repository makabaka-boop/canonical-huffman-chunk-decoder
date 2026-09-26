# canonical-huffman-decoder

规范（canonical）Huffman 解码器：从长度表按固定顺序重建码表，把十六进制字节块
拼成连续比特流，跨块解码到唯一的 EOS 为止。TypeScript / Node.js 实现，零运行时依赖。

## 输入格式

从**标准输入**读取一个 JSON 对象：

```json
{
  "symbols": [
    { "symbol": "A", "length": 1 },
    { "symbol": "B", "length": 2 },
    { "symbol": "EOS", "length": 2 }
  ],
  "bitstream": { "blocks": ["01", "60"], "totalBits": 11 }
}
```

- `symbols`：2～64 个**唯一**符号。每个符号是单个 ASCII 字符（U+0000–U+007F）
  或保留名 `"EOS"`；`EOS` 必须恰好出现一次。`length` 为码长，整数 1～15。
- `bitstream.blocks`：十六进制字节块（大小写均可，每块偶数位，空块等价于零字节）。
  所有块拼接后按 **MSB-first**（每字节最高位先传）连续解读——**块边界对解码不可见**，
  跨越块边界的码字照常读出，绝不逐块重启查表。
- `bitstream.totalBits`：声明的有效总位数。从该位到末字节末尾的填充位必须全为 0。

**码字分配（规范码）**：按 `(码长升序, 符号名 UTF-8 字节序)` 排序后从 0 连续分配，
码长增加时左移。允许 Kraft 和 < 1 的**不完整但合法**码表；Kraft 和 > 1 即超额订码。

## 输出格式

成功（退出码 0）：

```json
{
  "ok": true,
  "symbols": ["A", "…", "EOS"],
  "spans": [{ "symbol": "A", "start": 0, "end": 1 }],
  "codeTable": [{ "symbol": "A", "length": 1, "code": "0" }],
  "totalBits": 11
}
```

- `symbols`：解码出的符号序列，最后一个必为 `EOS`。
- `spans`：每个符号的起止**全局位偏移** `[start, end)`（0 起始、跨块连续、end 开区间）。
- `codeTable`：按规范顺序重建的码表，`code` 为 0/1 字符串。

失败（退出码 1，整份报错，无部分输出）：

```json
{ "ok": false, "error": { "code": "NO_VALID_PREFIX", "message": "…", "bitOffset": 17 } }
```

`error.bitOffset` 是**首次出错的全局位偏移**：

| code                  | 含义                                   | bitOffset                |
| --------------------- | -------------------------------------- | ------------------------ |
| `OVERSUBSCRIBED`      | 长度表超额订码（Kraft > 1）            | 0（解码尚未开始）        |
| `MISSING_EOS`         | 码表缺 EOS / 有效位耗尽仍未见 EOS      | 0 / `totalBits`          |
| `NO_VALID_PREFIX`     | 读到该位后已无任何可能的码字前缀       | 出错位                   |
| `EXTRA_BITS`          | EOS 之后仍有有效位                     | EOS 结束位（首个多余位） |
| `BAD_PADDING`         | 末字节无效填充位非零                   | 第一个为 1 的填充位      |
| `BITSTREAM_TOO_SHORT` | 声明的有效位超过实际传输位             | 实际可用位数             |
| `INVALID_INPUT`       | 输入 JSON 结构非法                     | `null`                   |

检查顺序即上表所暗示的流水线：码表 → 比特流结构 → 连续解码 → EOS 位置 → 填充位；
解码类错误的偏移必然小于填充类错误，因此报告的一定是全局最早出错点。

## 本地运行

```sh
npm install
npm run build          # 编译到 dist/
npm test               # Vitest
node dist/cli.js < examples/valid.json
node dist/cli.js --help
```

## Docker Compose（huff 服务）

```sh
docker compose build huff
docker compose run --rm -T huff < examples/valid.json       # 成功
docker compose run --rm -T huff < examples/bad-padding.json # 整份报错
```

`huff` 服务从标准输入读取 JSON，结果写标准输出；`-T` 关闭伪 TTY 以便管道重定向。

## 测试与对拍

`npm test`（Vitest）包含：

- **单元用例**：规范码表的字节序分配、跨块码字（含 15 位码字跨 4 个单字节块）、
  不完整码表、五类整份报错及各自的全局位偏移、输入结构校验。
- **对拍（差分测试）**：`test/reference.ts` 是刻意独立的第二实现——
  zlib/puff 风格 `bl_count/next_code` 建表 + 显式二叉前缀树逐位下行，
  与主实现（移位累加建表 + 前缀集合流式解码）在以下方面逐项比对：
  - 500 组随机长度表（合法与超额订码）的建表结果；
  - 300 组随机合法消息（随机 1–4 字节分块）的符号序列、起止位、码表；
  - 约 1000 组随机破坏（翻转有效位/填充位、截断、延长、超声明）后的
    错误类别与首次出错位偏移。

## 项目结构

```
src/
  errors.ts     错误码与 DecodeFailure
  symbols.ts    符号校验、规范排序、从长度表重建码表（超额订码检测）
  bitstream.ts  十六进制块解析、MSB-first 全局位读取
  decoder.ts    解码流水线（连续解码、EOS/填充校验）
  cli.ts        命令行入口：stdin → JSON → stdout
test/
  reference.ts  独立参考实现（二叉前缀树，用于对拍）
  gen.ts        确定性随机码表/消息/比特流生成器
  decoder.test.ts
examples/       示例输入
Dockerfile / compose.yaml
```
