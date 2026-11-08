#!/usr/bin/env bash
# 编译浮窗进程（通用二进制）。和 bridge/build.sh 同一套理由：
# 发出去要能跑在 Intel 上，所以两个架构都编，再 lipo 合并。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "缺 swiftc：先装 Xcode Command Line Tools（xcode-select --install）" >&2
  exit 1
fi

mkdir -p bin .build

build_slice() {
  local arch="$1" out="$2"
  swiftc -O -target "${arch}-apple-macos11" -module-cache-path ./.build/cache -framework Carbon -o "$out" Buddy.swift
}

if build_slice arm64 .build/dsh-buddy-arm64 && build_slice x86_64 .build/dsh-buddy-x64; then
  lipo -create .build/dsh-buddy-arm64 .build/dsh-buddy-x64 -output bin/dsh-buddy
  rm -rf .build
else
  echo "交叉编译失败，退回本机架构" >&2
  swiftc -O -module-cache-path ./.build/cache -framework Carbon -o bin/dsh-buddy Buddy.swift
fi
chmod +x bin/dsh-buddy
echo "已生成：$(pwd)/bin/dsh-buddy"
file bin/dsh-buddy
