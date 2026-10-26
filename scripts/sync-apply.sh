#!/bin/sh
# 远端执行：把上传的 studio 快照覆盖到 /opt/ekko-src
# 参数：--delete 时顺带删除目标里多出来的文件（受保护路径除外）
set -e

STAGE=/root/ekko-sync/stage
TAR=/root/ekko-upload/studio-sync.tgz
DEST=/opt/ekko-src

if [ ! -f "$TAR" ]; then
  echo "缺少 $TAR" >&2
  exit 1
fi
if [ ! -d "$DEST" ]; then
  echo "缺少 $DEST" >&2
  exit 1
fi

DEL=""
if [ "$1" = "--delete" ]; then
  DEL="--delete"
  echo "模式：覆盖 + 删除"
else
  echo "模式：仅覆盖"
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "$TAR" -C "$STAGE"

if command -v rsync >/dev/null 2>&1; then
  rsync -a $DEL \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'pnpm-lock.yaml' \
    --exclude 'pnpm-workspace.yaml' \
    --exclude 'packages/server/data' \
    --exclude '.hermes-web-ui' \
    --exclude '.env' \
    --exclude '.env.local' \
    "$STAGE/studio/" "$DEST/"
else
  echo "服务器上没有 rsync，退回 cp -a（不处理删除）"
  cp -a "$STAGE/studio/." "$DEST/"
fi

rm -rf "$STAGE"
echo "落地目录：$DEST"
echo "改动文件数：$(git -C "$DEST" status --porcelain | wc -l)"
