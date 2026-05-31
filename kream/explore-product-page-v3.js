/**
 * explore-product-page-v3.js
 * 정확한 탭 셀렉터로 각 탭 클릭 → API + 렌더된 HTML 캡처
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_URL = 'https://kream.co.kr/products/916477';
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
const OUT_DIR = path.join(__dirname, 'explore-output-v3');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const lock = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lock)) fs.unlinkSync(lock);
  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false, channel: 'chrome', viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());

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
      else if (body && typeof body === 'object') meta.summary = `keys=${Object.keys(body).slice(0, 8).join(',')}`;
    } catch (_) {}
    calls.push(meta);
    const u = url.replace('https://api.kream.co.kr', '').split('?')[0];
    console.log(`   [${phase}] #${idx} ${resp.status()} ${meta.method} ${u}${meta.summary ? ' — ' + meta.summary : ''}`);
  });

  try {
    phase = 'load';
    console.log('1️⃣  상품 페이지 로드');
    await page.goto(PRODUCT_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await delay(3000);

    // 탭이 보이는 위치로 스크롤 (visible 한 것만)
    await page.locator('ul.tab_list:visible:has(a:has-text("체결 거래"))').first().scrollIntoViewIfNeeded({ timeout: 5000 });
    await delay(1500);

    // 초기 = 체결거래 활성 상태에서 렌더된 컨테이너 추출
    const dumpTabContent = async (tabName) => {
      const html = await page.evaluate(() => {
        const ul = document.querySelector('ul.tab_list');
        if (!ul) return null;
        // tab_list 의 부모 영역 (sales/asks/bids 컨텐츠 포함된 컨테이너)
        const container = ul.closest('div')?.parentElement || ul.parentElement;
        return container ? container.outerHTML : null;
      });
      if (html) {
        fs.writeFileSync(path.join(OUT_DIR, `tab-${tabName}.html`), html);
        console.log(`   💾 tab-${tabName}.html 저장 (${html.length} chars)`);
      }
    };

    phase = 'sales-initial';
    console.log('\n2️⃣  체결거래 (초기 활성 상태) — 렌더된 영역 캡처');
    await dumpTabContent('sales');

    // 판매 입찰 클릭
    phase = 'asks';
    console.log('\n3️⃣  판매 입찰 탭 클릭');
    await page.locator('a.item_link:visible:has-text("판매 입찰")').first().click({ timeout: 5000 });
    await delay(2500);
    await dumpTabContent('asks');

    // 구매 입찰 클릭
    phase = 'bids';
    console.log('\n4️⃣  구매 입찰 탭 클릭');
    await page.locator('a.item_link:visible:has-text("구매 입찰")').first().click({ timeout: 5000 });
    await delay(2500);
    await dumpTabContent('bids');

    // 다시 체결 클릭
    phase = 'sales-reclick';
    console.log('\n5️⃣  체결 거래 탭 재클릭 (API 트리거 확인)');
    await page.locator('a.item_link:visible:has-text("체결 거래")').first().click({ timeout: 5000 });
    await delay(2500);

    // "거래 내역 더보기" 클릭 → 모달 열림 → 더 많은 데이터 API 가능성
    phase = 'more-modal';
    console.log('\n6️⃣  "거래 내역 더보기" 클릭');
    const moreBtn = page.locator('button:has-text("거래 내역 더보기")').first();
    if ((await moreBtn.count()) > 0) {
      await moreBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
      await moreBtn.click({ timeout: 5000 });
      await delay(3000);
      await page.screenshot({ path: path.join(OUT_DIR, '6-more-modal.png'), fullPage: false });
      // 모달의 HTML 도 저장
      const modalHtml = await page.evaluate(() => {
        const modal = document.querySelector('[class*="layer"], [class*="modal"], [role="dialog"]');
        return modal ? modal.outerHTML : null;
      });
      if (modalHtml) {
        fs.writeFileSync(path.join(OUT_DIR, 'modal.html'), modalHtml);
        console.log(`   💾 modal.html 저장 (${modalHtml.length} chars)`);
      }
    }

    fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(calls, null, 2));
    console.log(`\n📊 api.kream.co.kr 호출: ${calls.length}건`);
    calls.forEach((c) => {
      const u = c.url.replace('https://api.kream.co.kr', '').split('?')[0];
      console.log(`   [${c.phase}] ${c.status} ${u}`);
    });
    console.log('\n5초 후 종료...');
    await delay(5000);
  } catch (e) {
    console.error('❌', e.message);
  } finally {
    await context.close();
  }
}

main();
