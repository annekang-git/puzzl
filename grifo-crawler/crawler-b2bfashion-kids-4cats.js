/**
 * crawler-b2bfashion-kids-4cats.js
 * b2bfashion 키즈 4개 카테고리 일괄 크롤링
 *   - 212-baby-girl
 *   - 213-baby-boy
 *   - 211-boy
 *   - 209-girl
 *
 * 각 카테고리별로 별도 JSON 파일 + 이미지 폴더 생성:
 *   b2bfashion_kids_baby-girl.json / images-b2bfashion-kids-baby-girl/
 *   b2bfashion_kids_baby-boy.json  / images-b2bfashion-kids-baby-boy/
 *   b2bfashion_kids_boy.json       / images-b2bfashion-kids-boy/
 *   b2bfashion_kids_girl.json      / images-b2bfashion-kids-girl/
 *
 * v2: full_reference / short_reference 구분 수집 (b2b-fast-crawler.js 방식 통합)
 *   - short_reference : 목록 페이지 .produt_reference 셀렉터
 *   - full_reference  : quickview API product.reference 필드
 *   - embedded_reference: quickview API product.embedded_attributes.reference
 *   - spu / gender    : quickview API product.features 배열 (텍스트 정규식 대신 정확한 값)
 *
 * 사용법:
 *   B2B_EMAIL=... B2B_PASSWORD=... node crawler-b2bfashion-kids-4cats.js
 *   B2B_EMAIL=... B2B_PASSWORD=... node crawler-b2bfashion-kids-4cats.js --only=baby-girl
 *   B2B_EMAIL=... B2B_PASSWORD=... node crawler-b2bfashion-kids-4cats.js --max-pages=2
 */

import { chromium } from 'playwright';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const BASE_URL   = 'https://b2bfashion.online';
const LOGIN_URL  = `${BASE_URL}/`;
const EMAIL      = process.env.B2B_EMAIL;
const PASSWORD   = process.env.B2B_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('❌ B2B_EMAIL / B2B_PASSWORD 환경변수가 필요합니다');
  console.error('   예: B2B_EMAIL=you@x.com B2B_PASSWORD=xxx node crawler-b2bfashion-kids-4cats.js');
  process.exit(1);
}

// 크롤링 대상 4개 카테고리
const CATEGORIES = [
  { slug: 'baby-girl', url: `${BASE_URL}/212-baby-girl` },
  { slug: 'baby-boy',  url: `${BASE_URL}/213-baby-boy`  },
  { slug: 'boy',       url: `${BASE_URL}/211-boy`       },
  { slug: 'girl',      url: `${BASE_URL}/209-girl`      },
];

// CLI 옵션
const args         = process.argv.slice(2);
const onlyArg      = args.find((a) => a.startsWith('--only='));
const onlySlug     = onlyArg ? onlyArg.split('=')[1] : null;
const maxPagesArg  = args.find((a) => a.startsWith('--max-pages='));
const MAX_PAGES    = maxPagesArg ? parseInt(maxPagesArg.split('=')[1], 10) : Infinity;

