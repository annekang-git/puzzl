#!/bin/bash
# sync-kids-data.sh
# 최신 dresscode 데이터에서 키즈 상품만 추출하여 data/dresscode-kids.json 갱신 후 git push
# 크론탭: 13 7 * * * (매일 07:13)

cd /Users/anne/CascadeProjects/windsurf-project-2/cafe24-oauth

NODE=/opt/homebrew/Cellar/node/25.2.1/bin/node
DATA_DIR=grifo-crawler/sync/sync-data
OUT_FILE=data/dresscode-kids.json

echo "$(date '+%Y-%m-%d %H:%M:%S') 키즈 데이터 동기화 시작"

# 1. 키즈 상품 추출
$NODE --input-type=module -e "
import fs from 'fs';
const files = fs.readdirSync('${DATA_DIR}')
  .filter(f => /^dresscode_products_\\\\d{4}/.test(f)).sort().reverse();
if (files.length === 0) { console.error('데이터 파일 없음'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync('${DATA_DIR}/' + files[0], 'utf8'));
const all = raw.raw_api_response || raw.products || [];
const kids = all.filter(p => {
  const g = (p.genre || '').trim();
  return g.startsWith('Baby') || g === 'Unisex baby';
});
const output = { dataDate: files[0].match(/\\\\d{4}-\\\\d{2}-\\\\d{2}/)[0], total: kids.length, updatedAt: new Date().toISOString(), products: kids };
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('${OUT_FILE}', JSON.stringify(output));
console.log(files[0] + ' → 키즈 ' + kids.length + '개 추출');
"

if [ $? -ne 0 ]; then
  echo "❌ 키즈 데이터 추출 실패"
  exit 1
fi

# 2. git commit & push
git add data/dresscode-kids.json
git add server.js 2>/dev/null

# 변경사항이 있을 때만 커밋
if git diff --cached --quiet; then
  echo "✅ 변경 없음, push 스킵"
else
  git commit -m "Update kids product data $(date '+%Y-%m-%d')"
  git push origin main
  echo "✅ push 완료"
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') 완료"
