/**
 * cleanup-old-results.js
 * kream/results/ 의 결과 파일을 정리한다.
 *   1) 브랜드별 (kream_market_{slug}_MMDD.json) 최근 N일치만 유지
 *   2) orphan raw partial 파일 (kream_market_YYYY-MM-DD_HHMMSS.json) 모두 삭제
 *      — daily 스크립트가 rename 못한 crash 잔재
 *
 * 사용법:
 *   node cleanup-old-results.js              # 기본: 3일치 유지
 *   node cleanup-old-results.js --keep=7     # N 일치 유지
 *   node cleanup-old-results.js --dry-run    # 실제 삭제 없이 미리보기
 *
 * daily-kream-update.js 마지막 단계에서도 호출됨.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

// CLI 옵션
const args = process.argv.slice(2);
const KEEP = Number((args.find((a) => a.startsWith('--keep=')) || '--keep=3').split('=')[1]);
const DRY_RUN = args.includes('--dry-run');

if (!fs.existsSync(RESULTS_DIR)) {
  console.log(`results/ 폴더 없음 — 정리할 게 없음`);
  process.exit(0);
}

console.log(`📂 ${RESULTS_DIR}`);
console.log(`   브랜드당 유지: ${KEEP}개${DRY_RUN ? '  [DRY-RUN]' : ''}`);

const files = fs.readdirSync(RESULTS_DIR);

// 1) 브랜드별 그룹핑 — kream_market_{slug}_MMDD.json
const BRAND_RE = /^kream_market_([a-z0-9_]+)_(\d{4})\.json$/;
const byBrand = {};
for (const f of files) {
  const m = f.match(BRAND_RE);
  if (!m) continue;
  const slug = m[1];
  const stat = fs.statSync(path.join(RESULTS_DIR, f));
  (byBrand[slug] = byBrand[slug] || []).push({ f, mtime: stat.mtimeMs });
}

let totalKept = 0, totalTargetedForDelete = 0, totalActuallyDeleted = 0;

for (const slug of Object.keys(byBrand).sort()) {
  const list = byBrand[slug].sort((a, b) => b.mtime - a.mtime); // 최신 → 오래된
  const keep = list.slice(0, KEEP);
  const remove = list.slice(KEEP);
  totalKept += keep.length;
  totalTargetedForDelete += remove.length;

  console.log(`\n🏷  ${slug}  (${list.length}개 발견)`);
  for (const k of keep) console.log(`   ✓ keep:   ${k.f}`);
  for (const r of remove) {
    console.log(`   ✗ delete: ${r.f}`);
    if (!DRY_RUN) {
      fs.unlinkSync(path.join(RESULTS_DIR, r.f));
      totalActuallyDeleted++;
    }
  }
}

// 2) orphan raw partial — kream_market_YYYY-MM-DD_HHMMSS.json (rename 안 된 crash 잔재)
const RAW_RE = /^kream_market_\d{4}-\d{2}-\d{2}_\d{6}\.json$/;
const orphans = files.filter((f) => RAW_RE.test(f));
if (orphans.length > 0) {
  console.log(`\n🗑  orphan raw partial (rename 안 된 crash 잔재): ${orphans.length}개`);
  for (const o of orphans) {
    console.log(`   ✗ delete: ${o}`);
    if (!DRY_RUN) {
      fs.unlinkSync(path.join(RESULTS_DIR, o));
      totalActuallyDeleted++;
    }
  }
}
totalTargetedForDelete += orphans.length;

console.log(`\n📊 결과: keep ${totalKept}개  ·  ${DRY_RUN ? `would delete ${totalTargetedForDelete}개` : `deleted ${totalActuallyDeleted}개`}`);
