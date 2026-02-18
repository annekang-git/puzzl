# Cafe24 OAuth 인증 가이드

## 설정 정보

| 항목 | 값 |
|------|-----|
| Mall ID | `revintique` |
| Client ID | `iwbFTe0UPideWxknm6FsrB` |
| Client Secret | `qw1JPh0gB5Knn8ESDGkr5B` |
| Redirect URI | `https://unfathomable-distractedly-lilliana.ngrok-free.dev/oauth/cafe24/callback` |
| Scope | `mall.read_product,mall.write_product` |

---

## 방법 1: Postman Collection 사용

1. `Cafe24_OAuth_Collection.postman_collection.json` 파일을 Postman에서 Import
2. **1. Authorization URL** 요청의 URL을 복사해서 브라우저에서 열기
3. 로그인 후 권한 승인
4. 리다이렉트된 URL에서 `code` 파라미터 복사
5. Collection Variables에서 `authorization_code` 값 설정
6. **2. Get Access Token** 요청 실행
7. 토큰이 자동으로 변수에 저장됨
8. **4. Get Products Count** 등 API 테스트

---

## 방법 2: Node.js 서버 사용

### 설치 및 실행

```bash
cd cafe24-oauth
npm install
npm start
```

### 사용법

1. 브라우저에서 `http://localhost:3000` 접속
2. "OAuth 인증 시작" 클릭
3. Cafe24 로그인 및 권한 승인
4. 토큰이 자동으로 `tokens.json`에 저장됨
5. API 테스트 링크 클릭

---

## 방법 3: curl 수동 실행

### Step 1: Authorization Code 받기

브라우저에서 아래 URL 접속:

```
https://revintique.cafe24api.com/api/v2/oauth/authorize?response_type=code&client_id=iwbFTe0UPideWxknm6FsrB&state=anneTest01&redirect_uri=https://unfathomable-distractedly-lilliana.ngrok-free.dev/oauth/cafe24/callback&scope=mall.read_product,mall.write_product
```

### Step 2: Access Token 발급

```bash
curl -X POST \
  'https://revintique.cafe24api.com/api/v2/oauth/token' \
  -H 'Authorization: Basic aXdiRlRlMFVQaWRlV3hrbm02RnNyQjpxdzFKUGgwZ0I1S25uOEVTREdrcjVC' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code={받은_CODE}&redirect_uri=https://unfathomable-distractedly-lilliana.ngrok-free.dev/oauth/cafe24/callback'
```

### Step 3: 상품 개수 조회

```bash
curl -X GET \
  'https://revintique.cafe24api.com/api/v2/admin/products/count' \
  -H 'Authorization: Bearer {ACCESS_TOKEN}' \
  -H 'Content-Type: application/json' \
  -H 'X-Cafe24-Api-Version: 2025-12-01'
```

### Step 4: 토큰 갱신 (만료 시)

```bash
curl -X POST \
  'https://revintique.cafe24api.com/api/v2/oauth/token' \
  -H 'Authorization: Basic aXdiRlRlMFVQaWRlV3hrbm02RnNyQjpxdzFKUGgwZ0I1S25uOEVTREdrcjVC' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=refresh_token&refresh_token={REFRESH_TOKEN}'
```

---

## 토큰 정보

| 필드 | 설명 |
|------|------|
| `access_token` | API 호출에 사용 (2시간 유효) |
| `refresh_token` | 토큰 갱신에 사용 (2주 유효) |
| `expires_at` | Access Token 만료 시간 |
| `refresh_token_expires_at` | Refresh Token 만료 시간 |

---

## Base64 인코딩 참고

`client_id:client_secret` → Base64:
```
iwbFTe0UPideWxknm6FsrB:qw1JPh0gB5Knn8ESDGkr5B
→ aXdiRlRlMFVQaWRlV3hrbm02RnNyQjpxdzFKUGgwZ0I1S25uOEVTREdrcjVC
```
