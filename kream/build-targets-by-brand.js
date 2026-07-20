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
// dresscode 캐시 위치 — 레포 상대경로 (Mac/VPS 공용). DRESSCODE_SYNC_DATA env 로 override 가능.
const SYNC_DATA = process.env.DRESSCODE_SYNC_DATA
  || path.resolve(__dirname, '..', 'grifo-crawler', 'sync', 'sync-data');

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

// Stone Island 등 dresscode reference 를 KREAM 검색용 대시 형식으로 변환.
// 규칙: 뒤에서 5자(V+4) | 그 앞 7자 | 나머지(앞부분)  → "-" 로 join
//   L1S156100060S0051V0029 → L1S1561000-60S0051-V0029
//   159100011S0076V0029     → 1591000-11S0076-V0029
function formatKreamSku(ref) {
  if (!ref) return ref;
  const n = String(ref).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (n.length < 12) return ref; // 너무 짧으면 패턴 안 맞음
  const tail = n.slice(-5);
  const mid  = n.slice(-12, -5);
  const head = n.slice(0, -12);
  return head ? `${head}-${mid}-${tail}` : `${mid}-${tail}`;
}

// PRADA 변환 — dresscode 코드에서 중간 4자리(pos 6-9) 제거하면 KREAM 검색 형식.
// 의류/가방/신발 (18-20자리) 만 변환 대상이고, 액세서리 (14-15자리) 는 그대로.
// 예: UJL90BSWMO11OQF0002 (19자) → UJL90B + 11OQF0002 = UJL90B11OQF0002 (15자)
//     2MO513QHHF0002 (14자, 액세서리) → 그대로
function formatPradaSku(ref) {
  if (!ref) return ref;
  const n = String(ref).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (n.length >= 16) return n.slice(0, 6) + n.slice(10);
  return n;
}

// TOM FORD 변환 — reference 의 의미 없는 끝 토큰 제거
//   NAA / UNA / EBU (보통 단일 컬러 / 무옵션 의미) → 제거
//   001 (KREAM 에서 컬러 코드로 단축되는 경우 많음) → 제거
//   예: Y0228LCL158SNAA → Y0228LCL158S, TB178LCL236SUNA → TB178LCL236S,
//       Y0232LCL504SEBU → Y0232LCL504S, TB248LCL237G1N001 → TB248LCL237G1N
function formatTomFordSku(ref) {
  if (!ref) return ref;
  const n = String(ref).trim().toUpperCase();
  if (n.endsWith('NAA')) return n.slice(0, -3);
  if (n.endsWith('UNA')) return n.slice(0, -3);
  if (n.endsWith('EBU')) return n.slice(0, -3);
  if (n.endsWith('001')) return n.slice(0, -3);
  return n;
}

// SALOMON 변환 — reference 의 앞 9자리만 사용 (L + 8자리 숫자가 실제 모델 코드, 나머지는 색상명)
// 예: L49147500LUNARROCKFTWSILVERBRIGHTCHARTREUSE → L49147500
function formatSalomonSku(ref) {
  if (!ref) return ref;
  const n = String(ref).trim().toUpperCase();
  return n.length >= 9 ? n.slice(0, 9) : n;
}

// Y-3 변환 — reference 뒤쪽의 영문 색상명 제거 (KREAM 은 모델 코드만으로 검색됨)
// 예: JW7351BLACK → JW7351, KI7091WHITE → KI7091, JM7854CWHITE → JM7854C
const Y3_COLOR_RE = /(WHITE|BLACK|RED|BLUE|GREEN|GREY|GRAY|BROWN|BEIGE|NAVY|PINK|YELLOW|PURPLE|ORANGE|CREAM|IVORY|MULTICOLOR|MULTI|GOLD|SILVER|TAN|KHAKI|OLIVE|MAROON|TEAL|CORAL|MINT|MUSTARD|RUST|WINE|CHARCOAL|SAND|BONE|ECRU|NUDE|MAGENTA|CYAN|LIME|AQUA|FUCHSIA|BURGUNDY|TAUPE|CHOCOLATE)+$/i;
function formatY3Sku(ref) {
  if (!ref) return ref;
  const n = String(ref).trim().toUpperCase();
  return n.replace(Y3_COLOR_RE, '') || n;
}

// 브랜드별 KREAM 검색 키 추출 — Stone Island 는 대시 형식, PRADA 는 중간 4자리 제거,
// TOM FORD 는 의미없는 suffix 제거, SALOMON 는 앞 9자리만
function deriveSearchSku(brandNorm, ref) {
  if (brandNorm === 'STONE ISLAND') return formatKreamSku(ref);
  if (brandNorm === 'PRADA') return formatPradaSku(ref);
  if (brandNorm === 'TOM FORD') return formatTomFordSku(ref);
  if (brandNorm === 'SALOMON') return formatSalomonSku(ref);
  if (brandNorm === 'Y-3') return formatY3Sku(ref);
  return ref; // 다른 브랜드는 reference 그대로
}

// 브랜드별 카테고리(type) 제외 — KREAM 에 잘 안 잡히는 노이즈 카테고리 차단
//   TOM FORD: 'Clothing' 제외 (의류는 KREAM Tom Ford 카탈로그에 거의 없음, 매칭률 5%)
//   MM6: 'Clothing' 제외 (2026-07-20 검토 — 의류 233타겟 매칭 9%/유효 4%, 신발·가방만 유효)
const BRAND_TYPE_EXCLUDE = {
  'TOM FORD': new Set(['Clothing']),
  'MM6 MAISON MARGIELA': new Set(['Clothing']),
};
function shouldSkipForType(brandNorm, productType) {
  const ex = BRAND_TYPE_EXCLUDE[brandNorm];
  return ex ? ex.has(productType) : false;
}

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
  let skippedNoRef = 0, skippedNoSize = 0, skippedNoStock = 0, skippedType = 0;

  for (const p of limited) {
    const ref = p.reference;
    if (!ref) { skippedNoRef++; continue; }

    // 브랜드별 카테고리 필터 (예: TOM FORD 의류 제외 — KREAM 카탈로그 비매칭)
    if (shouldSkipForType(brand, p.type)) { skippedType++; continue; }

    // KREAM 검색용 SKU (Stone Island 는 대시 형식, 나머지는 ref 그대로)
    const searchSku = deriveSearchSku(brand, ref);

    const sizes = p.sizes || p.crawled_data?.sizes || [];
    if (sizes.length === 0) {
      // 사이즈 없으면 옵션 빈값 1건
      targets.push({
        sku: searchSku,
        spu: ref, // 원본 reference 는 검증/fallback 용
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
        sku: searchSku,
        spu: ref, // 원본 reference 는 검증/fallback 용
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
  console.log(`   스킵: 사이즈없음=${skippedNoSize} 재고0=${skippedNoStock} ref없음=${skippedNoRef} 카테고리제외=${skippedType}`);
}

console.log('\n다음 단계:');
console.log('  KREAM_EMAIL=... KREAM_PASSWORD=... node fetch-product-market.js targets-<slug>.json');
