import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data');
for (const f of ['SingletonLock','SingletonCookie','SingletonSocket']) { try { fs.unlinkSync(path.join(BROWSER_DATA_DIR,f)); } catch(_) {} }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(BROWSER_DATA_DIR, { channel:'chrome', headless:false, viewport:{width:1400,height:900} });
const page = ctx.pages()[0] || await ctx.newPage();

const pid = process.argv[2] || '38598';
const hits = [];
page.on('response', r => {
  const u = r.url();
  if (u.includes('kream.co.kr') && u.includes('/api/')) hits.push({ url: u, status: r.status() });
});

await page.goto(`https://kream.co.kr/products/${pid}`, { waitUntil:'domcontentloaded', timeout:30000 }).catch(()=>{});
await delay(3000);
console.log(`\n=== 로드 후 (${hits.length}건) ===`);
hits.forEach(h => console.log(`  ${h.status}  ${h.url.slice(0,180)}`));

// 스크롤
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await delay(2000);
console.log(`\n=== 스크롤 후 (누적 ${hits.length}건) ===`);
hits.slice(-20).forEach(h => console.log(`  ${h.status}  ${h.url.slice(0,180)}`));

// "거래 내역 더보기" 찾아서 click
try {
  await page.waitForSelector('button:has-text("거래 내역 더보기"):visible', { timeout: 6000 });
  const btn = page.locator('button:has-text("거래 내역 더보기"):visible').first();
  const beforeCount = hits.length;
  await btn.click({ force: true });
  await delay(5000);
  console.log(`\n=== 클릭 후 신규 (${hits.length - beforeCount}건) ===`);
  hits.slice(beforeCount).forEach(h => console.log(`  ${h.status}  ${h.url.slice(0,180)}`));
} catch (e) {
  console.log(`\n버튼 wait 실패: ${e.message.slice(0,100)}`);
}

await delay(3000);
await ctx.close();
