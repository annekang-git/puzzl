# PUZZL Kids Products API

**버전**: 1.0
**최종 업데이트**: 2026-04-17
**담당**: PUZZL (puzzl.kr)

PUZZL이 큐레이션한 프리미엄 럭셔리 키즈웨어 상품 정보를 조회할 수 있는 REST API입니다.

---

## 1. 기본 정보

| 항목 | 값 |
|------|-----|
| **Base URL** | `https://puzzl-kids-api.onrender.com` |
| **Protocol** | HTTPS (TLS 1.2 이상) |
| **Response** | JSON (UTF-8) |
| **Method** | GET |
| **Rate Limit** | 현재 미적용 (과도한 요청 감지 시 차단될 수 있음) |

### 데이터 갱신 주기
- **매일 오전 07:13 KST** — 최신 상품 마스터 데이터 반영
- 데이터의 기준일은 응답 바디의 `dataDate` 필드로 확인 가능

---

## 2. 인증 (Authentication)

모든 요청은 HTTP 헤더 `x-api-key` 로 인증합니다.

```
x-api-key: {발급받은 API 키}
```

> API 키는 담당자를 통해 별도로 전달됩니다.
> 키 유출 시 즉시 담당자에게 연락하여 재발급 받아주세요.

### 인증 실패 응답 (HTTP 401)
```json
{
  "error": "Invalid or missing API key. Set x-api-key header."
}
```

---

## 3. 엔드포인트 목록

| # | Method | Path | 설명 |
|---|--------|------|------|
| 1 | GET | `/api/dresscode/kids/count` | 키즈 상품 총 개수 조회 |
| 2 | GET | `/api/dresscode/kids` | 키즈 상품 목록 조회 (필터 지원) |
| 3 | GET | `/api/dresscode/kids/image/:sku/:idx` | 상품 이미지 프록시 (인증 불필요) |

---

## 4. 엔드포인트 상세

### 4-1. 상품 개수 조회

```
GET /api/dresscode/kids/count
```

현재 제공 중인 키즈 상품의 총 개수와 데이터 기준일을 반환합니다.
전체 목록을 받기 전 헬스체크 용도로 활용하세요.

#### Request 예시
```bash
curl -H "x-api-key: {API_KEY}" \
  https://puzzl-kids-api.onrender.com/api/dresscode/kids/count
```

#### Response 200 OK
```json
{
  "total": 377,
  "dataDate": "2026-04-16"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `total` | number | 현재 제공 중인 키즈 상품 개수 |
| `dataDate` | string (YYYY-MM-DD) | 상품 마스터 데이터 기준일 |

---

### 4-2. 상품 목록 조회

```
GET /api/dresscode/kids
```

키즈 상품 전체 목록을 반환합니다. 쿼리 파라미터로 필터링 가능합니다.
필터 조건을 지정하지 않으면 전체 상품(약 370~400개)이 반환됩니다.

#### 쿼리 파라미터 (모두 선택)

| 파라미터 | 타입 | 설명 | 예시 |
|---------|------|------|------|
| `brand` | string | 브랜드명 부분 일치 (대소문자 무시) | `moncler`, `moschino` |
| `genre` | string | 장르 정확 일치 | `Baby boy`, `Baby girl`, `Unisex baby` |
| `sku` | string | SKU 정확 일치 (단일 상품 조회) | `HDP05IN0Z83MEDIUMBLUE` |

> 복수의 파라미터를 동시에 사용하면 AND 조건으로 필터링됩니다.

#### Request 예시

```bash
# 전체 목록
curl -H "x-api-key: {API_KEY}" \
  "https://puzzl-kids-api.onrender.com/api/dresscode/kids"

# Moncler 브랜드만
curl -H "x-api-key: {API_KEY}" \
  "https://puzzl-kids-api.onrender.com/api/dresscode/kids?brand=moncler"

# Baby girl 장르만
curl -H "x-api-key: {API_KEY}" \
  "https://puzzl-kids-api.onrender.com/api/dresscode/kids?genre=Baby%20girl"

# SKU 단일 조회
curl -H "x-api-key: {API_KEY}" \
  "https://puzzl-kids-api.onrender.com/api/dresscode/kids?sku=HDP05IN0Z83MEDIUMBLUE"

# 복합 필터 (Moncler + Baby boy)
curl -H "x-api-key: {API_KEY}" \
  "https://puzzl-kids-api.onrender.com/api/dresscode/kids?brand=moncler&genre=Baby%20boy"
