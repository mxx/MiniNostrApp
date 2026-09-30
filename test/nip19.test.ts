import { describe, expect, test } from "bun:test";
import { encodeNip19 } from "../src/App";
import { SAMPLE_HEX_ID, SAMPLE_HEX_PUBKEY, TRUTH_HEX, TRUTH_NPUB, bech32Decode } from "./fixtures";

describe("encodeNip19", () => {
  test("真值向量：独立验证过的 npub 编码一致", () => {
    // 该向量经 workspace/wg/nostr.py（libsecp256k1 交叉验证）独立确认
    expect(encodeNip19("npub", TRUTH_HEX)).toBe(TRUTH_NPUB);
  });

  test("round-trip：编码后用独立解码器还原得到原 hex", () => {
    for (const hex of [SAMPLE_HEX_PUBKEY, SAMPLE_HEX_ID, "ff".repeat(32), "00".repeat(32)]) {
      for (const prefix of ["npub", "note"] as const) {
        const encoded = encodeNip19(prefix, hex);
        const decoded = bech32Decode(encoded);
        expect(decoded.prefix).toBe(prefix);
        expect(decoded.bytesHex).toBe(hex.toLowerCase());
      }
    }
  });

  test("note 编码结构：前缀 + 63 字符 + bech32 字符集", () => {
    const encoded = encodeNip19("note", SAMPLE_HEX_ID);
    expect(encoded.startsWith("note1")).toBe(true);
    expect(encoded).toHaveLength(63);
    expect(/^[0-9a-z]+$/.test(encoded)).toBe(true);
  });

  test("不同输入产生不同编码", () => {
    expect(encodeNip19("npub", SAMPLE_HEX_PUBKEY)).not.toBe(encodeNip19("npub", SAMPLE_HEX_ID));
  });

  test("非法 hex 原样返回（不抛错）", () => {
    expect(encodeNip19("npub", "not-hex")).toBe("not-hex");
    expect(encodeNip19("npub", "abcd")).toBe("abcd");
  });
});
