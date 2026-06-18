/**
 * build-targets-giglio.js
 * giglio fast-shipping CSV 에서 지정된 브랜드들을 추출해 KREAM 크롤링용 targets 파일로 변환.
 *
 * CSV 컬럼:
 *   Sku Color  ─ "{sku} ~ {color}" 형식. KREAM 검색용으로 ` ~ ` 제거 후 합침.
 *   Brand      ─ 브랜드명
 *   Size       ─ 옵션
 *   Quantity   ─ 재고
 *   Discounted Price ─ 공급가 (EUR)
 *   Retail Price     ─ 정가 (EUR)
 *   Name, Color ENG, Category 등
 *
 * 사용법:
 *   node build-targets-giglio.js --csv=/path/to/fast-shipping.csv "SAINT LAURENT:saintlaurent" "BOTTEGA VENETA:bottegaveneta" ...
 *
 * 출력: targets-giglio_{slug}.json (각 브랜드별)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CLI 파싱
const args = process.argv.slice(2);
const csvArg = args.find((a) => a.startsWith('--csv='));
const csvPath = csvArg ? csvArg.split('=')[1] : null;
const brandSpecs = args.filter((a) => !a.startsWith('--'));

if (!csvPath || brandSpecs.length === 0) {
  console.error('사용법: node build-targets-giglio.js --csv=/path/to/csv.csv "BRAND:slug" ...');
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error('❌ CSV 파일 없음:', csvPath);
  process.exit(1);
}

// 간단한 CSV 파서 (Sku Color 필드에 ~ 가 있으니 쉼표 split 안전)
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = parseCsvLine(lines[i]);
    if (cells.length === 0) continue;
    const obj = {};
    header.forEach((h, j) => { obj[h] = cells[j] ?? ''; });
    rows.push(obj);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"' && cur === '') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// KREAM 검색용 SKU 변환: "745644Y9G12 ~ 1001" → "745644Y9G121001"
function skuColorToKream(skuColor) {
  if (!skuColor) return '';
  return skuColor.replace(/\s*~\s*/, '').trim();
}

// BOM 제거
let text = fs.readFileSync(csvPath, 'utf-8');
if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

console.log(`📥 CSV 로드: ${csvPath}`);
const rows = parseCsv(text);
console.log(`   총 ${rows.length} 행\n`);

// 브랜드별 처리
for (const spec of brandSpecs) {
  const [brandRaw, slugRaw] = spec.split(':');
  if (!brandRaw || !slugRaw) {
    console.error(`❌ 인자 형식 오류: "${spec}" — "BRAND:slug" 형식 필요`);
    continue;
  }
  const brandUpper = brandRaw.trim().toUpperCase();
  const slug = `giglio_${slugRaw.trim()}`;

  // 필터링 — 같은 브랜드, sku+option 별로 합쳐서 quantity 합계
  const grouped = {}; // key = sku+option, value = { sku, option, ... , qty, sample row }
  let matched = 0;
  for (const r of rows) {
    const b = (r['Brand'] || '').trim().toUpperCase();
    if (b !== brandUpper) continue;
    matched++;
    const sku = skuColorToKream(r['Sku Color']);
    if (!sku) continue;
    const option = (r['Size'] || '').trim();
    const qty = parseInt(r['Quantity'] || '0', 10) || 0;
    const eurPrice = parseFloat(r['Discounted Price'] || '0') || null;
    const eurRetail = parseFloat(r['Retail Price'] || '0') || null;
    if (qty <= 0) continue;

    const key = `${sku}|${option}`;
    if (grouped[key]) {
      grouped[key].stock += qty;
    } else {
      grouped[key] = {
        sku,
        spu: sku, // giglio 는 sku 자체가 unique key
        b2b_sku: r['Sku Color'],  // 원본 형식 보존
        brand: brandRaw,
        name: r['Name'] || r['Description ENG'] || '',
        option,
        stock: qty,
        eur_price: eurPrice,
        eur_retail: eurRetail,
      };
    }
  }
  const targets = Object.values(grouped);
  const uniqueSku = new Set(targets.map((t) => t.sku)).size;

  const outFile = path.join(__dirname, `targets-${slug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(targets, null, 2));
  console.log(`🏷  ${brandRaw} → ${slug}`);
  console.log(`   CSV row: ${matched}건  →  타겟 ${targets.length}건  (고유 SKU ${uniqueSku})`);
  console.log(`   ✅ ${outFile}\n`);
}

console.log('다음 단계:');
console.log('  KREAM_EMAIL=... KREAM_PASSWORD=... node fetch-product-market.js targets-giglio_<slug>.json');
