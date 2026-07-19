/**
 * build-targets-giglio-feeds.js
 * giglio CSV 피드 (atny + fast-shipping) 에서 지정 브랜드를 뽑아 KREAM targets 파일 생성.
 *
 * 피드가 크므로 (atny ~112MB, 257k행) 전체를 메모리에 올리지 않고 스트리밍 파싱:
 *   HTTP response body → csv-parse stream → 브랜드 필터 → targets
 *
 * SKU 변환: "Sku Color" 필드의 "708514VKIV0 ~ 1000" → "708514VKIV01000"
 *   (" ~ " 구분자 제거 후 코드+컬러 연결 — KREAM 검색 형식)
 *
 * 크리덴셜: kream/.env
 *   GIGLIO_ATNY_USER / GIGLIO_ATNY_PASS
 *   GIGLIO_FAST_USER / GIGLIO_FAST_PASS
 *
 * 사용법:
 *   node build-targets-giglio-feeds.js                        # 기본 브랜드 (bottega, miumiu)
 *   node build-targets-giglio-feeds.js "BOTTEGA VENETA:bottega" "MIU MIU:miumiu"
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 로드 ─────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const FEEDS = [
  {
    name: 'atny',
    url: 'https://static.giglio.com/feeds/atny/atny.csv',
    user: process.env.GIGLIO_ATNY_USER,
    pass: process.env.GIGLIO_ATNY_PASS,
  },
  {
    name: 'fast-shipping',
    url: 'https://static.giglio.com/feeds/fast-shipping/fast-shipping.csv',
    user: process.env.GIGLIO_FAST_USER,
    pass: process.env.GIGLIO_FAST_PASS,
  },
];

for (const f of FEEDS) {
  if (!f.user || !f.pass) {
    console.error(`❌ ${f.name} 피드 크리덴셜 없음 — .env 에 GIGLIO_*_USER / GIGLIO_*_PASS 확인`);
    process.exit(1);
  }
}

// ── 브랜드 스펙 파싱 (기본: 보테가 + 미우미우) ──
const specs = process.argv.slice(2).filter((a) => a.includes(':'));
const BRAND_SPECS = specs.length > 0
  ? specs.map((s) => { const [b, slug] = s.split(':'); return { brand: b.trim().toUpperCase(), slug: slug.trim() }; })
  : [
      { brand: 'BOTTEGA VENETA', slug: 'giglio_bottega' },
      { brand: 'MIU MIU', slug: 'giglio_miumiu' },
      { brand: 'C.P. COMPANY', slug: 'giglio_cpcompany' },
      { brand: 'MONCLER', slug: 'giglio_moncler' },
      { brand: 'DIOR', slug: 'giglio_dior' },
    ];
const WANTED = new Map(BRAND_SPECS.map((b) => [b.brand, b.slug]));

// "708514VKIV0 ~ 1000" → "708514VKIV01000"
function skuFromSkuColor(skuColor) {
  return String(skuColor || '').split('~').map((s) => s.trim()).join('').toUpperCase();
}

// ── 브랜드별 카테고리 제외 ─────────────────────────
// BOTTEGA VENETA: 의류 + 신발 제외 (KREAM 판매 대상 아님) — 가방/선글라스/지갑/벨트/주얼리만 크롤.
// atny 피드는 영어, fast-shipping 피드는 이탈리아어 카테고리라 둘 다 등록.
// Scarf/Gloves 는 액세서리로 취급해 유지.
const BV_EXCLUDE = new Set([
  // 의류 (EN)
  'JACKET', 'SWEATER', 'SHIRT', 'PANTS', 'JEANS', 'DRESS', 'TOP', 'T-SHIRT', 'COAT',
  'SKIRT', 'SHORTS', 'POLO SHIRT', 'SUIT SEPARATE', 'WAISTCOAT', 'FUR COAT',
  'SWEATSHIRT', 'SWIMSUIT', 'SUIT VEST',
  // 신발 (EN)
  'SNEAKERS', 'BOOTS', 'BOOT', 'HEELED SANDAL', 'SHOES', 'BALLET FLAT',
  'LOAFERS', 'LOAFER', 'SANDALS', 'SANDAL', 'BROGUE SHOES',
  // 의류 (IT — fast-shipping 피드)
  'MAGLIA', 'MAGLIONE', 'CAMICIA', 'PANTALONE', 'PANTALONI', 'ABITO', 'GONNA',
  'CAPPOTTO', 'GIACCA', 'FELPA', 'GIUBBOTTO', 'COSTUME',
  'T-SHIRTS', 'PANTALONCINI', 'POLO', 'COMPLETO', 'GILET',
  // 선글라스 (EN/IT)
  'SUNGLASSES', 'OCCHIALI DA SOLE',
  // 신발 (IT)
  'STIVALI', 'STIVALE', 'STIVALETTI', 'SANDALI', 'SANDALI CON TACCO', 'MOCASSINI', 'SCARPE',
  'BALLERINE', 'DECOLLETE', 'SCARPE STRINGATE', 'SCARPE CON TACCO', 'ZEPPE',
]);
// 신규/변형 카테고리명 방어 — 위 셋에 없어도 이 키워드가 포함되면 의류/신발로 간주
const BV_EXCLUDE_KEYWORDS = ['SHIRT', 'PANT', 'BOOT', 'SNEAKER', 'LOAFER', 'SANDAL', 'SHOE',
  'DRESS', 'SKIRT', 'COAT', 'SWEAT', 'JACKET', 'JEAN', 'STIVAL', 'SCARP', 'MOCASS',
  'BALLERIN', 'MAGLI', 'CAMIC', 'FELPA', 'GIACC', 'GONNA', 'ABIT', 'PANTALON'];
// C.P. COMPANY: Sweatshirt/Pants/Jacket/Hat 제외 (2026-07-08 매칭률 검토 후 선정)
// EN (atny) + IT (fast-shipping) 카테고리명 모두 등록
const CP_EXCLUDE = new Set([
  'SWEATSHIRT', 'PANTS', 'JACKET', 'HAT',
  'FELPA', 'PANTALONE', 'PANTALONI', 'GIACCA', 'GIUBBOTTO', 'CAPPELLO',
]);

// MONCLER: 액세서리만 제외 (2026-07-19). 의류+신발은 유지.
// 제외 = 모자/가방류/선글라스/안경테/지갑/키링/스카프/담요/커버 등 비의류.
const MONCLER_EXCLUDE = new Set([
  'HAT', 'SUNGLASSES', 'OPTICAL FRAMES', 'SCARF', 'WALLET', 'KEYRING', 'KEY CHAIN',
  'HANDBAG', 'MINI BAG', 'BACKPACK', 'TRAVEL BAG', 'TOTE BAG', 'CROSSBODY BAG',
  'SHOULDER BAG', 'BAG', 'BRIEFCASE', 'BELT BAG', 'CLUTCH', 'BLANKET SET', 'COVER',
  // IT
  'CAPPELLO', 'OCCHIALI DA SOLE', 'SCIARPA', 'PORTAFOGLIO', 'PORTACHIAVI',
  'BORSA', 'ZAINO', 'POCHETTE', 'MARSUPIO', 'TRACOLLA',
]);
// bags 변형 방어 — BAG/BORSA 포함되면 액세서리로 간주 (의류/신발엔 이 토큰 없음)
const MONCLER_EXCLUDE_KEYWORDS = ['BAG', 'BORSA'];

const BRAND_CATEGORY_EXCLUDE = {
  'BOTTEGA VENETA': BV_EXCLUDE,
  'C.P. COMPANY': CP_EXCLUDE,
  'MONCLER': MONCLER_EXCLUDE,
};

// MIU MIU: 가방만 크롤 (include 방식 — 이 키워드에 안 걸리는 카테고리는 전부 제외)
// EN: Handbag/Shoulder bag/Mini bag/Crossbody bag/Tote bag/Backpack/Clutch
// IT: Borsa*/Zaino/Pochette/Marsupio/Tracolla
const BRAND_CATEGORY_INCLUDE_KEYWORDS = {
  'MIU MIU': ['BAG', 'BACKPACK', 'CLUTCH', 'BORSA', 'ZAINO', 'POCHETTE', 'MARSUPIO', 'TRACOLLA'],
};

