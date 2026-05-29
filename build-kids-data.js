#!/usr/bin/env node
/**
 * build-kids-data.js
 * 최신 Dresscode + Grifo 크롤링 결과에서 키즈 상품만 추출하여
 * 공통 스키마의 KRW 가격으로 변환한 뒤 data/dresscode-kids.json 에 저장한다.
 *
 * 각 소스의 가격 정책 (공통 가격정책 기반):
 *   ─ Dresscode (EUR):
 *       판매가 = round100(EUR × 1742 × 1.25 × 원산지요율 × tier) + 신발 30,000원
 *       정가   = round100(retailPriceEUR × 1742)
 *   ─ Grifo (USD):
 *       priceForCalc = 세일이면 final_price, 비세일이면 regular_price × 0.85
 *       판매가       = round100(priceForCalc × 1490 × 1.3 × 원산지요율 × tier) + 키즈신발 30,000원
 *       정가         = round100(regular_priceUSD × 1490)
 *
 * tier 판정은 항상 "krwRaw = 원가 × 환율" 기준 (마진/원산지 미반영).
 * retailPrice/pricesIncludeVat(EUR 원본) 필드는 API 응답에서 제거된다.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========================================================================
// 공통 유틸
// ========================================================================

// 원산지별 요율 (공통 정책)
const COUNTRY_RATES = {
  IT: 1, ES: 1, DE: 1, KR: 1, RO: 1, PL: 1, HU: 1, FR: 1, PT: 1, CZ: 1, BG: 1,
  CN: 1.06, US: 1.06, BD: 1.06, TN: 1.06, TH: 1.06, PK: 1.06, BR: 1.06,
  LK: 1.06, MM: 1.06, CO: 1.06, CL: 1.06, IN: 1.06, GB: 1.06, JP: 1.06,
  VN: 1.06, TR: 1.06, MA: 1.06, ID: 1.06, KH: 1.06, EG: 1.06, MX: 1.06,
  PH: 1.06, PE: 1.06, AR: 1.06, AM: 1.06, AL: 1.06, RS: 1.06, MD: 1.06,
  default: 1.06,
};

const COUNTRY_NAME_MAP = {
  italy: 'IT', italia: 'IT',
  china: 'CN', cina: 'CN',
  spain: 'ES', españa: 'ES',
  germany: 'DE', deutschland: 'DE',
  usa: 'US', 'united states': 'US',
  korea: 'KR', 'south korea': 'KR',
  france: 'FR',
  portugal: 'PT',
  romania: 'RO',
  poland: 'PL',
  hungary: 'HU',
  vietnam: 'VN',
  turkey: 'TR', türkiye: 'TR',
  morocco: 'MA',
  indonesia: 'ID',
  india: 'IN',
  bangladesh: 'BD',
  thailand: 'TH',
  uk: 'GB', 'united kingdom': 'GB', 'great britain': 'GB',
  moldova: 'MD',
};

function getCountryRate(madeIn) {
  if (!madeIn) return COUNTRY_RATES.default;
  const lower = String(madeIn).toLowerCase();
  for (const [name, code] of Object.entries(COUNTRY_NAME_MAP)) {
    if (lower.includes(name)) return COUNTRY_RATES[code] ?? COUNTRY_RATES.default;
  }
  return COUNTRY_RATES.default;
}

// 공통 금액대별 요율
function getPriceTierRate(priceKrw) {
  if (priceKrw <= 40000) return 1.9;
  if (priceKrw <= 65000) return 1.4;
  if (priceKrw <= 99999) return 1.15;
  if (priceKrw <= 130000) return 1.1;
  return 1.0;
}

function roundTo100(price) {
  return Math.round(price / 100) * 100;
}

// "$71.00" / "€71.00" / "71.00" 숫자만 추출
function parseMoney(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  const match = String(str).match(/[\d,.]+/);
  if (!match) return 0;
  return parseFloat(match[0].replace(',', ''));
}

const SHOE_SURCHARGE = 30000;

// ========================================================================
// Dresscode 가격 정책
//   EUR → KRW, 마진 25%
// ========================================================================
const DRESSCODE_CONFIG = {
  exchangeRate: 1742, // EUR -> KRW
  markup: 1.25,       // 25% 마진 (공통 정책의 키즈 30% 대비 -5%p)
  vatRate: 1.22,      // EU VAT 22% — Dresscode 원본 데이터는 모두 pricesIncludeVat=false (VAT 제외)
                      // 정가(retailPrice)를 API 로 노출할 때 실제 브랜드 MSRP 수준으로 올리기 위해 VAT 를 더해줌
};

function isDresscodeShoes(product) {
  return (product.type || '').toLowerCase() === 'shoes';
}

function calculateDresscodeKrwPrice(priceEur, product) {
  if (!priceEur || priceEur <= 0) return 0;
  const countryRate = getCountryRate(product.madeIn);
  const krwRaw = priceEur * DRESSCODE_CONFIG.exchangeRate;
  const tierRate = getPriceTierRate(krwRaw);
  let salePrice = roundTo100(krwRaw * DRESSCODE_CONFIG.markup * countryRate * tierRate);
  if (isDresscodeShoes(product)) salePrice += SHOE_SURCHARGE;
  return salePrice;
}

// Dresscode 원본 데이터는 VAT 제외 가격이므로 정가에 VAT 를 더해 실제 브랜드 MSRP 로 환산
//   retailPrice_KRW = retailPriceEUR × VAT(1.22) × 환율(1742)
// 예: €151.64(VAT 제외) × 1.22 × 1742 = ₩322,271 (실제 MSRP €185.00 기준)
function calculateDresscodeKrwRetailPrice(retailPriceEur, pricesIncludeVat = false) {
  if (!retailPriceEur || retailPriceEur <= 0) return 0;
  const vat = pricesIncludeVat ? 1 : DRESSCODE_CONFIG.vatRate;
  return roundTo100(retailPriceEur * vat * DRESSCODE_CONFIG.exchangeRate);
}

// ========================================================================
// Grifo 가격 정책 (공통 price-policy.js 의 GRIFO_KIDS 정책과 동일)
//   USD → KRW, 키즈 마진 30%, 비세일 할인 ×0.85
// ========================================================================
const GRIFO_CONFIG = {
  exchangeRate: 1467,      // USD -> KRW (2026-04-20 변경: 1490 → 1467)
  kidsMarkup: 1.25,        // 키즈 25% (2026-04-20 변경: 30% → 25%, Dresscode 와 동일화)
  nonSaleDiscount: 0.85,   // 비세일 기준가(regular_price) × 0.85
};

const GRIFO_SHOE_KEYWORDS = [
  'sneaker', 'shoe', 'boot', 'sandal', 'loafer',
  'slipper', 'trainer', 'runner', 'slip-on', 'moccasin',
];

function isGrifoKidsShoe(product) {
  const cs = (product.crawl_source || '').toLowerCase();
  if (cs.includes('shoes')) return true;
  const name = (product.name || '').toLowerCase();
  return GRIFO_SHOE_KEYWORDS.some((k) => name.includes(k));
}

function isGrifoSale(product) {
  const finalUsd = parseMoney(product.final_price);
  const regularUsd = parseMoney(product.regular_price);
  return regularUsd > 0 && finalUsd > 0 && finalUsd < regularUsd * 0.95;
}

/**
 * Grifo 상품의 USD 가격 → KRW 판매가
 * 세일이면 해당 USD 그대로, 비세일이면 regular × 0.85 적용
 *
 * 원본 정책 재현:
 *   priceForCalc = isSale ? sizePriceUSD : (sizeRegularUSD ?? sizePriceUSD) × 0.85
 *   krwRaw       = priceForCalc × 1490
 *   tier         = getPriceTierRate(krwRaw)
 *   salePrice    = round100(krwRaw × 1.3 × countryRate × tier) + 키즈신발 30,000원
 */
