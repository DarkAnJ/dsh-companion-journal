#!/usr/bin/env bash
# 编译原生桥，产出**通用二进制**（arm64 + x86_64）。
#
# 为什么必须 universal：插件是要发出去给别人装的。只编本机架构的话，Intel Mac
# 上会以 "Bad CPU type in executable" 失败，而那个错误看起来像插件坏了，不像
# 架构不匹配。两个切片加起来不到 200KB，没有理由省。
#
# 为什么不让 pnpm install 自动编译：包管理器的依赖构建脚本默认被拦（需要用户
# 逐个批准），所以发布时必须带上编译好的产物；源码只用于排障与重编。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "缺 swiftc：先装 Xcode Command Line Tools（xcode-select --install）" >&2
  exit 1
fi

mkdir -p bin .build

build_slice() {
  local arch="$1" out="$2"
  # 模块缓存放在包内，避免写到 ~/Library/Developer 触发沙箱拒绝。
  swiftc -O -target "${arch}-apple-macos11" -module-cache-path ./.build/cache -o "$out" DshBridge.swift
}

# 任一架构编译失败就退回本机架构：能跑永远比「架构齐全但装不上」强。
if build_slice arm64 .build/dsh-bridge-arm64 && build_slice x86_64 .build/dsh-bridge-x64; then
  lipo -create .build/dsh-bridge-arm64 .build/dsh-bridge-x64 -output bin/dsh-bridge
  rm -rf .build
  echo "已生成通用二进制：$(pwd)/bin/dsh-bridge"
else
  echo "交叉编译失败，退回本机架构" >&2
  swiftc -O -module-cache-path ./.build/cache -o bin/dsh-bridge DshBridge.swift
  echo "已生成本机架构二进制：$(pwd)/bin/dsh-bridge"
fi

chmod +x bin/dsh-bridge
file bin/dsh-bridge

# 自检：不需要任何权限就能跑的子命令，用来确认二进制没坏。
./bin/dsh-bridge trust || true
