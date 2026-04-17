#!/usr/bin/env node
/**
 * build-kids-data.js
 * 최신 dresscode 데이터에서 키즈 상품만 추출하여
 * 가격을 KRW로 변환(25% 마진 + 원산지/금액대/신발 정책)한 후
 * data/dresscode-kids.json 에 저장한다.
 *
 * API 응답용이므로 retailPrice, pricesIncludeVat 필드는 제거한다.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========================================================================
// 가격 정책 (API 전용)
// - 기존 dresscode-price-policy.js 의 키즈 정책 기반
// - 마진 30% → 25%, 환율 1730 → 1742 로 변경
// - 원산지별 요율, 금액대별 요율, 신발 +30,000원 정책은 유지
// ========================================================================
const EXCHANGE_RATE = 1742;     // EUR -> KRW
const MARKUP_RATE = 1.25;       // 25% 마진 (기존 키즈 1.3 → 1.25)
const SHOE_SURCHARGE = 30000;   // 신발 추가금 (원)

// 원산지별 요율 (기존 정책 그대로)
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

function isShoes(product) {
  return (product.type || '').toLowerCase() === 'shoes';
}

/**
 * EUR 가격 → KRW 판매가 변환
 *  KRW = round100(EUR × 환율 × 마진 × 원산지요율 × 금액대요율) + (신발이면 +30,000원)
 */
function calculateKrwPrice(priceEur, product) {
  if (!priceEur || priceEur <= 0) return 0;
  const countryRate = getCountryRate(product.madeIn);
  const base = priceEur * EXCHANGE_RATE * MARKUP_RATE * countryRate;
  const tierRate = getPriceTierRate(base);
  let salePrice = roundTo100(base * tierRate);
  if (isShoes(product)) salePrice += SHOE_SURCHARGE;
  return salePrice;
}

/**
 * EUR 정가(MSRP) → KRW 정가 변환
 *  마진/원산지/금액대 요율 없이 단순 환율만 적용
 *  (브랜드의 권장소비자가 그대로 유지)
 */
function calculateKrwRetailPrice(retailPriceEur) {
  if (!retailPriceEur || retailPriceEur <= 0) return 0;
  return roundTo100(retailPriceEur * EXCHANGE_RATE);
}

// ========================================================================
// 메인
// ========================================================================
function main() {
  const syncDataDir = path.join(__dirname, 'grifo-crawler/sync/sync-data');
  const outputFile = path.join(__dirname, 'data/dresscode-kids.json');

  // 최신 dresscode_products_YYYY-MM-DD.json 찾기
  const files = fs.readdirSync(syncDataDir)
    .filter(f => /^dresscode_products_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error('❌ dresscode_products_YYYY-MM-DD.json 파일을 찾을 수 없습니다.');
    process.exit(1);
  }

  const latestFile = files[0];
  console.log(`📂 소스 파일: ${latestFile}`);

  const raw = JSON.parse(fs.readFileSync(path.join(syncDataDir, latestFile), 'utf-8'));
  const allProducts = raw.raw_api_response || raw.products || [];
  console.log(`   전체 상품: ${allProducts.length}개`);

  // 키즈 필터 (Baby boy / Baby girl / Unisex baby)
  const kidsProducts = allProducts.filter(p => {
    const g = (p.genre || '').trim();
    return g.startsWith('Baby') || g === 'Unisex baby';
  });
  console.log(`   키즈 상품: ${kidsProducts.length}개`);

  // 가격 변환 + 필드 정리
  let shoesCount = 0;
  const processed = kidsProducts.map(p => {
    if (isShoes(p)) shoesCount++;

    // 상품 레벨 가격
    const priceKrw = calculateKrwPrice(p.price, p);
    const retailPriceKrw = calculateKrwRetailPrice(p.retailPrice);

    // 사이즈별 가격
    const sizes = (p.sizes || []).map(s => {
      const { retailPrice: sizeRetailEur, price: sizePriceEur, ...rest } = s;
      return {
        ...rest,
        price: calculateKrwPrice(sizePriceEur, p),
        retailPrice: calculateKrwRetailPrice(sizeRetailEur),
        currency: 'KRW',
      };
    });

    // 상품 본체에서 pricesIncludeVat 만 제거 (retailPrice 는 KRW 로 재계산하여 유지)
    const { retailPrice: _rpEur, pricesIncludeVat: _vat, price: _origPrice, ...rest } = p;
    return {
      ...rest,
      price: priceKrw,
      retailPrice: retailPriceKrw,
      currency: 'KRW',
      sizes,
    };
  });

  const dataDate = latestFile.match(/\d{4}-\d{2}-\d{2}/)[0];
  const output = {
    dataDate,
    total: processed.length,
    updatedAt: new Date().toISOString(),
    priceInfo: {
      currency: 'KRW',
      exchangeRate: EXCHANGE_RATE,
      markupRate: MARKUP_RATE,
      markupPercent: `${Math.round((MARKUP_RATE - 1) * 100)}%`,
      surcharges: { shoes: SHOE_SURCHARGE },
      note:
        'price = roundTo100(EUR × 환율 × 마진 × 원산지요율 × 금액대요율) + 신발 추가금. ' +
        'retailPrice = roundTo100(retailPriceEUR × 환율) — 브랜드 권장소비자가(MSRP)를 단순 환전한 값. ' +
        'pricesIncludeVat 필드는 API 응답에서 제거됨.',
    },
    products: processed,
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output));

  console.log(`\n✅ 출력: ${outputFile}`);
  console.log(`   상품 ${processed.length}개 (신발 ${shoesCount}개)`);
  console.log(`   💱 환율 ${EXCHANGE_RATE}원/EUR, 마진 ${((MARKUP_RATE - 1) * 100).toFixed(0)}%`);
}

main();