function calculateGrifoKrwPrice(sizePriceUsd, sizeRegularUsd, product, isSale) {
  const finalUsd = parseMoney(sizePriceUsd);
  const regularUsd = parseMoney(sizeRegularUsd) || finalUsd;

  const priceForCalc = isSale ? finalUsd : regularUsd * GRIFO_CONFIG.nonSaleDiscount;
  if (!priceForCalc || priceForCalc <= 0) return 0;

  const countryRate = getCountryRate(product.made_in);
  const krwRaw = priceForCalc * GRIFO_CONFIG.exchangeRate;
  const tierRate = getPriceTierRate(krwRaw);
  let salePrice = roundTo100(krwRaw * GRIFO_CONFIG.kidsMarkup * countryRate * tierRate);
  if (isGrifoKidsShoe(product)) salePrice += SHOE_SURCHARGE;
  return salePrice;
}

// Grifo 정가: regular_price USD × 환율 (단순 환전, Dresscode와 동일한 정가 정의)
function calculateGrifoKrwRetailPrice(regularUsd) {
  const usd = parseMoney(regularUsd);
  if (!usd || usd <= 0) return 0;
  return roundTo100(usd * GRIFO_CONFIG.exchangeRate);
}

// Grifo crawl_source → 공통 genre
function inferGrifoGenre(crawlSource) {
  const cs = (crawlSource || '').toLowerCase();
  if (cs.includes('boy')) return 'Baby boy';
  if (cs.includes('girl')) return 'Baby girl';
  if (cs.includes('baby')) return 'Unisex baby';
  return 'Unisex baby';
}

