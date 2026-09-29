# MiniNostrApp

极简 Nostr 网页客户端。纯前端，无后端，可部署在任何静态服务器上。

在线使用：http://lulin.org/client/

## 特性

- 浏览 kind-1 公开帖子，多 relay 去重
- 发帖（NIP-07 浏览器签名，私钥不经过页面）
- relay 面板：运行时添加/删除/开关，在线状态显示
- 支持 `ws://` 和 `wss://`（HTTP 页面下无 mixed content 限制）
- 默认 relay：`ws://lulin.org`、`wss://relay.gulugulu.moe`、`wss://relay-jp.nostr.wirednet.jp`、`wss://relay.nostr.wirednet.jp`

## 本地运行

```bash
# 构建（需要 node）
node build.mjs

# 预览
npx serve dist
```

构建产物在 `dist/`，直接丢到任何静态文件服务器即可。

## 协议支持

NIP-01（REQ/EVENT/EOSE）、NIP-07（签名）、NIP-11（relay 信息）

## License

Unlicense — 公有领域，见 [LICENSE](LICENSE)。
