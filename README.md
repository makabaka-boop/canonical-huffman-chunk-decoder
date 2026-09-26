# huff-decoder

规范（canonical）Huffman 解码器。TypeScript / Node.js 命令行程序，从标准输入读取
JSON，输出解码符号序列、每个符号的起止全局位偏移以及重建出的规范码表。

> 两个关键语义：
>
> 1. **十六进制 `blocks` 只是物理切分，逻辑上是一条连续比特流。** 码字可以跨越块（字节）
>    边界；逐块“从头查表”会把落在后一块里的后半截误判成另一个符号。解码器把所有块
>    拼接后按全局位偏移连续解码。
> 2. **规范 Huffman 码只能从码长表按固定顺序重建**：先按码长升序、同长按符号 UTF-8
>    字节序，码字从全 0 开始递增，长度提升时左移补齐。任何“前缀树叶子贪心”之类的朴素
>    重建只在完整树（Kraft 和 = 1）上等价，遇到不完整但合法的表（Kraft 和 < 1）会摆错。

## 输入格式（stdin JSON）

| 字段 | 说明 |
| --- | --- |
| `symbols` | 2～64 个**唯一**条目 `{"symbol", "length"}`。`symbol` 为单个可打印 ASCII 字符（空格–`~`），唯一例外是字符串 `"EOS"`；`length` 为 1～15 的整数。必须恰好有一个 EOS。 |
| `blocks` | 非空数组，每项是偶数长度的十六进制字符串（大小写均可，允许空串 `""`）。按数组顺序首尾相接，块边界按字节对齐。 |
| `totalBits` | 声明的有效总位数（非负整数，不得超过拼接后的流长度）。末字节中 `totalBits` 之后的位是填充位。 |

比特序：**每字节高位（MSB）在前**；全局位偏移从流的第 0 位开始连续计数。

```json
{
  "symbols": [
    { "symbol": "A", "length": 2 },
    { "symbol": "B", "length": 2 },
    { "symbol": "C", "length": 3 },
    { "symbol": "EOS", "length": 3 }
  ],
  "blocks": ["52", "50"],
  "totalBits": 12
}
```

上例中规范码为 `A=00 B=01 C=100 EOS=101`，流 `01010010 0101…` 解码为
`B B A C EOS`，其中 `C=100` 的位 6,7 位于块 0、位 8 位于块 1（跨块码字）。

## 输出格式（stdout JSON）

成功：

```json
{
  "ok": true,
  "symbols": ["B", "B", "A", "C", "EOS"],
  "trace": [
    { "symbol": "B", "startBit": 0, "endBit": 2 },
    { "symbol": "B", "startBit": 2, "endBit": 4 },
    { "symbol": "A", "startBit": 4, "endBit": 6 },
    { "symbol": "C", "startBit": 6, "endBit": 9 },
    { "symbol": "EOS", "startBit": 9, "endBit": 12 }
  ],
  "table": [
    { "symbol": "A", "length": 2, "code": 0, "bits": "00" },
    { "symbol": "B", "length": 2, "code": 1, "bits": "01" },
    { "symbol": "C", "length": 3, "code": 4, "bits": "100" },
    { "symbol": "EOS", "length": 3, "code": 5, "bits": "101" }
  ]
}
```

- `startBit`：码字首比特的全局偏移（从 0 起）。
- `endBit`：码字末比特之后的偏移（半开区间，即下一符号的 `startBit`）。
- `table`：按规范分配顺序（长度、符号 UTF-8 字节序）排列的码表，`bits` 为 MSB 在前的码字。
- EOS 本身也包含在 `symbols` / `trace` 中。

失败时进程退出码为 1，stdout 输出：

```json
{ "ok": false, "error": "DEAD_PREFIX", "message": "…", "bitOffset": 3 }
```

## 整体报错与首次出错位偏移

任何违规都**整份拒绝**（不输出部分解码结果），并给出首次出错的全局位偏移：

| `error` | 触发条件 | `bitOffset` |
| --- | --- | --- |
| `INVALID_INPUT` | JSON/结构非法：符号数不在 2～64、非 ASCII 符号、长度不在 1～15、符号重复、EOS 不唯一、hex 非法/奇数长度、块数组为空、`totalBits` 非法或超过流长度 | `0` |
| `OVERSUBSCRIBED` | 码长表 Kraft 和 > 1（超额订码），分配时该长度码空间耗尽 | `0`（码表级错误，先于任何比特） |
| `DEAD_PREFIX` | 解码途中走入一个不被任何码字共享的前缀（不完整表里的空洞） | 使前缀首次“死亡”的那个比特的偏移 |
| `MISSING_EOS` | 有效位耗尽仍未解码出 EOS（包括有效长度为 0） | 有效区末端（= `totalBits`） |
| `EXTRA_BITS` | EOS 未落在有效区末端：EOS 之后仍存在声明为有效的位 | EOS 结束后的第一位 |
| `BAD_PADDING` | 末字节 `totalBits` 之后的填充位中出现 1（必须全部为 0） | 首个非零填充位的偏移 |

规则要点：

- EOS **必须恰好**落在有效位末端（`endBit === totalBits`），早到即 `EXTRA_BITS`。
- 末字节无效填充位必须为 0；填充检查只在 EOS 校验通过后进行。
- 长度表允许 **Kraft 和 < 1**（不完整但合法）；空洞前缀在比特流中一旦被走入即报
  `DEAD_PREFIX`，但码表本身不报错。

## 本地运行

```bash
npm install
npm run build

# 编译后
node dist/cli.js < input.json

# 或免编译直接用 tsx
npm start -- < input.json
```

## Docker Compose（huff 服务）

```bash
docker compose build huff
# -T 关闭 TTY 分配，把 JSON 管道进标准输入
docker compose run --rm -T huff < input.json
```

## 测试

```bash
npm test          # 一次性运行
npm run test:watch
```

测试使用 Vitest，并带一个**独立参考实现**（`test/oracle.ts`）对拍：

- 参考码表用“长度计数 + DEFLATE 式 `next[len+1] = (next[len]+count[len]) << 1`
  起始码偏移”重建，与实现库逐条“左移 + 递增”的分配过程不同形；
- 参考解码器不使用实现库的二叉前缀树，而用码字字符串前缀匹配独立判活/判死；
- 对拍覆盖：跨块码字（含 EOS 自身跨块、死前缀跨块）、不完整但合法的码表
  （Kraft < 1）、五类错误的**首个失败位偏移**一致性、随机字节切分与空块；
- `test/stress.test.ts` 额外跑 2 万轮随机码表 × 随机突变（截断、追加杂位、翻数据位、
  翻填充位），断言两边连成功结果也逐符号、逐位区间一致。