const targets = onlySlug ? CATEGORIES.filter((c) => c.slug === onlySlug) : CATEGORIES;
if (targets.length === 0) {
  console.error(`❌ --only=${onlySlug} 매칭 없음. 가능: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
  process.exit(1);
}

// ── 국가코드 매핑 ───────────────────────────────────────────────────────────
const COUNTRY_CODE_MAP = {
  'italy': 'IT', 'china': 'CN', 'spain': 'ES', 'germany': 'DE',
  'usa': 'US', 'united states': 'US', 'korea': 'KR', 'south korea': 'KR',
  'bangladesh': 'BD', 'romania': 'RO', 'tunisia': 'TN', 'thailand': 'TH',
  'pakistan': 'PK', 'brazil': 'BR', 'poland': 'PL', 'hungary': 'HU',
  'sri lanka': 'LK', 'myanmar': 'MM', 'colombia': 'CO', 'chile': 'CL',
  'india': 'IN', 'france': 'FR', 'portugal': 'PT', 'uk': 'GB',
  'united kingdom': 'GB', 'japan': 'JP', 'vietnam': 'VN', 'turkey': 'TR',
  'morocco': 'MA', 'indonesia': 'ID', 'cambodia': 'KH', 'egypt': 'EG',
  'mexico': 'MX', 'czech republic': 'CZ', 'bulgaria': 'BG',
  'philippines': 'PH', 'peru': 'PE', 'argentina': 'AR', 'armenia': 'AM',
  'albania': 'AL', 'serbia': 'RS', 'moldova': 'MD',
};
function getCountryCode(name) {
  if (!name) return '';
  return COUNTRY_CODE_MAP[name.toLowerCase().trim()] || '';
}

// ── 이미지 다운로드 ─────────────────────────────────────────────────────────
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filepath);
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadImage(response.headers.location, filepath).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(filepath); });
    }).on('error', (err) => { fs.unlink(filepath, () => {}); reject(err); });
  });
}

function saveProgress(products, filename) {
  fs.writeFileSync(filename, JSON.stringify(products, null, 2));
  console.log(`💾 중간 저장: ${products.length}개 → ${path.basename(filename)}`);
}

// ── Playwright 쿠키 → axios 쿠키 문자열 변환 ────────────────────────────────
async function getCookieString(context) {
  const cookies = await context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ── quickview API 호출 (b2b-fast-crawler.js 방식) ────────────────────────────
// full_reference / embedded_reference / spu / gender 등을 features 배열에서 정확히 파싱
async function getQuickviewData(productId, productAttributeId, cookieString, retries = 3) {
  const url = `${BASE_URL}/index.php?controller=product&more=20&action=quickview&id_product=${productId}&id_product_attribute=${productAttributeId}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          cookie: cookieString,
          referer: BASE_URL,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 30000,
      });
      return response.data;
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries) {
        const wait = 10000 * attempt;
        console.log(`  ⚠️  429 — ${wait / 1000}초 대기 후 재시도 (${attempt}/${retries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// quickview API 응답에서 reference / features 파싱
function extractFromQuickviewApi(data) {
  const result = {
    full_reference:      '',
    embedded_reference:  '',
    spu:                 '',
    gender:              '',
    season:              '',
    is_carry_over:       '',
    color:               '',
    composition:         '',
    made_in:             '',
    size_and_fit:        '',
    category:            '',
    type:                '',
    description:         '',
    image_urls:          [],
  };

  if (!data || !data.product) return result;

  const product = data.product;

  result.full_reference     = product.reference || '';
  result.embedded_reference = product.embedded_attributes?.reference || '';
  result.description        = product.description || '';

  // 이미지 URL (quickview_html에서 추출)
  if (data.quickview_html) {
    const imgRegex = /https:\/\/julianfashionstorage\.blob\.core\.windows\.net\/jbc\/[^"'\s]+\.jpg/g;
    const matches  = data.quickview_html.match(imgRegex);
    if (matches) result.image_urls = [...new Set(matches)];
  }

  // features 배열에서 정확한 값 파싱
  if (Array.isArray(product.features)) {
    for (const f of product.features) {
      switch (f.name) {
        case 'spu':          result.spu          = f.value; break;
        case 'gender':       result.gender       = f.value; break;
        case 'season':       result.season       = f.value; break;
        case 'is carry over': result.is_carry_over = f.value; break;
        case 'color':        result.color        = f.value; break;
        case 'composition':  result.composition  = f.value; break;
        case 'made in':
        case 'made in ':     result.made_in      = f.value; break;
        case 'size and fit': result.size_and_fit = f.value; break;
        case 'category':     result.category     = f.value; break;
        case 'type':         result.type         = f.value; break;
      }
    }
  }

  return result;
}

// ── 로그인 ──────────────────────────────────────────────────────────────────
async function login(page) {
  console.log('📋 로그인 중...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.fill('input[placeholder*="email"], input[type="email"]', EMAIL);
  await page.fill('input[placeholder*="password"], input[type="password"]', PASSWORD);
  await page.click('button:has-text("Login")');
  await page.waitForTimeout(5000);
  console.log('✅ 로그인 완료\n');
}

// 오늘 날짜 (KST)
function todayKST() {
  return new Date(new Date().getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── 카테고리 크롤링 ─────────────────────────────────────────────────────────
async function crawlCategory(page, context, cat) {
  const IMAGES_DIR   = `./images-b2bfashion-kids-${cat.slug}`;
  // 주 출력: 날짜 suffix 파일 (히스토리 보존, 부분실패시 어제 데이터 손실 방지)
  // 보조 출력: 고정명 파일 (legacy 호환용 latest 포인터, 카테고리 완료 시 복사)
  const DATE         = todayKST();
  const OUTPUT_FILE  = `b2bfashion_kids_${cat.slug}_${DATE}.json`;
  const LATEST_FILE  = `b2bfashion_kids_${cat.slug}.json`;
  const SUPPLIER     = 'b2bfashion';

  console.log('\n' + '='.repeat(80));
  console.log(`🎯 카테고리: ${cat.slug}`);
  console.log(`   URL: ${cat.url}`);
  console.log(`   출력: ${OUTPUT_FILE}`);
  console.log('='.repeat(80));

  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // 로그인 후 쿠키 (quickview API 호출용)
  let cookieString = await getCookieString(context);

  const allProducts   = [];
  const processedSpus = new Set();

  console.log('📄 상품 목록 페이지 로딩...');
  await page.goto(cat.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);

  const paginationInfo = await page.evaluate(() => {
    const pageLinks = document.querySelectorAll('.pagination a, .page-link, ul.pagination li a');
    let maxPage = 1;
    pageLinks.forEach((link) => {
      const num = parseInt(link.textContent?.trim());
      if (!isNaN(num) && num > maxPage) maxPage = num;
    });
    return { maxPage };
  });

  const totalPages     = Math.min(paginationInfo.maxPage, MAX_PAGES);
  const firstPageCount = await page.locator('.item-inner, .product-item').count();
  console.log(`📊 총 ${totalPages} 페이지 (첫 페이지: ${firstPageCount}개)\n`);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    console.log(`\n----- [${cat.slug}] 페이지 ${pageNum}/${totalPages} -----`);

    if (pageNum > 1) {
      const sep     = cat.url.includes('?') ? '&' : '?';
      const pageUrl = `${cat.url}${sep}page=${pageNum}`;
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);
      const cnt = await page.locator('.item-inner, .product-item').count();
      if (cnt === 0) { console.log('   ⚠️  상품 없음 — 종료'); break; }
    }

    // ── 목록 페이지에서 카드 정보 추출 ──────────────────────────────────────
    // short_reference: .produt_reference 셀렉터 (b2b-fast-crawler.js 방식)
    // idProduct: data-id-product 속성 (quickview API 호출에 필요)
    const productCards = await page.evaluate(() => {
      const cards = [];
      const items = document.querySelectorAll('.item-inner, .product-item');

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const text = item.innerText || '';

        // ── 브랜드 ──
        let brand = '';
        const brandSelectors = [
          '.product-description > div:first-child', '.product-brand',
          '.brand', 'h3 + div', '.product-manufacturer',
        ];
        for (const sel of brandSelectors) {
          const el = item.querySelector(sel);
          if (el) {
            const t = el.textContent?.trim() || '';
            if (t && t.length < 50 && !t.includes('€') && !t.includes('PRICE')) { brand = t; break; }
          }
        }

        // ── 상품명 ──
        const nameEl = item.querySelector('.product-title, h3, .name');
        let name = nameEl?.textContent?.trim() || '';
        if (!name) name = item.querySelector('img')?.alt || '';

        // ── short_reference (b2b-fast-crawler.js와 동일한 셀렉터) ──
        const refEl        = item.querySelector('.produt_reference');
        const shortReference = refEl ? refEl.textContent?.trim() : '';

        // ── id_product / id_product_attribute (quickview API 호출용) ──
        // b2b-fast-crawler.js와 동일하게 .product-miniature 부모에서 data attribute 추출
        let idProduct = '';
        let idProductAttribute = '';

        // 1순위: 부모 .product-miniature 요소의 data attribute
        const miniature = item.closest('.product-miniature, .js-product-miniature');
        if (miniature) {
          idProduct          = miniature.dataset.idProduct          || miniature.getAttribute('data-id-product')          || '';
          idProductAttribute = miniature.dataset.idProductAttribute || miniature.getAttribute('data-id-product-attribute') || '';
        }
        // 2순위: item 자체 또는 자식에 data attribute가 있는 경우
        if (!idProduct) {
          const el = item.closest('[data-id-product]') || item.querySelector('[data-id-product]');
          if (el) idProduct = el.dataset.idProduct || el.getAttribute('data-id-product') || '';
        }
        if (!idProductAttribute) {
          const el = item.closest('[data-id-product-attribute]') || item.querySelector('[data-id-product-attribute]');
          if (el) idProductAttribute = el.dataset.idProductAttribute || el.getAttribute('data-id-product-attribute') || '';
        }
        // 3순위: quickview 링크 href에서 파싱
        if (!idProduct || !idProductAttribute) {
          const qvLink = item.querySelector('a.quick-view, a[data-link-action="quickview"]');
          if (qvLink) {
            const href = qvLink.href || qvLink.getAttribute('href') || '';
            if (!idProduct) {
              const m = href.match(/id_product[=_](\d+)/i);
              if (m) idProduct = m[1];
            }
            if (!idProductAttribute) {
              const m = href.match(/id_product_attribute[=_](\d+)/i);
              if (m) idProductAttribute = m[1];
            }
          }
        }
        // 4순위: comb_ 클래스에서 파싱 (팝업이 미리 렌더된 경우)
        if (!idProductAttribute) {
          const combEl = item.querySelector('[class*="comb_"]');
          if (combEl) {
            const m = (combEl.className || '').match(/comb_\d+_(\d+)/);
            if (m) idProductAttribute = m[1];
          }
        }

        // ── 가격 ──
        let retailPrice = 0, finalPrice = 0, discount = 0;
        const rm = text.match(/RETAIL\s*PRICE\s*€?([\d,.]+)/i);
        if (rm) retailPrice = parseFloat(rm[1].replace(/,/g, ''));
        const fm = text.match(/FINAL\s*PRICE\s*-?(\d+)%?\s*:?\s*€?([\d,.]+)/i);
        if (fm) { discount = parseInt(fm[1]) || 0; finalPrice = parseFloat(fm[2].replace(/,/g, '')); }

        // ── 시즌 ──
        let season = '';
        const sm = text.match(/(Spring Summer \d+|Fall Winter \d+\/\d+|Sale)/i);
        if (sm) season = sm[1];

        // ── 사이즈 ──
        const sizes = [];
        let foundSize = false;
        item.querySelectorAll('.row').forEach((row) => {
          row.querySelectorAll('.col-md-3').forEach((col) => {
            if (col.textContent?.trim().toLowerCase() === 'size') foundSize = true;
          });
        });
        if (foundSize) {
          item.querySelectorAll('a[title]').forEach((link) => {
            const sz = link.getAttribute('title')?.trim();
            const lt = link.textContent?.trim();
            if (sz && lt && sz === lt &&
                !sz.toLowerCase().includes('subtract') &&
                !sz.toLowerCase().includes('add') &&
                !sz.toLowerCase().includes('button') &&
                !sizes.includes(sz)) sizes.push(sz);
          });
        }

        cards.push({
          index: i,
          brand,
          name,
          shortReference,      // .produt_reference 에서 추출
          idProduct,           // data-id-product (quickview API용)
          idProductAttribute,  // data-id-product-attribute (quickview API용)
          retailPriceEUR: retailPrice,
          finalPriceEUR:  finalPrice,
          discount,
          season,
          sizes,
        });
      }
      return cards;
    });

    console.log(`📝 ${productCards.length}개 카드 발견`);

    for (let i = 0; i < productCards.length; i++) {
      const card = productCards[i];
      const globalIdx = allProducts.length + 1;

      console.log(`\n[${cat.slug} #${globalIdx}] ${card.brand} - ${(card.name || '').substring(0, 40)}...`);
      console.log(`   short_reference: ${card.shortReference || '(없음)'}`);

      try {
        // ── Playwright 모달 열기 ─────────────────────────────────────────────
        const itemInners = await page.locator('.item-inner, .product-item').all();
        if (itemInners[i]) {
          await itemInners[i].scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
        }
        await page.evaluate(() => {
          const l = document.querySelector('.loading');
          if (l) l.style.display = 'none';
        });
        await page.waitForTimeout(500);

        const clicked = await page.evaluate((idx) => {
          const items = document.querySelectorAll('.item-inner, .product-item');
          if (!items[idx]) return false;
          const link = items[idx].querySelector('a.quick-view, a[data-link-action="quickview"]');
          if (!link) return false;
          link.click();
          return true;
        }, i);
        if (!clicked) throw new Error('quickview 링크 못 찾음');

        await page.waitForTimeout(2500);
        await page.waitForSelector('[id^="quickview-modal"]', { timeout: 5000 }).catch(() => {});

        // ── 모달에서 이미지 + id_product_attribute 추출 ─────────────────────
        const modalData = await page.evaluate(() => {
          const modal = document.querySelector('[id^="quickview-modal"]');
          if (!modal) return { images: [], description: '', detailDescription: '', idProductAttribute: '' };

          // 이미지
          const images = [];
          modal.querySelectorAll('.js-qv-mask img.thumb, img.js-thumb').forEach((el) => {
            const src = el.dataset.imageLargeSrc || el.dataset.imageMediumSrc || el.src;
            if (src && src.includes('blob.core.windows.net') && !images.includes(src)) images.push(src);
          });
          modal.querySelectorAll('img[data-image-large-src]').forEach((el) => {
            const s = el.dataset.imageLargeSrc;
            if (s && !images.includes(s)) images.push(s);
          });

          // 설명
          let detailDescription = '';
          const h2 = modal.querySelector('h2');
          if (h2?.nextElementSibling) {
            detailDescription = h2.nextElementSibling.innerHTML || h2.nextElementSibling.textContent?.trim() || '';
          }
          let description = '';
          const dd = modal.querySelector('.product-description, [class*="description"]');
          if (dd) description = dd.textContent?.trim() || '';

          // id_product_attribute 추출 (comb_productId_attributeId 클래스 패턴)
          let idProductAttribute = '';
          const combEl = modal.querySelector('[class*="comb_"]');
          if (combEl) {
            const m = (combEl.className || '').match(/comb_\d+_(\d+)/);
            if (m) idProductAttribute = m[1];
          }
          // 대체: add-to-cart 버튼의 data attribute
          if (!idProductAttribute) {
            const btn = modal.querySelector('[data-id-product-attribute]');
            if (btn) idProductAttribute = btn.dataset.idProductAttribute || '';
          }

          return { images, description, detailDescription, idProductAttribute };
        });

        // 모달 닫기
        try {
          const closeBtn = await page.locator('[id^="quickview-modal"] button').filter({ hasText: /Close|×/ }).first();
          await closeBtn.click({ timeout: 2000 });
        } catch {
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(500);

        // ── quickview API 호출 (full_reference / features 파싱) ─────────────
        // idProductAttribute: 목록 페이지 data 속성 우선, 없으면 모달에서 폴백
        const effectiveAttrId = card.idProductAttribute || modalData.idProductAttribute || '';
        let apiResult = null;
        if (card.idProduct && effectiveAttrId) {
          try {
            // 쿠키 갱신 (세션 만료 대비)
            cookieString = await getCookieString(context);
            const qvData = await getQuickviewData(card.idProduct, effectiveAttrId, cookieString);
            apiResult    = extractFromQuickviewApi(qvData);
            console.log(`   full_reference : ${apiResult.full_reference || '(없음)'}`);
            console.log(`   embedded_ref   : ${apiResult.embedded_reference || '(없음)'}`);
            console.log(`   spu (features) : ${apiResult.spu || '(없음)'}`);
            console.log(`   gender         : ${apiResult.gender || '(없음)'}`);
          } catch (apiErr) {
            console.log(`   ⚠️  quickview API 실패: ${apiErr.message} — 모달 텍스트 파싱으로 폴백`);
          }
        } else {
          console.log(`   ⚠️  idProduct=${card.idProduct} idProductAttribute=${effectiveAttrId} — API 호출 불가, 모달 파싱 사용`);
        }

        // ── 브랜드 후보정 (모달 description 첫 줄) ──────────────────────────
        const mbm = modalData.description.match(/^([A-Z][A-Z\s&]+?)(?:\s+-\s+|$)/);
        if (mbm && mbm[1].length > 2) card.brand = mbm[1].trim();
        if (!card.brand || card.brand.length < 3) card.brand = mbm ? mbm[1].trim() : 'UNKNOWN';

        // ── reference 필드 결합 ─────────────────────────────────────────────
        card.short_reference     = card.shortReference || '';
        card.full_reference      = apiResult?.full_reference      || '';
        card.embedded_reference  = apiResult?.embedded_reference  || '';
        delete card.shortReference; // 정규화된 필드명으로 통일

        // ── spu: features API > 모달 텍스트 정규식 순으로 우선 적용 ──────────
        const apiSpu = apiResult?.spu || '';
        if (apiSpu) {
          card.spu = apiSpu;
        } else {
          // 폴백: 기존 텍스트 정규식 (short_reference 또는 full_reference 활용)
          card.spu = card.full_reference || card.short_reference || card.spu || '';
        }

        // ── 기타 features 필드 적용 ─────────────────────────────────────────
        if (apiResult) {
          if (apiResult.gender)      card.gender       = apiResult.gender;
          if (apiResult.season)      card.season       = apiResult.season;
          if (apiResult.color)       card.color        = apiResult.color;
          if (apiResult.composition) card.composition  = apiResult.composition;
          if (apiResult.made_in)     card.madeIn       = apiResult.made_in;
          if (apiResult.size_and_fit) card.sizeAndFit  = apiResult.size_and_fit;
          if (apiResult.type)        card.type         = apiResult.type;
          if (apiResult.description) card.description  = apiResult.description;
        }
        card.detailDescription = modalData.detailDescription || '';

        // ── 이미지: 모달 이미지 우선, API 이미지로 보완 ─────────────────────
        const allImageUrls = [
          ...modalData.images,
          ...(apiResult?.image_urls || []),
        ];
        const uniqueImages = [...new Set(allImageUrls)];

        const localImages = [];
        const uniquePrefix = `${card.spu || card.short_reference || 'NOSPU'}_P${allProducts.length + 1}`;
        for (let ii = 0; ii < uniqueImages.length; ii++) {
          const imgUrl  = uniqueImages[ii];
          const ext     = imgUrl.includes('.jpg') ? 'jpg' : 'png';
          const localPath = path.join(IMAGES_DIR, `${uniquePrefix}_${ii + 1}.${ext}`);
          try {
            await downloadImage(imgUrl, localPath);
            localImages.push(localPath);
          } catch {
            console.log(`   ⚠️  이미지 실패: ${imgUrl}`);
          }
        }
        card.images      = uniqueImages;
        card.localImages = localImages;

        // ── 사이즈 variants ─────────────────────────────────────────────────
        card.sizeVariants = (card.sizes || []).map((s) => ({
          size: s, priceEUR: card.finalPriceEUR, isLargeSize: false,
        }));

        card.madeInCode = getCountryCode(card.madeIn);
        card.supplier   = SUPPLIER;
        card.category   = cat.slug;

        // SPU 중복 체크 (중복이면 추가 안 함)
        if (card.spu && processedSpus.has(card.spu)) {
          console.log(`   ⏭️  중복 SPU: ${card.spu} — 스킵`);
          continue;
        }

        allProducts.push(card);
        if (card.spu) processedSpus.add(card.spu);

        console.log(`   ✅ SPU:${card.spu || '-'}  short:${card.short_reference || '-'}  full:${card.full_reference || '-'}  €${card.finalPriceEUR}(-${card.discount}%)  imgs:${localImages.length}  sizes:${card.sizes?.length || 0}`);

        if (allProducts.length % 10 === 0) saveProgress(allProducts, OUTPUT_FILE);

        await page.waitForTimeout(1500);
      } catch (err) {
        console.log(`   ❌ 오류: ${err.message}`);
      }
    }
  }

  saveProgress(allProducts, OUTPUT_FILE);

  // 카테고리 완료 시 latest 포인터 갱신 (legacy 호환). 부분실패 시 latest 미갱신 가능 — 그 경우 build 가 가장 최근 정상 dated 파일로 fallback.
  try {
    fs.copyFileSync(OUTPUT_FILE, LATEST_FILE);
    console.log(`📌 latest 포인터 갱신: ${LATEST_FILE} ← ${OUTPUT_FILE}`);
  } catch (err) {
    console.warn(`⚠️  latest 포인터 복사 실패: ${err.message}`);
  }

  const withImages   = allProducts.filter((p) => p.images?.length > 0).length;
  const withSizes    = allProducts.filter((p) => p.sizes?.length > 0).length;
  const withSpu      = allProducts.filter((p) => p.spu).length;
  const withFullRef  = allProducts.filter((p) => p.full_reference).length;
  const withShortRef = allProducts.filter((p) => p.short_reference).length;

  console.log(`\n📊 [${cat.slug}] 완료: ${allProducts.length}개`);
  console.log(`   이미지:${withImages}  사이즈:${withSizes}  SPU:${withSpu}`);
  console.log(`   full_reference:${withFullRef}  short_reference:${withShortRef}`);

  return { slug: cat.slug, count: allProducts.length, withImages, withSizes, withSpu, withFullRef, withShortRef };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 b2bfashion 키즈 4카테고리 크롤러 (v2 — full/short reference 구분)');
  console.log(`   대상: ${targets.map((t) => t.slug).join(', ')}`);
  if (MAX_PAGES !== Infinity) console.log(`   페이지 제한: ${MAX_PAGES}`);

  const browser = await chromium.launch({ headless: true, slowMo: 100 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const summary = [];
  try {
    await login(page);
    for (const cat of targets) {
      try {
        const r = await crawlCategory(page, context, cat);
        summary.push(r);
      } catch (err) {
        console.error(`❌ [${cat.slug}] 카테고리 크롤 실패:`, err.message);
        summary.push({ slug: cat.slug, error: err.message });
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(80));
  console.log('📊 전체 요약');
  console.log('='.repeat(80));
  for (const s of summary) {
    if (s.error) {
      console.log(`  ❌ ${s.slug}: ${s.error}`);
    } else {
      console.log(`  ✅ ${s.slug}: ${s.count}개  (img:${s.withImages} / size:${s.withSizes} / spu:${s.withSpu})`);
      console.log(`       full_ref:${s.withFullRef}  short_ref:${s.withShortRef}`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