function shouldSkipCategory(brand, category) {
  const c = String(category || '').trim().toUpperCase();
  // include 방식 브랜드: 키워드 미포함 → 제외
  const inc = BRAND_CATEGORY_INCLUDE_KEYWORDS[brand];
  if (inc) return !inc.some((k) => c.includes(k));
  // exclude 방식 브랜드
  const ex = BRAND_CATEGORY_EXCLUDE[brand];
  if (!ex) return false;
  if (ex.has(c)) return true;
  if (brand === 'BOTTEGA VENETA' && BV_EXCLUDE_KEYWORDS.some((k) => c.includes(k))) return true;
  if (brand === 'MONCLER' && MONCLER_EXCLUDE_KEYWORDS.some((k) => c.includes(k))) return true;
  return false;
}

// ── 피드 1개 스트리밍 처리 ─────────────────────────
// collected: Map<slug, Map<dedupKey, target>>  — sku+size 로 dedup (두 피드 간 중복 제거)
async function processFeed(feed, collected) {
  // giglio 는 datacenter IP (Hetzner 등) 를 403 차단 — KREAM_PROXY_* 설정돼 있으면 프록시 경유.
  // curl stdout 스트리밍 → csv-parse (130MB 를 메모리/디스크에 안 올림)
  let proxyArgs = [];
  const list = (process.env.KREAM_PROXY_LIST || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length > 0) {
    const [host, port, user, pass] = list[Math.floor(Math.random() * list.length)].split(':');
    proxyArgs = ['-x', `http://${host}:${port}`, ...(user ? ['-U', `${user}:${pass || ''}`] : [])];
  } else if (process.env.KREAM_PROXY_SERVER) {
    proxyArgs = ['-x', process.env.KREAM_PROXY_SERVER,
      ...(process.env.KREAM_PROXY_USER ? ['-U', `${process.env.KREAM_PROXY_USER}:${process.env.KREAM_PROXY_PASS || ''}`] : [])];
  }
  console.log(`\n📡 ${feed.name} 다운로드+파싱 시작: ${feed.url}${proxyArgs.length ? '  (프록시 경유)' : ''}`);
  const curl = spawn('curl', [
    '-sS', '--fail', '--max-time', '600',
    ...proxyArgs,
    '-u', `${feed.user}:${feed.pass}`,
    feed.url,
  ]);
  let curlErr = '';
  curl.stderr.on('data', (d) => { curlErr += d.toString(); });

  const parser = parse({
    columns: true,          // 첫 행을 헤더로
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_records_with_error: true,
  });

  let rows = 0, picked = 0, skippedCat = 0;
  const t0 = Date.now();

  await new Promise((resolve, reject) => {
    parser.on('readable', () => {
      let row;
      while ((row = parser.read()) !== null) {
        rows++;
        const brand = String(row['Brand'] || '').trim().toUpperCase();
        const slug = WANTED.get(brand);
        if (!slug) continue;

        const sku = skuFromSkuColor(row['Sku Color']);
        if (!sku) continue;
        // 브랜드별 카테고리 제외 (예: 보테가 의류/신발)
        if (shouldSkipCategory(brand, row['Category'])) { skippedCat++; continue; }
        const size = String(row['Size'] || '').trim();
        const qty = Number(row['Quantity'] || 0) || 0;
        if (qty <= 0) continue;

        const key = `${sku} ${size}`;
        const bySlug = collected.get(slug);
        if (bySlug.has(key)) {
          // 두 피드 간 중복 — 재고 큰 쪽 유지
          const prev = bySlug.get(key);
          if (qty > (prev.stock ?? 0)) prev.stock = qty;
          continue;
        }
        picked++;
        bySlug.set(key, {
          sku,
          spu: String(row['Sku Color'] || '').trim(),
          b2b_sku: String(row['Code'] || '').trim(),
          brand,
          name: String(row['Name'] || '').trim() || null,
          option: size,
          stock: qty,
          eur_price: Number(row['Discounted Price'] || 0) || null,
          eur_retail: Number(row['Retail Price'] || 0) || null,
          source: `giglio:${feed.name}`,
        });
      }
    });
    // 주의: curl 이 즉시 실패하면 (프록시 402 등) stdout 이 빈 채로 닫혀 parser 'end' 가
    // 'close' 보다 먼저 발생 → resolve 후 reject 가 무시되는 race 가 있었음.
    // curl exit code 확인이 끝난 뒤에만 resolve 하도록 순서 보장.
    let parserDone = false, curlCode = null;
    const tryFinish = () => {
      if (!parserDone || curlCode === null) return;
      if (curlCode !== 0) reject(new Error(`${feed.name} curl exit=${curlCode}: ${curlErr.slice(0, 200)}`));
      else if (rows === 0) reject(new Error(`${feed.name} 응답이 비어있음 (0행) — 피드/프록시 이상`));
      else resolve();
    };
    parser.on('error', reject);
    parser.on('end', () => { parserDone = true; tryFinish(); });
    curl.on('close', (code) => { curlCode = code; tryFinish(); });
    curl.stdout.pipe(parser);
  });

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   ✅ ${rows.toLocaleString()}행 스캔 → ${picked}건 채택, 카테고리제외 ${skippedCat}건  (${sec}s)`);
}

// ── main ─────────────────────────────────────────
const collected = new Map(BRAND_SPECS.map((b) => [b.slug, new Map()]));

for (const feed of FEEDS) {
  await processFeed(feed, collected);
}

console.log('');
let wroteAny = false;
for (const { brand, slug } of BRAND_SPECS) {
  const targets = Array.from(collected.get(slug).values());
  const outFile = path.join(__dirname, `targets-${slug}.json`);
  // 0건이면 기존 targets 파일 보존 — 피드 장애 시 어제 targets 로 fetch 가능하게
  if (targets.length === 0) {
    console.log(`⚠️  ${brand}: 타겟 0건 — 기존 ${path.basename(outFile)} 유지 (덮어쓰지 않음)`);
    continue;
  }
  fs.writeFileSync(outFile, JSON.stringify(targets, null, 2));
  wroteAny = true;
  const uniqueSku = new Set(targets.map((t) => t.sku)).size;
  console.log(`🏷  ${brand} → ${path.basename(outFile)}  타겟 ${targets.length}건 (고유 SKU ${uniqueSku}개)`);
}
if (!wroteAny) {
  console.error('❌ 모든 브랜드 타겟 0건 — 피드 다운로드 실패로 간주, exit 1');
  process.exit(1);
}

console.log('\n다음 단계:');
console.log('  node fetch-product-market.js targets-giglio_bottega.json');
console.log('  node fetch-product-market.js targets-giglio_miumiu.json');
