/**
 * smartstore-sync.js
 * 스마트스토어 동기화 오케스트레이터
 * 
 * 실행 순서:
 *   1. 스마트스토어 토큰 갱신
 *   2. 스마트스토어 전체 상품 조회
 *   3. 스마트스토어 상품 상세 조회
 *   4. Cafe24 ↔ 스마트스토어 상품 비교
 *   5. 업로드 대상 상품 생성
 * 
 * 사용법:
 *   node smartstore-sync.js
 */

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function log(message) {
  const timestamp = new Date().toLocaleString('ko-KR');
  console.log(`[${timestamp}] ${message}`);
}

function logPhase(phase, title) {
  console.log('\n' + '='.repeat(80));
  console.log(`${phase} ${title}`);
  console.log('='.repeat(80));
}

// 오늘 날짜 가져오기 (YYYY-MM-DD)
function getTodayDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Cafe24 상품 파일 찾기 (오늘 날짜)
async function findCafe24ProductsFile() {
  const today = getTodayDate();
  const syncDataDir = path.join(__dirname, '../grifo-crawler/sync/sync-data');
  const expectedFile = path.join(syncDataDir, `cafe24_products_${today}.json`);
  
  try {
    await fs.access(expectedFile);
    log(`✅ Cafe24 상품 파일 발견: cafe24_products_${today}.json`);
    return expectedFile;
  } catch (error) {
    log(`⚠️  오늘 날짜 Cafe24 상품 파일 없음: cafe24_products_${today}.json`);
    
    // 가장 최근 파일 찾기
    const files = await fs.readdir(syncDataDir);
    const cafe24Files = files
      .filter(f => f.startsWith('cafe24_products_') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    if (cafe24Files.length > 0) {
      const latestFile = path.join(syncDataDir, cafe24Files[0]);
      log(`📁 최신 Cafe24 상품 파일 사용: ${cafe24Files[0]}`);
      return latestFile;
    }
    
    throw new Error('Cafe24 상품 파일을 찾을 수 없습니다.');
  }
}

// Node 스크립트 실행
function runScript(scriptName, description) {
  log(`${description} 시작...`);
  try {
    execSync(`node ${scriptName}`, {
      cwd: __dirname,
      stdio: 'inherit'
    });
    log(`✅ ${description} 완료`);
    return true;
  } catch (error) {
    console.error(`❌ ${description} 실패:`, error.message);
    throw error;
  }
}

async function runSmartStoreSync() {
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(80));
  console.log('🏪 스마트스토어 동기화 시작');
  console.log('='.repeat(80));
  log('시작 시간: ' + new Date().toLocaleString('ko-KR'));
  
  try {
    // Phase 1: 토큰 갱신 (token.json 에 저장됨)
    //   ⚠️ refresh-token.js 는 콘솔 출력만 하고 파일에 저장하지 않으므로
    //      반드시 get-token.js 를 사용해야 함 (이후 단계가 token.json 을 읽음)
    logPhase('🔑 PHASE 1', '스마트스토어 토큰 갱신');
    runScript('get-token.js', '토큰 발급 + token.json 저장');
    
    // Phase 2: 스마트스토어 상품 조회
    logPhase('📦 PHASE 2', '스마트스토어 상품 조회');
    runScript('get-products.js', '전체 상품 리스트 조회');
    
    log('상품 상세 정보 조회 중...');
    runScript('get-product-details.js', '상품 상세 정보 조회');
    
    // Phase 3: Cafe24 상품 파일 확인
    logPhase('🔍 PHASE 3', 'Cafe24 상품 파일 확인');
    const cafe24File = await findCafe24ProductsFile();
    log(`사용할 Cafe24 파일: ${path.basename(cafe24File)}`);
    
    // Phase 4: 상품 비교
    logPhase('⚖️  PHASE 4', 'Cafe24 ↔ 스마트스토어 상품 비교');
    runScript('compare-products.js', '상품 비교 분석');
    
    // Phase 5: 업로드 대상 생성
    logPhase('📋 PHASE 5', '업로드 대상 상품 생성');
    runScript('generate-upload-targets.js', '업로드 대상 생성');
    
    const totalMinutes = Math.round((Date.now() - startTime) / 1000 / 60);
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ 스마트스토어 동기화 완료!');
    console.log('='.repeat(80));
    log(`종료 시간: ${new Date().toLocaleString('ko-KR')}`);
    log(`총 소요 시간: ${totalMinutes}분`);
    
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ 스마트스토어 동기화 실패');
    console.error('='.repeat(80));
    console.error('에러:', error);
    process.exit(1);
  }
}

runSmartStoreSync();
