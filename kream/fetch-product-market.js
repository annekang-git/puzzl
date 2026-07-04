/**
 * fetch-product-market.js
 * SKU + 옵션 리스트를 받아 KREAM 시세/입찰/체결 데이터를 일괄 수집
 *
 * 입력: targets.json (또는 CLI 첫 인자로 경로)
 *   [
 *     { "sku": "SSX03L101N", "option": "40mm", "eur_price": 1200 },
 *     { "sku": "HSW765730045", "option": "270" }
 *   ]
 *   ※ eur_price 는 optional. 있으면 결과에 echo (마진 계산용)
 *
 * 출력: results/kream_market_{YYYY-MM-DD_HHMMSS}.json
 *
 * 사용법:
 *   node fetch-product-market.js                 # ./targets.json 사용
 *   node fetch-product-market.js my-targets.json
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KREAM_URL = 'https://kream.co.kr';
const API_BASE = 'https://api.kream.co.kr';
// KREAM 직접 로그인 (이메일 + 비밀번호) — 반드시 환경변수로 주입.
// 레포가 public 이라 하드코딩 금지. 로컬에서 .env 또는 shell export 로 설정.
//   export KREAM_EMAIL='...'
//   export KREAM_PASSWORD='...'
const KREAM_EMAIL = process.env.KREAM_EMAIL;
const KREAM_PASSWORD = process.env.KREAM_PASSWORD;
if (!KREAM_EMAIL || !KREAM_PASSWORD) {
  console.error('❌ KREAM_EMAIL / KREAM_PASSWORD 환경변수가 필요합니다.');
  console.error('   예: KREAM_EMAIL=you@example.com KREAM_PASSWORD=... node fetch-product-market.js targets.json');
  process.exit(1);
}
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

const PER_PAGE = 5; // 마지막 N건만

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const nowKstStamp = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
};

// ──────────────────────────────────────────────────
// 로그인
// ──────────────────────────────────────────────────
async function ensureLoggedIn(page, context) {
  await page.goto(KREAM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000); // 페이지가 자동으로 /users/me 호출하여 토큰 갱신할 시간

  // 1) /my 페이지로 이동 시도해서 redirect 여부로 확인
  try {
    await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(1500);
    const u = page.url();
    if (u.includes('/my') && !u.includes('login')) {
      console.log('✅ 기존 세션으로 로그인 됨 (/my 접근 성공)');
      return true;
    }
  } catch (_) {}

  console.log('   /my 접근 불가 — 새로 로그인 필요');

  console.log(`🔐 KREAM 직접 로그인 진행 (${KREAM_EMAIL})...`);
  // 1단계: /login 진입 (소셜 로그인 + '이메일 로그인' 버튼 선택 화면)
  await page.goto(`${KREAM_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await delay(3000);
  console.log(`   📍 1단계 URL: ${page.url()}`);
  await page.screenshot({ path: path.join(RESULTS_DIR, 'login-step1-page.png'), fullPage: true }).catch(() => {});

  // 2단계: '이메일 로그인' 버튼/링크 클릭 → /login/email 로 이동
  // 클릭이 실패하면 직접 URL 이동으로 fallback
  const emailLoginEntry = page.locator([
    'a:has-text("이메일 로그인")',
    'button:has-text("이메일 로그인")',
    'a[href*="/login/email"]',
    '[class*="email"]:has-text("이메일")',
  ].join(', ')).first();

  try {
    await emailLoginEntry.waitFor({ state: 'visible', timeout: 5000 });
    await emailLoginEntry.click({ timeout: 3000 });
    console.log('   ✓ "이메일 로그인" 버튼 클릭');
    await delay(2500);
  } catch (_) {
    console.log('   ℹ️ 버튼 못 찾음 — /login/email 직접 이동');
    await page.goto(`${KREAM_URL}/login/email`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await delay(2500);
  }
  console.log(`   📍 2단계 URL (이메일 폼): ${page.url()}`);

  // KREAM 로그인 폼: 이메일 + 비밀번호 input
  // 셀렉터 다양화 (페이지 구조 변동 대응)
  const emailInput = page.locator([
    'input[type="email"]',
    'input[name="email"]',
    'input[name="id"]',
    'input[placeholder*="이메일"]',
    'input[placeholder*="아이디"]',
  ].join(', ')).first();
  const pwInput = page.locator([
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="비밀번호"]',
  ].join(', ')).first();

  try {
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    console.log('   ✓ 이메일 input 발견');
  } catch (e) {
    const dbg = path.join(RESULTS_DIR, 'login-error.png');
    await page.screenshot({ path: dbg, fullPage: true }).catch(() => {});
    console.log(`   📸 디버그 스크린샷: ${dbg}`);
    throw new Error(`KREAM 로그인 폼(이메일) 못 찾음. 현재 URL: ${page.url()}`);
  }

  await emailInput.click();
  await emailInput.fill('');
  await emailInput.pressSequentially(KREAM_EMAIL, { delay: 60 });
  await delay(300);

  await pwInput.click();
  await pwInput.fill('');
  await pwInput.pressSequentially(KREAM_PASSWORD, { delay: 60 });
  await delay(500);

  // 작성 후 스크린샷 (입력 검증용)
  await page.screenshot({ path: path.join(RESULTS_DIR, 'login-step2-filled.png'), fullPage: true }).catch(() => {});

  // 로그인 버튼 — "로그인" 텍스트 있는 버튼 우선
  // KREAM 페이지에는 헤더에도 "로그인" 링크가 있으므로 폼 내부의 submit 버튼을 우선
  const loginBtn = page.locator([
    'button[type="submit"]:has-text("로그인")',
    'form button:has-text("로그인")',
    'button.signin-btn',
    'button[type="submit"]',
  ].join(', ')).first();

  try {
    await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch (e) {
    console.log('   ⚠️ 로그인 버튼 후보 미발견 — Enter 키로 submit 시도');
  }
  // 시도 1: 버튼 클릭
  try {
    await loginBtn.click({ timeout: 3000 });
    console.log('   ✓ 로그인 버튼 클릭');
  } catch (_) {
    // 시도 2: Enter 키
    await pwInput.press('Enter');
    console.log('   ✓ Enter 키로 submit');
  }

  // 클릭 후 스크린샷 (에러 메시지/캡차 확인용)
  await delay(4000);
  await page.screenshot({ path: path.join(RESULTS_DIR, 'login-step3-after-submit.png'), fullPage: true }).catch(() => {});
  console.log(`   📍 submit 후 URL: ${page.url()}`);

  // 로그인 완료까지 대기 (캡차 발생 시 사용자 개입 가능, 최대 90초)
  console.log('   ⏳ KREAM 메인 복귀 대기 (캡차 발생 시 직접 처리, 최대 90s)...');
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const u = page.url();
    // /login 빠져나가면 성공
    if (u.includes('kream.co.kr') && !u.includes('/login')) break;
    await delay(2000);
  }
  await delay(2000);
  await page.screenshot({ path: path.join(RESULTS_DIR, 'login-step4-final.png'), fullPage: true }).catch(() => {});

  // /my 접근 가능하면 로그인 성공
  try {
    await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(1500);
    if (!page.url().includes('/my') || page.url().includes('login')) {
      throw new Error('로그인 후에도 /my 접근 실패');
    }
  } catch (e) {
    throw new Error('로그인 실패: ' + e.message);
  }
  console.log('✅ 로그인 완료');
  return true;
}

// ──────────────────────────────────────────────────
// SKU → product_id 검색 + 검증
// ──────────────────────────────────────────────────
async function searchAndExtractCandidates(page, keyword) {
  const url = `${KREAM_URL}/search?keyword=${encodeURIComponent(keyword)}`;
  // KREAM 이 0건 결과에 자체 redirect 를 걸기 때문에, navigation interrupt 가능 → 1회 재시도
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 페이지의 후속 redirect/네트워크 활동 settle 대기 (interrupt 방지)
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      break;
    } catch (e) {
      if (attempt === 0 && /interrupted by another navigation|frame was detached/i.test(e.message || '')) {
        await delay(1000);
        continue;
      }
      throw e;
    }
  }
  await delay(1500);
  return await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    document.querySelectorAll('a[href*="/products/"]').forEach((a) => {
      const m = a.href.match(/\/products\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ product_id: Number(id), text: (a.innerText || '').trim().slice(0, 200) });
    });
    return out;
  });
}

// SKU/모델번호 비교용 정규화: 영숫자만 남기고 대문자로
function normalizeCode(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

async function verifyCandidate(page, productId, needles) {
  // needles 중 하나라도 상품 페이지 DOM 에 등장하면 매칭 성공
  // 하이픈/공백 무시하고 비교 (KREAM 모델번호는 "I034594-89-XX" 형식)
  try {
    await page.goto(`${KREAM_URL}/products/${productId}`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await delay(1500);
    const body = await page.evaluate(() => document.body.innerText);
    const bodyNorm = normalizeCode(body);
    for (const n of needles) {
      if (!n) continue;
      const needleNorm = normalizeCode(n);
      if (needleNorm && bodyNorm.includes(needleNorm)) {
        const title = await page.evaluate(() => {
          // 우선순위 1: document.title (KREAM 페이지 title — 보통 정확한 상품명 포함, 가장 안정적)
          //   예: "비비안 웨스트우드 Vivienne Westwood OOO 셔츠 - KREAM"
          const docTitle = (document.title || '').replace(/\s*[-|]\s*KREAM\s*$/i, '').trim();
          if (docTitle && docTitle.length > 5) return docTitle;
          // 우선순위 2: 명시적 product-title 클래스
          const sel = ['[class*="product-title-ko"]', '[class*="title-ko"]', '[class*="product-name"]', 'h1'];
          for (const s of sel) {
            const el = document.querySelector(s);
            if (el && el.innerText.trim().length > 5) return el.innerText.trim().slice(0, 200);
          }
          // fallback
          const el = document.querySelector('[class*="title"]');
          return el ? el.innerText.trim().slice(0, 200) : '';
        });
        return { ok: true, product_name_ko: title, matched_needle: n };
      }
    }
    return { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function resolveSkuToProductId(page, target) {
  const sku = target.sku;
  const spu = target.spu;
  // 매칭 needle 후보 (검증용 — 큰 것부터 작은 것으로)
  const needles = [sku, spu].filter(Boolean);

  // 검색 키 우선순위
  const searchKeys = [sku];
  if (spu && spu !== sku) searchKeys.push(spu);

  let allCandidates = [];
  for (const key of searchKeys) {
    const cands = await searchAndExtractCandidates(page, key);

    // (1) 검색 결과가 정확히 1건이면 자동 채택 (user 룰)
    if (cands.length === 1) {
      return {
        product_id: cands[0].product_id,
        product_name_ko: cands[0].text.split('\n').find((l) => l.trim() && !/[A-Za-z]+\s*WIP|Carhartt/i.test(l)) || cands[0].text.slice(0, 80),
        matched_via: `single-candidate(${key})`,
      };
    }

    // (2) 카드 텍스트에 SKU/SPU 가 보이는 후보가 있으면 즉시 채택 (정규화 비교)
    for (const c of cands) {
      const textNorm = normalizeCode(c.text);
      for (const n of needles) {
        const needleNorm = normalizeCode(n);
        if (needleNorm && textNorm.includes(needleNorm)) {
          return { product_id: c.product_id, matched_via: `search-card-text(${key}→${n})` };
        }
      }
    }

    // (3) 상위 3개만 상품 페이지 직접 검증 (verify 도 정규화 비교)
    for (const c of cands.slice(0, 3)) {
      const v = await verifyCandidate(page, c.product_id, needles);
      if (v.ok) {
        return { product_id: c.product_id, product_name_ko: v.product_name_ko, matched_via: `verify(${key}→${v.matched_needle})` };
      }
    }
    allCandidates = allCandidates.concat(cands.slice(0, 5));
  }

  return {
    error: `No KREAM match for SKU="${sku}"${spu ? ` SPU="${spu}"` : ''}`,
    candidates: allCandidates.slice(0, 5),
  };
}

// ──────────────────────────────────────────────────
// product_id + option → market data
// ──────────────────────────────────────────────────
// KREAM API 경로 (2026-07 기준): 옵션 segment 가 URL 에 다시 들어감.
//   /api/p/products/{id}/{option_key}/sales?cursor=...
//   /api/p/products/{id}/{option_key}/asks
//   /api/p/products/{id}/{option_key}/bids
//   /api/p/products/{id}/{option_key}/chart
// (과거 한때 옵션 없는 flat endpoint 였으나 다시 옵션 segment 부활함 — 둘 다 지원)
// items[].option 필드가 있을 수도 없을 수도 있으므로 URL segment 우선 사용.
// "거래 내역 더보기" 버튼 클릭이 트리거 — 누르지 않으면 API 호출이 일어나지 않음.
async function fetchAllOptionsForProduct(page, productId) {
  const captured = {}; // captured[opt] = { sales:[...], asks:[...], bids:[...], chart:{...} }
  // {id}/{option?}/{type} — option segment 는 optional 로 매칭
  const apiRegex = new RegExp(`/api/p/products/${productId}/(?:([^/?]+)/)?(sales|asks|bids|chart)(?:\\?|$)`);

  function ensureOpt(o) {
    if (!captured[o]) captured[o] = { sales: [], asks: [], bids: [], chart: null };
    return captured[o];
  }

  const handler = async (resp) => {
    const m = resp.url().match(apiRegex);
    if (!m) return;
    const urlOpt = m[1] ? decodeURIComponent(m[1]).trim() : null;
    const type = m[2];
    let body;
    try { body = await resp.json(); } catch (_) { return; }

    if (type === 'chart') {
      // chart 는 옵션별로 오지만 전체 상품 대표값도 같이 쓸 수 있게 '__all' 로도 저장
      const key = urlOpt || '__all';
      ensureOpt(key).chart = body;
      if (!captured['__all']) ensureOpt('__all').chart = body;
      return;
    }
    // sales/asks/bids
    const items = Array.isArray(body.items) ? body.items : [];
    for (const it of items) {
      // URL segment 우선, 없으면 item 필드 fallback
      const opt = urlOpt || String(it.option ?? it.product_option?.key ?? '__all').trim();
      ensureOpt(opt)[type].push(it);
    }
  };

  page.on('response', handler);

  try {
    await page.goto(`${KREAM_URL}/products/${productId}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await delay(2500);

    // 거래 내역 더보기 클릭 — 이게 API 호출 트리거.
    // KREAM 은 PC/Mobile 두 개의 버튼을 duplicate 로 렌더링하고 CSS 로 하나만 visible 로 만드는데,
    // domcontentloaded 직후엔 layout 이 아직 안 잡혀 visible 판단이 실패함. waitForSelector 로 명시적 대기.
    let clicked = false;
    try {
      // 하단 섹션이 lazy render 되는 경우가 있어 스크롤로 강제 mount
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await delay(800);

      // visible 인 "거래 내역 더보기" 버튼이 나올 때까지 최대 8초 대기
      await page.waitForSelector('button:has-text("거래 내역 더보기"):visible', { timeout: 8000 });
      const moreBtn = page.locator('button:has-text("거래 내역 더보기"):visible').first();
      await moreBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
      await moreBtn.click({ timeout: 5000, force: true });
      await delay(4000); // API 응답 받을 시간
      clicked = true;
    } catch (e) {
      // fallback — 그래도 visible 인 게 안 잡히면 hidden 상관 없이 아무 매칭 버튼이라도 시도
      const anyBtn = page.locator('button:has-text("거래 내역 더보기")').first();
      if ((await anyBtn.count()) > 0) {
        try {
          await anyBtn.click({ timeout: 5000, force: true });
          await delay(4000);
          clicked = true;
        } catch (_) {}
      }
      if (!clicked) console.log(`     ℹ️  "거래 내역 더보기" 버튼 없음/클릭 실패 (pid=${productId})`);
    }
  } finally {
    page.off('response', handler);
  }

  return captured;
}

// 사이즈 별칭 — 의미적으로 같은 사이즈를 동일하게 취급
const UNIVERSAL_SIZES = new Set(['U', 'UNICA', 'FREE', 'ONE SIZE', 'ONESIZE', 'OS', 'F', 'UNI', 'UNIVERSAL']);
// 지역 접두/접미사 — EU 42 == 42 == 42 IT 처럼 취급
const SIZE_REGION_RE = /^(EU|US|UK|IT|FR|JP|JPN|KR|KOR|EUR)\s+|\s+(EU|US|UK|IT|FR|JP|JPN|KR|KOR|EUR)$/i;
function normSize(s) { return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' '); }
function stripSizeRegion(s) { return normSize(s).replace(SIZE_REGION_RE, '').trim(); }
function isSameSizeGroup(a, b) {
  const na = normSize(a), nb = normSize(b);
  if (na === nb) return true;
  if (UNIVERSAL_SIZES.has(na) && UNIVERSAL_SIZES.has(nb)) return true;
  // 지역 접두/접미 (EU 42 ↔ 42, 42 IT ↔ 42, EU 42 ↔ US 42) 떼고 비교
  const sa = stripSizeRegion(na), sb = stripSizeRegion(nb);
  if (sa && sb && sa === sb) return true;
  return false;
}

// 캐시된 옵션 데이터에서 target option 선택 + market 요약
function pickOptionFromCache(captured, option) {
  const allOpts = Object.keys(captured);
  let chosen = null;
  // 1) 완전 일치 (정규화 후)
  for (const o of allOpts) {
    if (isSameSizeGroup(o, option)) { chosen = o; break; }
  }
  // 2) "US 10" 같은 prefix
  if (!chosen && captured[`US ${option}`]) chosen = `US ${option}`;
  // 3) 부분일치
  if (!chosen) {
    const found = allOpts.find((o) => o.includes(String(option)) || String(option).includes(o));
    if (found) chosen = found;
  }
  // 4) 단일 옵션 상품이면 그냥 채택 (universal 처리)
  if (!chosen && allOpts.length === 1) chosen = allOpts[0];
  // 5) 최후 fallback
  if (!chosen && allOpts.length > 0) chosen = allOpts[0];

  // mismatch 판단도 별칭 인식
  const optionMismatch = chosen != null
    ? !isSameSizeGroup(chosen, option) && allOpts.length > 1
    : true;

  // 새 API 구조: captured[opt] = { sales:[...], asks:[...], bids:[...], chart:{} }
  //   chart 는 '__all' 키에만 저장됨 (전체 상품 차원)
  const sel = chosen ? captured[chosen] : {};
  const chart = captured['__all']?.chart || sel.chart || null;
  const sales = Array.isArray(sel.sales) ? sel.sales : [];
  const asks  = Array.isArray(sel.asks)  ? sel.asks  : [];
  const bids  = Array.isArray(sel.bids)  ? sel.bids  : [];

  const slimSales = sales.map((it) => ({
    price: it.price, option: it.option, date_created: it.date_created,
    date_text: it.date_created_display_text, is_immediate: it.is_immediate_delivery_item,
  }));
  const slimAsks = asks.map((it) => ({ price: it.price, option: it.option, quantity: it.quantity }));
  const slimBids = bids.map((it) => ({ price: it.price, option: it.option, quantity: it.quantity }));
  const lowestAsk  = slimAsks.length ? Math.min(...slimAsks.map((a) => a.price)) : null;
  const highestBid = slimBids.length ? Math.max(...slimBids.map((b) => b.price)) : null;
  const lastSale   = slimSales.length ? slimSales[0].price : null;
  const changeText = chart?.recently_sale_price?.lookups?.[0]?.text || null;

  return {
    market: { last_sale_price: lastSale, lowest_ask: lowestAsk, highest_bid: highestBid, change_text: changeText },
    sales: slimSales, asks: slimAsks, bids: slimBids,
    totals: {
      sales: slimSales.length,
      asks: slimAsks.length,
      bids: slimBids.length,
    },
    raw_chart_recently: chart?.recently_sale_price || null,
    kream_option: chosen,
    kream_options_available: allOpts.filter((o) => o !== '__all'),
    option_mismatch: optionMismatch,
  };
}

async function fetchMarketData(page, productId, option) {
  // 응답 인터셉터 — 모든 옵션 응답을 캡처해놓고 나중에 best match 선택
  const captured = {}; // captured[opt][type] = body
  const apiRegex = new RegExp(`/api/p/products/${productId}/([^/?]+)/(sales|asks|bids|chart)(?:\\?|$)`);
  const handler = async (resp) => {
    const m = resp.url().match(apiRegex);
    if (!m) return;
    const respOpt = decodeURIComponent(m[1]);
    const type = m[2];
    try {
      const body = await resp.json();
      if (!captured[respOpt]) captured[respOpt] = {};
      captured[respOpt][type] = body;
    } catch (_) {}
  };
  page.on('response', handler);

  try {
    // 상품 페이지 진입
    await page.goto(`${KREAM_URL}/products/${productId}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await delay(2000);

    // "거래 내역 더보기" 모달 — 4개 API 자동 트리거됨
    const moreBtn = page.locator('button:has-text("거래 내역 더보기"):visible').first();
    if ((await moreBtn.count()) > 0) {
      try {
        await moreBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
        await moreBtn.click({ timeout: 5000, force: true });
        await delay(3500);
      } catch (e) {
        console.log(`     ⚠️  거래 내역 더보기 클릭 실패: ${e.message.slice(0, 60)}`);
      }
    }

    // 추가로 옵션 selector 보이면 target option 클릭해서 데이터 갱신 시도
    const optTab = page.locator(`a:visible:has-text("${option}"), button:visible:has-text("${option}")`).first();
    if ((await optTab.count()) > 0) {
      try {
        await optTab.click({ timeout: 4000, force: true });
        await delay(3000);
      } catch (_) {}
    }
  } finally {
    page.off('response', handler);
  }

  // best match 선택: 정확히 option 일치 → 없으면 option 을 포함하는 키 → 없으면 첫 캡처
  const allOpts = Object.keys(captured);
  let chosen = null;
  if (captured[option]) chosen = option;
  else if (captured[`US ${option}`]) chosen = `US ${option}`;
  else {
    // option 이 숫자면 KREAM 사이즈 변환 케이스 (예: dresscode "10" → KREAM "275" mm)
    // 일단 단순 부분일치 시도
    const found = allOpts.find((o) => o.includes(String(option)) || String(option).includes(o));
    if (found) chosen = found;
  }
  // 마지막 fallback: 캡처된 첫 옵션 (보통 KREAM 디폴트 옵션)
  if (!chosen && allOpts.length > 0) chosen = allOpts[0];

  const sel = chosen ? captured[chosen] : {};
  const data = {
    sales: sel.sales || null,
    asks: sel.asks || null,
    bids: sel.bids || null,
    chart: sel.chart || null,
    _chosen_option: chosen,
    _available_options: allOpts,
    _option_mismatch: chosen != null ? (!isSameSizeGroup(chosen, option) && allOpts.length > 1) : true,
  };

  if (allOpts.length === 0) {
    console.log(`     ⚠️  옵션 응답 0개 (모달이 안 열렸을 수 있음)`);
  } else if (data._option_mismatch) {
    console.log(`     ℹ️  옵션 ${option} 없음 → '${chosen}' 사용. 사용가능: ${allOpts.join(', ')}`);
  }

  // 정리 — 핵심 필드만 압축
  const slimSales = (data.sales?.items || []).map((it) => ({
    price: it.price,
    option: it.option,
    date_created: it.date_created,
    date_text: it.date_created_display_text,
    is_immediate: it.is_immediate_delivery_item,
  }));
  const slimAsks = (data.asks?.items || []).map((it) => ({
    price: it.price, option: it.option, quantity: it.quantity,
  }));
  const slimBids = (data.bids?.items || []).map((it) => ({
    price: it.price, option: it.option, quantity: it.quantity,
  }));

  const lowestAsk = slimAsks.length > 0 ? Math.min(...slimAsks.map((a) => a.price)) : null;
  const highestBid = slimBids.length > 0 ? Math.max(...slimBids.map((b) => b.price)) : null;
  const lastSale = slimSales.length > 0 ? slimSales[0].price : null;
  const changeText = data.chart?.recently_sale_price?.lookups?.[0]?.text || null;

  return {
    market: {
      last_sale_price: lastSale,
      lowest_ask: lowestAsk,
      highest_bid: highestBid,
      change_text: changeText,
    },
    sales: slimSales,
    asks: slimAsks,
    bids: slimBids,
    totals: {
      sales: data.sales?.total ?? null,
      asks: data.asks?.total ?? null,
      bids: data.bids?.total ?? null,
    },
    raw_chart_recently: data.chart?.recently_sale_price || null,
    kream_option: data._chosen_option,
    kream_options_available: data._available_options,
    option_mismatch: data._option_mismatch,
  };
}

// ──────────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────────
// CHUNK 모드 — chromium 메모리 누적/IPC crash 완화를 위해 N 타겟마다 브라우저 컨텍스트 재시작.
// KREAM_CHUNK_SIZE 환경변수로 조정 가능 (기본 50). 0 이면 chunk 비활성 (단일 컨텍스트).
const CHUNK_SIZE = Number(process.env.KREAM_CHUNK_SIZE ?? 50);

// 한국 residential 프록시 설정 (선택) — 해외 클라우드 IP 가 KREAM 에 차단된 경우 사용.
// .env 또는 환경변수로 주입:
//   KREAM_PROXY_SERVER=http://proxy.webshare.io:80
//   KREAM_PROXY_USER=username-country-kr
//   KREAM_PROXY_PASS=password
// 설정 안 되어 있으면 프록시 없이 직접 접속 (Mac mini, 한국 IP 환경).
function getProxyConfig() {
  const server = process.env.KREAM_PROXY_SERVER;
  if (!server) return null;
  return {
    server,
    ...(process.env.KREAM_PROXY_USER ? { username: process.env.KREAM_PROXY_USER } : {}),
    ...(process.env.KREAM_PROXY_PASS ? { password: process.env.KREAM_PROXY_PASS } : {}),
  };
}

// 브라우저 컨텍스트 열기 — chunk 마다 호출
async function openContext(isHeadless) {
  // 다른 호스트 (Mac → Linux 이전 등) 에서 복사된 SingletonLock/Cookie/Socket 잔재 제거.
  // Chrome 이 옛 PID/호스트 보고 "다른 컴퓨터에서 사용 중" 으로 잘못 인식해 launch 실패하는 사고 방지.
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(BROWSER_DATA_DIR, name);
    try { if (fs.existsSync(p) || fs.lstatSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
  const proxy = getProxyConfig();
  if (proxy) console.log(`🌐 프록시 사용: ${proxy.server}`);
  const ctx = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: isHeadless,
    ...(isHeadless ? {} : { channel: 'chrome' }),
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-popup-blocking'],
    ...(proxy ? { proxy } : {}),
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  return { ctx, page };
}

// 단일 타겟 처리 — chunk 내 loop 가 호출
async function processTarget(page, t, results, skuCache, productMarketCache, i, total) {
  const tag = `[${i + 1}/${total}] ${t.sku} / ${t.option}`;
  console.log(`🔍 ${tag}`);

  // 1) SKU 해결
  let resolved = skuCache.get(t.sku);
  if (!resolved) {
    try { resolved = await resolveSkuToProductId(page, t); }
    catch (e) { resolved = { error: `Resolve threw: ${e.message}` }; }
    skuCache.set(t.sku, resolved);
  }

  if (resolved.error) {
    console.log(`   ❌ ${resolved.error}`);
    results.push({
      sku: t.sku, option: t.option, stock: t.stock ?? null, eur_price: t.eur_price ?? null,
      matched: false, error: resolved.error, candidates: resolved.candidates,
    });
    return;
  }

  // 2) market data
  try {
    let allOptionsData = productMarketCache.get(resolved.product_id);
    if (!allOptionsData) {
      allOptionsData = await fetchAllOptionsForProduct(page, resolved.product_id);
      productMarketCache.set(resolved.product_id, allOptionsData);
    }
    const market = pickOptionFromCache(allOptionsData, t.option);
    console.log(
      `   ✅ pid=${resolved.product_id}  ` +
      `lastSale=${market.market.last_sale_price ?? '-'}  ` +
      `lowAsk=${market.market.lowest_ask ?? '-'}  ` +
      `highBid=${market.market.highest_bid ?? '-'}  ` +
      `(${market.totals.sales}/${market.totals.asks}/${market.totals.bids})`
    );
    results.push({
      sku: t.sku, option: t.option, stock: t.stock ?? null, eur_price: t.eur_price ?? null,
      matched: true, product_id: resolved.product_id,
      product_name_ko: resolved.product_name_ko || null,
      product_url: `${KREAM_URL}/products/${resolved.product_id}`,
      ...market,
    });
  } catch (e) {
    console.log(`   ❌ fetchMarketData 실패: ${e.message}`);
    results.push({
      sku: t.sku, option: t.option, stock: t.stock ?? null, eur_price: t.eur_price ?? null,
      matched: false, product_id: resolved.product_id,
      error: `fetchMarketData: ${e.message}`,
    });
  }
}

async function main() {
  const inputFile = process.argv[2] || path.join(__dirname, 'targets.json');
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ 입력 파일 없음: ${inputFile}`);
    console.error('예시 targets.json:');
    console.error('  [{"sku":"SSX03L101N","option":"40mm","eur_price":1200}]');
    process.exit(1);
  }

  const targets = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  if (!Array.isArray(targets) || targets.length === 0) {
    console.error('❌ targets 는 배열이어야 하고 1개 이상 항목이 있어야 함');
    process.exit(1);
  }

  const isHeadless = process.env.KREAM_HEADLESS === '1';
  const chunkSize = CHUNK_SIZE > 0 ? CHUNK_SIZE : targets.length;
  const totalChunks = Math.ceil(targets.length / chunkSize);
  console.log(`📥 ${targets.length}개 타겟 로드: ${inputFile}`);
  console.log(`📦 Chunk 모드: ${chunkSize} 타겟 × ${totalChunks} chunk  (KREAM_CHUNK_SIZE 로 조정)`);
  if (isHeadless) console.log('🤖 headless 모드 (cron 자동화)');
  console.log();

  const results = [];
  const skuCache = new Map();         // SKU → product_id
  const productMarketCache = new Map(); // product_id → 옵션별 시세

  // ── chromium IPC 충돌 (Playwright pipeTransport SyntaxError) 대응 ──
  // chromium 서브프로세스가 잘린 JSON 응답 보내면 uncaughtException 으로 올라와 process 강제 종료.
  // 핸들러 등록 → Node 가 죽지 않음 → flag 만 세팅 → chunk loop 가 감지해서 현재 chunk 중단,
  // 다음 chunk 에서 새 context 로 깨끗하게 재시작.
  //
  // ⚠️ stuck 방지: 같은 chunk 내에서 uncaughtException 이 너무 많이 발생하면
  // (chromium 이 완전히 망가짐) fetch 전체를 종료 → daily-kream-update.js 가 다음 브랜드로 이행.
  let browserCrashed = false;
  let totalUncaught = 0;
  const MAX_UNCAUGHT = 50; // 이 값 초과 시 fetch 전체 abort
  process.on('uncaughtException', (err) => {
    totalUncaught++;
    if (totalUncaught <= 3 || totalUncaught % 20 === 0) {
      console.error(`⚠️ uncaughtException (#${totalUncaught}): ${(err.message || String(err)).slice(0, 150)}`);
    }
    browserCrashed = true;
    if (totalUncaught >= MAX_UNCAUGHT) {
      console.error(`\n❌ uncaughtException 누적 ${MAX_UNCAUGHT}회 초과 — chromium 회복 불가, fetch 중단`);
      try { saveProgress(); } catch (_) {}
      process.exit(2);
    }
  });
  process.on('unhandledRejection', (err) => {
    const msg = err?.message || String(err);
    if (totalUncaught < 3) console.error(`⚠️ unhandledRejection: ${msg.slice(0, 150)}`);
    if (/JSON|pipe|Target closed|browser has been closed/i.test(msg)) browserCrashed = true;
  });

  // 결과 파일을 미리 정해두고 chunk 마다 덮어쓰기 (incremental save)
  const outFile = path.join(RESULTS_DIR, `kream_market_${nowKstStamp()}.json`);
  const saveProgress = () => {
    const out = {
      fetched_at: new Date().toISOString(),
      input_file: path.basename(inputFile),
      total_targets: targets.length,
      matched: results.filter((r) => r.matched).length,
      failed: results.filter((r) => !r.matched).length,
      results,
    };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  };

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const chunkStart = chunkIdx * chunkSize;
    const chunkEnd = Math.min(chunkStart + chunkSize, targets.length);
    console.log(`\n${'═'.repeat(60)}\n📦 Chunk ${chunkIdx + 1}/${totalChunks}  (targets ${chunkStart + 1}-${chunkEnd}/${targets.length})\n${'═'.repeat(60)}`);

    // chunk 시작 — 이전 chunk 의 crash 플래그 리셋
    browserCrashed = false;

    let ctx, page;
    try {
      ({ ctx, page } = await openContext(isHeadless));

      // 첫 chunk 만 명시적 로그인 — 후속 chunk 는 .browser-data 세션 그대로 사용
      if (chunkIdx === 0) {
        await ensureLoggedIn(page, ctx);
        console.log();
      } else {
        // 세션 유효성 빠른 확인 (실패 시 ensureLoggedIn 으로 재로그인)
        try {
          await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await delay(1500);
          if (!page.url().includes('/my') || page.url().includes('login')) {
            await ensureLoggedIn(page, ctx);
          }
        } catch (_) {
          await ensureLoggedIn(page, ctx);
        }
      }

      // chunk 내 targets 순회 — chromium IPC 충돌 감지 시 즉시 중단하고 나머지는 fail 마킹
      for (let i = chunkStart; i < chunkEnd; i++) {
        if (browserCrashed) {
          console.log(`   ⏭  browser crash 감지 — chunk 잔여 타겟 fail 마킹 후 다음 chunk 로`);
          break;
        }
        await processTarget(page, targets[i], results, skuCache, productMarketCache, i, targets.length);
        await delay(800);
      }

      if (browserCrashed) {
        // 남은 타겟을 fail 로 채워서 results.length 일치시킴
        for (let i = results.length; i < chunkEnd; i++) {
          const t = targets[i];
          results.push({
            sku: t.sku, option: t.option, stock: t.stock ?? null, eur_price: t.eur_price ?? null,
            matched: false, error: 'chromium IPC 충돌로 skip (다음 chunk 에서 새 context 재시작)',
          });
        }
        console.log(`⚠️ Chunk ${chunkIdx + 1} crash 회복  (누적 결과: ${results.length}/${targets.length})`);
      } else {
        console.log(`✅ Chunk ${chunkIdx + 1} 완료  (누적 결과: ${results.length}/${targets.length})`);
      }
    } catch (e) {
      console.error(`❌ Chunk ${chunkIdx + 1} 도중 치명적 에러: ${e.message}`);
      console.error(e.stack);
      // 이 chunk 에서 아직 results 에 들어가지 못한 미처리 타겟을 fail 로 기록.
      // processTarget 는 항상 results 에 1건 push 하므로 results.length = 다음 처리할 인덱스.
      for (let i = results.length; i < chunkEnd; i++) {
        const t = targets[i];
        results.push({
          sku: t.sku, option: t.option, stock: t.stock ?? null, eur_price: t.eur_price ?? null,
          matched: false, error: `chunk crash: ${e.message.slice(0, 100)}`,
        });
      }
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }

    // chunk 마다 incremental save → 다음 chunk 가 죽어도 진행분 보존
    saveProgress();

    // 마지막 chunk 가 아니면 잠깐 쉬고 다음 chunk 진행 (chromium 리소스 정리 시간)
    if (chunkIdx < totalChunks - 1) await delay(3000);
  }

  const matched = results.filter((r) => r.matched).length;
  const failed = results.filter((r) => !r.matched).length;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📁 저장 완료: ${outFile}`);
  console.log(`   매칭 성공: ${matched}개, 실패: ${failed}개  (전체 ${targets.length})`);
}

main();
