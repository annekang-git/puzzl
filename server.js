const express = require('express');
const axios = require('axios');
const open = require('open');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

// ============ 설정 ============
const CONFIG = {
  mall_id: 'revintique',
  client_id: 'iwbFTe0UPideWxknm6FsrB',
  client_secret: 'qw1JPh0gB5Knn8ESDGkr5B',
  redirect_uri: 'https://unfathomable-distractedly-lilliana.ngrok-free.dev/oauth/cafe24/callback',
  state: 'anneTest01',
  scope: 'mall.read_product,mall.write_product,mall.read_collection,mall.write_collection',
  api_version: '2025-12-01'
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
