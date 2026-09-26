import { fail } from "./errors.js";
/** 保留符号名：消息结束标记。普通符号是单个 ASCII 字符，不会与之冲突。 */
export const EOS = "EOS";
export const MIN_SYMBOLS = 2;
export const MAX_SYMBOLS = 64;
export const MIN_LENGTH = 1;
export const MAX_LENGTH = 15;
/** 合法符号名：保留字 "EOS"，或单个 ASCII 字符（U+0000..U+007F）。 */
export function isValidSymbolName(s) {
    if (typeof s !== "string")
        return false;
    if (s === EOS)
        return true;
    if ([...s].length !== 1)
        return false;
    return s.codePointAt(0) <= 0x7f;
}
export function utf8Bytes(s) {
    return Array.from(new TextEncoder().encode(s));
}
export function compareByteArrays(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i])
            return a[i] - b[i];
    }
    return a.length - b.length;
}
/**
 * 规范顺序：先按码长升序，同码长内按符号名的 UTF-8 字节序。
 * （"EOS" 作为符号名同样取其 UTF-8 字节参与排序。）
 */
export function canonicalOrder(entries) {
    return [...entries].sort((x, y) => {
        if (x.length !== y.length)
            return x.length - y.length;
        return compareByteArrays(utf8Bytes(x.symbol), utf8Bytes(y.symbol));
    });
}
/**
 * 从长度表按固定顺序重建规范码表：按规范顺序遍历符号，
 * 码字从 0 开始连续分配，码长增加时左移。
 * 若某一步码字值超出当前码长可表示的范围，则长度表违反 Kraft 不等式，
 * 即超额订码（OVERSUBSCRIBED）。允许 Kraft 和 < 1 的不完整码表。
 */
export function buildCodeTable(entries) {
    const sorted = canonicalOrder(entries);
    const table = [];
    let value = 0;
    let prevLength = 0;
    for (const { symbol, length } of sorted) {
        value <<= length - prevLength;
        if (value >= 2 ** length) {
            fail("OVERSUBSCRIBED", `code lengths are oversubscribed: no ${length}-bit codeword left for symbol ` +
                `${JSON.stringify(symbol)} (Kraft sum exceeds 1)`, 0);
        }
        table.push({ symbol, length, value, code: value.toString(2).padStart(length, "0") });
        value += 1;
        prevLength = length;
    }
    return table;
}
