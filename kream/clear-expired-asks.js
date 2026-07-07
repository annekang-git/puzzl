/**
 * clear-expired-asks.js
 * KREAM 기한만료 판매입찰 일괄 삭제 스크립트.
 *
 * ⚠️ 이 스크립트는 별도 계정 (네이버 로그인) 사용 — 크롤링 계정과 다름.
 *    프로파일도 분리: .browser-data-naver/
 *
 * 흐름:
 *  1) 네이버 계정으로 KREAM 로그인 (세션 있으면 재사용)
 *  2) 마이페이지 > 판매내역 > 판매입찰 → '전체' → '기한만료' 필터
 *  3) 리스트 첫 항목 클릭 → 상세 → '입찰 지우기' → 팝업 '입찰 지우기' 확인
 *  4) 판매내역으로 복귀 → 2번부터 반복 (리스트 빌 때까지)
 *
 * 환경변수 (kream/.env):
 *   KREAM_NAVER_ID / KREAM_NAVER_PASS
 *
 * 사용법:
 *   node clear-expired-asks.js              # 전체 삭제
 *   node clear-expired-asks.js --dry-run    # 삭제 직전까지만 (팝업 확인 안 누름)
 *   node clear-expired-asks.js --max=5      # 최대 5건만 삭제
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KREAM_URL = 'https://kream.co.kr';
// 크롤링 계정 (.browser-data) 과 분리된 네이버 계정 전용 프로파일
const BROWSER_DATA_DIR = path.join(__dirname, '.browser-data-naver');
const SHOT_DIR = path.join(__dirname, 'clear-asks-shots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── .env 로드 ─────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const NAVER_ID = process.env.KREAM_NAVER_ID;
const NAVER_PASS = process.env.KREAM_NAVER_PASS;
if (!NAVER_ID || !NAVER_PASS) {
  console.error('❌ KREAM_NAVER_ID / KREAM_NAVER_PASS 환경변수 필요 (.env 확인)');
  process.exit(1);
}

// CLI 옵션
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX = Number((args.find((a) => a.startsWith('--max=')) || '--max=999').split('=')[1]);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19).replace(/:/g, '');

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(SHOT_DIR, `${stamp()}-${name}.png`), fullPage: false }); } catch (_) {}
}

// ──────────────────────────────────────────────────
// 네이버 로그인
// ──────────────────────────────────────────────────
async function ensureLoggedIn(page) {
  await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await delay(2500);
  if (page.url().includes('/my') && !page.url().includes('login')) {
    console.log('✅ 기존 세션으로 로그인 됨');
    return true;
  }

  console.log(`🔐 네이버 로그인 진행 (${NAVER_ID})...`);
  await page.goto(`${KREAM_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await delay(2500);
  await shot(page, 'login-page');

  // '네이버' 소셜 로그인 버튼
  const naverBtn = page.locator([
    'a:has-text("네이버")',
    'button:has-text("네이버")',
    '[class*="naver"]',
  ].join(', ')).first();
  if ((await naverBtn.count()) === 0) {
    console.error('❌ 네이버 로그인 버튼을 못 찾음');
    await shot(page, 'no-naver-btn');
    return false;
  }

  // 네이버 로그인은 팝업 또는 같은 탭 redirect 둘 다 가능 — popup 이벤트 대기하며 클릭
  const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
  await naverBtn.click();
  let loginPage = await popupPromise;
  if (!loginPage) loginPage = page; // 같은 탭 redirect
  await delay(3000);

  // 네이버 로그인 폼 (nid.naver.com)
  if (loginPage.url().includes('nid.naver.com')) {
    console.log('   📍 네이버 로그인 폼');
    // 네이버는 봇 감지로 fill 시 캡차가 자주 뜸 — 클립보드 붙여넣기 방식이 더 안전하지만
    // 우선 pressSequentially (천천히 타이핑) 로 시도
    await loginPage.locator('#id').click();
    await loginPage.locator('#id').pressSequentially(NAVER_ID, { delay: 120 });
    await delay(600);
    await loginPage.locator('#pw').click();
    await loginPage.locator('#pw').pressSequentially(NAVER_PASS, { delay: 120 });
    await delay(600);
    await shot(loginPage, 'naver-form-filled');
    await loginPage.locator('#log\\.login, button[type="submit"]').first().click();
    await delay(5000);

    // 캡차 / 새 기기 등록 등이 뜨면 사용자가 직접 처리할 시간 제공 (headed 전제)
    for (let i = 0; i < 18; i++) { // 최대 90초 대기
      if (!loginPage.isClosed() && loginPage.url().includes('nid.naver.com')) {
        if (i === 0) console.log('   ⏳ 캡차/기기등록 화면이면 직접 처리해주세요 (최대 90초 대기)...');
        await delay(5000);
      } else break;
    }
  }

  // KREAM 으로 복귀 확인
  await delay(3000);
  await page.goto(`${KREAM_URL}/my`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await delay(2500);
  if (page.url().includes('/my') && !page.url().includes('login')) {
    console.log('✅ 네이버 로그인 완료');
    return true;
  }
  console.error('❌ 로그인 실패 — 스크린샷 확인');
  await shot(page, 'login-failed');
  return false;
}

// ──────────────────────────────────────────────────
// 판매내역 > 판매입찰 > 전체 > 기한만료 필터 적용
// ──────────────────────────────────────────────────
async function gotoExpiredList(page) {
  // 판매내역 페이지 (판매입찰 텝)
  await page.goto(`${KREAM_URL}/my/selling`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await delay(3000);

  // '판매 입찰' 탭 (이미 기본일 수 있음 — 있으면 클릭)
  const bidTab = page.locator('a:has-text("판매 입찰"), button:has-text("판매 입찰"), [class*="tab"]:has-text("판매 입찰")').first();
  if ((await bidTab.count()) > 0) {
    await bidTab.click({ timeout: 3000 }).catch(() => {});
    await delay(1500);
  }

  // '전체' 클릭
  const allBtn = page.locator('button:has-text("전체"), a:has-text("전체"), [class*="filter"]:has-text("전체")').first();
  if ((await allBtn.count()) > 0) {
    await allBtn.click({ timeout: 3000 }).catch(() => {});
    await delay(1500);
  }

  // '기한만료' 클릭 (필터 시트/드롭다운에 있을 수 있음)
  const expiredBtn = page.locator('button:has-text("기한만료"), a:has-text("기한만료"), label:has-text("기한만료"), [class*="filter"]:has-text("기한만료")').first();
  if ((await expiredBtn.count()) === 0) {
    console.error('   ⚠️  "기한만료" 필터를 못 찾음');
    await shot(page, 'no-expired-filter');
    return false;
  }
  await expiredBtn.click({ timeout: 3000 }).catch(() => {});
  await delay(2500);
  await shot(page, 'expired-list');
  return true;
}

// 기한만료 리스트의 첫 항목 클릭 → 상세 진입. 항목 없으면 null.
async function openFirstExpiredItem(page) {
  // 리스트 항목 — KREAM 판매내역 리스트는 상품 단위 카드/행. '기한만료' 뱃지가 붙은 행을 우선 탐색.
  const item = page.locator([
    '[class*="list"] [class*="item"]:has-text("기한만료")',
    '[class*="history"] [class*="item"]:has-text("기한만료")',
    'a[href*="/my/selling/"]',
    '[class*="item_inner"]:has-text("기한만료")',
  ].join(', ')).first();

  if ((await item.count()) === 0) return false;
  await item.click({ timeout: 5000 });
  await delay(2500);
  return true;
}

// 상세 화면에서 '입찰 지우기' → 팝업 '입찰 지우기'
async function deleteCurrentBid(page) {
  const delBtn = page.locator('button:has-text("입찰 지우기"), a:has-text("입찰 지우기")').first();
  try {
    await delBtn.waitFor({ state: 'visible', timeout: 8000 });
  } catch (_) {
    console.error('   ⚠️  상세에서 "입찰 지우기" 버튼 못 찾음');
    await shot(page, 'no-delete-btn');
    return false;
  }
  await delBtn.click();
  await delay(1500);

  // 확인 팝업의 '입찰 지우기'
  // 팝업(모달) 내부 버튼 — 마지막에 나타난 같은 텍스트 버튼
  const confirmBtn = page.locator('[class*="layer"] button:has-text("입찰 지우기"), [class*="modal"] button:has-text("입찰 지우기"), [class*="popup"] button:has-text("입찰 지우기"), button:has-text("입찰 지우기")').last();
  try {
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch (_) {
    console.error('   ⚠️  확인 팝업 못 찾음');
    await shot(page, 'no-confirm-popup');
    return false;
  }

  if (DRY_RUN) {
    console.log('   🔍 [dry-run] 확인 팝업까지 도달 — 실제 삭제 안 함');
    await shot(page, 'dryrun-confirm');
    // 팝업 닫기 (취소/닫기)
    const cancel = page.locator('[class*="layer"] button:has-text("취소"), [class*="modal"] button:has-text("취소"), button[class*="close"]').first();
    await cancel.click({ timeout: 3000 }).catch(() => {});
    return true;
  }

  await confirmBtn.click();
  await delay(2500);
  return true;
}

// ──────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────
console.log('═'.repeat(60));
console.log(`🗑  KREAM 기한만료 판매입찰 삭제${DRY_RUN ? '  [DRY-RUN]' : ''}  (max=${MAX})`);
console.log('═'.repeat(60));

// SingletonLock 잔재 제거
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(path.join(BROWSER_DATA_DIR, f)); } catch (_) {}
}

const HEADLESS = process.env.KREAM_HEADLESS === '1';
const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
  channel: 'chrome',
  headless: HEADLESS,
  viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] || await context.newPage();

let deleted = 0;
try {
  if (!(await ensureLoggedIn(page))) {
    throw new Error('로그인 실패');
  }

  while (deleted < MAX) {
    // 매 반복마다 리스트 화면 → 필터 재적용 (삭제 후 필터가 풀리므로)
    const listOk = await gotoExpiredList(page);
    if (!listOk) break;

    const opened = await openFirstExpiredItem(page);
    if (!opened) {
      console.log(`\n✨ 기한만료 항목 없음 — 완료`);
      break;
    }
    await shot(page, `detail-${deleted + 1}`);

    const ok = await deleteCurrentBid(page);
    if (!ok) {
      console.error('   ❌ 삭제 실패 — 다음 반복에서 재시도하지 않고 중단');
      break;
    }
    deleted++;
    console.log(`   ✅ [${deleted}] 삭제 완료${DRY_RUN ? ' (dry-run)' : ''}`);

    if (DRY_RUN) break; // dry-run 은 1건만 시연
  }
} catch (e) {
  console.error(`\n❌ 에러: ${e.message}`);
  await shot(page, 'error');
} finally {
  console.log(`\n📊 총 ${deleted}건 처리${DRY_RUN ? ' (dry-run)' : ''}`);
  await context.close();
}