// ========================================================================
// 소스별 정규화 (공통 스키마로 매핑)
// ========================================================================

function normalizeDresscode(p) {
  const vatIncluded = p.pricesIncludeVat === true;
  const priceKrw = calculateDresscodeKrwPrice(p.price, p);
  let retailKrw = calculateDresscodeKrwRetailPrice(p.retailPrice, vatIncluded);
  // 공통 정책: 판매가가 정가보다 크면 정가를 판매가 × 1.1 로 조정
  if (priceKrw > retailKrw && priceKrw > 0) {
    retailKrw = roundTo100(priceKrw * 1.1);
  }

  const sizes = (p.sizes || []).map((s) => {
    const { retailPrice: _r, price: _p, ...rest } = s;
    const sizePriceKrw = calculateDresscodeKrwPrice(s.price, p);
    let sizeRetailKrw = calculateDresscodeKrwRetailPrice(s.retailPrice, vatIncluded);
    if (sizePriceKrw > sizeRetailKrw && sizePriceKrw > 0) {
      sizeRetailKrw = roundTo100(sizePriceKrw * 1.1);
    }
    return {
      ...rest,
      price: sizePriceKrw,
      retailPrice: sizeRetailKrw,
      currency: 'KRW',
    };
  });

  const { retailPrice: _rpEur, pricesIncludeVat: _vat, price: _origPrice, ...rest } = p;
  return {
    source: 'dresscode',
    ...rest,
    price: priceKrw,
    retailPrice: retailKrw,
    currency: 'KRW',
    sizes,
  };
}

function normalizeGrifo(p) {
  const isSale = isGrifoSale(p);

  const sizes = (p.all_sizes || []).map((s) => {
    const priceKrw = calculateGrifoKrwPrice(s.price, s.regular_price || s.price, p, isSale);
    let retailPriceKrw = calculateGrifoKrwRetailPrice(s.regular_price || s.price);
    // 공통 정책: 판매가가 정가보다 크면 정가를 판매가 × 1.1 로 조정
    if (priceKrw > retailPriceKrw && priceKrw > 0) {
      retailPriceKrw = roundTo100(priceKrw * 1.1);
    }
    return {
      size: s.size,
      stock: Number(s.stock) || 0,
      gtin: null,
      price: priceKrw,
      retailPrice: retailPriceKrw,
      currency: 'KRW',
    };
  });

  const priceKrw = sizes.length > 0
    ? Math.min(...sizes.map((s) => s.price).filter((v) => v > 0))
    : calculateGrifoKrwPrice(p.final_price, p.regular_price, p, isSale);

  let retailKrw = calculateGrifoKrwRetailPrice(p.regular_price);
  if (priceKrw > retailKrw && priceKrw > 0) {
    retailKrw = roundTo100(priceKrw * 1.1);
  }

  const photos = (p.images && p.images.length) ? p.images : (p.image_urls || []);

  return {
    source: 'grifo',
    productID: String(p.id || ''),
    clientProductID: String(p.id_product_attribute || ''),
    spu: p.full_reference || p.short_reference || '',
    sku: p.short_reference || p.full_reference || '',
    brand: p.brand || '',
    name: p.name || '',
    description: p.description || '',
    genre: inferGrifoGenre(p.crawl_source),
    type: p.type || '',
    category: p.category || '',
    season: p.season || '',
    isCarryOver: String(p.is_carry_over || '').toLowerCase() === 'true',
    color: p.color || '',
    composition: p.composition || '',
    madeIn: p.made_in || '',
    sizeAndFit: p.size_and_fit || '',
    productLastUpdated: null, // Grifo 원본에 없음
    sizeType: null,
    weight: null,
    price: Number.isFinite(priceKrw) ? priceKrw : 0,
    retailPrice: retailKrw,
    currency: 'KRW',
    sizes,
    photos,
  };
}

