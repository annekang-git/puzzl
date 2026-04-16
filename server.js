const express = require('express');
const axios = require('axios');
const open = require('open');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Render/Cloudflare 뒤에서 HTTPS가 정상적으로 인식되도록 신뢰
app.set('trust proxy', true);

// ============ 설정 ============
const CONFIG = {
  mall_id: 'revintique',
  client_id: 'C6tfSZmTX6ZP9LlZOdjn7D',
  client_secret: 'ZFqUoN0ODFXoSh2Q7MTcBA',
  redirect_uri: 'https://puzzl.kr/api/cafe24/oauth/callback',
  state: 'anneTest01',
  scope: 'mall.read_product,mall.write_product,mall.read_collection,mall.write_collection',
  api_version: '2026-03-01'
};

// Base64 인코딩
const basicAuth = Buffer.from(`${CONFIG.client_id}:${CONFIG.client_secret}`).toString('base64');

// 토큰 저장 경로
const TOKEN_FILE = path.join(__dirname, 'tokens.json');

// ============ 유틸리티 함수 ============

// 토큰 저장
function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('✅ 토큰이 tokens.json에 저장되었습니다.');
}

// 토큰 로드
function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  }
  return null;
}

// ============ OAuth 엔드포인트 ============

// 1. 인증 시작 - 브라우저에서 Cafe24 로그인 페이지로 리다이렉트
app.get('/auth/start', (req, res) => {
  const authUrl = `https://${CONFIG.mall_id}.cafe24api.com/api/v2/oauth/authorize?` +
    `response_type=code&` +
    `client_id=${CONFIG.client_id}&` +
    `state=${CONFIG.state}&` +
    `redirect_uri=${encodeURIComponent(CONFIG.redirect_uri)}&` +
    `scope=${encodeURIComponent(CONFIG.scope)}`;
  
  console.log('\n🔗 Authorization URL:');
  console.log(authUrl);
  console.log('\n브라우저에서 위 URL을 열어 인증을 진행하세요.\n');
  
  res.redirect(authUrl);
});

// 2. OAuth 콜백 - Authorization Code를 받아 Access Token으로 교환
app.get('/oauth/cafe24/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.status(400).send('Authorization code가 없습니다.');
  }
  
  console.log('\n📥 Authorization Code 수신:', code);
  console.log('📥 State:', state);
  
  try {
    // Access Token 요청
    const response = await axios.post(
      `https://${CONFIG.mall_id}.cafe24api.com/api/v2/oauth/token`,
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(CONFIG.redirect_uri)}`,
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const tokens = response.data;
    saveTokens(tokens);
    
    console.log('\n✅ Access Token 발급 성공!');
    console.log('─'.repeat(50));
    console.log('Access Token:', tokens.access_token);
    console.log('Refresh Token:', tokens.refresh_token);
    console.log('만료 시간:', tokens.expires_at);
    console.log('Scopes:', tokens.scopes.join(', '));
    console.log('─'.repeat(50));
    
    res.send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Cafe24 OAuth 성공</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; background: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #2ecc71; }
            pre { background: #f8f9fa; padding: 15px; border-radius: 5px; overflow-x: auto; font-size: 12px; }
            .token { word-break: break-all; }
            a { color: #3498db; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ OAuth 인증 성공!</h1>
            <h3>Access Token:</h3>
            <pre class="token">${tokens.access_token}</pre>
            <h3>Refresh Token:</h3>
            <pre class="token">${tokens.refresh_token}</pre>
            <h3>만료 시간:</h3>
            <pre>${tokens.expires_at}</pre>
            <h3>Scopes:</h3>
            <pre>${tokens.scopes.join(', ')}</pre>
            <hr>
            <p>토큰이 <code>tokens.json</code> 파일에 저장되었습니다.</p>
            <p><a href="/api/products/count">상품 개수 조회 테스트 →</a></p>
          </div>
        </body>
      </html>
    `);
    
  } catch (error) {
    console.error('❌ 토큰 발급 실패:', error.response?.data || error.message);
    res.status(500).send(`
      <html>
        <head><meta charset="UTF-8"><title>오류</title></head>
        <body>
          <h1>❌ 토큰 발급 실패</h1>
          <pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>
        </body>
      </html>
    `);
  }
});

