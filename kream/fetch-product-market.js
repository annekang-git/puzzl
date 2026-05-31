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
  await page.goto(`${KREAM_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await delay(4000); // 페이지 hydration 대기
  console.log(`   📍 로그인 페이지 URL: ${page.url()}`);
  await page.screenshot({ path: path.join(RESULTS_DIR, 'login-step1-page.png'), fullPage: true }).catch(() => {});

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
          const el = document.querySelector('h1, [class*="product-title-ko"], [class*="title"]');
          return el ? el.innerText.trim().slice(0, 100) : '';
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
// 새 KREAM API (2026~): 옵션 segment 없는 단일 endpoint 가 모든 사이즈 응답을 한꺼번에 반환.
//   /api/p/products/{id}/sales?cursor=...
//   /api/p/products/{id}/asks
//   /api/p/products/{id}/bids
//   /api/p/products/{id}/chart
// 각 응답의 items[].option 필드에서 사이즈를 group 하여 captured[option] = {sales,asks,bids,chart}.
// "거래 내역 더보기" 버튼 클릭이 트리거 — 누르지 않으면 API 호출이 일어나지 않음.
async function fetchAllOptionsForProduct(page, productId) {
  const captured = {}; // captured[opt] = { sales:[...], asks:[...], bids:[...], chart:{...} }
  const apiRegex = new RegExp(`/api/p/products/${productId}/(sales|asks|bids|chart)(?:\\?|$)`);

  function ensureOpt(o) {
    if (!captured[o]) captured[o] = { sales: [], asks: [], bids: [], chart: null };
    return captured[o];
  }

  const handler = async (resp) => {
    const m = resp.url().match(apiRegex);
    if (!m) return;
    const type = m[1];
    let body;
    try { body = await resp.json(); } catch (_) { return; }

    if (type === 'chart') {
      // chart 는 전체 상품 차원 (옵션별 분리 없음). '__all' 키로 저장.
      ensureOpt('__all').chart = body;
      return;
    }
    // sales/asks/bids — items[].option 으로 group
    const items = Array.isArray(body.items) ? body.items : [];
    for (const it of items) {
      const opt = String(it.option ?? it.product_option?.key ?? '__all').trim();
      ensureOpt(opt)[type].push(it);
    }
  };

  page.on('response', handler);

  try {
    await page.goto(`${KREAM_URL}/products/${productId}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await delay(2500);

    // 거래 내역 더보기 클릭 — 이게 API 호출 트리거
    const moreBtn = page.locator('button:has-text("거래 내역 더보기"):visible').first();
    if ((await moreBtn.count()) > 0) {
      try {
        await moreBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
        await moreBtn.click({ timeout: 5000, force: true });
        await delay(4000); // API 응답 받을 시간
      } catch (e) {
        console.log(`     ⚠️  모달 클릭 실패: ${e.message.slice(0, 60)}`);
      }
    } else {
      console.log(`     ℹ️  "거래 내역 더보기" 버튼 없음 (pid=${productId})`);
    }
  } finally {
    page.off('response', handler);
  }

  return captured;
}

// 사이즈 별칭 — 의미적으로 같은 사이즈를 동일하게 취급
const UNIVERSAL_SIZES = new Set(['U', 'UNICA', 'FREE', 'ONE SIZE', 'ONESIZE', 'OS', 'F', 'UNI', 'UNIVERSAL']);
function normSize(s) { return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' '); }
function isSameSizeGroup(a, b) {
  const na = normSize(a), nb = normSize(b);
  if (na === nb) return true;
  if (UNIVERSAL_SIZES.has(na) && UNIVERSAL_SIZES.has(nb)) return true;
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
  console.log(`📥 ${targets.length}개 타겟 로드: ${inputFile}\n`);

  const lock = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false, channel: 'chrome', viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-popup-blocking'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

  const results = [];
  // SKU → product_id 캐시 (같은 SKU 여러 옵션이면 재사용)
  const skuCache = new Map();
  // product_id → {captured 모든 옵션} 캐시 — 같은 상품 여러 사이즈일 때 페이지 1번만 방문
  const productMarketCache = new Map();

  try {
    await ensureLoggedIn(page, context);
    console.log();

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const tag = `[${i + 1}/${targets.length}] ${t.sku} / ${t.option}`;
      console.log(`🔍 ${tag}`);

      // 1) SKU 해결 (캐시 사용)
      let resolved = skuCache.get(t.sku);
      if (!resolved) {
        try {
          resolved = await resolveSkuToProductId(page, t); // 객체 전체 전달 (sku + spu 둘 다 사용)
        } catch (e) {
          resolved = { error: `Resolve threw: ${e.message}` };
        }
        skuCache.set(t.sku, resolved);
      }

      if (resolved.error) {
        console.log(`   ❌ ${resolved.error}`);
        results.push({
          sku: t.sku,
          option: t.option,
          eur_price: t.eur_price ?? null,
          matched: false,
          error: resolved.error,
          candidates: resolved.candidates,
        });
        continue;
      }

      // 2) market data — product_id 캐시 사용 (페이지 한 번만 방문)
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
          sku: t.sku,
          option: t.option,
          eur_price: t.eur_price ?? null,
          matched: true,
          product_id: resolved.product_id,
          product_name_ko: resolved.product_name_ko || null,
          product_url: `${KREAM_URL}/products/${resolved.product_id}`,
          ...market,
        });
      } catch (e) {
        console.log(`   ❌ fetchMarketData 실패: ${e.message}`);
        results.push({
          sku: t.sku,
          option: t.option,
          eur_price: t.eur_price ?? null,
          matched: false,
          product_id: resolved.product_id,
          error: `fetchMarketData: ${e.message}`,
        });
      }

      // rate limit 회피
      await delay(800);
    }

    const out = {
      fetched_at: new Date().toISOString(),
      input_file: path.basename(inputFile),
      total_targets: targets.length,
      matched: results.filter((r) => r.matched).length,
      failed: results.filter((r) => !r.matched).length,
      results,
    };

    const outFile = path.join(RESULTS_DIR, `kream_market_${nowKstStamp()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`\n📁 저장 완료: ${outFile}`);
    console.log(`   매칭 성공: ${out.matched}개, 실패: ${out.failed}개`);
  } catch (e) {
    console.error('❌', e.message);
    console.error(e.stack);
  } finally {
    await context.close();
  }
}

main();