// ========================================================================
// b2bfashion 가격 정책 (dresscode 와 동일 공급사 Julian Fashion — EUR, 마진 25%, retail VAT 22%)
//   판매가 = round100(finalEUR × 환율 × 마진 × 원산지요율 × 금액대tier) (+신발 30,000)
//   정가   = round100(retailEUR × VAT(1.22) × 환율)
//   재고   = 무조건 1 (b2b 원본에 재고 정보 없음)
// ========================================================================
const B2B_CONFIG = {
  exchangeRate: 1743, // EUR -> KRW
  markup: 1.25,       // 25% 마진 (dresscode 와 동일)
  vatRate: 1.22,      // EU VAT 22% (정가 환산용)
};

function isB2bShoes(product) {
  return (product.type || '').toLowerCase() === 'shoes';
}

function calculateB2bKrwPrice(priceEur, product) {
  if (!priceEur || priceEur <= 0) return 0;
  const countryRate = getCountryRate(product.madeIn);
  const krwRaw = priceEur * B2B_CONFIG.exchangeRate;
  const tierRate = getPriceTierRate(krwRaw);
  let salePrice = roundTo100(krwRaw * B2B_CONFIG.markup * countryRate * tierRate);
  if (isB2bShoes(product)) salePrice += SHOE_SURCHARGE;
  return salePrice;
}

function calculateB2bKrwRetailPrice(retailPriceEur) {
  if (!retailPriceEur || retailPriceEur <= 0) return 0;
  return roundTo100(retailPriceEur * B2B_CONFIG.vatRate * B2B_CONFIG.exchangeRate);
}

// b2b gender → 공통 genre (재크롤링 데이터는 이미 "Baby girl" 형식이나 방어적 정규화)
function normalizeB2bGenre(gender) {
  const g = (gender || '').trim().toLowerCase();
  if (g === 'baby girl' || g === 'girl') return 'Baby girl';
  if (g === 'baby boy' || g === 'boy') return 'Baby boy';
  if (g === 'unisex baby') return 'Unisex baby';
  return 'Unisex baby';
}

