#!/bin/bash
# ============================================================
# 사용자 레벨 셋업 — puzzl 유저로 실행
# Repo clone + npm install + Playwright 브라우저 설치
#
# 사용법 (puzzl 으로 SSH 접속한 상태):
#   git clone https://github.com/annekang-git/puzzl.git
#   bash puzzl/infra/vps/setup-user.sh
# ============================================================
set -euo pipefail

REPO_DIR="$HOME/puzzl"
REPO_URL="${REPO_URL:-https://github.com/annekang-git/puzzl.git}"

step() { echo ""; echo "════════════════════════════════════════"; echo "📦 $*"; echo "════════════════════════════════════════"; }

# whoami 검증
if [ "$(whoami)" = "root" ]; then
  echo "❌ root 가 아닌 puzzl 유저로 실행하세요"
  exit 1
fi

step "[1/6] Repo 확인 (이미 있으면 git pull, 없으면 clone)"
if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR"
  git pull --ff-only
else
  git clone "$REPO_URL" "$REPO_DIR"
  cd "$REPO_DIR"
fi

step "[2/6] 루트 npm install"
cd "$REPO_DIR"
if [ -f package.json ]; then
  npm install --omit=dev
fi

step "[3/6] kream/ npm install + Playwright 명시 설치"
cd "$REPO_DIR/kream"
if [ -f package.json ]; then
  # Playwright 가 devDependencies 라 명시적으로 설치
  npm install
  npm install playwright
fi

step "[4/6] grifo-crawler/ npm install (Playwright 의존)"
if [ -f "$REPO_DIR/grifo-crawler/package.json" ]; then
  cd "$REPO_DIR/grifo-crawler"
  npm install
fi

step "[5/6] grifo-crawler/sync/ npm install (있는 경우)"
if [ -f "$REPO_DIR/grifo-crawler/sync/package.json" ]; then
  cd "$REPO_DIR/grifo-crawler/sync"
  npm install
fi

step "[6/6] Playwright Chromium 브라우저 다운로드 (~200MB)"
cd "$REPO_DIR/kream"
npx playwright install chromium

# (Playwright 가 의존하는 시스템 라이브러리 — Hetzner 기본 Ubuntu 에 보통 다 있지만 안전망)
sudo npx playwright install-deps chromium 2>&1 | grep -v "^Skipping" || true

# logs 폴더
mkdir -p "$HOME/logs"

cat <<EOF

╔════════════════════════════════════════════════════════════╗
║  ✅ puzzl 유저 셋업 완료                                     ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  🔑 다음 단계 — Mac mini 에서 자격증명/세션 복사:              ║
║                                                            ║
║  rsync -avz --progress -e ssh \\                            ║
║    /Users/anne/CascadeProjects/windsurf-project-2/         ║
║      cafe24-oauth/kream/.env \\                             ║
║      cafe24-oauth/kream/.browser-data/ \\                   ║
║    puzzl@<VPS_IP>:~/puzzl/kream/                           ║
║                                                            ║
║  자세한 secrets 목록 + rsync 명령:                            ║
║    cat ~/puzzl/infra/vps/README.md                         ║
║                                                            ║
║  Secrets 복사 후 crontab 등록:                               ║
║    crontab ~/puzzl/infra/vps/crontab.txt                   ║
║    crontab -l                                              ║
║                                                            ║
║  검증:                                                       ║
║    cd ~/puzzl/kream                                        ║
║    xvfb-run -a node fetch-product-market.js \\              ║
║      targets-tomford.json   # 작은 브랜드 1개 테스트          ║
╚════════════════════════════════════════════════════════════╝
EOF