// 3. 토큰 갱신
app.get('/auth/refresh', async (req, res) => {
  const tokens = loadTokens();
  
  if (!tokens?.refresh_token) {
    return res.status(400).json({ error: 'Refresh token이 없습니다. 먼저 /auth/start로 인증하세요.' });
  }
  
  try {
    const response = await axios.post(
      `https://${CONFIG.mall_id}.cafe24api.com/api/v2/oauth/token`,
      `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`,
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const newTokens = response.data;
    saveTokens(newTokens);
    
    console.log('\n✅ 토큰 갱신 성공!');
    res.json(newTokens);
    
  } catch (error) {
    console.error('❌ 토큰 갱신 실패:', error.response?.data || error.message);
    res.status(500).json(error.response?.data || { error: error.message });
  }
});

// ============ Dresscode 키즈 상품 API ============

const DRESSCODE_API_KEY = process.env.DRESSCODE_API_KEY || 'puzzl-kids-2026';
const KIDS_DATA_PATH = path.join(__dirname, 'data', 'dresscode-kids.json');

// 캐시 (10분 TTL)
let kidsCache = { data: null, loadedAt: 0, dataDate: '' };
const CACHE_TTL = 10 * 60 * 1000;

function loadKidsProducts() {
  const now = Date.now();
  if (kidsCache.data && (now - kidsCache.loadedAt) < CACHE_TTL) {
    return kidsCache;
  }

  if (!fs.existsSync(KIDS_DATA_PATH)) {
    throw new Error('키즈 상품 데이터 파일이 없습니다: ' + KIDS_DATA_PATH);
  }

  const raw = JSON.parse(fs.readFileSync(KIDS_DATA_PATH, 'utf-8'));
  kidsCache = { data: raw.products || [], loadedAt: now, dataDate: raw.dataDate || '' };
  return kidsCache;
}

// API 키 인증 미들웨어
function requireDresscodeApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== DRESSCODE_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key. Set x-api-key header.' });
  }
  next();
}

// 공개 베이스 URL (프록시 이미지 URL 생성용)
function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  return `${proto}://${host}`;
}

// 상품 응답에서 photos 배열을 프록시 URL로 교체
function withProxiedPhotos(product, baseUrl) {
  const skuEncoded = encodeURIComponent(product.sku);
  const photoCount = (product.photos || []).length;
  const proxied = Array.from({ length: photoCount }, (_, idx) =>
    `${baseUrl}/api/dresscode/kids/image/${skuEncoded}/${idx}`
  );
  return { ...product, photos: proxied };
}

// 키즈 상품 이미지 프록시 (API 키 없이 접근 가능 - img 태그 호환)
app.get('/api/dresscode/kids/image/:sku/:idx', async (req, res) => {
  try {
    const { sku, idx } = req.params;
    const idxNum = parseInt(idx, 10);
    if (Number.isNaN(idxNum) || idxNum < 0) {
      return res.status(400).json({ error: 'Invalid image index' });
    }

    const { data } = loadKidsProducts();
    const product = data.find(p => p.sku === sku);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const imageUrl = (product.photos || [])[idxNum];
    if (!imageUrl) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const upstream = await axios.get(imageUrl, {
      responseType: 'stream',
      timeout: 15000
    });

    res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
    if (upstream.headers['content-length']) {
      res.set('Content-Length', upstream.headers['content-length']);
    }
    // 브라우저/CDN 에서 하루 캐싱
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    upstream.data.pipe(res);

    upstream.data.on('error', (err) => {
      console.error('이미지 스트리밍 오류:', err.message);
      if (!res.headersSent) res.status(502).end();
    });
  } catch (err) {
    const status = err.response?.status || 500;
    console.error(`❌ 이미지 프록시 실패 [${req.params.sku}/${req.params.idx}]: ${err.message}`);
    res.status(status === 404 ? 404 : 502).json({ error: 'Failed to fetch image' });
  }
});

