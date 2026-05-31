import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================
// KREAM 판매 입찰 목록 전체 조회 스크립트
//
// Playwright로 네이버 로그인 → 판매입찰 페이지 스크롤 → API 응답 인터셉트
// 사용법: node fetch-selling-bids.js
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KREAM_URL = 'https://kream.co.kr';
const NAVER_ID = 'dasom6y';
const NAVER_PW = 'Qwe123!!@@';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────
// API 아이템에서 핵심 데이터 추출
// ─────────────────────────────────────────────
function extractItemData(item) {
  if (!item || !item.actions || item.actions.length < 2) return null;
  const askId = item.actions?.[1]?.parameters?.ask_id?.[0];
  if (!askId) return null;
  return {
    ask_id: askId,
    detail_url: item.actions?.[0]?.value || '',
    product_name: item.text_item?.items?.[0]?.text_element?.default_variation?.text
               || item.text_item?.items?.[0]?.text_element_pc?.default_variation?.text || '',
    size: item.option_item?.option1_item?.text_element?.default_variation?.text || '',
    price: item.caption_item?.text_element?.default_variation?.text || '',
    expiry_date: item.label_item?.items?.[0]?.text_element?.default_variation?.text || '',
    image_url: item.image_item?.image_item?.image_element?.default_variation?.url || '',
  };
}

// ─────────────────────────────────────────────
// 메인 실행
// ─────────────────────────────────────────────
async function main() {
  console.log('============================================================');
  console.log('� KREAM 판매 입찰 목록 전체 조회');
  console.log('============================================================');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // 1. 로그인
    console.log('\n🔑 KREAM 네이버 로그인 중...');
    await page.goto(`${KREAM_URL}/login`, { waitUntil: 'networkidle' });
    await delay(2000);

    // 네이버로 로그인 버튼 클릭
    const naverBtn = page.locator('button:has-text("네이버"), a:has-text("네이버")').first();
    await naverBtn.waitFor({ state: 'visible', timeout: 10000 });

    let naverPage;
    try {
      [naverPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 10000 }),
        naverBtn.click()
      ]);
    } catch {
      naverPage = page;
      await page.waitForURL('**/nid.naver.com/**', { timeout: 15000 });
    }
    await naverPage.waitForLoadState('domcontentloaded');
    await delay(2000);

    // 네이버 로그인
    await naverPage.waitForSelector('#id', { timeout: 15000 });
    await naverPage.locator('#id').click();
    await naverPage.locator('#id').pressSequentially(NAVER_ID, { delay: 100 });
    await delay(500);
    await naverPage.locator('#pw').click();
    await naverPage.locator('#pw').pressSequentially(NAVER_PW, { delay: 100 });
    await delay(500);
    await naverPage.locator('.btn_login, button[type="submit"], #log\\.login').first().click();

    // KREAM으로 리다이렉트 대기
    await page.waitForURL('**/kream.co.kr/**', { timeout: 30000 }).catch(() => {});
    await delay(5000);
    console.log('   ✅ 로그인 성공!\n');

    // 2. 판매 입찰 페이지로 이동 & API 응답 수집
    console.log('📦 판매 입찰 목록 수집 중...');
    const allApiData = [];

    page.on('response', async (response) => {
      if (response.url().includes('/api/o/asks/') && response.url().includes('tab=bidding')) {
        try { allApiData.push(await response.json()); } catch {}
      }
    });

    await page.goto(`${KREAM_URL}/my/selling?tab=bidding`, { waitUntil: 'networkidle' });
    await delay(2000);

    // 스크롤로 다음 페이지들 트리거
    let prevCount = 0;
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(2000);
      const totalItems = allApiData.reduce((sum, d) => sum + (d.items?.length || 0), 0);
      if (totalItems === prevCount && i > 0) break;
      prevCount = totalItems;
    }

    // 3. 응답에서 아이템 추출 (중복 제거)
    const allItems = [];
    const seenIds = new Set();
    let total = 0;
    for (const data of allApiData) {
      if (data.total) total = data.total;
      for (const item of (data.items || [])) {
        const extracted = extractItemData(item);
        if (extracted && !seenIds.has(extracted.ask_id)) {
          seenIds.add(extracted.ask_id);
          allItems.push(extracted);
        }
      }
    }

    // 4. 결과 저장
    const today = new Date().toISOString().split('T')[0];
    const filename = path.join(__dirname, `kream_selling_bids_${today}.json`);
    const result = { total, fetchedCount: allItems.length, items: allItems };
    fs.writeFileSync(filename, JSON.stringify(result, null, 2), 'utf8');

    console.log('\n============================================================');
    console.log(`✅ 조회 완료!`);
    console.log(`   - 총 입찰 수: ${total}개`);
    console.log(`   - 추출된 상품: ${allItems.length}개`);
    console.log(`   - API 호출: ${allApiData.length}회`);
    console.log(`   - 저장 파일: ${filename}`);
    console.log('============================================================\n');

    // 미리보기
    console.log('📋 미리보기 (상위 5개):');
    console.log('──────────────────────────────────────');
    allItems.slice(0, 5).forEach((item, i) => {
      console.log(`${i + 1}. [${item.ask_id}] ${item.product_name}`);
      console.log(`   사이즈: ${item.size} | 가격: ${item.price} | 만료: ${item.expiry_date}`);
    });

  } catch (error) {
    console.error('\n❌ 오류 발생:', error.message);
    try { await page.screenshot({ path: path.join(__dirname, 'kream-error.png') }); } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