function titleCaseWords(s) {
  return (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeB2b(p) {
  const priceKrw = calculateB2bKrwPrice(p.finalPriceEUR, p);
  let retailKrw = calculateB2bKrwRetailPrice(p.retailPriceEUR);
  if (priceKrw > retailKrw && priceKrw > 0) {
    retailKrw = roundTo100(priceKrw * 1.1);
  }

  // 사이즈: sizeVariants(사이즈별 동일가) 우선, 없으면 sizes 문자열 배열. 재고 무조건 1.
  const sizeList = Array.isArray(p.sizeVariants) && p.sizeVariants.length
    ? p.sizeVariants.map((v) => v.size)
    : (Array.isArray(p.sizes) ? p.sizes : []);
  const sizes = sizeList.map((sz) => ({
    size: String(sz),
    stock: 1,             // ← b2b 무재고 → 1 고정
    gtin: null,
    price: priceKrw,
    retailPrice: retailKrw,
    currency: 'KRW',
  }));

  return {
    source: 'b2bfashion',
    productID: p.idProduct ? String(p.idProduct) : (p.spu || ''),
    clientProductID: p.idProductAttribute ? String(p.idProductAttribute) : '',
    spu: p.spu || '',
    sku: p.short_reference || p.spu || '',   // 색상 포함 변형 키 (dresscode sku=spu+color 와 동일)
    brand: p.brand ? `${titleCaseWords(p.brand)} Kids` : '',
    name: p.name || '',
    description: p.detailDescription || p.description || '',
    genre: normalizeB2bGenre(p.gender),
    type: titleCaseWords(p.type),            // CLOTHING → Clothing
    category: '',                            // b2b 세부 category 없음
    season: p.season || '',
    isCarryOver: false,
    color: titleCaseWords(p.color),
    composition: p.composition || '',
    madeIn: titleCaseWords(p.madeIn),
    sizeAndFit: p.sizeAndFit || '',
    productLastUpdated: null,
    sizeType: null,
    weight: null,
    price: priceKrw,
    retailPrice: retailKrw,
    currency: 'KRW',
    sizes,
    photos: (p.images && p.images.length) ? p.images : [],
  };
}

// b2bfashion 키즈 4개 카테고리 파일 로드 + short_reference 기준 dedup
//   - 색상별(short_reference 다름)은 보존, 카테고리 간 동일상품 중복은 제거
function loadB2bKids(dir) {
  const cats = ['baby-girl', 'baby-boy', 'boy', 'girl'];
  const all = [];
  let latestMs = 0;
  for (const c of cats) {
    const f = path.join(dir, `b2bfashion_kids_${c}.json`);
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    if (st.mtimeMs > latestMs) latestMs = st.mtimeMs;
    JSON.parse(fs.readFileSync(f, 'utf-8')).forEach((p) => all.push(p));
  }
  const byKey = new Map();
  for (const p of all) {
    const key = String(p.short_reference || p.spu || '').trim().toUpperCase();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, p);
  }
  const date = latestMs ? new Date(latestMs).toISOString().split('T')[0] : null;
  return { raw: all.length, products: [...byKey.values()], date };
}

// ========================================================================
// 메인
// ========================================================================
function loadLatest(dir, regex, keyExtractor = 'products') {
  const files = fs.readdirSync(dir).filter((f) => regex.test(f)).sort().reverse();
  if (files.length === 0) return { file: null, date: null, products: [] };
  const file = files[0];
  const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
  const products = data[keyExtractor] || data.raw_api_response || [];
  const date = file.match(/\d{4}-\d{2}-\d{2}/)[0];
  return { file, date, products };
}

function main() {
  const syncDataDir = path.join(__dirname, 'grifo-crawler/sync/sync-data');
  const outputFile = path.join(__dirname, 'data/dresscode-kids.json');

  // ─── 1) Dresscode 로드 & 키즈 필터 ──────────────────────────────────────
  const dc = loadLatest(syncDataDir, /^dresscode_products_\d{4}-\d{2}-\d{2}\.json$/, 'raw_api_response');
  if (!dc.file) {
    console.error('❌ dresscode_products_YYYY-MM-DD.json 파일을 찾을 수 없습니다.');
    process.exit(1);
  }
  console.log(`📂 Dresscode 소스: ${dc.file} (전체 ${dc.products.length}개)`);

  const dcKids = dc.products.filter((p) => {
    const g = (p.genre || '').trim();
    return g.startsWith('Baby') || g === 'Unisex baby';
  });
  console.log(`   👶 Dresscode 키즈 추출: ${dcKids.length}개`);

  // ─── 2) Grifo 로드 (이미 전부 키즈) ────────────────────────────────────
  const gf = loadLatest(syncDataDir, /^grifo_products_\d{4}-\d{2}-\d{2}\.json$/, 'products');
  if (!gf.file) {
    console.warn('⚠️  grifo_products_YYYY-MM-DD.json 없음 — Dresscode만 사용');
  } else {
    console.log(`📂 Grifo 소스: ${gf.file} (전체 ${gf.products.length}개)`);
  }

  const gfKids = (gf.products || []).filter((p) => {
    // Grifo 전수 데이터가 이미 키즈지만 방어적으로 crawl_source 로 재확인
    const cs = (p.crawl_source || '').toLowerCase();
    return cs.includes('boy') || cs.includes('girl') || cs.includes('baby') || cs.includes('kid');
  });
  console.log(`   👦 Grifo 키즈 추출: ${gfKids.length}개`);

  // ─── 2-b) b2bfashion 키즈 로드 (short_reference 기준 dedup) ──────────────
  const b2bDir = path.join(__dirname, 'grifo-crawler');
  const b2b = loadB2bKids(b2bDir);
  console.log(`📂 b2bfashion 키즈: raw ${b2b.raw} → 고유(short_reference) ${b2b.products.length}개${b2b.date ? ` (${b2b.date})` : ''}`);

  // ─── 3) 정규화 ─────────────────────────────────────────────────────────
  const processedDc = dcKids.map(normalizeDresscode);
  const processedB2bAll = b2b.products.map(normalizeB2b);
  const processedGfAll = gfKids.map(normalizeGrifo);

  // ─── 3-1) 중복 제거: Dresscode > b2bfashion > Grifo ──────────────────
  const normKey = (s) => String(s || '').trim().toUpperCase();

  // 예외 가격 정책: 아래 SKU 들은 b2b/grifo 둘 다 있을 때 "더 비싼" grifo 가격으로 올린다.
  //   동작: 해당 SKU 의 b2b 항목을 (grifo 에 존재할 때만) 버려서 grifo 항목이 살아남게 함.
  //   ※ grifo 에 없으면 안전하게 b2b 유지 (상품 누락 방지)
  const PRICE_EXCEPTION_GRIFO_SKUS = new Set([
    'L19518C0001289BCPF05', // Moncler Striped t-shirt — grifo($134) 가 b2b(€71) 보다 비쌈
  ].map((s) => s.toUpperCase()));

  // grifo 보유 키 셋 (예외 SKU 가 grifo 에 실제 존재하는지 확인용)
  const grifoKeys = new Set();
  processedGfAll.forEach((g) => {
    if (g.sku) grifoKeys.add(normKey(g.sku));
    if (g.spu) grifoKeys.add(normKey(g.spu));
  });
  const isExceptionWithGrifo = (p) => {
    const sku = normKey(p.sku), spu = normKey(p.spu);
    const isException = PRICE_EXCEPTION_GRIFO_SKUS.has(sku) || PRICE_EXCEPTION_GRIFO_SKUS.has(spu);
    const grifoHas = grifoKeys.has(sku) || grifoKeys.has(spu);
    return isException && grifoHas;
  };

  // (a) Dresscode 예약 키 (현재 dresscode 키즈는 API 장애로 0건일 수 있음)
  const dcReservedKeys = new Set();
  processedDc.forEach((p) => {
    if (p.sku) dcReservedKeys.add(normKey(p.sku));
    if (p.spu) dcReservedKeys.add(normKey(p.spu));
  });

  // (b) b2b: Dresscode 와 겹치면 제외 (Dresscode 우선) + 예외 SKU 는 grifo 우선이라 제외
  const processedB2b = [];
  const b2bDroppedByDc = [];
  const b2bDroppedByException = [];
  processedB2bAll.forEach((b) => {
    if (isExceptionWithGrifo(b)) {
      b2bDroppedByException.push({ sku: b.sku, brand: b.brand, name: b.name });
      return; // grifo 가격으로 올리기 위해 b2b 버림 (reservedKeys 에도 안 들어감)
    }
    if ((b.sku && dcReservedKeys.has(normKey(b.sku))) || (b.spu && dcReservedKeys.has(normKey(b.spu)))) {
      b2bDroppedByDc.push({ sku: b.sku, brand: b.brand, name: b.name });
      return;
    }
    processedB2b.push(b);
  });

  // (c) Dresscode + b2b 예약 키 → Grifo 제외 (b2b 우선)
  const reservedKeys = new Set(dcReservedKeys);
  processedB2b.forEach((p) => {
    if (p.sku) reservedKeys.add(normKey(p.sku));
    if (p.spu) reservedKeys.add(normKey(p.spu));
  });

  const processedGf = [];
  const dedupDropped = [];
  processedGfAll.forEach((g) => {
    const gSku = normKey(g.sku);
    const gSpu = normKey(g.spu);
    if ((gSku && reservedKeys.has(gSku)) || (gSpu && reservedKeys.has(gSpu))) {
      dedupDropped.push({ sku: g.sku, brand: g.brand, name: g.name });
      return;
    }
    processedGf.push(g);
  });

  if (b2bDroppedByException.length > 0) {
    console.log(`   💰 예외 가격정책(grifo 우선)으로 b2b 제외: ${b2bDroppedByException.length}개 → [${b2bDroppedByException.map((x) => x.sku).join(', ')}]`);
  }
  if (b2bDroppedByDc.length > 0) {
    console.log(`   🔁 Dresscode 중복으로 b2b 제외: ${b2bDroppedByDc.length}개`);
  }
  if (dedupDropped.length > 0) {
    console.log(`   🔁 Dresscode/b2b 중복으로 Grifo 제외: ${dedupDropped.length}개`);
  }

  const merged = [...processedDc, ...processedB2b, ...processedGf];

  // 통계
  const shoesCount = merged.filter((p) => (p.type || '').toLowerCase() === 'shoes').length;

  // dataDate: 세 소스 중 최신 날짜
  const dataDate = [dc.date, gf.date, b2b.date].filter(Boolean).sort().reverse()[0];

  const output = {
    dataDate,
    total: merged.length,
    sources: {
      dresscode: { dataDate: dc.date, count: processedDc.length },
      b2bfashion: {
        dataDate: b2b.date,
        count: processedB2b.length,
        raw: b2b.raw,
        droppedByDresscode: b2bDroppedByDc.length,
      },
      grifo: {
        dataDate: gf.date,
        count: processedGf.length,
        dedupDroppedByDresscodeOrB2b: dedupDropped.length,
      },
    },
    updatedAt: new Date().toISOString(),
    priceInfo: {
      currency: 'KRW',
      dresscode: {
        exchangeRate: DRESSCODE_CONFIG.exchangeRate,
        markupRate: DRESSCODE_CONFIG.markup,
        markupPercent: `${Math.round((DRESSCODE_CONFIG.markup - 1) * 100)}%`,
        retailVatRate: DRESSCODE_CONFIG.vatRate,
      },
      b2bfashion: {
        exchangeRate: B2B_CONFIG.exchangeRate,
        markupRate: B2B_CONFIG.markup,
        markupPercent: `${Math.round((B2B_CONFIG.markup - 1) * 100)}%`,
        retailVatRate: B2B_CONFIG.vatRate,
        stockPolicy: 'fixed 1 (재고정보 없음)',
      },
      grifo: {
        exchangeRate: GRIFO_CONFIG.exchangeRate,
        markupRate: GRIFO_CONFIG.kidsMarkup,
        markupPercent: `${Math.round((GRIFO_CONFIG.kidsMarkup - 1) * 100)}%`,
        nonSaleDiscount: GRIFO_CONFIG.nonSaleDiscount,
      },
      surcharges: { shoes: SHOE_SURCHARGE },
      note:
        '공통 순서: (1) krwRaw = 원가USD/EUR × 환율 → (2) krwRaw 금액으로 금액대요율(tier) 결정 → ' +
        '(3) round100(krwRaw × 마진 × 원산지요율 × tier) → (4) 신발이면 +30,000원. ' +
        'Grifo는 비세일 상품의 경우 기준가(regular_price)에 0.85 를 곱한 값을 krwRaw 계산의 기준가로 사용. ' +
        'retailPrice(정가): Dresscode/b2bfashion 는 원본 retailPrice(VAT 제외)에 EU VAT 22% 를 더한 뒤 환율 적용. ' +
        'Grifo 는 원본 regular_price(USD, 이미 VAT 포함)에 환율만 적용. ' +
        'b2bfashion 은 dresscode 와 동일 공급사(Julian Fashion)이며 재고는 1 고정. ' +
        '중복 우선순위: Dresscode > b2bfashion > Grifo. ' +
        'source 필드 = "dresscode" / "b2bfashion" / "grifo".',
    },
    products: merged,
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output));

  console.log(`\n✅ 출력: ${outputFile}`);
  console.log(`   총 ${merged.length}개 = Dresscode ${processedDc.length} + b2bfashion ${processedB2b.length} + Grifo ${processedGf.length}`);
  console.log(`   신발(type=Shoes): ${shoesCount}개`);
  console.log(`   💱 Dresscode ${DRESSCODE_CONFIG.exchangeRate}원/EUR × ${DRESSCODE_CONFIG.markup} | b2b ${B2B_CONFIG.exchangeRate}원/EUR × ${B2B_CONFIG.markup} | Grifo ${GRIFO_CONFIG.exchangeRate}원/USD × ${GRIFO_CONFIG.kidsMarkup}`);
}

main();
