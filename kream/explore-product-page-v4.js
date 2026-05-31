/**
 * explore-product-page-v4.js
 * 로그인 → 상품 페이지 → 체결/판매/구매 탭 모두 캡처
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KREAM_URL = 'https://kream.co.kr';
const PRODUCT_URL = 'https://kream.co.kr/products/916477';
const NAVER_ID = 'dasom6y';
const NAVER_PW = 'Kds2149827!';
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
const OUT_DIR = path.join(__dirname, 'explore-output-v4');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function isLoggedIn(page) {
  // /users/me 가 200 이면 로그인 됨. 페이지에서 직접 호출해보는 대신 cookie 로 판단
  const cookies = await page.context().cookies();
  const hasAuth = cookies.find((c) => /token|session|auth/i.test(c.name) && c.value);
  return !!hasAuth;
}

async function loginViaNaver(page, context) {
  console.log('   🔐 네이버 SSO 로그인 시작');
  await page.goto(`${KREAM_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await delay(2500);

  const naverBtn = page.locator('button:has-text("네이버"), a:has-text("네이버")').first();
  await naverBtn.waitFor({ state: 'visible', timeout: 10000 });

  // window.open 가로채서 같은 창으로
  await page.evaluate(() => {
    window.__origOpen = window.open;
    window.open = function (url) {
      if (url && url.includes('naver.com')) { window.location.href = url; return window; }
      return window.__origOpen.apply(this, arguments);
    };
  });

  let naverPage = page;
  const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  await naverBtn.click();
  const popup = await popupPromise;
  if (popup) {
    naverPage = popup;
    console.log('   📌 팝업 감지');
  } else {
    await page.waitForURL((u) => u.includes('naver.com'), { timeout: 10000 });
  }
  await naverPage.waitForLoadState('domcontentloaded');
  await delay(2000);

  await naverPage.waitForSelector('#id', { timeout: 10000 });
  await naverPage.locator('#id').click();
  await naverPage.locator('#id').pressSequentially(NAVER_ID, { delay: 80 });
  await delay(400);
  await naverPage.locator('#pw').click();
  await naverPage.locator('#pw').pressSequentially(NAVER_PW, { delay: 80 });
  await delay(400);
  await naverPage.locator('.btn_login, button[type="submit"], #log\\.login').first().click();

  // KREAM 으로 돌아올 때까지 대기 (팝업 닫히면 메인 page 가 자동 새로고침 안 될 수 있어 폴링)
  console.log('   ⏳ KREAM 으로 리다이렉트 대기 (최대 90초)...');
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const u = page.url();
    if (u.includes('kream.co.kr') && !u.includes('login')) {
      console.log('   ✅ 메인 page 가 kream 으로 복귀:', u);
      break;
    }
    // 팝업이 닫혔는데 main 이 그대로면 강제로 메인 reload
    if (popup && popup.isClosed && popup.isClosed()) {
      await page.goto(KREAM_URL, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await delay(2000);
      if (page.url().includes('kream.co.kr') && !page.url().includes('login')) {
        console.log('   ✅ 강제 reload 후 로그인 확인:', page.url());
        break;
      }
    }
    await delay(2000);
  }
  await delay(2000);
}

async function main() {
  console.log('🔍 v4 — 로그인 후 탐색\n');
  const lock = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lock)) fs.unlinkSync(lock);

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false, channel: 'chrome', viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-popup-blocking'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

  const calls = [];
  let counter = 0;
  let phase = 'init';
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/api\.kream\.co\.kr/.test(url)) return;
    if (resp.request().method() === 'OPTIONS') return;
    const idx = ++counter;
    const meta = { idx, phase, status: resp.status(), method: resp.request().method(), url };
    try {
      const body = await resp.json();
      fs.writeFileSync(path.join(OUT_DIR, `api-${String(idx).padStart(3, '0')}.json`), JSON.stringify(body, null, 2));
      meta.saved = `api-${String(idx).padStart(3, '0')}.json`;
      if (Array.isArray(body)) meta.summary = `array len=${body.length}`;
      else if (body) meta.summary = `keys=${Object.keys(body).slice(0, 8).join(',')}`;
    } catch (_) {}
    calls.push(meta);
    const u = url.replace('https://api.kream.co.kr', '').split('?')[0];
    console.log(`   [${phase}] #${idx} ${resp.status()} ${meta.method} ${u}${meta.summary ? ' — ' + meta.summary : ''}`);
  });

  try {
    // 1. 메인 + 로그인 상태 확인
    phase = 'check';
    console.log('1️⃣  메인 페이지 진입');
    await page.goto(KREAM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    // /users/me 결과를 보고 로그인 상태 판단
    let loggedIn = false;
    try {
      const meResp = calls.find((c) => c.url.includes('/users/me'));
      if (meResp && meResp.status === 200) loggedIn = true;
    } catch (_) {}

    if (!loggedIn) {
      // 한번 더 확인 — 마이 클릭해서 /my 로 가지는지
      try {
        await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await delay(1500);
        if (page.url().includes('/my') && !page.url().includes('login')) loggedIn = true;
      } catch (_) {}
    }
    console.log(`   로그인: ${loggedIn ? '✅' : '❌'}`);

    // 2. 로그인 필요 시 진행
    if (!loggedIn) {
      phase = 'login';
      await loginViaNaver(page, context);
    }

    // 3. 상품 페이지 진입
    phase = 'product-load';
    console.log('\n2️⃣  상품 페이지 진입');
    await page.goto(PRODUCT_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await delay(3000);
    await page.screenshot({ path: path.join(OUT_DIR, '1-loaded.png') });

    // 탭 영역까지 스크롤
    await page.locator('ul.tab_list:visible:has(a:has-text("체결 거래"))').first()
      .scrollIntoViewIfNeeded({ timeout: 5000 });
    await delay(1500);

    const dumpTab = async (name) => {
      const html = await page.evaluate(() => {
        const ul = Array.from(document.querySelectorAll('ul.tab_list'))
          .find(u => u.getBoundingClientRect().width > 0);
        if (!ul) return null;
        // tab 영역의 상위 div (탭+컨텐츠 다 포함)
        let parent = ul.parentElement;
        for (let i = 0; i < 4 && parent; i++) parent = parent.parentElement;
        return parent ? parent.outerHTML : ul.parentElement.outerHTML;
      });
      if (html) {
        fs.writeFileSync(path.join(OUT_DIR, `tab-${name}.html`), html);
        console.log(`   💾 tab-${name}.html (${html.length} chars)`);
      }
    };

    phase = 'sales-default';
    console.log('\n3️⃣  체결거래 (기본 활성) 캡처');
    await dumpTab('sales');
    await page.screenshot({ path: path.join(OUT_DIR, '3-sales.png') });

    phase = 'asks';
    console.log('\n4️⃣  판매 입찰 탭 클릭 + 캡처');
    await page.locator('a.item_link:visible:has-text("판매 입찰")').first().click({ timeout: 5000, force: true });
    await delay(3000);
    await dumpTab('asks');
    await page.screenshot({ path: path.join(OUT_DIR, '4-asks.png') });

    phase = 'bids';
    console.log('\n5️⃣  구매 입찰 탭 클릭 + 캡처');
    await page.locator('a.item_link:visible:has-text("구매 입찰")').first().click({ timeout: 5000, force: true });
    await delay(3000);
    await dumpTab('bids');
    await page.screenshot({ path: path.join(OUT_DIR, '5-bids.png') });

    phase = 'sales-reclick';
    console.log('\n6️⃣  체결 재클릭 (API 트리거 재확인)');
    await page.locator('a.item_link:visible:has-text("체결 거래")').first().click({ timeout: 5000, force: true });
    await delay(2500);

    phase = 'more-modal';
    console.log('\n7️⃣  "거래 내역 더보기" 모달');
    const moreBtn = page.locator('button:has-text("거래 내역 더보기"):visible').first();
    if ((await moreBtn.count()) > 0) {
      await moreBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
      await moreBtn.click({ timeout: 5000, force: true });
      await delay(3000);
      await page.screenshot({ path: path.join(OUT_DIR, '7-modal.png') });
      const modalHtml = await page.evaluate(() => {
        const m = document.querySelector('[class*="layer"][class*="open"], [role="dialog"]:not([style*="display: none"])');
        return m ? m.outerHTML : null;
      });
      if (modalHtml) {
        fs.writeFileSync(path.join(OUT_DIR, 'modal.html'), modalHtml);
        console.log(`   💾 modal.html (${modalHtml.length} chars)`);
      }

      // 모달에서 더 스크롤 (모달 안 무한스크롤일 수 있음)
      console.log('   📜 모달 내부 스크롤');
      await page.evaluate(() => {
        const m = document.querySelector('[class*="layer"][class*="open"], [role="dialog"]');
        if (m) {
          const scroller = m.querySelector('[class*="scroll"], [class*="list"], ul, tbody') || m;
          for (let i = 0; i < 5; i++) scroller.scrollTop = scroller.scrollHeight;
        }
      });
      await delay(3000);
    }

    fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(calls, null, 2));
    console.log(`\n📊 api.kream.co.kr 호출 ${calls.length}건:`);
    calls.forEach((c) => {
      const u = c.url.replace('https://api.kream.co.kr', '').split('?')[0];
      console.log(`   [${c.phase}] ${c.status} ${u}${c.summary ? ' — ' + c.summary : ''}`);
    });
    console.log('\n10초 후 종료 (브라우저 직접 닫지 마세요)...');
    await delay(10000);
  } catch (e) {
    console.error('❌', e.message);
    try { await page.screenshot({ path: path.join(OUT_DIR, 'error.png'), fullPage: true }); } catch (_) {}
  } finally {
    await context.close();
  }
}

main();
