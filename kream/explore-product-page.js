/**
 * explore-product-page.js
 * KREAM 상품 상세 페이지 (체결거래/판매입찰/구매입찰) 탐색용 스크립트
 *
 * 목적:
 *   - 페이지가 호출하는 모든 API 응답 캡처
 *   - 각 탭 클릭 → API 식별
 *   - 추후 스크래퍼 설계용 artifacts 수집
 *
 * 출력:
 *   - explore-output/network.json   (전체 API 호출 + 응답 메타)
 *   - explore-output/api-{n}.json   (각 API 응답 body)
 *   - explore-output/page.html      (최종 DOM)
 *   - explore-output/screenshot-{tab}.png
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KREAM_URL = 'https://kream.co.kr';
const PRODUCT_URL = 'https://kream.co.kr/products/916477';
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
const OUT_DIR = path.join(__dirname, 'explore-output');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('🔍 KREAM 상품 페이지 탐색 시작\n');
  console.log('   URL:', PRODUCT_URL);
  console.log('   OUT:', OUT_DIR, '\n');

  // SingletonLock 정리
  const lockFile = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-popup-blocking', '--disable-blink-features=AutomationControlled'],
    ignoreHTTPSErrors: true,
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // ── 네트워크 캡처 (api 도메인만) ──
  const calls = [];
  let apiCounter = 0;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/kream\.co\.kr\/api|api\.kream\.co\.kr/.test(url)) return;
    if (resp.request().method() === 'OPTIONS') return;

    const idx = ++apiCounter;
    const meta = {
      idx,
      status: resp.status(),
      method: resp.request().method(),
      url,
      tab_context: currentTab,
    };
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('json')) {
        const body = await resp.json();
        fs.writeFileSync(path.join(OUT_DIR, `api-${String(idx).padStart(3, '0')}.json`), JSON.stringify(body, null, 2));
        meta.saved = `api-${String(idx).padStart(3, '0')}.json`;
        // 간략 요약
        if (Array.isArray(body)) meta.summary = `array len=${body.length}`;
        else if (body && typeof body === 'object') meta.summary = `keys=${Object.keys(body).slice(0, 10).join(',')}`;
      } else {
        meta.saved = null;
        meta.content_type = ct;
      }
    } catch (e) {
      meta.error = e.message;
    }
    calls.push(meta);
    const tagStr = currentTab ? `[${currentTab}] ` : '';
    console.log(`   ${tagStr}#${idx} ${meta.method} ${resp.status()} ${url.slice(0, 100)}${meta.summary ? ' — ' + meta.summary : ''}`);
  });

  let currentTab = 'initial';

  try {
    // 1. 메인 페이지 워밍 (세션 확인)
    console.log('1️⃣  메인 페이지 접속 (세션 확인)');
    await page.goto(KREAM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(1500);
    const isLoggedIn = await page.locator('text=마이').count();
    console.log(`   로그인 상태: ${isLoggedIn > 0 ? '✅ 로그인됨' : '⚠️ 로그아웃 상태 (스크립트는 비로그인으로 진행)'}`);

    // 2. 상품 상세 페이지 접속
    console.log('\n2️⃣  상품 상세 페이지 접속');
    currentTab = 'product-detail';
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000);

    // 페이지 제목 확인
    const title = await page.title();
    console.log(`   페이지 제목: ${title}`);

    // 모델번호 (스타일코드) 검증
    const styleCode = await page.locator('text=SSX03L101N').first().textContent().catch(() => null);
    console.log(`   SSX03L101N 노출: ${styleCode ? '✅' : '❌'}`);

    // 초기 스크린샷
    await page.screenshot({ path: path.join(OUT_DIR, 'screenshot-1-initial.png'), fullPage: false });

    // 3. 각 탭 클릭 시도 — KREAM 의 일반적인 탭 이름들
    const tabsToTry = [
      { name: 'sales', selectors: ['text=체결 거래', 'text=체결거래', 'button:has-text("체결")'] },
      { name: 'asks', selectors: ['text=판매 입찰', 'text=판매입찰', 'button:has-text("판매")'] },
      { name: 'bids', selectors: ['text=구매 입찰', 'text=구매입찰', 'button:has-text("구매")'] },
    ];

    for (const tab of tabsToTry) {
      console.log(`\n3️⃣ ▶ 탭 클릭: ${tab.name}`);
      currentTab = tab.name;
      let clicked = false;
      for (const sel of tab.selectors) {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0) {
          try {
            await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
            await loc.click({ timeout: 5000 });
            console.log(`   ✅ 클릭 성공: ${sel}`);
            clicked = true;
            break;
          } catch (e) {
            console.log(`   ⚠️ 클릭 실패 (${sel}): ${e.message.slice(0, 60)}`);
          }
        }
      }
      if (!clicked) console.log(`   ❌ 탭 찾기 실패: ${tab.name}`);
      await delay(2500);
      await page.screenshot({ path: path.join(OUT_DIR, `screenshot-${tab.name}.png`), fullPage: false });
    }

    // 4. 최종 DOM 저장
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, 'page.html'), html);
    console.log(`\n4️⃣  최종 DOM 저장: page.html (${html.length} chars)`);

    // 5. 네트워크 로그 저장
    fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(calls, null, 2));
    console.log(`\n📊 총 API 호출: ${calls.length}건`);
    console.log(`📁 결과 디렉토리: ${OUT_DIR}`);
    console.log('\n10초 후 브라우저 종료 (수동 탐색 원하면 그 전에 Ctrl+C)...');
    await delay(10000);
  } catch (e) {
    console.error('❌ 오류:', e.message);
    await page.screenshot({ path: path.join(OUT_DIR, 'error.png'), fullPage: true });
  } finally {
    await context.close();
  }
}

main();
