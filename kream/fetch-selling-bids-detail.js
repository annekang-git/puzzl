import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================
// KREAM 판매 입찰 목록 + 상세 데이터 전체 조회 스크립트
//
// 1단계: 판매입찰 페이지 스크롤 → ask_id 목록 수집
// 2단계: 각 ask_id별 상세 API 호출 → 주문번호, 한글명, 모델번호 등
//
// 사용법: node fetch-selling-bids-detail.js
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KREAM_URL = 'https://kream.co.kr';
const API_BASE = 'https://api.kream.co.kr';
const NAVER_ID = 'dasom6y';
const NAVER_PW = 'Qwe123!!@@';
const BROWSER_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.browser-data');
const ASK_IDS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ask_ids.json');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────
// 목록 API 아이템에서 ask_id 추출
// ─────────────────────────────────────────────
function extractAskId(item) {
  if (!item || !item.actions || item.actions.length < 2) return null;
  return item.actions?.[1]?.parameters?.ask_id?.[0] || null;
}

// ─────────────────────────────────────────────
// 상세 API 응답에서 핵심 데이터 추출
// ─────────────────────────────────────────────
function extractDetailData(data) {
  const release = data.product?.release || {};
  const market = data.product?.market || {};
  const brand = data.product?.brand || {};
  const breakdown = data.price_breakdown || {};

  return {
    // 주문/입찰 정보
    ask_id: data.id,
    oid: data.oid || '',
    order_id: data.order_id || '',
    status: data.status || '',
    status_display: data.status_display || '',
    price: data.price || 0,
    option: data.option || '',
    expires_at: data.expires_at || '',
    date_created: data.date_created || '',

    // 상품 정보
    product_id: data.product_id || 0,
    name: release.name || '',
    translated_name: release.translated_name || '',
    style_code: release.style_code || '',
    colorway: release.colorway || '',
    category: release.category || '',
    gender: release.gender || '',
    date_released: release.date_released || '',

    // 브랜드
    brand_name: brand.name || '',

    // 가격 정보
    original_price: release.original_price || 0,
    original_price_currency: release.original_price_currency || '',
    local_price: release.local_price || 0,

    // 시세
    market_price: market.market_price || null,
    lowest_ask: market.lowest_ask || null,
    highest_bid: market.highest_bid || null,
    last_sale_price: market.last_sale_price || null,
    total_sales: market.total_sales || 0,

    // 정산
    processing_fee: breakdown.processing_fee?.value || 0,
    authentication_fee: breakdown.authentication_fee?.value || 0,
    total_payout: breakdown.total_payout || 0,

    // 이미지
    image_url: data.image_url || release.image_urls?.[0] || '',
  };
}

