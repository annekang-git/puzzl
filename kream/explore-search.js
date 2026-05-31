/**
 * explore-search.js
 * KREAM 검색 API 탐색 — SKU 로 product_id 자동 추출 가능한지 확인
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKU = 'SSX03L101N';
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
const OUT_DIR = path.join(__dirname, 'explore-search-output');
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
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/api\.kream\.co\.kr/.test(url)) return;
    if (resp.request().method() === 'OPTIONS') return;
    const idx = ++counter;
    const meta = { idx, status: resp.status(), method: resp.request().method(), url };
    try {
      const body = await resp.json();
      fs.writeFileSync(path.join(OUT_DIR, `search-${String(idx).padStart(3, '0')}.json`), JSON.stringify(body, null, 2));
      meta.saved = `search-${String(idx).padStart(3, '0')}.json`;
      if (Array.isArray(body)) meta.summary = `array len=${body.length}`;
      else if (body) meta.summary = `keys=${Object.keys(body).slice(0, 8).join(',')}`;
    } catch (_) {}
    calls.push(meta);
    const u = url.replace('https://api.kream.co.kr', '').split('?')[0];
    const qs = url.split('?')[1]?.split('&').slice(0, 3).join('&') || '';
    console.log(`   #${idx} ${resp.status()} ${u}?${qs.slice(0, 80)}${meta.summary ? ' — ' + meta.summary : ''}`);
  });

  try {
    console.log('1️⃣  메인 진입');
    await page.goto('https://kream.co.kr', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    // 방법 1: URL 직접 /search?keyword=SKU
    console.log(`\n2️⃣  URL 방식: /search?keyword=${SKU}`);
    await page.goto(`https://kream.co.kr/search?keyword=${encodeURIComponent(SKU)}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await delay(3000);
    await page.screenshot({ path: path.join(OUT_DIR, '1-search-url.png') });

    // DOM 에서 상품 카드의 링크 추출
    const productLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/products/"]'));
      return links.slice(0, 10).map((a) => ({
        href: a.href,
        text: (a.innerText || '').trim().slice(0, 80),
      }));
    });
    console.log(`   상품 링크 후보 ${productLinks.length}개:`);
    productLinks.forEach((l, i) => console.log(`   ${i + 1}. ${l.href.replace('https://kream.co.kr', '')} — ${l.text.slice(0, 50)}`));

    // 방법 2: 검색바 직접 입력 (autocomplete 도 트리거)
    console.log(`\n3️⃣  검색바 직접 입력 (autocomplete 트리거)`);
    await page.goto('https://kream.co.kr', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);
    // 검색 버튼/input 찾기
    const searchInput = page.locator('input[type="search"], input[placeholder*="검색"], button:has-text("검색")').first();
    if ((await searchInput.count()) > 0) {
      try {
        await searchInput.click({ timeout: 3000 });
        await delay(1000);
      } catch (_) {}
      const realInput = page.locator('input[type="text"]:visible, input[type="search"]:visible').first();
      if ((await realInput.count()) > 0) {
        await realInput.pressSequentially(SKU, { delay: 100 });
        await delay(2500); // autocomplete 대기
        await page.screenshot({ path: path.join(OUT_DIR, '3-autocomplete.png') });
      }
    }

    fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(calls, null, 2));
    console.log(`\n📊 검색 관련 API ${calls.length}건:`);
    calls.forEach((c) => {
      const u = c.url.replace('https://api.kream.co.kr', '').split('?')[0];
      console.log(`   ${c.status} ${u}${c.summary ? ' — ' + c.summary : ''}`);
    });
    console.log('\n8초 후 종료...');
    await delay(8000);
  } catch (e) {
    console.error('❌', e.message);
  } finally {
    await context.close();
  }
}

main();
