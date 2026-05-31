/**
 * build-targets-by-brand.js
 * 최신 dresscode_products_*.json 에서 지정된 브랜드들을 뽑아 KREAM 검색용 targets 파일로 출력.
 *
 * 사용법:
 *   node build-targets-by-brand.js "THOM BROWNE:tombrown" "STONE ISLAND:stoneisland" "GUCCI:gucci"
 *     → targets-tombrown.json, targets-stoneisland.json, targets-gucci.json
 *
 * 각 인자 형식: "<dresscode 브랜드명>:<출력 슬러그>"
 *   - 브랜드명 매칭은 대소문자/공백 무시
 *   - 슬러그는 파일명·결과명에 쓰일 짧은 표기
 *
 * 옵션:
 *   --in-stock-only   : 재고>0 사이즈만 (기본 true)
 *   --max-per-brand N : 디버그용 브랜드당 N개 SKU 까지만
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DATA = '/Users/anne/CascadeProjects/windsurf-project-2/cafe24-oauth/grifo-crawler/sync/sync-data';

// CLI 파싱
const args = process.argv.slice(2);
const flags = {};
const brandSpecs = [];
for (const a of args) {
  if (a.startsWith('--max-per-brand=')) flags.max = Number(a.split('=')[1]);
  else if (a === '--no-in-stock-only') flags.allStock = true;
  else brandSpecs.push(a);
}
if (brandSpecs.length === 0) {
  console.error('사용법: node build-targets-by-brand.js "THOM BROWNE:tombrown" "GUCCI:gucci" ...');
  process.exit(1);
}

// 최신 dresscode 캐시
function findLatestDresscode() {
  const files = fs.readdirSync(SYNC_DATA)
    .filter((f) => /^dresscode_products_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(SYNC_DATA, files[0]) : null;
}
const cachePath = findLatestDresscode();
if (!cachePath) {
  console.error('❌ dresscode_products_*.json 없음:', SYNC_DATA);
  process.exit(1);
}
console.log(`📦 dresscode 캐시: ${path.basename(cachePath)}`);

const cacheRaw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
const products = Array.isArray(cacheRaw) ? cacheRaw : (cacheRaw.products || []);
console.log(`   전체 상품: ${products.length}`);

function norm(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ' '); }

for (const spec of brandSpecs) {
  const [brandRaw, slugRaw] = spec.split(':');
  if (!brandRaw || !slugRaw) {
    console.error(`❌ 인자 형식 오류: "${spec}" — "BRAND:slug" 형식 필요`);
    continue;
  }
  const brand = norm(brandRaw);
  const slug = slugRaw.trim();

  const matches = products.filter((p) => norm(p.brand) === brand);
  if (matches.length === 0) {
    console.log(`\n⚠️  "${brandRaw}" (${brand}) 매칭 0건 — 브랜드명 확인`);
    continue;
  }

  const limited = flags.max ? matches.slice(0, flags.max) : matches;
  console.log(`\n🏷  ${brandRaw} → slug="${slug}"  (${limited.length}/${matches.length} 상품)`);

  const targets = [];
  let skippedNoRef = 0, skippedNoSize = 0, skippedNoStock = 0;

  for (const p of limited) {
    const ref = p.reference;
    if (!ref) { skippedNoRef++; continue; }

    const sizes = p.sizes || p.crawled_data?.sizes || [];
    if (sizes.length === 0) {
      // 사이즈 없으면 옵션 빈값 1건
      targets.push({
        sku: ref,
        spu: p.spu || null,
        b2b_sku: ref,
        brand: p.brand || null,
        name: p.name || null,
        option: '',
        stock: null,
        eur_price: p.price ?? null,
        eur_retail: p.retailPrice ?? null,
      });
      skippedNoSize++;
      continue;
    }

    for (const sz of sizes) {
      const stock = sz.stock ?? 0;
      if (!flags.allStock && stock <= 0) { skippedNoStock++; continue; }
      targets.push({
        sku: ref,
        spu: p.spu || null,
        b2b_sku: ref,
        brand: p.brand || null,
        name: p.name || null,
        option: String(sz.size || ''),
        stock,
        eur_price: p.price ?? null,
        eur_retail: p.retailPrice ?? null,
      });
    }
  }

  const outFile = path.join(__dirname, `targets-${slug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(targets, null, 2));
  const uniqueSku = new Set(targets.map((t) => t.sku)).size;

  console.log(`   ✅ ${outFile}`);
  console.log(`   타겟: ${targets.length}건 (고유 SKU ${uniqueSku}개)`);
  console.log(`   스킵: 사이즈없음=${skippedNoSize} 재고0=${skippedNoStock} ref없음=${skippedNoRef}`);
}

console.log('\n다음 단계:');
console.log('  KREAM_EMAIL=... KREAM_PASSWORD=... node fetch-product-market.js targets-<slug>.json');
