# MiniNostrApp

极简 Nostr 网页客户端。纯前端，无后端，可部署在任何静态服务器上。

在线使用：http://lulin.org/client/

## 特性

- 浏览 kind-1 公开帖子，多 relay 去重
- 发帖（NIP-07 浏览器签名，私钥不经过页面）
- 资讯源面板：运行时添加/删除/开关，在线状态显示
- 支持 `ws://` 和 `wss://`（HTTP 页面下无 mixed content 限制）
- 默认资讯源：`wss://lulin.org`、`wss://relay.gulugulu.moe`、`wss://relay-jp.nostr.wirednet.jp`、`wss://relay.nostr.wirednet.jp`
- 等尺寸卡片网格：帖子按统一大小 box 排列，长内容自动折叠并提示，点击展开全文
- 浏览模式：**自动**（默认）固定网格——无页面滚动、无切换动画，新帖进入左上角，其余内容按从左到右、从上到下顺移；**手动**——等尺寸网格，滚动浏览，右上角按钮手动刷新
- 回复：卡片与详情页的「回复」按钮，按 NIP-10 生成 `e`（带资讯源提示 + reply 标记）/`p` 标签，经 NIP-07 签名发布
- 用户 profile：拉取 kind-0 资料（名字/头像/简介），按 profile 显示作者
- 关注：kind-3 联系人列表读取与编辑（需 NIP-07 签名器），未连接时本地保存
- 离线可用：Service Worker 缓存 app shell，帖子 feed 持久化到 localStorage，断网/重启浏览器后无需重新下载即可打开

## 离线机制

- `sw.js`：安装时预缓存 `./` 与 `./index.html`；同源 GET 请求 cache-first（带 hash 的 bundle 文件名无需写死，运行时缓存）；navigation 离线时回退到缓存的 index.html；绝不拦截跨域 relay 流量。每次发布若 bundle 变化，记得 bump `sw.js` 里的 `CACHE_VERSION`。
- 帖子 feed：`loadCachedEvents` / `saveCachedEvents`（`src/App.tsx`），上限 `MAX_EVENTS` 条，节流写入 + `pagehide` 兜底；损坏数据自动丢弃。
- 纯 HTTP 站点（如 `http://lulin.org`）不是 secure context，浏览器会禁用 Service Worker；此时靠 HTTP 磁盘缓存 + 持久化数据实现"重启免下载"。建议 nginx 配置：

```nginx
location /client/ {
    # sw.js 与 index.html：每次都向源站确认，保证更新及时下发
    location ~ ^/client/(sw\.js|index\.html)$ { add_header Cache-Control "no-cache"; }
    # 带 hash 的 bundle 资源：永久缓存
    location ~ ^/client/assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
```

## 本地运行

```bash
# 构建（需要 node）
node build.mjs

# 预览
npx serve dist
```

构建产物在 `dist/`，直接丢到任何静态文件服务器即可。

## 依赖

- 运行时依赖由上层 `ts-spaces/nostr-2/package.json` 提供（`bun install` 在 `ts-spaces/nostr-2/` 下执行）。
- NIP-46 远程签名需要 `nostr-tools`（NIP-44 加密、Schnorr 签名 24133 信封）。

## 测试

```bash
cd ~/workspace/ts-spaces/nostr-2/client
bun test                  # 单元测试 + 回归测试（含显示交叉检查）
../node_modules/.bin/tsc --noEmit -p tsconfig.json   # 类型检查
```

- `test/`：测试夹具（`fixtures.ts`）+ 测试用例，`bun test` 运行。
- `test/styles.test.ts`：显示回归检查 —— 设计 token 完整性、App.tsx 引用的 CSS 类都有定义、等尺寸卡片网格布局不变量。
- 每次 bug 修复 / 功能修改都必须同步补充单元测试。

## 发布流程

发布必须走 `scripts/release.sh`，它强制门禁：**全部测试 + 类型检查通过 → 工作区干净 → 与远端一致 → 才 push**。任何一步失败都不会推送。

```bash
scripts/release.sh           # 全流程发布
scripts/release.sh --check  # 只跑测试+类型检查，不推送
```

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
