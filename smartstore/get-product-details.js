/**
 * get-product-details.js
 * 네이버 스마트스토어 전체 상품 상세 정보 조회 스크립트
 */

import axios from 'axios';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SMARTSTORE_CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 토큰 우선순위: env > token.json > config.js (config 는 만료 fallback)
function resolveAccessToken() {
  if (process.env.SMARTSTORE_ACCESS_TOKEN) return process.env.SMARTSTORE_ACCESS_TOKEN;
  try {
    const tokenFile = path.join(__dirname, 'token.json');
    if (fsSync.existsSync(tokenFile)) {
      const t = JSON.parse(fsSync.readFileSync(tokenFile, 'utf-8'));
      if (t.access_token) return t.access_token;
    }
  } catch (_) {}
  return SMARTSTORE_CONFIG.accessToken;
}
const ACCESS_TOKEN = resolveAccessToken();

/**
 * 상품 상세 조회 API 호출
 * @param {number} originProductNo - 원상품번호
 */
async function getProductDetail(originProductNo) {
  try {
    const response = await axios.get(
      `${SMARTSTORE_CONFIG.baseUrl}/v2/products/origin-products/${originProductNo}`,
      {
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`
        }
      }
    );
    return { success: true, data: response.data };
  } catch (error) {
    const errorData = error.response?.data || { message: error.message };
    return { success: false, error: errorData, originProductNo };
  }
}

/**
 * 딜레이 함수
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 전체 상품 상세 조회
 */
async function getAllProductDetails() {
  // 기존 상품 목록 로드
  const today = new Date().toISOString().slice(0, 10);
  const listFile = `smartstore_products_${today}.json`;
  
  let productList;
  try {
    const data = await fs.readFile(listFile, 'utf-8');
    productList = JSON.parse(data);
  } catch (error) {
    console.log(`❌ 상품 목록 파일을 찾을 수 없습니다: ${listFile}`);
    console.log('   먼저 node get-products.js 를 실행하세요.');
    return [];
  }

  console.log(`📦 ${productList.length.toLocaleString()}개 상품 상세 정보 조회 시작...\n`);

  const allDetails = [];
  const errors = [];
  let retryCount = 0;
  const maxRetries = 5;

  for (let i = 0; i < productList.length; i++) {
    const product = productList[i];
    const originProductNo = product.originProductNo;
    
    // 진행률 표시 (100개마다)
    if ((i + 1) % 100 === 0 || i === 0) {
      const percent = ((i + 1) / productList.length * 100).toFixed(1);
      console.log(`📄 ${i + 1}/${productList.length} (${percent}%) - 상품번호: ${originProductNo}`);
    }

    const result = await getProductDetail(originProductNo);

    if (!result.success) {
      // Rate limit 오류 시 재시도
      if (result.error?.code === 'GW.RATE_LIMIT') {
        retryCount++;
        if (retryCount > maxRetries) {
          console.log('❌ 최대 재시도 횟수 초과');
          break;
        }
        const waitTime = 3000 * retryCount;
        console.log(`⏳ 속도 제한 - ${waitTime/1000}초 대기 후 재시도... (${retryCount}/${maxRetries})`);
        await delay(waitTime);
        i--; // 같은 상품 재시도
        continue;
      }
      errors.push({ originProductNo, error: result.error });
      continue;
    }

    retryCount = 0;
    allDetails.push(result.data);

    // Rate limit 방지 (500ms 딜레이)
    await delay(500);
  }

  if (errors.length > 0) {
    console.log(`\n⚠️ ${errors.length}개 상품 조회 실패`);
  }

  return allDetails;
}

/**
 * 메인 함수
 */
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('📦 네이버 스마트스토어 전체 상품 상세 조회');
  console.log('='.repeat(60) + '\n');

  const startTime = Date.now();
  const products = await getAllProductDetails();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (products.length === 0) {
    console.log('\n⚠️ 조회된 상품이 없습니다.');
    return;
  }

  console.log(`\n✅ 총 ${products.length.toLocaleString()}개 상품 상세 조회 완료! (소요시간: ${elapsed}초)`);

  // 상품 요약 출력 (처음 5개)
  console.log('\n📋 상품 상세 정보 (처음 5개):');
  console.log('-'.repeat(80));
  products.slice(0, 5).forEach((product, i) => {
    const origin = product.originProduct || {};
    const name = origin.name || 'N/A';
    const salePrice = origin.salePrice || 0;
    const retailPrice = origin.retailPrice || salePrice;
    const stockQty = origin.stockQuantity || 0;
    console.log(`${i + 1}. ${name}`);
    console.log(`   정가: ${retailPrice.toLocaleString()}원 → 판매가: ${salePrice.toLocaleString()}원`);
    console.log(`   재고: ${stockQty}개`);
  });

  // JSON 파일로 저장
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `smartstore_products_detail_${timestamp}.json`;
  await fs.writeFile(filename, JSON.stringify(products, null, 2));
  console.log(`\n📁 파일 저장: ${filename}`);
  console.log(`   파일 크기: ${(JSON.stringify(products).length / 1024 / 1024).toFixed(2)} MB`);

  console.log('\n' + '='.repeat(60));
}

// 실행
main();
