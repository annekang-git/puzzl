/**
 * explore-product-page-v2.js
 * v1 보강: ALL 네트워크 캡처 + 스크롤 + 클릭 가능한 요소 자동 탐지
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_URL = 'https://kream.co.kr/products/916477';
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
const OUT_DIR = path.join(__dirname, 'explore-output-v2');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('🔍 v2 탐색 시작\n');
  const lock = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lock)) fs.unlinkSync(lock);

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-popup-blocking', '--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

  const calls = [];
  let counter = 0;
  let phase = 'init';

  page.on('response', async (resp) => {
    const url = resp.url();
    // 모든 API/JSON 캡처
    if (resp.request().method() === 'OPTIONS') return;
    if (!/\.(css|js|woff2?|ttf|png|jpe?g|gif|svg|webp|ico|mp4)(\?|$)/.test(url)) {
      const idx = ++counter;
      const meta = { idx, phase, status: resp.status(), method: resp.request().method(), url };
      try {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('json') || (url.includes('api') && resp.status() === 200)) {
          const body = await resp.json().catch(() => null);
          if (body) {
            fs.writeFileSync(path.join(OUT_DIR, `api-${String(idx).padStart(3, '0')}.json`), JSON.stringify(body, null, 2));
            meta.saved = `api-${String(idx).padStart(3, '0')}.json`;
            if (Array.isArray(body)) meta.summary = `array len=${body.length}`;
            else if (body && typeof body === 'object') meta.summary = `keys=${Object.keys(body).slice(0, 8).join(',')}`;
          }
        }
      } catch (_) {}
      calls.push(meta);
      const shortUrl = url.length > 110 ? url.slice(0, 110) + '…' : url;
      console.log(`   [${phase}] #${idx} ${resp.status()} ${shortUrl}${meta.summary ? '\n        → ' + meta.summary : ''}`);
    }
  });

  try {
    phase = 'load';
    console.log('1️⃣  상품 페이지 직접 진입 (warmup 없이)');
    await page.goto(PRODUCT_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await delay(3000);
    await page.screenshot({ path: path.join(OUT_DIR, '1-loaded.png') });

    phase = 'scroll';
    console.log('\n2️⃣  전체 페이지 스크롤 (lazy load 트리거)');
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 250);
      });
    });
    await delay(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(1500);
    await page.screenshot({ path: path.join(OUT_DIR, '2-after-scroll.png') });

    phase = 'inspect';
    console.log('\n3️⃣  클릭 가능한 요소 탐지');
    const clickables = await page.evaluate(() => {
      const targets = ['체결 거래', '체결거래', '판매 입찰', '판매입찰', '구매 입찰', '구매입찰', '시세', '더보기'];
      const found = [];
      const all = document.querySelectorAll('button, a, [role="button"], [role="tab"], .tab, [class*="tab"]');
      all.forEach((el) => {
        const txt = (el.innerText || el.textContent || '').trim();
        for (const t of targets) {
          if (txt.includes(t) && txt.length < 30) {
            const rect = el.getBoundingClientRect();
            found.push({ text: txt, tag: el.tagName, class: el.className?.toString().slice(0, 80) || '', visible: rect.width > 0 && rect.height > 0, x: rect.x, y: rect.y });
            break;
          }
        }
      });
      return found;
    });
    console.log(`   발견된 후보: ${clickables.length}개`);
    clickables.slice(0, 20).forEach((c) => {
      console.log(`   - <${c.tag}> "${c.text}" visible=${c.visible} y=${c.y?.toFixed(0)} class=${c.class.slice(0, 50)}`);
    });
    fs.writeFileSync(path.join(OUT_DIR, 'clickables.json'), JSON.stringify(clickables, null, 2));

    phase = 'click-sales';
    console.log('\n4️⃣  체결거래 클릭 시도');
    const salesBtn = clickables.find((c) => c.text.includes('체결'));
    if (salesBtn) {
      try {
        await page.locator(`${salesBtn.tag.toLowerCase()}:has-text("${salesBtn.text.split('\n')[0]}")`).first().click({ timeout: 5000 });
        await delay(3000);
        await page.screenshot({ path: path.join(OUT_DIR, '4-sales.png') });
      } catch (e) { console.log('   ⚠️ 체결 클릭 실패:', e.message.slice(0, 80)); }
    }

    phase = 'click-asks';
    console.log('\n5️⃣  판매입찰 클릭 시도');
    const asksBtn = clickables.find((c) => c.text.includes('판매 입찰') || c.text.includes('판매입찰'));
    if (asksBtn) {
      try {
        await page.locator(`${asksBtn.tag.toLowerCase()}:has-text("${asksBtn.text.split('\n')[0]}")`).first().click({ timeout: 5000 });
        await delay(3000);
        await page.screenshot({ path: path.join(OUT_DIR, '5-asks.png') });
      } catch (e) { console.log('   ⚠️ 판매입찰 클릭 실패:', e.message.slice(0, 80)); }
    }

    phase = 'click-bids';
    console.log('\n6️⃣  구매입찰 클릭 시도');
    const bidsBtn = clickables.find((c) => c.text.includes('구매 입찰') || c.text.includes('구매입찰'));
    if (bidsBtn) {
      try {
        await page.locator(`${bidsBtn.tag.toLowerCase()}:has-text("${bidsBtn.text.split('\n')[0]}")`).first().click({ timeout: 5000 });
        await delay(3000);
        await page.screenshot({ path: path.join(OUT_DIR, '6-bids.png') });
      } catch (e) { console.log('   ⚠️ 구매입찰 클릭 실패:', e.message.slice(0, 80)); }
    }

    // 최종 저장
    fs.writeFileSync(path.join(OUT_DIR, 'page-final.html'), await page.content());
    fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(calls, null, 2));
    console.log(`\n📊 총 캡처: ${calls.length}건`);

    // api 도메인 호출만 요약
    const apiCalls = calls.filter((c) => /api\.kream/.test(c.url));
    console.log(`\n🎯 api.kream.co.kr 호출 ${apiCalls.length}건:`);
    apiCalls.forEach((c) => {
      const u = c.url.split('?')[0].replace('https://api.kream.co.kr', '');
      console.log(`   ${c.status} ${c.method} ${u}  [${c.phase}]${c.summary ? ' — ' + c.summary : ''}`);
    });
  } catch (e) {
    console.error('❌', e.message);
  } finally {
    await delay(5000);
    await context.close();
  }
}

main();
