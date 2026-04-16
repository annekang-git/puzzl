#!/bin/bash
# sync-kids-data.sh
# 최신 dresscode 데이터에서 키즈 상품만 추출하여 data/dresscode-kids.json 갱신 후 git push
# 가격은 KRW로 변환되어 저장됨 (25% 마진 + 원산지/금액대/신발 정책 유지)
# 크론탭: 13 7 * * * (매일 07:13)

cd /Users/anne/CascadeProjects/windsurf-project-2/cafe24-oauth

NODE=/opt/homebrew/Cellar/node/25.2.1/bin/node
OUT_FILE=data/dresscode-kids.json

echo "$(date '+%Y-%m-%d %H:%M:%S') 키즈 데이터 동기화 시작"

# 1. 키즈 상품 추출 + 가격 변환 (build-kids-data.js 가 data/dresscode-kids.json 생성)
$NODE build-kids-data.js
if [ $? -ne 0 ]; then
  echo "❌ 키즈 데이터 빌드 실패"
  exit 1
fi

# 2. git commit & push
git add "$OUT_FILE"
git add server.js 2>/dev/null
git add build-kids-data.js 2>/dev/null

# 변경사항이 있을 때만 커밋
if git diff --cached --quiet; then
  echo "✅ 변경 없음, push 스킵"
else
  git commit -m "Update kids product data $(date '+%Y-%m-%d')"
  git push origin main
  echo "✅ push 완료"
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') 완료"