// ─────────────────────────────────────────────
// 메인 실행
// ─────────────────────────────────────────────
async function main() {
  console.log('============================================================');
  console.log('📋 KREAM 판매 입찰 목록 + 상세 데이터 전체 조회');
  console.log('============================================================');

  // 영구 브라우저 프로필 사용 (로그인 세션 유지)
  // SingletonLock이 남아있으면 자동 제거
  const lockFile = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
    console.log('   🔓 이전 브라우저 잠금 파일 제거');
  }

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    channel: 'chrome',  // 실제 Chrome 사용 (봇 감지 우회)
    viewport: { width: 1440, height: 900 },
    args: [
      '--disable-popup-blocking',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreHTTPSErrors: true,
  });

  // navigator.webdriver 플래그 제거 (봇 감지 우회)
  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // 팝업 윈도우 자동 감지 (네이버 로그인 등)
  context.on('page', async (popup) => {
    console.log('   📌 팝업 감지:', popup.url());
  });

  try {
    // ─── 1단계: 로그인 확인 ───
    console.log('\n🔑 KREAM 로그인 확인 중...');

    // 먼저 메인 페이지 접속 (직접 /my 접근 시 차단될 수 있음)
    await page.goto(KREAM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);

    // 마이페이지로 이동 시도
    try {
      await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(2000);
    } catch {
      console.log('   ℹ️  마이페이지 직접 접근 불가, 로그인 시도...');
    }

    let loginSuccess = false;
    const currentUrl = page.url();

    // 이미 로그인되어 있으면 (영구 프로필에 세션 있음)
    if (currentUrl.includes('/my') && !currentUrl.includes('/login')) {
      loginSuccess = true;
      console.log('   ✅ 기존 세션으로 로그인 되어 있습니다!\n');
    }

    if (!loginSuccess) {
      // 로그인 페이지로 이동
      try {
        await page.goto(`${KREAM_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        // domcontentloaded 실패 시 load로 재시도
        await page.goto(`${KREAM_URL}/login`, { waitUntil: 'load', timeout: 15000 });
      }
      await delay(3000);

      // 자동 로그인 시도
      try {
        const naverBtn = page.locator('button:has-text("네이버"), a:has-text("네이버")').first();
        await naverBtn.waitFor({ state: 'visible', timeout: 5000 });

        // 네이버 로그인 버튼의 href 또는 onclick에서 URL을 추출하여 직접 이동 시도
        let naverPage;
        let naverLoginUrl = null;

        // 방법 1: 버튼/링크에서 네이버 로그인 URL 추출 후 같은 페이지에서 직접 이동
        try {
          naverLoginUrl = await naverBtn.evaluate(el => {
            // a 태그면 href, 아니면 onclick 또는 data 속성에서 URL 추출
            if (el.tagName === 'A' && el.href) return el.href;
            const onclick = el.getAttribute('onclick') || '';
            const match = onclick.match(/https?:\/\/[^\s'"]+/);
            return match ? match[0] : null;
          });
        } catch {}

        if (naverLoginUrl && naverLoginUrl.includes('naver.com')) {
          console.log('   🔗 네이버 로그인 URL로 직접 이동...');
          await page.goto(naverLoginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          naverPage = page;
        } else {
          // 방법 2: 팝업 감지 + 클릭 (기존 방식)
          // window.open을 가로채서 팝업 대신 같은 창에서 열리도록 처리
          await page.evaluate(() => {
            window.__originalOpen = window.open;
            window.open = function(url, target, features) {
              if (url && url.includes('naver.com')) {
                window.location.href = url;
                return window;
              }
              return window.__originalOpen.call(this, url, target, features);
            };
          });

          try {
            // 팝업이 열리는 경우
            const popupPromise = context.waitForEvent('page', { timeout: 8000 });
            await naverBtn.click();

            try {
              naverPage = await popupPromise;
            } catch {
              // 팝업이 안 열렸으면 같은 페이지에서 네이버로 이동했는지 확인
              naverPage = page;
              await page.waitForURL(url => url.includes('nid.naver.com') || url.includes('naver.com'), { timeout: 10000 });
            }
          } catch {
            // 최후 수단: 클릭 후 모든 페이지 확인
            naverPage = page;
            await delay(3000);
            const allPages = context.pages();
            for (const p of allPages) {
              if (p.url().includes('naver.com')) {
                naverPage = p;
                break;
              }
            }
            if (!naverPage.url().includes('naver.com')) {
              throw new Error('네이버 로그인 페이지로 이동 실패');
            }
          }
        }

        await naverPage.waitForLoadState('domcontentloaded');
        await delay(2000);

        // 네이버 로그인 폼 입력
        await naverPage.waitForSelector('#id', { timeout: 10000 });
        await naverPage.locator('#id').click();
        await naverPage.locator('#id').pressSequentially(NAVER_ID, { delay: 100 });
        await delay(500);
        await naverPage.locator('#pw').click();
        await naverPage.locator('#pw').pressSequentially(NAVER_PW, { delay: 100 });
        await delay(500);
        await naverPage.locator('.btn_login, button[type="submit"], #log\\.login').first().click();

        // 로그인 후 KREAM으로 돌아올 때까지 대기
        await page.waitForURL('**/kream.co.kr/**', { timeout: 30000 });
        await delay(3000);
        loginSuccess = true;
        console.log('   ✅ 자동 로그인 성공!\n');
      } catch (e) {
        console.log('\n   ⚠️  자동 로그인 실패:', e.message);
        console.log('   👉 브라우저에서 직접 네이버로 로그인해주세요.');
        console.log('   👉 로그인 후 KREAM 마이페이지가 보이면 자동 진행됩니다.');
        console.log('   ⏳ 대기 중... (최대 5분)\n');
        for (let w = 0; w < 100; w++) {
          await delay(3000);
          const url = page.url();
          if (url.includes('kream.co.kr') && !url.includes('/login') && !url.includes('nid.naver.com')) {
            loginSuccess = true;
            console.log('   ✅ 로그인 확인!\n');
            break;
          }
        }
      }
    }

    if (!loginSuccess) {
      throw new Error('로그인에 실패했습니다. 다시 시도해주세요.');
    }

    // ─── 2단계: 판매 입찰 목록 수집 (스크롤 또는 캐시 파일) ───
    let askIds = [];
    let total = 0;

    // 기존 ask_ids.json 파일이 있으면 재사용
    if (fs.existsSync(ASK_IDS_FILE)) {
      askIds = JSON.parse(fs.readFileSync(ASK_IDS_FILE, 'utf8'));
      total = askIds.length;
      console.log(`📦 [1/2] 기존 ask_ids.json 로드: ${askIds.length}개\n`);
    } else {
      console.log('📦 [1/2] 판매 입찰 목록 수집 중...');
      const allApiData = [];

      page.on('response', async (response) => {
        if (response.url().includes('/api/o/asks/') && response.url().includes('tab=bidding')) {
          try { allApiData.push(await response.json()); } catch {}
        }
      });

      await page.goto(`${KREAM_URL}/my/selling?tab=bidding`, { waitUntil: 'networkidle' });
      await delay(2000);

      let prevCount = 0;
      for (let i = 0; i < 30; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(2000);
        const totalItems = allApiData.reduce((sum, d) => sum + (d.items?.length || 0), 0);
        console.log(`   스크롤 ${i + 1}: 누적 ${totalItems}개`);
        if (totalItems === prevCount && i > 0) break;
        prevCount = totalItems;
      }

      const seenIds = new Set();
      for (const data of allApiData) {
        if (data.total) total = data.total;
        for (const item of (data.items || [])) {
          const askId = extractAskId(item);
          if (askId && !seenIds.has(askId)) {
            seenIds.add(askId);
            askIds.push(askId);
          }
        }
      }
      // ask_ids 캐시 저장
      fs.writeFileSync(ASK_IDS_FILE, JSON.stringify(askIds), 'utf8');
      console.log(`   ✅ 목록 수집 완료: ${askIds.length}개 (total: ${total})\n`);
    }

    // ─── 3단계: 각 ask_id별 상세 페이지 방문 → API 응답 인터셉트 ───
    console.log(`🔍 [2/2] 상세 데이터 수집 중... (${askIds.length}건, 약 ${Math.ceil(askIds.length * 1.2 / 60)}분 소요 예상)`);
    const detailItems = [];
    const failedIds = [];

    // 불필요한 리소스 차단 (속도 최적화)
    await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,css}', route => route.abort());
    await page.route('**/analytics/**', route => route.abort());
    await page.route('**/gtm.**', route => route.abort());
    await page.route('**/notification/unread/**', route => route.abort());

    const startTime = Date.now();

    for (let i = 0; i < askIds.length; i++) {
      const askId = askIds[i];
      try {
        // API 응답 대기 Promise 먼저 설정
        const apiPromise = page.waitForResponse(
          resp => resp.url().includes(`/api/m/asks/${askId}`),
          { timeout: 15000 }
        );

        // 상세 페이지로 이동 (commit만 대기 → 빠름)
        await page.goto(`${KREAM_URL}/my/selling/${askId}`, { waitUntil: 'commit' });

        // API 응답 인터셉트
        const apiResponse = await apiPromise;
        const data = await apiResponse.json();
        detailItems.push(extractDetailData(data));

        if ((i + 1) % 20 === 0 || i === askIds.length - 1) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const eta = ((Date.now() - startTime) / (i + 1) * (askIds.length - i - 1) / 1000).toFixed(0);
          console.log(`   📄 [${i + 1}/${askIds.length}] ${data.product?.release?.name || askId} ✓  (${elapsed}s / 남은: ~${eta}s)`);
        }
      } catch (err) {
        failedIds.push({ askId, error: err.message });
        console.log(`   ❌ [${i + 1}/${askIds.length}] ${askId} → ${err.message}`);
      }
    }

    // 실패 항목 재시도 (1회)
    if (failedIds.length > 0) {
      console.log(`\n   🔄 실패 ${failedIds.length}건 재시도...`);
      const retryIds = [...failedIds];
      failedIds.length = 0;

      for (const { askId } of retryIds) {
        await delay(1000);
        try {
          const apiPromise = page.waitForResponse(
            resp => resp.url().includes(`/api/m/asks/${askId}`),
            { timeout: 15000 }
          );
          await page.goto(`${KREAM_URL}/my/selling/${askId}`, { waitUntil: 'commit' });
          const apiResponse = await apiPromise;
          const data = await apiResponse.json();
          detailItems.push(extractDetailData(data));
        } catch (err) {
          failedIds.push({ askId, error: err.message });
        }
      }
    }

    // 리소스 차단 해제
    await page.unroute('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,css}');
    await page.unroute('**/analytics/**');
    await page.unroute('**/gtm.**');
    await page.unroute('**/notification/unread/**');

    console.log(`   ✅ 상세 수집 완료: ${detailItems.length}개 성공, ${failedIds.length}개 실패\n`);

    // ─── 4단계: 결과 저장 ───
    const today = new Date().toISOString().split('T')[0];
    const filename = path.join(__dirname, `kream_selling_bids_detail_${today}.json`);
    const result = {
      total,
      fetchedCount: detailItems.length,
      failedCount: failedIds.length,
      fetchedAt: new Date().toISOString(),
      items: detailItems,
      ...(failedIds.length > 0 ? { failedIds } : {}),
    };
    fs.writeFileSync(filename, JSON.stringify(result, null, 2), 'utf8');

    const fileSizeKB = (fs.statSync(filename).size / 1024).toFixed(1);

    console.log('============================================================');
    console.log(`✅ 전체 조회 완료!`);
    console.log(`   - 총 입찰 수: ${total}개`);
    console.log(`   - 상세 수집: ${detailItems.length}개`);
    console.log(`   - 실패: ${failedIds.length}개`);
    console.log(`   - 파일: ${filename} (${fileSizeKB} KB)`);
    console.log('============================================================\n');

    // 미리보기
    console.log('📋 미리보기 (상위 5개):');
    console.log('──────────────────────────────────────');
    detailItems.slice(0, 5).forEach((item, i) => {
      console.log(`${i + 1}. [${item.oid}] ${item.name}`);
      console.log(`   한글: ${item.translated_name}`);
      console.log(`   모델: ${item.style_code} | 브랜드: ${item.brand_name}`);
      console.log(`   사이즈: ${item.option} | 입찰가: ${item.price?.toLocaleString()}원 | 정산: ${item.total_payout?.toLocaleString()}원`);
      console.log(`   시세: 최저판매 ${item.lowest_ask?.toLocaleString() || '-'}원 / 최고구매 ${item.highest_bid?.toLocaleString() || '-'}원`);
    });

  } catch (error) {
    console.error('\n❌ 오류 발생:', error.message);
    try { await page.screenshot({ path: path.join(__dirname, 'kream-error.png') }); } catch {}
    process.exit(1);
  } finally {
    await context.close();
  }
}

main();
