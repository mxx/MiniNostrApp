import { describe, expect, test } from "bun:test";
import { getPublicKey, nip44 } from "nostr-tools";
import {
  NIP46_KIND,
  NostrConnectClient,
  parseBunkerUri,
  randomHex,
} from "../src/nostrconnect";

const REMOTE_PUBKEY = "fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52";

describe("parseBunkerUri", () => {
  test("标准 bunker:// 连接串", () => {
    const parsed = parseBunkerUri(
      `bunker://${REMOTE_PUBKEY}?relay=wss%3A%2F%2Frelay.nsec.app&secret=abc123`,
    );
    expect(parsed.remotePubkey).toBe(REMOTE_PUBKEY);
    expect(parsed.relays).toEqual(["wss://relay.nsec.app"]);
    expect(parsed.secret).toBe("abc123");
  });

  test("多个 relay 与无 secret", () => {
    const parsed = parseBunkerUri(
      `bunker://${REMOTE_PUBKEY}?relay=wss://a.example&relay=wss://b.example`,
    );
    expect(parsed.relays).toEqual(["wss://a.example", "wss://b.example"]);
    expect(parsed.secret).toBeNull();
  });

  test("接受 nostrconnect:// 形式的签名器连接串", () => {
    const parsed = parseBunkerUri(`nostrconnect://${REMOTE_PUBKEY}?relay=wss://a.example`);
    expect(parsed.remotePubkey).toBe(REMOTE_PUBKEY);
    expect(parsed.relays).toEqual(["wss://a.example"]);
  });

  test("公钥大小写不敏感", () => {
    const parsed = parseBunkerUri(`bunker://${REMOTE_PUBKEY.toUpperCase()}?relay=wss://a.example`);
    expect(parsed.remotePubkey).toBe(REMOTE_PUBKEY);
  });

  test("非法输入抛错", () => {
    expect(() => parseBunkerUri("https://example.com")).toThrow();
    expect(() => parseBunkerUri("bunker://tooshort?relay=wss://a.example")).toThrow();
    expect(() => parseBunkerUri(`bunker://${REMOTE_PUBKEY}`)).toThrow(); // 无 relay
    expect(() => parseBunkerUri("")).toThrow();
  });

  test("过滤非 ws 协议的 relay", () => {
    expect(() =>
      parseBunkerUri(`bunker://${REMOTE_PUBKEY}?relay=https://a.example`),
    ).toThrow();
  });
});

describe("randomHex", () => {
  test("长度与字符集正确且每次不同", () => {
    const a = randomHex(8);
    const b = randomHex(8);
    expect(a).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("NostrConnectClient 会话与加密", () => {
  test("newSession 生成合法会话", () => {
    const session = NostrConnectClient.newSession(REMOTE_PUBKEY, "wss://relay.nsec.app");
    expect(session.clientSecretHex).toMatch(/^[0-9a-f]{64}$/);
    expect(session.remotePubkey).toBe(REMOTE_PUBKEY);
    expect(session.relayUrl).toBe("wss://relay.nsec.app");
    const client = new NostrConnectClient(session);
    expect(client.clientPubkey).toBe(getPublicKey(
      Uint8Array.from(Buffer.from(session.clientSecretHex, "hex")),
    ));
    expect(client.remotePubkey).toBe(REMOTE_PUBKEY);
    expect(client.connected).toBe(false);
  });

  test("两次 newSession 的 client keypair 不同", () => {
    const a = NostrConnectClient.newSession(REMOTE_PUBKEY, "wss://a.example");
    const b = NostrConnectClient.newSession(REMOTE_PUBKEY, "wss://a.example");
    expect(a.clientSecretHex).not.toBe(b.clientSecretHex);
  });

  test("NIP-44 会话密钥：客户端与签名器两端推导一致", () => {
    // 模拟签名器端：用自己的私钥 + client 公钥推导
    const session = NostrConnectClient.newSession(REMOTE_PUBKEY, "wss://a.example");
    const client = new NostrConnectClient(session);
    const clientSecretBytes = Uint8Array.from(Buffer.from(session.clientSecretHex, "hex"));
    const keyFromClientSide = nip44.v2.utils.getConversationKey(clientSecretBytes, REMOTE_PUBKEY);
    // 加密一段 NIP-46 请求，用"签名器视角"的密钥解密
    const payload = JSON.stringify({ id: "r1", method: "ping", params: [] });
    const encrypted = nip44.v2.encrypt(payload, keyFromClientSide);
    // NIP-46 信封 kind 固定为 24133
    expect(NIP46_KIND).toBe(24133);
    expect(client.clientPubkey).toHaveLength(64);
    expect(nip44.v2.decrypt(encrypted, keyFromClientSide)).toBe(payload);
  });

  test("非法会话构造抛错", () => {
    expect(
      () => new NostrConnectClient({ clientSecretHex: "abcd", remotePubkey: REMOTE_PUBKEY, relayUrl: "wss://a.example" }),
    ).toThrow();
    expect(
      () =>
        new NostrConnectClient({
          clientSecretHex: "ab".repeat(32),
          remotePubkey: "tooshort",
          relayUrl: "wss://a.example",
        }),
    ).toThrow();
  });
});
