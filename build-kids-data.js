#!/usr/bin/env node
/**
 * build-kids-data.js
 * 최신 Dresscode + Grifo 크롤링 결과에서 키즈 상품만 추출하여
 * 공통 스키마의 KRW 가격으로 변환한 뒤 data/dresscode-kids.json 에 저장한다.
 *
 * 각 소스의 가격 정책 (공통 가격정책 기반):
 *   ─ Dresscode (EUR):
 *       판매가 = round100(EUR × 1750 × 1.25 × 원산지요율 × tier) + 신발 30,000원
 *       정가   = round100(retailPriceEUR × 1750)
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
import { tenerestoreToKidsRecord } from './tenerestore-to-kidsapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========================================================================
// 공통 유틸
// ========================================================================

// 원산지별 요율 (공통 정책)
// 2026-06-16 변경: 비유럽 1.06 → 1.1 / 유럽 기준 EU+EEA+GB+CH 로 확장.
// 유럽 = 1.0 (한·EU·EFTA·영 FTA 로 의류 0% 관세) / 그 외 = 1.1
const COUNTRY_RATES = {
  // === 유럽 1.0 ===
  // EU 27 — 한·EU FTA 의류 0%
  AT: 1, BE: 1, BG: 1, CY: 1, CZ: 1, DE: 1, DK: 1, EE: 1,
  ES: 1, FI: 1, FR: 1, GR: 1, HR: 1, HU: 1, IE: 1, IT: 1,
  LT: 1, LU: 1, LV: 1, MT: 1, NL: 1, PL: 1, PT: 1, RO: 1,
  SE: 1, SI: 1, SK: 1,
  // EEA 비EU — 한·EFTA FTA 의류 0% (노르웨이·아이슬란드·리히텐슈타인)
  IS: 1, LI: 1, NO: 1,
  // 영국 — 한·영 FTA 의류 0%
  GB: 1,
  // 스위스 — 한·EFTA FTA 의류 0%
  CH: 1,
  // 한국 — 국내 생산 (관세 없음)
  KR: 1,
  // === 비유럽 1.1 ===
  AL: 1.1, AM: 1.1, AR: 1.1, BD: 1.1, BR: 1.1, CL: 1.1, CN: 1.1,
  CO: 1.1, EG: 1.1, HK: 1.1, ID: 1.1, IN: 1.1, JP: 1.1, KH: 1.1,
  LK: 1.1, MA: 1.1, MD: 1.1, MG: 1.1, MM: 1.1, MX: 1.1, PE: 1.1,
  PH: 1.1, PK: 1.1, RS: 1.1, TH: 1.1, TN: 1.1, TR: 1.1, US: 1.1,
  VN: 1.1,
  default: 1.1,
};

const COUNTRY_NAME_MAP = {
  // === 유럽 (1.0) ===
  // EU 27
  italy: 'IT', italia: 'IT',
  spain: 'ES', españa: 'ES', espana: 'ES',
  germany: 'DE', deutschland: 'DE',
  france: 'FR',
  portugal: 'PT',
  romania: 'RO',
  poland: 'PL',
  hungary: 'HU',
  netherlands: 'NL', holland: 'NL',
  belgium: 'BE', belgique: 'BE', belgie: 'BE',
  austria: 'AT', österreich: 'AT', osterreich: 'AT',
  sweden: 'SE', sverige: 'SE',
  denmark: 'DK', danmark: 'DK',
  finland: 'FI', suomi: 'FI',
  ireland: 'IE',
  greece: 'GR', hellas: 'GR',
  czech: 'CZ', czechia: 'CZ',
  slovakia: 'SK',
  slovenia: 'SI',
  croatia: 'HR', hrvatska: 'HR',
  bulgaria: 'BG',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  luxembourg: 'LU',
  malta: 'MT',
  cyprus: 'CY',
  // EEA (비EU)
  norway: 'NO', norge: 'NO',
  iceland: 'IS', ísland: 'IS',
  liechtenstein: 'LI',
  // GB + CH
  uk: 'GB', 'united kingdom': 'GB', 'great britain': 'GB', england: 'GB', britain: 'GB',
  switzerland: 'CH', schweiz: 'CH', suisse: 'CH',
  // 한국
  korea: 'KR', 'south korea': 'KR', republic: 'KR',
  // === 비유럽 (1.1) ===
  china: 'CN', cina: 'CN',
  usa: 'US', 'united states': 'US', america: 'US',
  vietnam: 'VN', 'viet nam': 'VN',
  turkey: 'TR', türkiye: 'TR', turkiye: 'TR',
  morocco: 'MA', maroc: 'MA',
  indonesia: 'ID',
  india: 'IN',
  bangladesh: 'BD',
  thailand: 'TH',
  cambodia: 'KH',
  pakistan: 'PK',
  'sri lanka': 'LK',
  myanmar: 'MM',
  philippines: 'PH',
  japan: 'JP',
  'hong kong': 'HK',
  egypt: 'EG',
  tunisia: 'TN',
  brazil: 'BR',
  mexico: 'MX',
  argentina: 'AR',
  peru: 'PE',
  colombia: 'CO',
  chile: 'CL',
  armenia: 'AM',
  albania: 'AL',
  serbia: 'RS',
  moldova: 'MD',
  madagascar: 'MG',
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
  exchangeRate: 1750, // EUR -> KRW (2026-06-16: 1742 → 1750)
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
//   retailPrice_KRW = retailPriceEUR × VAT(1.22) × 환율(1750)
// 예: €151.64(VAT 제외) × 1.22 × 1750 = ₩323,800 (실제 MSRP €185.00 기준)
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
  exchangeRate: 1497,      // USD -> KRW (2026-06-18: 1467 → 1497)
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

// ========================================================================
// tenerestore 정규화
//   입력: tenerestore-to-kidsapi.tenerestoreToKidsRecord() 가 만든 중간 형식
//         (price/retailPrice 가 EUR, 사이즈별 price/retailPrice 도 EUR)
//   가격정책: dresscode 와 동일(EUR × 1750 × 1.25 × 원산지 × tier + 신발 +30,000)
//             — tene 의 brandDiscount 는 이미 price 에 적용되어 들어오므로 그대로 사용
//   정가: retailPrice 가 VAT 포함 EUR 이므로 pricesIncludeVat=true 로 환산
// ========================================================================
function normalizeTenere(p) {
  const priceKrw = calculateDresscodeKrwPrice(p.price, p);
  let retailKrw = calculateDresscodeKrwRetailPrice(p.retailPrice, true); // VAT 포함
  if (priceKrw > retailKrw && priceKrw > 0) {
    retailKrw = roundTo100(priceKrw * 1.1);
  }

  const sizes = (p.sizes || []).map((s) => {
    const { retailPrice: _r, price: _sp, currency: _c, ...rest } = s;
    const sizePriceKrw = calculateDresscodeKrwPrice(s.price, p);
    let sizeRetailKrw = calculateDresscodeKrwRetailPrice(s.retailPrice, true);
    if (sizePriceKrw > sizeRetailKrw && sizePriceKrw > 0) {
      sizeRetailKrw = roundTo100(sizePriceKrw * 1.1);
    }
    return { ...rest, price: sizePriceKrw, retailPrice: sizeRetailKrw, currency: 'KRW' };
  });

  const { price: _orig, retailPrice: _origRetail, currency: _origCcy, ...rest } = p;
  return {
    source: 'tenerestore',
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

// b2bfashion 키즈 카테고리별 최신 정상파일 선택
//   - 우선: 날짜 suffix 파일 (b2bfashion_kids_<cat>_YYYY-MM-DD.json) 중 lookback 윈도우 내 max count 의 50% 이상인 가장 최신
//   - 보조 fallback: 고정명 파일 (legacy)
//   - 부분실패(오늘만 적게)한 카테고리는 자동으로 어제 정상 데이터 사용
function selectLatestGoodB2bFile(dir, cat, maxLookback = 7) {
  const datedRe = new RegExp(`^b2bfashion_kids_${cat}_(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  const allFiles = fs.readdirSync(dir);

  // 날짜 suffix 파일들 — 최신순
  const dated = allFiles
    .map((f) => { const m = f.match(datedRe); return m ? { f, date: m[1] } : null; })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxLookback);

  if (dated.length > 0) {
    const withCounts = dated.map((x) => {
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(dir, x.f), 'utf-8'));
        return { ...x, count: arr.length, arr };
      } catch (e) {
        console.warn(`⚠️  ${x.f} 파싱 실패: ${e.message}`);
        return { ...x, count: 0, arr: [] };
      }
    });
    const maxCount = Math.max(...withCounts.map((x) => x.count));
    const threshold = Math.max(5, maxCount * 0.5); // 최근 7일 max 의 50% 또는 최소 5
    // 최신부터 threshold 이상 첫 파일
    for (const x of withCounts) {
      if (x.count >= threshold) {
        if (x.f !== withCounts[0].f) {
          console.warn(`⚠️  b2b ${cat}: ${withCounts[0].f} (${withCounts[0].count}개, min ${Math.round(threshold)} 미달) → ${x.f} (${x.count}개) fallback`);
        }
        return { products: x.arr, date: x.date, file: x.f, fallback: x.f !== withCounts[0].f };
      }
    }
    // 모든 dated 파일이 threshold 미달 → 가장 최신 dated 사용
    const latest = withCounts[0];
    console.warn(`⚠️  b2b ${cat}: 모든 dated 파일이 임계치 미달, 최신(${latest.f}, ${latest.count}개) 사용`);
    return { products: latest.arr, date: latest.date, file: latest.f, fallback: false };
  }

  // 날짜 suffix 파일이 없으면 고정명 (legacy) fallback
  const legacy = path.join(dir, `b2bfashion_kids_${cat}.json`);
  if (fs.existsSync(legacy)) {
    try {
      const arr = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
      const date = new Date(fs.statSync(legacy).mtimeMs).toISOString().split('T')[0];
      return { products: arr, date, file: `b2bfashion_kids_${cat}.json`, fallback: false };
    } catch (e) {
      console.warn(`⚠️  legacy ${legacy} 파싱 실패: ${e.message}`);
    }
  }
  return { products: [], date: null, file: null, fallback: false };
}

function loadB2bKids(dir) {
  const cats = ['baby-girl', 'baby-boy', 'boy', 'girl'];
  const all = [];
  let latestDate = null;
  const perCat = {};
  for (const c of cats) {
    const sel = selectLatestGoodB2bFile(dir, c);
    perCat[c] = { count: sel.products.length, file: sel.file, fallback: sel.fallback, date: sel.date };
    sel.products.forEach((p) => all.push(p));
    if (sel.date && (!latestDate || sel.date > latestDate)) latestDate = sel.date;
  }
  // 카테고리별 선택 결과 로그
  console.log(`   📂 b2b 카테고리별 선택:`);
  for (const c of cats) {
    const x = perCat[c];
    const tag = x.fallback ? ' [📦 fallback]' : '';
    console.log(`      - ${c.padEnd(10)} ${x.count}개${tag}  ${x.file || '(없음)'}`);
  }

  const byKey = new Map();
  for (const p of all) {
    const key = String(p.short_reference || p.spu || '').trim().toUpperCase();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, p);
  }
  const anyFallback = Object.values(perCat).some((x) => x.fallback);
  return { raw: all.length, products: [...byKey.values()], date: latestDate, fallback: anyFallback };
}

// ========================================================================
// 메인
// ========================================================================
// 최신 파일 로드. 단 minCount 미달이면 그 이전 날짜 파일로 fallback (최대 maxLookback 일).
//   사용 의도: 크롤러가 어느 날 빈 결과를 내도 전날의 정상 데이터를 유지해서 API 소비자(뭉클) 가 영향을 안 받게 함.
function loadLatest(dir, regex, keyExtractor = 'products', minCount = 1, maxLookback = 14) {
  const files = fs.readdirSync(dir).filter((f) => regex.test(f)).sort().reverse();
  if (files.length === 0) return { file: null, date: null, products: [], fallback: false };

  let fallbackFromFile = null;
  for (let i = 0; i < Math.min(files.length, maxLookback); i++) {
    const file = files[i];
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      const products = data[keyExtractor] || data.raw_api_response || [];
      if (products.length >= minCount) {
        const date = file.match(/\d{4}-\d{2}-\d{2}/)[0];
        if (i > 0) {
          console.warn(`⚠️  ${fallbackFromFile} 부적합 → ${file} (${date}) fallback 사용 (${products.length}개)`);
        }
        return { file, date, products, fallback: i > 0 };
      }
      if (i === 0) fallbackFromFile = `${file}(${products.length}개)`;
      console.warn(`⚠️  ${file} 비어있음 또는 minCount(${minCount}) 미달: ${products.length}개`);
    } catch (e) {
      if (i === 0) fallbackFromFile = `${file}(파싱실패)`;
      console.warn(`⚠️  ${file} 파싱 실패: ${e.message}`);
    }
  }
  // 최후의 수단: 어쨌든 가장 최신 파일 그대로 반환 (빈 배열일 수 있음)
  const file = files[0];
  const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
  const products = data[keyExtractor] || data.raw_api_response || [];
  const date = file.match(/\d{4}-\d{2}-\d{2}/)[0];
  return { file, date, products, fallback: false };
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
  //   minCount=50: 평상시 ≥800개. 50 미만이면 크롤러 실패로 간주하고 전날(또는 그 이전) 정상 파일 사용.
  const gf = loadLatest(syncDataDir, /^grifo_products_\d{4}-\d{2}-\d{2}\.json$/, 'products', 50);
  if (!gf.file) {
    console.warn('⚠️  grifo_products_YYYY-MM-DD.json 없음 — Dresscode만 사용');
  } else {
    const tag = gf.fallback ? ' [📦 fallback]' : '';
    console.log(`📂 Grifo 소스: ${gf.file}${tag} (전체 ${gf.products.length}개)`);
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

  // ─── 2-c) tenerestore 키즈 로드 (단일 파일, fallback 자동) ─────────────
  //   minCount=1500: 평상시 ~2000개. 1500 미만이면 크롤러 실패로 간주 → 전날(또는 그 이전) 정상 파일 사용.
  const tn = loadLatest(syncDataDir, /^tenerestore_products_\d{4}-\d{2}-\d{2}\.json$/, 'products', 1500);
  if (!tn.file) {
    console.warn('⚠️  tenerestore_products_YYYY-MM-DD.json 없음 — tenere 소스 제외');
  } else {
    const tag = tn.fallback ? ' [📦 fallback]' : '';
    console.log(`📂 tenerestore 소스: ${tn.file}${tag} (전체 ${tn.products.length}개)`);
  }

  // ─── 3) 정규화 ─────────────────────────────────────────────────────────
  const processedDc = dcKids.map(normalizeDresscode);
  const processedB2bAll = b2b.products.map(normalizeB2b);
  const processedGfAll = gfKids.map(normalizeGrifo);
  //   tene 는 tenerestoreToKidsRecord 로 중간 형식(EUR) 으로 변환 후 normalizeTenere 로 KRW 변환
  const processedTnAll = (tn.products || []).map((p) => normalizeTenere(tenerestoreToKidsRecord(p)));

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

  // (d) Dresscode + b2b + Grifo 와 겹치는 tenerestore 제외 (tene 가 최하위 우선순위)
  //     → 기존 소스가 있으면 그대로 두고, tene 는 신규 항목만 보충.
  const reservedKeysIncludingGf = new Set(reservedKeys);
  processedGf.forEach((p) => {
    if (p.sku) reservedKeysIncludingGf.add(normKey(p.sku));
    if (p.spu) reservedKeysIncludingGf.add(normKey(p.spu));
  });
  const processedTn = [];
  const tnDedupDropped = [];
  processedTnAll.forEach((t) => {
    const tSku = normKey(t.sku);
    const tSpu = normKey(t.spu);
    if ((tSku && reservedKeysIncludingGf.has(tSku)) || (tSpu && reservedKeysIncludingGf.has(tSpu))) {
      tnDedupDropped.push({ sku: t.sku, brand: t.brand, name: t.name });
      return;
    }
    processedTn.push(t);
  });
  if (tnDedupDropped.length > 0) {
    console.log(`   🔁 Dresscode/b2b/Grifo 중복으로 tenerestore 제외: ${tnDedupDropped.length}개`);
  }

  let merged = [...processedDc, ...processedB2b, ...processedGf, ...processedTn];

  // ─── 3-2) 가격 검토 패스 (임계치 기반 자동 교체) ──────────────────────
  // 우선순위로 채택된 항목보다 다른 소스가 PRICE_REPLACEMENT_THRESHOLD(20%) 이상 저렴하면 교체.
  //   - 비교 기준: 정규화 후 price (KRW, 동일 정책으로 환산됨)
  //   - 작은 변동(<20%)은 출처 일관성 유지를 위해 무시
  //   - 교체된 SKU 는 priceReplacements 로 출력 + 콘솔 로그 (Slack 노출용)
  const PRICE_REPLACEMENT_THRESHOLD = 0.20;
  const candidatesByKey = new Map();
  const addCandidate = (p) => {
    if (!p || (!p.sku && !p.spu)) return;
    if (!p.price || p.price <= 0) return;
    [normKey(p.sku), normKey(p.spu)].filter(Boolean).forEach((k) => {
      if (!candidatesByKey.has(k)) candidatesByKey.set(k, []);
      candidatesByKey.get(k).push(p);
    });
  };
  // dedup 전 모든 후보를 키 인덱스에 등록 (b2b 예외제외분도 후보로 포함)
  processedDc.forEach(addCandidate);
  processedB2bAll.forEach(addCandidate);
  processedGfAll.forEach(addCandidate);
  processedTnAll.forEach(addCandidate);

  const priceReplacements = [];
  merged = merged.map((chosen) => {
    if (!chosen.price || chosen.price <= 0) return chosen;
    const keys = [normKey(chosen.sku), normKey(chosen.spu)].filter(Boolean);
    const seen = new Set();
    const candidates = [];
    for (const k of keys) {
      for (const c of candidatesByKey.get(k) || []) {
        if (!seen.has(c)) { seen.add(c); candidates.push(c); }
      }
    }
    // 후보 중 가장 싼 것
    let cheapest = chosen;
    for (const c of candidates) {
      if (c.price > 0 && c.price < cheapest.price) cheapest = c;
    }
    // 임계치 이상 저렴할 때만 교체
    const savings = (chosen.price - cheapest.price) / chosen.price;
    if (cheapest !== chosen && savings >= PRICE_REPLACEMENT_THRESHOLD) {
      priceReplacements.push({
        sku: chosen.sku,
        brand: chosen.brand,
        name: chosen.name,
        from: { source: chosen.source, price: chosen.price },
        to: { source: cheapest.source, price: cheapest.price },
        savingsPercent: Math.round(savings * 100),
        savingsKrw: chosen.price - cheapest.price,
      });
      return cheapest;
    }
    return chosen;
  });

  if (priceReplacements.length > 0) {
    const totalSavings = priceReplacements.reduce((s, r) => s + r.savingsKrw, 0);
    console.log(`   💱 가격 검토 패스: ${priceReplacements.length}개 SKU 가 ≥${PRICE_REPLACEMENT_THRESHOLD * 100}% 저렴한 소스로 교체됨 (총 절감 ₩${totalSavings.toLocaleString()})`);
    priceReplacements.slice(0, 10).forEach((r) => {
      console.log(`      • [${r.sku}] ${r.brand} / ${(r.name || '').slice(0, 40)} : ${r.from.source}(₩${r.from.price.toLocaleString()}) → ${r.to.source}(₩${r.to.price.toLocaleString()}) (-${r.savingsPercent}%)`);
    });
    if (priceReplacements.length > 10) console.log(`      ... 외 ${priceReplacements.length - 10}개`);
  }

  // 통계 (가격 검토 패스 후 최종 source 분포 재계산)
  const shoesCount = merged.filter((p) => (p.type || '').toLowerCase() === 'shoes').length;
  const finalSourceCount = merged.reduce((acc, p) => {
    acc[p.source] = (acc[p.source] || 0) + 1;
    return acc;
  }, {});

  // dataDate: 네 소스 중 최신 날짜
  const dataDate = [dc.date, gf.date, b2b.date, tn.date].filter(Boolean).sort().reverse()[0];

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
      tenerestore: {
        dataDate: tn.date,
        count: processedTn.length,
        raw: processedTnAll.length,
        dedupDroppedByOthers: tnDedupDropped.length,
        fallback: tn.fallback || false,
      },
    },
    // 가격 검토 패스 후 최종 source 분포 (가격 교체 반영)
    finalSourceCount,
    // 임계치(20%) 이상 저렴해서 다른 소스로 교체된 SKU 목록
    priceReplacements: {
      thresholdPercent: 20,
      total: priceReplacements.length,
      totalSavingsKrw: priceReplacements.reduce((s, r) => s + r.savingsKrw, 0),
      items: priceReplacements,
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
      tenerestore: {
        exchangeRate: DRESSCODE_CONFIG.exchangeRate,
        markupRate: DRESSCODE_CONFIG.markup,
        markupPercent: `${Math.round((DRESSCODE_CONFIG.markup - 1) * 100)}%`,
        retailVatRate: DRESSCODE_CONFIG.vatRate,
        note: '브랜드별 할인율은 크롤링 단계에서 b2bPrice 에 이미 적용됨 (시트: TENERE_Kids_Brand_Conditions).',
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
  console.log(`   총 ${merged.length}개 (가격 검토 후 분포): ${Object.entries(finalSourceCount).map(([k, v]) => `${k} ${v}`).join(' + ')}`);
  if (priceReplacements.length > 0) {
    console.log(`   💱 가격 교체 ${priceReplacements.length}건 / 총 절감 ₩${priceReplacements.reduce((s, r) => s + r.savingsKrw, 0).toLocaleString()}`);
  }
  console.log(`   신발(type=Shoes): ${shoesCount}개`);
  console.log(`   💱 Dresscode ${DRESSCODE_CONFIG.exchangeRate}원/EUR × ${DRESSCODE_CONFIG.markup} | b2b ${B2B_CONFIG.exchangeRate}원/EUR × ${B2B_CONFIG.markup} | Grifo ${GRIFO_CONFIG.exchangeRate}원/USD × ${GRIFO_CONFIG.kidsMarkup}`);
}

main();
