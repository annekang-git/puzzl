/**
 * build-targets-from-tsv.js
 * TSV (사이즈 / B2B상품코드 / KREAM상품코드) → KREAM 검색용 targets.json
 *
 * 입력: input-kream-codes.tsv (또는 인자로 전달)
 * 출력: targets-from-tsv.json
 *
 * 사용법:
 *   node build-targets-from-tsv.js
 *   node build-targets-from-tsv.js path/to/file.tsv
 *
 * dresscode 캐시에서 B2B 상품코드로 EUR 가격을 lookup 해서 함께 저장
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DATA = '/Users/anne/CascadeProjects/windsurf-project-2/cafe24-oauth/grifo-crawler/sync/sync-data';

const inputFile = process.argv[2] || path.join(__dirname, 'input-kream-codes.tsv');
if (!fs.existsSync(inputFile)) {
  console.error('❌ 입력 파일 없음:', inputFile);
  process.exit(1);
}

// 1) TSV 파싱
const lines = fs.readFileSync(inputFile, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
const header = lines[0].split('\t');
console.log(`📥 TSV 입력: ${inputFile} (${lines.length - 1}행)`);

const rawRows = lines.slice(1).map((l) => {
  const [size, b2b, kream] = l.split('\t').map((s) => s.trim());
  return { size, b2b, kream };
}).filter((r) => r.size && r.b2b && r.kream);
console.log(`   유효 행: ${rawRows.length}`);

// 2) dresscode 캐시 로드 (B2B SKU → EUR price lookup)
function findLatestDresscodeCache() {
  const files = fs.readdirSync(SYNC_DATA)
    .filter((f) => /^dresscode_products_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(SYNC_DATA, files[0]) : null;
}

const cachePath = findLatestDresscodeCache();
let skuMap = new Map(); // b2b sku → { eur_price, eur_retail, brand, name }
if (cachePath) {
  console.log(`📦 dresscode 캐시: ${path.basename(cachePath)}`);
  const arr = JSON.parse(fs.readFileSync(cachePath, 'utf-8')).products || JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  for (const p of arr) {
    const k = (p.reference || p.sku || '').toUpperCase();
    if (!k) continue;
    skuMap.set(k, {
      eur_price: p.price,
      eur_retail: p.retailPrice,
      brand: p.brand,
      name: p.name,
      spu: p.spu,
    });
  }
  console.log(`   캐시 SKU 인덱스: ${skuMap.size}개`);
}

// 3) targets 생성
const targets = rawRows.map((r) => {
  const info = skuMap.get(r.b2b.toUpperCase()) || {};
  return {
    sku: r.kream, // 검색 키 = KREAM 상품코드 (대시 포함 그대로)
    spu: r.kream.split('-')[0] || null, // 첫 부분만 분리 (fallback 검색용)
    b2b_sku: r.b2b,
    option: r.size,
    brand: info.brand || null,
    name: info.name || null,
    eur_price: info.eur_price ?? null,
    eur_retail: info.eur_retail ?? null,
  };
});

const outFile = path.join(__dirname, 'targets-from-tsv.json');
fs.writeFileSync(outFile, JSON.stringify(targets, null, 2));

const withPrice = targets.filter((t) => t.eur_price != null).length;
const uniqueKream = new Set(targets.map((t) => t.sku)).size;
console.log(`\n✅ 생성 완료: ${outFile}`);
console.log(`   총 타겟: ${targets.length}건 (KREAM 코드 고유 ${uniqueKream}개)`);
console.log(`   EUR 가격 매칭: ${withPrice}/${targets.length}`);

console.log('\n📋 미리보기 (처음 10건):');
targets.slice(0, 10).forEach((t, i) => {
  const p = t.eur_price != null ? `€${t.eur_price}` : 'EUR?';
  console.log(`   ${i + 1}. KREAM=${t.sku} / ${t.option} ${t.brand ? `(${t.brand})` : ''} ${p}`);
});
