#!/usr/bin/env bash
# MiniNostrApp 自动发布流程
#
# 门禁：单元测试 + 回归测试 + 类型检查全部通过，才允许 push 到 mxx/MiniNostrApp。
# 任何一步失败 → 非零退出，不推送，不留半截状态。
#
# 用法：
#   scripts/release.sh          # 全流程：测试 -> 类型检查 -> 干净检查 -> push
#   scripts/release.sh --check  # 只跑测试 + 类型检查，不 push（本地验证 / CI 用）
#
# 推送走 SSH 跳板链（sandbox 直连 github.com:22 被 egress 代理墙掉）：
#   sandbox -> 127.0.0.1:2223 -> lulin.org -> ff.fudu.space -> github.com
# 私钥 ~/.bridge/ssh-tunnel 绝不打印、不写入文件、不进日志。

set -euo pipefail

MODE="${1:-release}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

log() { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

cleanup_agent() { ssh-agent -k >/dev/null 2>&1 || true; }
trap cleanup_agent EXIT

log "[1/4] 单元测试 + 回归测试 (bun test)"
command -v bun >/dev/null 2>&1 || fail "需要 bun 运行测试"
bun test || fail "测试失败，拒绝发布"

log "[2/4] 类型检查 (tsc --noEmit)"
TSC="$REPO_DIR/../node_modules/.bin/tsc"
[ -x "$TSC" ] || fail "找不到 $TSC（需在 ts-spaces/nostr-2 下装好依赖）"
"$TSC" --noEmit -p "$REPO_DIR/tsconfig.json" || fail "类型检查失败，拒绝发布"

if [ "$MODE" = "--check" ]; then
  log "检查模式：测试与类型检查通过，未推送。"
  trap - EXIT
  exit 0
fi

log "[3/4] 工作区干净检查"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fail "有未提交的修改，先 git add/commit 再发布"
fi

log "[4/4] 推送到 mxx/MiniNostrApp"
ss -ltn 2>/dev/null | grep -q "127.0.0.1:2223" \
  || fail "隧道 127.0.0.1:2223 未监听，无法推送（先重启 tunnel-supervisor）"

eval "$(ssh-agent -s)" >/dev/null 2>&1
ssh-add ~/.bridge/ssh-tunnel
export GIT_SSH_COMMAND="ssh -o ProxyCommand='ssh -A -p 2223 -i ~/.bridge/ssh-tunnel -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 mi@127.0.0.1 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -W %h:%p mi@ff.fudu.space' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=25"

git fetch origin || fail "git fetch 失败"
# 允许推送当且仅当 origin/main 是本地 HEAD 的祖先（即本地领先或一致）；
# 若已分叉（diverged），必须先 rebase。
git merge-base --is-ancestor "origin/main" HEAD \
  || fail "本地与 origin/main 已分叉，先 rebase 再发布"

git push origin main || fail "git push 失败"
log "发布成功"
