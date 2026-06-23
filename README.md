# Cafe24 OAuth 인증 가이드

## 설정 정보

자격증명은 코드/문서에 절대 하드코딩하지 않습니다. **환경변수로 주입**:

| 환경변수 | 설명 | 예시 |
|---|---|---|
| `CAFE24_MALL_ID` | Mall ID | (Cafe24 콘솔에서 확인) |
| `CAFE24_CLIENT_ID` | App Client ID | (앱 발급 시 받음) |
| `CAFE24_CLIENT_SECRET` | App Client Secret | (앱 발급 시 받음 — 노출 절대 금지) |
| `CAFE24_REDIRECT_URI` | OAuth callback URI | `https://puzzl.kr/api/cafe24/oauth/callback` |
| Scope | (코드에 고정) | `mall.read_product,mall.write_product,mall.read_collection,mall.write_collection` |

### 로컬 개발 (.env)

```env
CAFE24_MALL_ID=...
CAFE24_CLIENT_ID=...
CAFE24_CLIENT_SECRET=...
CAFE24_REDIRECT_URI=https://localhost:3001/oauth/cafe24/callback
```

### Render 배포

Render dashboard → Environment Variables 탭에 위 키 4개 등록.

---

## OAuth 인증 흐름

### 1. Authorization URL 접속

브라우저에서 아래 형식 URL 접속:
```
https://{MALL_ID}.cafe24api.com/api/v2/oauth/authorize
  ?response_type=code
  &client_id={CLIENT_ID}
  &state=anneTest01
  &redirect_uri={REDIRECT_URI}
  &scope=mall.read_product,mall.write_product
```

### 2. Access Token 발급

```bash
BASIC_AUTH=$(echo -n "${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}" | base64)

curl -X POST \
  "https://${CAFE24_MALL_ID}.cafe24api.com/api/v2/oauth/token" \
  -H "Authorization: Basic ${BASIC_AUTH}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&code={받은_CODE}&redirect_uri=${CAFE24_REDIRECT_URI}"
```

### 3. 상품 개수 조회 (예시)

```bash
curl -X GET \
  "https://${CAFE24_MALL_ID}.cafe24api.com/api/v2/admin/products/count" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'X-Cafe24-Api-Version: 2026-03-01'
```

### 4. 토큰 갱신 (Access Token 만료 시)

```bash
curl -X POST \
  "https://${CAFE24_MALL_ID}.cafe24api.com/api/v2/oauth/token" \
  -H "Authorization: Basic ${BASIC_AUTH}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}"
```

---

## Node.js 서버로 실행

```bash
cd cafe24-oauth
npm install
# .env 에 CAFE24_* 환경변수 채운 뒤
npm start
# http://localhost:3001 접속 → "OAuth 인증 시작" 클릭
```

토큰은 자동으로 `tokens.json` 에 저장됨 (gitignored).

---

## 토큰 정보

| 필드 | 설명 |
|---|---|
| `access_token` | API 호출에 사용 (2시간 유효) |
| `refresh_token` | 토큰 갱신에 사용 (2주 유효) |
| `expires_at` | Access Token 만료 시간 |
| `refresh_token_expires_at` | Refresh Token 만료 시간 |

자동 갱신 cron: `grifo-crawler/sync/refresh-cafe24-token.js` (매일 02:30 KST).

---

## ⚠️ 보안 주의

- ❌ `client_secret`, `tokens.json`, 비밀번호를 **코드/README/commit 에 절대 포함 금지**
- ✅ 모든 비밀값은 `.env` 또는 클라우드 환경변수
- ✅ `.gitignore` 가 자동으로 `.env`, `tokens.json`, 토큰류 차단
- ✅ Public repo 이므로 더욱 주의 (`gitleaks` pre-commit hook 권장)