```

#### Response 200 OK

```json
{
  "total": 1,
  "dataDate": "2026-04-16",
  "products": [
    {
      "productID": "259028",
      "clientProductID": "285807307",
      "spu": "HDP05IN0Z83",
      "sku": "HDP05IN0Z83MEDIUMBLUE",
      "brand": "MOSCHINO KID TEEN",
      "name": "Button detail jeans",
      "description": "KIDS\r\nStretch cotton denim jeans with zip closure...",
      "genre": "Baby girl",
      "type": "Clothing",
      "category": "Jeans",
      "season": "Fall Winter 2023/2024",
      "isCarryOver": false,
      "color": "Blue",
      "composition": "98% cotton, 2% elastane",
      "madeIn": "China",
      "sizeAndFit": "true to size fit",
      "productLastUpdated": "2026-04-16T11:01:52.1180571Z",
      "sizeType": "KID MONTH AGE",
      "weight": 1,
      "price": 112400,
      "currency": "KRW",
      "sizes": [
        {
          "size": "10",
          "stock": 1,
          "gtin": "001907021172",
          "price": 118600,
          "currency": "KRW"
        }
      ],
      "photos": [
        "https://puzzl-kids-api.onrender.com/api/dresscode/kids/image/HDP05IN0Z83MEDIUMBLUE/0",
        "https://puzzl-kids-api.onrender.com/api/dresscode/kids/image/HDP05IN0Z83MEDIUMBLUE/1",
        "https://puzzl-kids-api.onrender.com/api/dresscode/kids/image/HDP05IN0Z83MEDIUMBLUE/2"
      ]
    }
  ]
}
```

---

### 4-3. 상품 이미지 프록시

```
GET /api/dresscode/kids/image/:sku/:idx
```

상품 이미지를 프록시로 제공합니다.
**API 키가 필요하지 않으므로** 브라우저의 `<img src="...">` 태그나 일반 HTTP 클라이언트로 바로 사용할 수 있습니다.

#### Path 파라미터

| 파라미터 | 타입 | 설명 | 예시 |
|---------|------|------|------|
| `sku` | string | 상품 SKU (URL 인코딩 필요할 수 있음) | `HDP05IN0Z83MEDIUMBLUE` |
| `idx` | number (0 이상) | 이미지 인덱스 (`photos` 배열 내 위치) | `0` = 메인 이미지 |

#### Request 예시
```bash
# 메인 이미지 다운로드
curl -o main.jpg \
  "https://puzzl-kids-api.onrender.com/api/dresscode/kids/image/HDP05IN0Z83MEDIUMBLUE/0"
```

```html
<!-- HTML에서 직접 사용 -->
<img src="https://puzzl-kids-api.onrender.com/api/dresscode/kids/image/HDP05IN0Z83MEDIUMBLUE/0"
     alt="Main product image" />
