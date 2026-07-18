/**
 * fetch-product-market-api.js  (프로토타입)
 * KREAM 시세를 브라우저 없이 API 직접 호출로 수집.
 *
 * 동작:
 *  1) 세션 부트스트랩 — _api-session.json 이 신선하면 재사용, 아니면 브라우저를 잠깐 열어
 *     실 API 요청 헤더 (Bearer 토큰 + x-kream-* 커스텀 헤더) + 쿠키 캡처 후 저장
 *  2) 타겟별: 검색 API → 후보 매칭 (기존 브라우저 로직과 동일 규칙) → 옵션 목록 → 시세 API
 *  3) 결과는 fetch-product-market.js 와 같은 스키마로 저장 (비교 검증용)
 *
 * 사용법:
 *   node fetch-product-market-api.js targets-prada.json --limit=50 --delay=600
 *
 * 브라우저 방식 대비: 타겟당 ~4MB → ~50KB, 분당 3건 → (delay 에 따라) 수십 건
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ProxyAgent } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.kream.co.kr';
const WEB = 'https://kream.co.kr';
const SESSION_FILE = path.join(__dirname, '_api-session.json');
const SESSION_MAX_AGE_MS = 90 * 60 * 1000; // 90분 (토큰 수명 ~2h 추정, 여유 두고 갱신)
const BROWSER_DATA_DIR = process.env.KREAM_BROWSER_DATA
  ? path.resolve(__dirname, process.env.KREAM_BROWSER_DATA)
  : path.join(__dirname, '.browser-data');
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ── .env ─────────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ── CLI ──────────────────────────────────────────
const args = process.argv.slice(2);
const targetsFile = args.find((a) => !a.startsWith('--')) || 'targets.json';
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '--limit=0').split('=')[1]) || 0;
const DELAY_MS = Number((args.find((a) => a.startsWith('--delay=')) || '--delay=600').split('=')[1]);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rk = () => crypto.randomUUID();

// ── 프록시 (VPS 용 — KREAM 이 datacenter IP 차단) ──
// fetch: undici ProxyAgent / 브라우저 harvest: playwright proxy 옵션
function getProxyConfig() {
  const server = process.env.KREAM_PROXY_SERVER;
  if (!server) return null;
  return {
    server,
    ...(process.env.KREAM_PROXY_USER ? { username: process.env.KREAM_PROXY_USER } : {}),
    ...(process.env.KREAM_PROXY_PASS ? { password: process.env.KREAM_PROXY_PASS } : {}),
  };
}
const PROXY = getProxyConfig();
let proxyDispatcher = null;
if (PROXY) {
  const u = new URL(PROXY.server);
  if (PROXY.username) { u.username = PROXY.username; u.password = PROXY.password || ''; }
  proxyDispatcher = new ProxyAgent(u.toString());
  console.log(`🌐 프록시 사용: ${PROXY.server}`);
}
const nowKstStamp = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '');
};

// ── 세션 (헤더+쿠키) ──────────────────────────────
async function harvestSession() {
  console.log('🔑 브라우저로 세션 헤더 캡처 중...');
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(BROWSER_DATA_DIR, f)); } catch (_) {}
  }
  const headless = process.env.KREAM_HEADLESS === '1';
  const ctx = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless, ...(headless ? {} : { channel: 'chrome' }),
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ...(PROXY ? { proxy: PROXY } : {}),
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let captured = null;
  page.on('request', (req) => {
    const h = req.headers();
    if (!captured && req.url().includes('api.kream.co.kr/api/') && h['authorization']) captured = h;
  });
  await page.goto(`${WEB}/products/135046`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await delay(4000);
  const cookies = await ctx.cookies(WEB);
  await ctx.close();
  if (!captured) throw new Error('API 요청 헤더 캡처 실패 — 로그인 상태 확인 필요');
  const headers = {};
  for (const [k, v] of Object.entries(captured)) {
    if (k.startsWith(':') || ['content-length', 'host'].includes(k)) continue;
    headers[k] = v;
  }
  headers['cookie'] = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const session = { headers, saved_at: Date.now() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  console.log('   ✅ 세션 저장됨');
  return session;
}

async function getSession(force = false) {
  if (!force && fs.existsSync(SESSION_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      if (Date.now() - (s.saved_at || 0) < SESSION_MAX_AGE_MS) {
        console.log('🔑 저장된 세션 재사용');
        return s;
      }
    } catch (_) {}
  }
  return harvestSession();
}

let SESSION = null;
let apiCallCount = 0;
let rateLimitHits = 0;

async function apiGet(url, { retry401 = true } = {}) {
  apiCallCount++;
  const r = await fetch(url, { headers: SESSION.headers, ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}) });
  if (r.status === 401 && retry401) {
    console.log('   🔄 401 — 세션 갱신 후 재시도');
    SESSION = await getSession(true);
    return apiGet(url, { retry401: false });
  }
  if (r.status === 429) {
    rateLimitHits++;
    console.log('   🛑 429 rate limit — 30초 대기 후 재시도');
    await delay(30000);
    return apiGet(url, { retry401 });
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

// ── 매칭 유틸 (fetch-product-market.js 와 동일 규칙) ──
function normalizeCode(s) { return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
const UNIVERSAL_SIZES = new Set(['U', 'UNICA', 'FREE', 'ONE SIZE', 'ONESIZE', 'OS', 'F', 'UNI', 'UNIVERSAL']);
const SIZE_REGION_RE = /^(EU|US|UK|IT|FR|JP|JPN|KR|KOR|EUR)\s+|\s+(EU|US|UK|IT|FR|JP|JPN|KR|KOR|EUR)$/i;
function normSize(s) { return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' '); }
function stripSizeRegion(s) { return normSize(s).replace(SIZE_REGION_RE, '').trim(); }
function isSameSizeGroup(a, b) {
  const na = normSize(a), nb = normSize(b);
  if (na === nb) return true;
  if (UNIVERSAL_SIZES.has(na) && UNIVERSAL_SIZES.has(nb)) return true;
  const sa = stripSizeRegion(na), sb = stripSizeRegion(nb);
  if (sa && sb && sa === sb) return true;
  return false;
}

// ── screens JSON 에서 텍스트/상품카드 추출 ─────────
function collectTexts(node, out, depth = 0) {
  if (depth > 20 || !node) return;
  if (Array.isArray(node)) { for (const v of node) collectTexts(v, out, depth + 1); return; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'text' || k === 'name') && typeof v === 'string' && v.trim()) out.push(v.trim());
      else collectTexts(v, out, depth + 1);
    }
  }
}

function extractSearchCards(searchJson) {
  const items = searchJson?.content?.items || [];
  const cards = [];
  for (const it of items) {
    // 상품 카드 = actions 에 /products/{id} url 이 있는 노드
    let pid = null;
    const findPid = (node, depth = 0) => {
      if (pid || depth > 12 || !node) return;
      if (Array.isArray(node)) { for (const v of node) findPid(v, depth + 1); return; }
      if (typeof node === 'object') {
        if (node.type === 'url' && typeof node.value === 'string') {
          const m = node.value.match(/\/products\/(\d+)/);
          if (m) { pid = Number(m[1]); return; }
        }
        for (const v of Object.values(node)) findPid(v, depth + 1);
      }
    };
    findPid(it);
    if (!pid) continue;
    const texts = [];
    collectTexts(it, texts);
    cards.push({ product_id: pid, text: texts.join('\n').slice(0, 500) });
  }
  // 중복 pid 제거
  const seen = new Set();
  return cards.filter((c) => (seen.has(c.product_id) ? false : (seen.add(c.product_id), true)));
}

// 상품 상세 검증 — SSR HTML 을 받아 모델번호 포함 여부 확인 (verify 단계)
async function verifyCandidate(pid, needles) {
  const r = await apiGet(`${WEB}/products/${pid}`);
  if (r.status !== 200) return { ok: false };
  const bodyNorm = normalizeCode(r.text);
  for (const n of needles) {
    if (!n) continue;
    const nn = normalizeCode(n);
    if (nn && bodyNorm.includes(nn)) {
      const tm = r.text.match(/<title>([^<]+)<\/title>/i);
      const title = tm ? tm[1].replace(/\s*[-|]\s*KREAM\s*$/i, '').trim() : '';
      return { ok: true, product_name_ko: title, matched_needle: n };
    }
  }
  return { ok: false };
}

async function resolveSku(target) {
  const { sku, spu } = target;
  const needles = [sku, spu].filter(Boolean);
  const searchKeys = [sku];
  if (spu && spu !== sku) searchKeys.push(spu);

  let allCandidates = [];
  for (const key of searchKeys) {
    const kw = encodeURIComponent(key);
    const r = await apiGet(`${API}/api/screens/search/products?keyword=${kw}&tab=products&typed_string=${kw}&search_type=direct&request_key=${rk()}`);
    await delay(DELAY_MS);
    if (r.status !== 200 || !r.json) continue;
    const cands = extractSearchCards(r.json);

    if (cands.length === 1) {
      const koText = cands[0].text.split('\n').find((l) => /[가-힣]/.test(l)) || '';
      return { product_id: cands[0].product_id, product_name_ko: koText, matched_via: `single-candidate(${key})` };
    }
    for (const c of cands) {
      const textNorm = normalizeCode(c.text);
      for (const n of needles) {
        const nn = normalizeCode(n);
        if (nn && textNorm.includes(nn)) {
          const koText = c.text.split('\n').find((l) => /[가-힣]/.test(l)) || '';
          return { product_id: c.product_id, product_name_ko: koText, matched_via: `search-card-text(${key}→${n})` };
        }
      }
    }
    for (const c of cands.slice(0, 3)) {
      const v = await verifyCandidate(c.product_id, needles);
      await delay(DELAY_MS);
      if (v.ok) return { product_id: c.product_id, product_name_ko: v.product_name_ko, matched_via: `verify(${key}→${v.matched_needle})` };
    }
    allCandidates = allCandidates.concat(cands.slice(0, 5));
  }
  return { error: `No KREAM match for SKU="${sku}"${spu ? ` SPU="${spu}"` : ''}`, candidates: allCandidates.slice(0, 5) };
}

// ── 옵션 목록 ─────────────────────────────────────
function extractOptions(optionsJson) {
  // content.items[] 각각이 옵션 — title_item 계열 텍스트 중 첫 번째가 옵션명
  const items = optionsJson?.content?.items || [];
  const opts = [];
  for (const it of items) {
    const texts = [];
    collectTexts(it?.title_item ?? it, texts);
    const cand = texts.find((t) => t && t.length <= 20 && !/구매|판매|입찰|배송|보관|빠른|즉시|원$|,\d{3}/.test(t));
    if (cand) opts.push(cand);
  }
  return [...new Set(opts)];
}

async function fetchMarketForOption(pid, kreamOption) {
  const opt = encodeURIComponent(kreamOption);
  const out = { sales: [], asks: [], bids: [], chart: null };
  const s = await apiGet(`${API}/api/p/products/${pid}/${opt}/sales?cursor=1&per_page=50&request_key=${rk()}`);
  await delay(DELAY_MS);
  if (s.json?.items) out.sales = s.json.items;
  const a = await apiGet(`${API}/api/p/products/${pid}/${opt}/asks?cursor=1&per_page=50&request_key=${rk()}`);
  await delay(DELAY_MS);
  if (a.json?.items) out.asks = a.json.items;
  const b = await apiGet(`${API}/api/p/products/${pid}/${opt}/bids?cursor=1&per_page=50&request_key=${rk()}`);
  await delay(DELAY_MS);
  if (b.json?.items) out.bids = b.json.items;
  const c = await apiGet(`${API}/api/p/products/${pid}/${opt}/chart?request_key=${rk()}`);
  await delay(DELAY_MS);
  if (c.json) out.chart = c.json;
  return out;
}

// ── main ─────────────────────────────────────────
const targetsPath = path.isAbsolute(targetsFile) ? targetsFile : path.join(__dirname, targetsFile);
let targets = JSON.parse(fs.readFileSync(targetsPath, 'utf-8'));
if (!Array.isArray(targets) || targets.length === 0) {
  console.error('❌ targets 는 배열이어야 하고 1개 이상 항목이 있어야 함');
  process.exit(1);
}
if (LIMIT > 0) targets = targets.slice(0, LIMIT);
console.log(`📥 ${targets.length}개 타겟 (API 모드, delay=${DELAY_MS}ms): ${path.basename(targetsPath)}`);

SESSION = await getSession();

const results = [];
const skuCache = new Map();      // sku → resolve 결과
const optionsCache = new Map();  // pid → 옵션 목록
const marketCache = new Map();   // pid|opt → market

const t0 = Date.now();
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  console.log(`🔍 [${i + 1}/${targets.length}] ${t.sku} / ${t.option}`);

  let resolved = skuCache.get(t.sku);
  if (!resolved) {
    try { resolved = await resolveSku(t); } catch (e) { resolved = { error: `Resolve threw: ${e.message}` }; }
    skuCache.set(t.sku, resolved);
  }
  if (resolved.error) {
    console.log(`   ❌ ${resolved.error}`);
    results.push({
      sku: t.sku, spu: t.spu ?? null, b2b_sku: t.b2b_sku ?? null, brand: t.brand ?? null, name: t.name ?? null,
      option: t.option, stock: t.stock ?? null, eur_price: t.eur_price ?? null,
      matched: false, error: resolved.error, candidates: resolved.candidates,
    });
    continue;
  }
  const pid = resolved.product_id;

  try {
    let allOpts = optionsCache.get(pid);
    if (!allOpts) {
      const o = await apiGet(`${API}/api/p/options/display?product_id=${pid}&picker_type=buy&request_key=${rk()}`);
      await delay(DELAY_MS);
      allOpts = o.json ? extractOptions(o.json) : [];
      optionsCache.set(pid, allOpts);
    }

    // 옵션 선택 (브라우저 버전 pickOptionFromCache 와 동일 우선순위)
    let chosen = null;
    for (const o of allOpts) { if (isSameSizeGroup(o, t.option)) { chosen = o; break; } }
    if (!chosen && allOpts.includes(`US ${t.option}`)) chosen = `US ${t.option}`;
    if (!chosen) chosen = allOpts.find((o) => o.includes(String(t.option)) || String(t.option).includes(o)) || null;
    if (!chosen && allOpts.length >= 1) chosen = allOpts[0];
    const optionMismatch = chosen != null ? (!isSameSizeGroup(chosen, t.option) && allOpts.length > 1) : true;

    let market = { sales: [], asks: [], bids: [], chart: null };
    if (chosen) {
      const ck = `${pid}|${chosen}`;
      market = marketCache.get(ck);
      if (!market) { market = await fetchMarketForOption(pid, chosen); marketCache.set(ck, market); }
    }

    const slimSales = market.sales.map((it) => ({ price: it.price, option: it.option, date_created: it.date_created, date_text: it.date_created_display_text, is_immediate: it.is_immediate_delivery_item }));
    const slimAsks = market.asks.map((it) => ({ price: it.price, option: it.option, quantity: it.quantity }));
    const slimBids = market.bids.map((it) => ({ price: it.price, option: it.option, quantity: it.quantity }));
    const lowestAsk = slimAsks.length ? Math.min(...slimAsks.map((x) => x.price)) : null;
    const highestBid = slimBids.length ? Math.max(...slimBids.map((x) => x.price)) : null;
    const lastSale = slimSales.length ? slimSales[0].price : null;
    const changeText = market.chart?.recently_sale_price?.lookups?.[0]?.text || null;

    console.log(`   ✅ pid=${pid}  lastSale=${lastSale ?? '-'}  lowAsk=${lowestAsk ?? '-'}  highBid=${highestBid ?? '-'}  (${slimSales.length}/${slimAsks.length}/${slimBids.length})`);
    results.push({
      sku: t.sku, spu: t.spu ?? null, b2b_sku: t.b2b_sku ?? null, brand: t.brand ?? null, name: t.name ?? null,
      option: t.option, stock: t.stock ?? null, eur_price: t.eur_price ?? null, eur_retail: t.eur_retail ?? null,
      matched: true, product_id: pid,
      product_name_ko: resolved.product_name_ko || null,
      product_url: `${WEB}/products/${pid}`,
      matched_via: resolved.matched_via,
      market: { last_sale_price: lastSale, lowest_ask: lowestAsk, highest_bid: highestBid, change_text: changeText },
      sales: slimSales.slice(0, 5), asks: slimAsks.slice(0, 5), bids: slimBids.slice(0, 5),
      totals: { sales: slimSales.length, asks: slimAsks.length, bids: slimBids.length },
      kream_option: chosen, kream_options_available: allOpts, option_mismatch: optionMismatch,
    });
  } catch (e) {
    console.log(`   ⚠️  market 실패: ${e.message.slice(0, 80)}`);
    results.push({ sku: t.sku, option: t.option, matched: true, product_id: pid, error: `market: ${e.message.slice(0, 100)}` });
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
const matched = results.filter((r) => r.matched).length;
// 파일명은 브라우저 버전과 동일 패턴 — daily 스크립트의 rename 로직이 그대로 인식
const outFile = path.join(RESULTS_DIR, `kream_market_${nowKstStamp()}.json`);
fs.writeFileSync(outFile, JSON.stringify({
  fetched_at: new Date().toISOString(), mode: 'api-direct',
  total_targets: targets.length, matched, failed: targets.length - matched,
  api_calls: apiCallCount, rate_limit_hits: rateLimitHits, elapsed_sec: Number(elapsed),
  results,
}, null, 2));
console.log(`\n📁 저장: ${outFile}`);
console.log(`   매칭 ${matched}/${targets.length} · API 호출 ${apiCallCount}회 · rate-limit ${rateLimitHits}회 · ${elapsed}s (${(targets.length / (elapsed / 60)).toFixed(1)}건/분)`);
