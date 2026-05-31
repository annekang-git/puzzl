/**
 * build-targets-from-diff.js
 * 최신 dresscode_diff_*.json 의 to_add 목록에서 KREAM 검색 타겟 생성
 *
 * 입력: dresscode_diff_YYYY-MM-DD.json (가장 최신, 자동 선택)
 *       -- dresscode.to_add[] = cafe24에 없어서 새로 추가해야 하는 dresscode 상품들
 *
 * 출력: targets-from-diff.json
 *   [{ sku, spu, brand, name, option, stock, eur_price, eur_retail }]
 *
 * 사용법:
 *   node build-targets-from-diff.js
 *   node build-targets-from-diff.js /path/to/diff.json  # 특정 파일
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DATA = '/Users/anne/CascadeProjects/windsurf-project-2/cafe24-oauth/grifo-crawler/sync/sync-data';

function findLatestDiff() {
  const files = fs.readdirSync(SYNC_DATA)
    .filter((f) => /^dresscode_diff_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(SYNC_DATA, files[0]) : null;
}

const diffFile = process.argv[2] || findLatestDiff();
if (!diffFile || !fs.existsSync(diffFile)) {
  console.error('❌ diff 파일을 찾을 수 없음:', diffFile);
  process.exit(1);
}
console.log('📥 입력 파일:', diffFile);

const diff = JSON.parse(fs.readFileSync(diffFile, 'utf-8'));
const toAdd = diff?.dresscode?.to_add || [];
console.log(`   to_add: ${toAdd.length}개 상품`);

const targets = [];
const skipped = [];

for (const item of toAdd) {
  const ref = item.reference;
  const brand = item.brand || '';
  const name = item.product_name || '';
  const eurPrice = item.price ?? null;       // 우리 매입원가 (EUR)
  const eurRetail = item.retailPrice ?? null; // 정가 (EUR)
  const sizes = item.crawled_data?.sizes || [];

  if (!ref) {
    skipped.push({ reason: 'no reference', item });
    continue;
  }

  if (sizes.length === 0) {
    // 사이즈 정보 없음 — 옵션 빈 값으로 1건 emit
    targets.push({
      sku: ref,
      spu: item.crawled_data?.spu || null,
      brand, name, option: '',
      stock: null, eur_price: eurPrice, eur_retail: eurRetail,
    });
    continue;
  }

  for (const sz of sizes) {
    // 재고 0 인 사이즈는 스킵
    if ((sz.stock ?? 0) <= 0) continue;
    targets.push({
      sku: ref,
      spu: item.crawled_data?.spu || null,
      brand, name,
      option: String(sz.size || ''),
      stock: sz.stock,
      eur_price: eurPrice,
      eur_retail: eurRetail,
    });
  }
}

const outFile = path.join(__dirname, 'targets-from-diff.json');
fs.writeFileSync(outFile, JSON.stringify(targets, null, 2));
console.log(`\n✅ 생성 완료: ${outFile}`);
console.log(`   총 타겟: ${targets.length}건 (상품 ${toAdd.length}개 × 사이즈)`);
console.log(`   스킵: ${skipped.length}건`);

// 미리보기
console.log('\n📋 미리보기 (처음 10건):');
targets.slice(0, 10).forEach((t, i) => {
  console.log(`   ${i + 1}. ${t.sku} / ${t.option} — ${t.brand} ${t.name.slice(0, 40)} (€${t.eur_price})`);
});
if (targets.length > 10) console.log(`   ... 외 ${targets.length - 10}건`);