```

#### Response
- **200 OK** — 이미지 스트림 반환
  - `Content-Type: image/jpeg`
  - `Cache-Control: public, max-age=86400, immutable`
- **400 Bad Request** — 잘못된 인덱스 형식
- **404 Not Found** — 존재하지 않는 SKU 또는 인덱스
- **502 Bad Gateway** — 원본 이미지 서버에서 오류 발생 (일시적)

---

## 5. 데이터 스키마

### 5-1. 최상위 응답 객체

| 필드 | 타입 | 설명 |
|------|------|------|
| `total` | number | 필터 적용 후 상품 개수 |
| `dataDate` | string | 데이터 기준일 (YYYY-MM-DD) |
| `products` | array\<Product\> | 상품 배열 |

### 5-2. Product 객체

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `productID` | string | ✅ | 원본 공급사 상품 ID (내부 식별자) |
| `clientProductID` | string | ✅ | 클라이언트(PUZZL) 측 상품 ID |
| `spu` | string | ✅ | SPU 코드 — 동일 모델의 색상/패턴 그룹 식별자 |
| `sku` | string | ✅ | SKU 코드 — 색상까지 포함한 고유 식별자 (단일 조회용 키) |
| `brand` | string | ✅ | 브랜드명 (원문 대문자) |
| `name` | string | ✅ | 상품명 (영문) |
| `description` | string | ✅ | 상품 설명 (영문, 개행문자 포함 가능) |
| `genre` | string | ✅ | 장르 — `Baby boy`, `Baby girl`, `Unisex baby` 중 하나 |
| `type` | string | ✅ | 상품 타입 — `Clothing`, `Shoes`, `Accessories` 등 |
| `category` | string | ✅ | 상세 카테고리 — `Jeans`, `T-Shirts`, `Sneakers` 등 |
| `season` | string | ⚪ | 시즌 (예: `Fall Winter 2023/2024`) |
| `isCarryOver` | boolean | ⚪ | 이월 상품 여부 |
| `color` | string | ⚪ | 색상 (영문) |
| `composition` | string | ⚪ | 소재 구성 (예: `98% cotton, 2% elastane`) |
| `madeIn` | string | ⚪ | 원산지 (예: `Italy`, `China`) |
| `sizeAndFit` | string | ⚪ | 사이즈/핏 가이드 (예: `true to size fit`) |
| `productLastUpdated` | string (ISO 8601) | ✅ | 상품 정보 최종 수정 시각 (UTC) |
| `sizeType` | string | ⚪ | 사이즈 체계 (예: `KID MONTH AGE`, `KID YEAR`) |
| `weight` | number | ⚪ | 무게 (kg) |
| `price` | number | ✅ | 상품 대표 판매가 (원) — 최저 사이즈 가격 기준 |
| `currency` | string | ✅ | 통화 코드 — 항상 `"KRW"` |
| `sizes` | array\<Size\> | ✅ | 사이즈별 재고 및 가격 |
| `photos` | array\<string\> | ✅ | 상품 이미지 URL 배열 (PUZZL 프록시 URL, 고해상도 JPG). 상품당 2~5장. 배열 순서가 곧 표시 순서(첫 번째 = 메인 이미지). `<img src="...">` 또는 별도 다운로드로 바로 사용 가능 (API 키 불필요) |

### 5-3. Size 객체

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `size` | string | ✅ | 사이즈 표기 (예: `10`, `12 Months`, `EU 30`) |
| `stock` | number | ✅ | 현재 재고 수량 (0이면 품절) |
| `gtin` | string | ⚪ | GTIN/EAN 바코드 (13자리) |
| `price` | number | ✅ | 해당 사이즈 판매가 (원) |
| `currency` | string | ✅ | 통화 코드 — 항상 `"KRW"` |

> ⚠️ **중요**: 사이즈마다 가격이 다를 수 있습니다. 결제 시 반드시 `sizes[].price`를 사용하세요.

---

## 6. 가격 정책

모든 가격은 **대한민국 원화(KRW)** 로 제공됩니다. 부가세/관세/운송료 관련 사항은 PUZZL 담당자와 별도 협의합니다.

- 가격 변동이 있을 경우 매일 데이터 갱신 시점에 자동 반영됩니다.
- 판매가는 공급가 + 마진 + 환율 + 원산지별 요율 등이 반영된 **최종 소비자 판매가(권장)** 입니다.
- 재고는 `sizes[].stock` 필드로 확인하며, **실시간 반영이 아닌 일 단위 스냅샷**입니다.

---

## 7. HTTP 상태 코드

| 코드 | 의미 | 대응 방법 |
|------|------|----------|
| **200** | 정상 응답 | — |
| **401** | API 키 누락/무효 | 헤더 확인, 키 재발급 |
| **404** | 잘못된 경로 | URL 오타 확인 |
| **500** | 서버 내부 오류 | 잠시 후 재시도. 지속되면 담당자 연락 |

---

## 8. 운영 관련 참고사항

### Cold Start
서버가 15분 이상 요청이 없으면 일시 중지될 수 있습니다. 이 경우 **첫 요청은 30초~1분 지연**될 수 있으니 타임아웃을 넉넉히 설정하세요 (권장: **60초 이상**).

### 권장 사용 패턴
1. **전체 동기화** — 하루 1회, 아침 08:00 이후 `GET /api/dresscode/kids` 호출로 전체 목록 캐싱
2. **변경 감지** — `productLastUpdated` 필드로 마지막 동기화 이후 변경된 상품 식별
3. **단일 조회** — 특정 상품 상세 필요 시 `?sku={SKU}` 사용

### 이미지 CDN
`photos` 배열의 URL은 PUZZL의 이미지 프록시 엔드포인트입니다.
- **API 키 불필요** — `<img src="...">` 태그에서 바로 사용 가능
- **Cache-Control 24시간** — 브라우저/CDN 레벨에서 자동 캐싱
- 반복 요청은 지양하고, 안정적인 서비스를 위해 **귀사 CDN 또는 스토리지에 미러링하여 사용하시는 것을 권장**합니다.
- URL 포맷: `https://puzzl-kids-api.onrender.com/api/dresscode/kids/image/{SKU}/{INDEX}`

---

## 9. 문의 및 지원

| 구분 | 연락처 |
|------|--------|
| **기술 문의** | *(담당자 이메일)* |
| **API 키 발급/갱신** | *(담당자 이메일)* |
| **장애 신고** | *(담당자 이메일)* |

### 변경 이력
| 버전 | 날짜 | 변경 내역 |
|------|------|----------|
| 1.0 | 2026-04-17 | 최초 공개 — `/kids`, `/kids/count` 엔드포인트 제공 |

---

© 2026 PUZZL. All product data provided via this API remains the intellectual property of the respective brands.
