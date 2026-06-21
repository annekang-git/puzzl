#!/bin/bash
# ============================================================
# VPS 코드 즉시 업데이트 — Mac mini 에서 git push 후 VPS 에서 실행
#
# 사용법:
#   ssh puzzl@<VPS_IP> bash puzzl/infra/vps/update.sh
#
# 또는 일상적으로는 crontab 의 01:00 자동 git pull 에 맡김
# ============================================================
set -euo pipefail

REPO_DIR="$HOME/puzzl"
cd "$REPO_DIR"

echo "📥 git pull..."
OLD_HEAD=$(git rev-parse HEAD)
git pull --ff-only
NEW_HEAD=$(git rev-parse HEAD)

if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  echo "ℹ️  변경 없음."
  exit 0
fi

echo "📋 변경된 파일:"
git diff --name-only "$OLD_HEAD" "$NEW_HEAD"

# package.json 변경 감지 → 자동 npm install
declare -a PKG_DIRS=("." "kream" "grifo-crawler" "grifo-crawler/sync")
NEEDS_INSTALL=0
for d in "${PKG_DIRS[@]}"; do
  if git diff "$OLD_HEAD" "$NEW_HEAD" --name-only | grep -q "^${d#./}package.json"; then
    echo "📦 $d/package.json 변경됨"
    NEEDS_INSTALL=1
    (cd "$REPO_DIR/$d" && npm install) || echo "  ⚠️ $d npm install 실패"
  fi
done

# crontab.txt 변경 감지 → 자동 등록
if git diff "$OLD_HEAD" "$NEW_HEAD" --name-only | grep -q "^infra/vps/crontab.txt"; then
  echo "⏰ crontab.txt 변경됨 → 재등록"
  crontab "$REPO_DIR/infra/vps/crontab.txt"
  crontab -l
fi

# setup-*.sh 변경 감지 → 경고만 (자동 실행은 위험)
if git diff "$OLD_HEAD" "$NEW_HEAD" --name-only | grep -qE "^infra/vps/setup-(root|user)\.sh"; then
  echo "⚠️  setup-*.sh 가 변경됨. 필요 시 수동 재실행:"
  echo "     bash $REPO_DIR/infra/vps/setup-user.sh"
fi

echo "✅ update 완료 $(date)"
