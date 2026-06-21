#!/bin/bash
# ============================================================
# Mac mini → VPS 로 자격증명/세션 파일 일괄 rsync
#
# ⚠️ Mac mini 에서 실행 (VPS 에서 X)
#
# 사용법:
#   bash infra/vps/sync-secrets-from-mac.sh <VPS_IP>
# ============================================================
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "사용법: $0 <VPS_IP>"
  exit 1
fi

VPS_IP="$1"
VPS_USER="puzzl"
REMOTE="${VPS_USER}@${VPS_IP}"
LOCAL_REPO="/Users/anne/CascadeProjects/windsurf-project-2/cafe24-oauth"
REMOTE_REPO="puzzl"

RSYNC_OPTS="-avz --progress --partial -e ssh"

echo "════════════════════════════════════════"
echo "🔑 Secrets sync: Mac mini → ${REMOTE}"
echo "════════════════════════════════════════"

# 헬퍼: 파일/폴더 존재하면 rsync
sync_if_exists() {
  local src="$1"; local dst="$2"
  if [ -e "$src" ]; then
    echo ""
    echo "▸ $src → ${REMOTE}:${dst}"
    rsync $RSYNC_OPTS "$src" "${REMOTE}:${dst}"
  else
    echo "  (skip — $src 없음)"
  fi
}

# ── KREAM ─────────────────────────────────────
echo ""
echo "─── KREAM ───"
sync_if_exists "$LOCAL_REPO/kream/.env"           "${REMOTE_REPO}/kream/.env"
sync_if_exists "$LOCAL_REPO/kream/.browser-data/" "${REMOTE_REPO}/kream/.browser-data/"

# ── Cafe24 / Dresscode / Grifo ─────────────────
echo ""
echo "─── Cafe24 / Dresscode / Grifo ───"
sync_if_exists "$LOCAL_REPO/tokens.json"          "${REMOTE_REPO}/tokens.json"
sync_if_exists "$LOCAL_REPO/tokens_new.json"      "${REMOTE_REPO}/tokens_new.json"
sync_if_exists "$LOCAL_REPO/service-account.json" "${REMOTE_REPO}/service-account.json"
# grifo 관련 .env / .browser-data 가 있다면 추가
sync_if_exists "$LOCAL_REPO/grifo-crawler/.env"            "${REMOTE_REPO}/grifo-crawler/.env"
sync_if_exists "$LOCAL_REPO/grifo-crawler/.browser-data/"  "${REMOTE_REPO}/grifo-crawler/.browser-data/"
sync_if_exists "$LOCAL_REPO/grifo-crawler/sync/.env"       "${REMOTE_REPO}/grifo-crawler/sync/.env"
# Google service account 가 별도 경로에 있다면
for f in $LOCAL_REPO/puzzlwhitelisted-*.json; do
  [ -e "$f" ] && sync_if_exists "$f" "${REMOTE_REPO}/$(basename $f)"
done

# ── Smartstore ────────────────────────────────
echo ""
echo "─── Smartstore ───"
sync_if_exists "$LOCAL_REPO/smartstore/.env"        "${REMOTE_REPO}/smartstore/.env"
sync_if_exists "$LOCAL_REPO/smartstore/tokens.json" "${REMOTE_REPO}/smartstore/tokens.json"
sync_if_exists "$LOCAL_REPO/smartstore/token.json"  "${REMOTE_REPO}/smartstore/token.json"

# ── 권한 정리 (.env 류는 600) ─────────────────
echo ""
echo "─── 권한 정리 (.env 600, .browser-data 700) ───"
ssh "$REMOTE" "find puzzl -name '.env' -exec chmod 600 {} \\; ; find puzzl -name '.browser-data' -type d -exec chmod 700 {} \\; ; find puzzl -name 'tokens*.json' -exec chmod 600 {} \\; ; find puzzl -name 'service-account.json' -o -name 'puzzlwhitelisted-*.json' -exec chmod 600 {} \\; 2>/dev/null ; echo '권한 설정 완료'"

echo ""
echo "════════════════════════════════════════"
echo "✅ Secrets sync 완료"
echo "════════════════════════════════════════"
echo ""
echo "다음 단계 (VPS 에서):"
echo "  ssh ${REMOTE}"
echo "  crontab puzzl/infra/vps/crontab.txt"
echo "  crontab -l    # 확인"
echo ""
echo "검증 (작은 브랜드 1개 KREAM 테스트):"
echo "  cd puzzl/kream"
echo "  xvfb-run -a node fetch-product-market.js targets-tomford.json"
