/**
 * diagnose-product-page.js
 * 특정 KREAM 상품 페이지를 headed 로 열어 DOM/버튼 텍스트 덤프.
 * 왜 "거래 내역 더보기" 버튼이 안 잡히는지 진단용.
 *
 * 사용법:
 *   node diagnose-product-page.js 38598 [135046 ...]
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
const OUT_DIR = path.join(__dirname, 'diagnose-out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// .env 로드
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const pids = process.argv.slice(2);
if (pids.length === 0) {
  console.error('사용법: node diagnose-product-page.js <pid> [pid...]');
  process.exit(1);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// SingletonLock 잔재 제거 (Mac↔VPS 프로필 공유 이슈)
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(BROWSER_DATA_DIR, f)); } catch (_) {}
}

const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1400, height: 900 },
});
const page = context.pages()[0] || await context.newPage();

// 모든 KREAM API 응답 캡처
const apiHits = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/p/products/') || u.includes('/api/products/')) {
    apiHits.push({ url: u, status: r.status() });
  }
});

for (const pid of pids) {
  console.log(`\n${'='.repeat(60)}\n▶ product_id = ${pid}\n${'='.repeat(60)}`);
  apiHits.length = 0;

  await page.goto(`https://kream.co.kr/products/${pid}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await delay(3500);

  const title = await page.title();
  const url = page.url();
  console.log(`  URL: ${url}`);
  console.log(`  title: ${title}`);

  // 모든 버튼 텍스트 덤프
  const btns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, a')).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 60),
      cls: (el.className || '').toString().slice(0, 80),
      visible: !!(el.offsetWidth || el.offsetHeight),
    })).filter((b) => b.text && b.text.length > 1);
  });

  const candidates = btns.filter((b) => /거래|체결|시세|입찰|호가|더보기|내역/.test(b.text));
  console.log(`\n  🔍 관련 후보 (${candidates.length}건):`);
  candidates.forEach((b) => console.log(`     ${b.visible ? '👁' : '🚫'} <${b.tag}> "${b.text}"  (${b.cls.slice(0, 40)})`));

  // 스크롤해서 하단 영역 로드 유도
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(2500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(2500);

  // 스크롤 후 다시 버튼 스캔
  const btns2 = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, a')).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 60),
      cls: (el.className || '').toString().slice(0, 80),
      visible: !!(el.offsetWidth || el.offsetHeight),
    })).filter((b) => b.text && /거래|체결|시세|입찰|호가|더보기|내역/.test(b.text));
  });
  console.log(`\n  🔍 스크롤 후 후보 (${btns2.length}건):`);
  btns2.forEach((b) => console.log(`     ${b.visible ? '👁' : '🚫'} <${b.tag}> "${b.text}"  (${b.cls.slice(0, 40)})`));

  console.log(`\n  📡 API 호출 (${apiHits.length}건):`);
  apiHits.forEach((h) => console.log(`     ${h.status}  ${h.url.slice(0, 120)}`));

  await page.screenshot({ path: path.join(OUT_DIR, `pid-${pid}.png`), fullPage: true });
  console.log(`  📸 screenshot: ${path.join(OUT_DIR, `pid-${pid}.png`)}`);
}

console.log('\n✅ 완료. 화면 확인하고 창 닫으면 종료.');
await delay(20000);
await context.close();
