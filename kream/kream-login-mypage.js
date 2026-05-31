import { chromium } from 'playwright';

// ============================================================
// KREAM 로그인 → 마이페이지 스크립트
// 네이버 소셜 로그인을 통해 KREAM에 로그인하고 마이페이지를 확인합니다.
// ============================================================

const KREAM_URL = 'https://kream.co.kr';
const NAVER_ID = 'dasom6y';
const NAVER_PW = 'Qwe123!!@@';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function loginAndGoToMyPage() {
  console.log('\n============================================================');
  console.log('🔑 KREAM 로그인 → 마이페이지');
  console.log('============================================================\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. KREAM 메인 페이지 접속
    console.log('1️⃣  KREAM 메인 페이지 접속...');
    await page.goto(KREAM_URL, { waitUntil: 'domcontentloaded' });
    console.log('   ✅ 접속 완료\n');

    // 2. 로그인 페이지로 이동
    console.log('2️⃣  로그인 페이지로 이동...');
    await page.click('a[href*="/login"]');
    await page.waitForURL('**/login**');
    console.log('   ✅ 로그인 페이지 도착\n');

    // 3. 네이버로 로그인 버튼 클릭 (새 탭이 열림)
    console.log('3️⃣  네이버로 로그인 클릭...');
    const [naverPage] = await Promise.all([
      context.waitForEvent('page'),
      page.click('button:has-text("네이버로 로그인")')
    ]);
    await naverPage.waitForLoadState('domcontentloaded');
    console.log('   ✅ 네이버 로그인 페이지 열림\n');

    // 4. 네이버 아이디/비밀번호 입력
    console.log('4️⃣  네이버 로그인 정보 입력...');
    const idInput = naverPage.locator('input[id="id"]');
    const pwInput = naverPage.locator('input[id="pw"]');

    await idInput.click();
    await idInput.pressSequentially(NAVER_ID, { delay: 100 });
    await delay(500);

    await pwInput.click();
    await pwInput.pressSequentially(NAVER_PW, { delay: 100 });
    await delay(500);
    console.log('   ✅ 아이디/비밀번호 입력 완료\n');

    // 5. 로그인 버튼 클릭
    console.log('5️⃣  로그인 버튼 클릭...');
    await naverPage.click('button[type="submit"], button.btn_login, #log\\.login');
    
    // 로그인 후 KREAM으로 리다이렉트 대기
    await page.waitForURL('**/kream.co.kr/**', { timeout: 30000 });
    await delay(2000);
    console.log('   ✅ 로그인 성공! KREAM으로 리다이렉트됨\n');

    // 6. 마이페이지로 이동
    console.log('6️⃣  마이페이지로 이동...');
    await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded' });
    await delay(2000);
    console.log('   ✅ 마이페이지 도착\n');

    // 7. 마이페이지 정보 수집
    console.log('7️⃣  마이페이지 정보 수집...');
    console.log('============================================================\n');

    // 프로필 정보
    const profileName = await page.locator('.my_page .profile_info strong, [class*="profile"] strong').first().textContent().catch(() => 'N/A');
    const profileEmail = await page.locator('.my_page .profile_info p, [class*="profile"] p').first().textContent().catch(() => 'N/A');
    console.log(`👤 프로필: ${profileName} / ${profileEmail}`);

    // 구매 내역
    const buyingSection = page.locator('text=구매 내역').first();
    if (await buyingSection.isVisible()) {
      console.log('\n📦 구매 내역:');
      const buyingLinks = page.locator('a[href*="/my/buying/"]');
      const buyingCount = await buyingLinks.count();
      for (let i = 0; i < Math.min(buyingCount, 5); i++) {
        const text = await buyingLinks.nth(i).textContent();
        console.log(`   ${i + 1}. ${text.replace(/\s+/g, ' ').trim().substring(0, 100)}`);
      }
    }

    // 판매 내역
    const sellingSection = page.locator('text=판매 내역').first();
    if (await sellingSection.isVisible()) {
      console.log('\n💰 판매 내역:');
      const sellingLinks = page.locator('a[href*="/my/selling/"]');
      const sellingCount = await sellingLinks.count();
      for (let i = 0; i < Math.min(sellingCount, 5); i++) {
        const text = await sellingLinks.nth(i).textContent();
        console.log(`   ${i + 1}. ${text.replace(/\s+/g, ' ').trim().substring(0, 100)}`);
      }
    }

    console.log('\n============================================================');
    console.log('✅ 마이페이지 정보 수집 완료!');
    console.log('============================================================\n');

    // 브라우저를 열어둔 상태로 대기 (수동 확인용)
    console.log('🔍 브라우저가 열려 있습니다. 확인 후 Ctrl+C로 종료하세요.');
    await page.waitForTimeout(60000 * 5); // 5분 대기

  } catch (error) {
    console.error('\n❌ 오류 발생:', error.message);
    
    // 스크린샷 저장
    try {
      await page.screenshot({ path: 'kream-error-screenshot.png' });
      console.log('📸 에러 스크린샷 저장: kream-error-screenshot.png');
    } catch (e) {}
    
    throw error;
  } finally {
    await browser.close();
  }
}

loginAndGoToMyPage();