// 키즈 상품 목록
app.get('/api/dresscode/kids', requireDresscodeApiKey, (req, res) => {
  try {
    const { data, dataDate } = loadKidsProducts();
    let products = data;

    // 브랜드 필터
    if (req.query.brand) {
      const brand = req.query.brand.toLowerCase();
      products = products.filter(p => (p.brand || '').toLowerCase().includes(brand));
    }

    // 장르 필터
    if (req.query.genre) {
      products = products.filter(p => p.genre === req.query.genre);
    }

    // SKU 필터
    if (req.query.sku) {
      products = products.filter(p => p.sku === req.query.sku);
    }

    const baseUrl = getPublicBaseUrl(req);
    const transformed = products.map(p => withProxiedPhotos(p, baseUrl));

    res.json({
      total: transformed.length,
      dataDate,
      products: transformed
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 키즈 상품 수
app.get('/api/dresscode/kids/count', requireDresscodeApiKey, (req, res) => {
  try {
    const { data, dataDate } = loadKidsProducts();
    res.json({ total: data.length, dataDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ API 엔드포인트 ============

// 상품 개수 조회
app.get('/api/products/count', async (req, res) => {
  const tokens = loadTokens();
  
  if (!tokens?.access_token) {
    return res.status(401).json({ error: 'Access token이 없습니다. 먼저 /auth/start로 인증하세요.' });
  }
  
  try {
    const response = await axios.get(
      `https://${CONFIG.mall_id}.cafe24api.com/api/v2/admin/products/count`,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': CONFIG.api_version
        }
      }
    );
    
    console.log('📦 상품 개수:', response.data);
    res.json(response.data);
    
  } catch (error) {
    console.error('❌ API 호출 실패:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
  }
});

// 상품 목록 조회
app.get('/api/products', async (req, res) => {
  const tokens = loadTokens();
  
  if (!tokens?.access_token) {
    return res.status(401).json({ error: 'Access token이 없습니다. 먼저 /auth/start로 인증하세요.' });
  }
  
  const limit = req.query.limit || 10;
  
  try {
    const response = await axios.get(
      `https://${CONFIG.mall_id}.cafe24api.com/api/v2/admin/products?limit=${limit}`,
      {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': CONFIG.api_version
        }
      }
    );
    
    console.log(`📦 상품 ${response.data.products?.length || 0}개 조회됨`);
    res.json(response.data);
    
  } catch (error) {
    console.error('❌ API 호출 실패:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
  }
});

// 현재 토큰 정보 조회
app.get('/api/tokens', (req, res) => {
  const tokens = loadTokens();
  if (tokens) {
    res.json(tokens);
  } else {
    res.status(404).json({ error: '저장된 토큰이 없습니다.' });
  }
});

// 홈 페이지
app.get('/', (req, res) => {
  const tokens = loadTokens();
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Cafe24 OAuth 테스트</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; background: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #333; }
          a { display: block; padding: 15px 20px; margin: 10px 0; background: #3498db; color: white; text-decoration: none; border-radius: 5px; }
          a:hover { background: #2980b9; }
          .status { padding: 10px; border-radius: 5px; margin: 20px 0; }
          .status.success { background: #d4edda; color: #155724; }
          .status.warning { background: #fff3cd; color: #856404; }
          pre { background: #f8f9fa; padding: 10px; border-radius: 5px; font-size: 11px; overflow-x: auto; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🛒 Cafe24 OAuth 테스트</h1>
          
          ${tokens ? `
            <div class="status success">
              ✅ 토큰이 저장되어 있습니다.<br>
              <small>만료: ${tokens.expires_at}</small>
            </div>
          ` : `
            <div class="status warning">
              ⚠️ 저장된 토큰이 없습니다. 인증을 시작하세요.
            </div>
          `}
          
          <h3>인증</h3>
          <a href="/auth/start">🔐 OAuth 인증 시작</a>
          <a href="/auth/refresh">🔄 토큰 갱신</a>
          
          <h3>API 테스트</h3>
          <a href="/api/products/count">📊 상품 개수 조회</a>
          <a href="/api/products">📦 상품 목록 조회</a>
          <a href="/api/tokens">🔑 현재 토큰 정보</a>
          
          <h3>설정 정보</h3>
          <pre>
Mall ID: ${CONFIG.mall_id}
Client ID: ${CONFIG.client_id}
Redirect URI: ${CONFIG.redirect_uri}
Scope: ${CONFIG.scope}
          </pre>
        </div>
      </body>
    </html>
  `);
});

// 서버 시작
app.listen(PORT, () => {
  console.log('═'.repeat(50));
  console.log('🚀 Cafe24 OAuth 서버가 시작되었습니다!');
  console.log('═'.repeat(50));
  console.log(`\n📍 로컬 서버: http://localhost:${PORT}`);
  console.log(`📍 인증 시작: http://localhost:${PORT}/auth/start`);
  console.log('\n⚠️  ngrok을 통해 외부 접근이 필요합니다:');
  console.log(`   ngrok http ${PORT}`);
  console.log('\n' + '─'.repeat(50));
});
