/**
 * get-products.js
 * 네이버 스마트스토어 전체 상품 리스트 조회 스크립트
 */

import axios from 'axios';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SMARTSTORE_CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 토큰 우선순위:
//   1) SMARTSTORE_ACCESS_TOKEN env var (호출자가 명시적으로 주입)
//   2) token.json (get-token.js 가 저장한 최신 토큰)
//   3) config.js 의 하드코딩 fallback (만료 가능)
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
 * 상품 리스트 조회 API 호출
 * @param {number} page - 페이지 번호 (1부터 시작)
 * @param {number} size - 페이지당 상품 수 (최대 500)
 */
async function searchProducts(page = 1, size = 500) {
  try {
    const response = await axios.post(
      `${SMARTSTORE_CONFIG.baseUrl}/v1/products/search`,
      {
        productStatusTypes: ['SALE'],
        page,
        size,
        orderType: 'NO'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ACCESS_TOKEN}`
        }
      }
    );
    return { success: true, data: response.data };
  } catch (error) {
    const errorData = error.response?.data || { message: error.message };
    return { success: false, error: errorData };
  }
}

/**
 * 딜레이 함수
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 전체 상품 조회 (페이지네이션 처리)
 */
async function getAllProducts() {
  const productMap = new Map(); // 중복 방지용
  let page = 1;  // 페이지 1부터 시작
  const size = 500;
  let totalElements = 0;
  let retryCount = 0;
  const maxRetries = 5;

  console.log('📦 스마트스토어 전체 상품 조회 시작...\n');

  while (true) {
    console.log(`📄 페이지 ${page} 조회 중...`);
    const result = await searchProducts(page, size);

    if (!result.success) {
      // Rate limit 오류 시 재시도
      if (result.error?.code === 'GW.RATE_LIMIT') {
        retryCount++;
        if (retryCount > maxRetries) {
          console.log('❌ 최대 재시도 횟수 초과');
          break;
        }
        const waitTime = 3000 * retryCount; // 점진적 대기
        console.log(`⏳ 속도 제한 - ${waitTime/1000}초 대기 후 재시도... (${retryCount}/${maxRetries})`);
        await delay(waitTime);
        continue;
      }
      console.log('❌ 조회 실패:', JSON.stringify(result.error, null, 2));
      break;
    }

    retryCount = 0; // 성공 시 재시도 카운트 리셋
    const products = result.data.contents || [];
    
    // 중복 제거하며 추가
    for (const product of products) {
      if (!productMap.has(product.originProductNo)) {
        productMap.set(product.originProductNo, product);
      }
    }

    // 전체 개수 확인
    totalElements = result.data.totalElements || 0;
    const totalPages = result.data.totalPages || 1;
    
    if (page === 1) {
      console.log(`📊 전체 상품 수: ${totalElements.toLocaleString()}개 (${totalPages}페이지)`);
    }

    console.log(`   - ${products.length}개 조회 (고유: ${productMap.size.toLocaleString()}개 / 전체: ${totalElements.toLocaleString()}개)`);

    // 다음 페이지 확인
    page++;
    
    if (page > totalPages) {
      console.log('\n✅ 모든 페이지 조회 완료!');
      break;
    }

    // Rate limit 방지를 위한 딜레이 (1초)
    await delay(1000);
  }

  return Array.from(productMap.values());
}

/**
 * 메인 함수
 */
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('📦 네이버 스마트스토어 전체 상품 조회');
  console.log('='.repeat(60) + '\n');

  const startTime = Date.now();
  const products = await getAllProducts();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (products.length === 0) {
    console.log('\n⚠️ 조회된 상품이 없습니다.');
    return;
  }

  console.log(`\n✅ 총 ${products.length.toLocaleString()}개 상품 조회 완료! (소요시간: ${elapsed}초)`);

  // 상품 요약 출력 (처음 10개만)
  console.log('\n📋 상품 목록 (처음 10개):');
  console.log('-'.repeat(80));
  products.slice(0, 10).forEach((product, i) => {
    const channelProduct = product.channelProducts?.[0] || {};
    const name = channelProduct.name || product.name || 'N/A';
    const price = channelProduct.salePrice || 0;
    const sku = channelProduct.sellerManagementCode || '';
    console.log(`${i + 1}. [${product.originProductNo}] ${name}`);
    console.log(`   SKU: ${sku} | 가격: ${price.toLocaleString()}원`);
  });
  if (products.length > 10) {
    console.log(`   ... 외 ${(products.length - 10).toLocaleString()}개`);
  }

  // JSON 파일로 저장
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `smartstore_products_${timestamp}.json`;
  await fs.writeFile(filename, JSON.stringify(products, null, 2));
  console.log(`\n📁 파일 저장: ${filename}`);
  console.log(`   파일 크기: ${(JSON.stringify(products).length / 1024 / 1024).toFixed(2)} MB`);

  console.log('\n' + '='.repeat(60));
}

// 실행
main();
