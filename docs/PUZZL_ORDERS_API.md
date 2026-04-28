# PUZZL Orders API (주문 웹훅 + 발주/배송 상태 조회)

**버전**: 1.1
**최종 업데이트**: 2026-04-28
**담당**: PUZZL (puzzl.kr)

뭉클에서 주문이 발생/취소될 때 PUZZL 측 재고 상태를 동기화하기 위한 웹훅 API입니다.
주문 정보를 POST로 전송하면 PUZZL 쪽 재고가 즉시 차감되며, 이후 상품 조회 API (`GET /api/dresscode/kids`) 응답의 `sizes[].stock` 값에 자동으로 반영됩니다.

또한 v1.1부터 **발주확인 / 해외배송 송장 정보**를 뭉클 측에서 폴링(GET) 으로 조회할 수 있습니다. PUZZL 쪽에서 해외 공급사 발주확인이 끝나거나 운송장이 등록되면 `GET /api/orders/:orderId` 응답에 자동 반영됩니다.

---

## 1. 기본 정보

| 항목 | 값 |
|------|-----|
| **Base URL** | `https://puzzl-kids-api.onrender.com` |
| **Protocol** | HTTPS (TLS 1.2 이상) |
| **Method** | `POST` |
| **Content-Type** | `application/json` |
| **권장 타임아웃** | 5~10초 (Cold start 대비) |
| **재시도 정책** | 네트워크 오류 시 최대 3회, 간격 2초/5초/10초 권장 |

---

## 2. 인증

웹훅 호출 시 **별도 전용 키** 를 `x-webhook-key` 헤더로 전달해주세요.

```
x-webhook-key: {발급받은 webhook key}
```

> 기존 상품 조회용 `x-api-key` 와는 **다른 키** 입니다. 권한이 분리되어 있습니다.
> 키는 담당자를 통해 별도 전달됩니다. 키 유출 시 즉시 담당자에게 연락해주세요.

### 인증 실패 (HTTP 401)
```json
{ "ok": false, "error": "Invalid or missing webhook key. Set x-webhook-key header." }
```

---

## 3. 엔드포인트 목록

| # | Method | Path | 설명 |
|---|--------|------|------|
| 1 | POST | `/api/orders` | 주문(판매/취소) 기록 → 재고 반영 |
| 2 | GET | `/api/orders/:orderId` | 특정 주문 조회 (**발주/배송 상태 포함**) |

---

## 4. 엔드포인트 상세

### 4-1. 주문 기록 (판매/취소)

```
POST /api/orders
```

#### Request Body

| 필드 | 타입 | 필수 | 설명 |
|------|------|:---:|------|
| `order_id` | string | ✅ | 뭉클 측 고유 주문 번호. **판매와 취소는 별도 order_id** 로 보내주세요 (예: `...-001`, `...-001-CANCEL`) |
| `sku` | string | ✅ | 상품 SKU (상품 조회 API `sku` 필드 그대로) |
| `size` | string | ✅ | 선택된 사이즈 (상품 조회 API `sizes[].size` 값과 **정확히 일치**) |
| `action` | string | ✅ | `"sold"` 또는 `"canceled"` |
| `buyer_info` | object | ⚪ | 감사 로그용. 자유 JSON. (이름, 전화번호 등) |

#### Request 예시

##### ▶ 판매 기록
```bash
curl -X POST https://puzzl-kids-api.onrender.com/api/orders \
  -H "x-webhook-key: {WEBHOOK_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "MNKL-20260423-00042",
    "sku": "HDP05IN0Z83MEDIUMBLUE",
    "size": "10",
    "action": "sold",
    "buyer_info": {
      "name": "홍길동",
      "phone": "010-0000-0000",
      "payment_method": "card"
    }
  }'
```

##### ▶ 주문 취소 기록
```bash
curl -X POST https://puzzl-kids-api.onrender.com/api/orders \
  -H "x-webhook-key: {WEBHOOK_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "MNKL-20260423-00042-CANCEL",
    "sku": "HDP05IN0Z83MEDIUMBLUE",
    "size": "10",
    "action": "canceled"
  }'
```

#### Response 200 OK (정상 처리)

```json
{
  "ok": true,
  "order_id": "MNKL-20260423-00042",
  "sku": "HDP05IN0Z83MEDIUMBLUE",
  "size": "10",
  "action": "sold",
  "delta": -1,
  "crawl_stock": 2,
  "remaining_stock": 1,
  "timestamp": "2026-04-23T12:34:56.000+09:00"
}
```

| 응답 필드 | 의미 |
|----------|------|
| `ok` | 항상 `true` (성공) |
| `order_id` | 기록된 주문 번호 (에코) |
| `delta` | 재고 변동량 (`sold`=-1, `canceled`=+1) |
| `crawl_stock` | PUZZL이 마지막 크롤링 시점에 확인한 재고 |
| `remaining_stock` | 본 주문 반영 후 남은 재고 (= `crawl_stock + 누적 delta`, 0 이하 방지) |
| `timestamp` | 서버 기록 시각 (KST) |

#### 실패 응답 코드

| HTTP | 케이스 | Body (error) |
|:---:|------|-------------|
| **400** | 필수 필드 누락 | `"Missing required fields. Required: order_id, sku, size, action."` |
| **400** | `action` 값 오류 | `"Invalid 'action'. Must be 'sold' or 'canceled'."` |
| **401** | webhook 키 누락/무효 | `"Invalid or missing webhook key..."` |
| **404** | SKU 없음 | `"SKU not found: {sku}"` |
| **404** | Size 없음 | `"Size not found for SKU {sku}: {size}"` |
| **409** | `order_id` 중복 | `"Duplicate order_id. Order already recorded."` |
| **422** | 재고 부족 (`sold` 전용) | `"Insufficient stock"` + `remaining_stock: 0` |
| **500** | 서버 내부 오류 | 가변. **재시도 대상** |

##### 재고 부족 예시 (422)
```json
{
  "ok": false,
  "error": "Insufficient stock",
  "sku": "HDP05IN0Z83MEDIUMBLUE",
  "size": "10",
  "remaining_stock": 0
}
```

##### 중복 예시 (409)
```json
{
  "ok": false,
  "error": "Duplicate order_id. Order already recorded.",
  "order_id": "MNKL-20260423-00042"
}
```

---

### 4-2. 주문 조회 (발주/배송 상태 포함)

```
GET /api/orders/:orderId
```

#### Request 예시
```bash
curl https://puzzl-kids-api.onrender.com/api/orders/MNKL-20260423-00042 \
  -H "x-webhook-key: {WEBHOOK_KEY}"
```

#### Response 200 OK
```json
{
  "ok": true,
  "order": {
    "order_id": "MNKL-20260423-00042",
    "sku": "HDP05IN0Z83MEDIUMBLUE",
    "size": "10",
    "delta": "-1",
    "timestamp": "2026-04-23T12:34:56.000+09:00",
    "status": "active",
    "buyer_info": "{\"name\":\"홍길동\",\"phone\":\"010-0000-0000\"}",

    "order_status": "shipping",
    "confirmed_at": "2026-04-24T11:20:00+09:00",
    "tracking_carrier": "DHL",
    "tracking_number": "1234567890123"
  }
}
```

#### 응답 필드 설명 (v1.1 추가분)

| 필드 | 타입 | 설명 |
|------|------|------|
| `order_status` | string | 주문 진행 상태. 아래 5단계 중 하나 |
| `confirmed_at` | string \| null | PUZZL 이 해외 공급사에 **발주확인 완료**한 시각 (KST ISO8601). 이 시점 이후로는 **취소 불가**. 미확인 상태에서는 `null`. |
| `tracking_carrier` | string \| null | 해외배송 운송사 (예: `DHL`, `FedEx`, `UPS`). 미등록이면 `null`. |
| `tracking_number` | string \| null | 운송장 번호. 미등록이면 `null`. |

#### `order_status` 값 정의

| 값 | 의미 | 다음 단계 |
|----|------|---------|
| `pending` | 주문 접수됨, 아직 해외 공급사 발주확인 전 | 취소 가능 |
| `confirmed` | PUZZL 이 해외 공급사에 발주확인 완료. **이 시점부터 취소 불가** (`confirmed_at` 채워짐) | 송장 등록 대기 |
| `shipping` | 해외 운송사에 인계되어 운송장이 발급됨 (`tracking_carrier` + `tracking_number` 채워짐) | 한국 도착 대기 |
| `completed` | 한국 도착/전달 완료 | 종료 |
| `canceled` | 주문 취소됨 (POST `/api/orders` 에 `action: "canceled"` 로 기록되었거나, 내부적으로 무효 처리된 경우) | — |

> ⚠️ **중요 — 취소 가능 시점**
> `order_status` 가 **`pending` 일 때만** 뭉클에서 취소를 보내주세요.
> `confirmed` 이후로는 해외 공급사에서 이미 결제가 확정되어 PUZZL 측에서 환불이 어렵습니다.

#### 폴링 권장 주기

운송장 등록은 보통 발주확인 후 **24~72시간** 내에 완료됩니다. 권장 폴링 주기:

| 주문 상태 | 권장 폴링 주기 |
|---------|---------------|
| `pending` | 30분~1시간 (발주확인 시점 모니터링) |
| `confirmed` | 1~3시간 (송장 등록 대기) |
| `shipping`, `completed`, `canceled` | 폴링 중단 (필요 시 1일 1회만) |

#### Response 404
```json
{ "ok": false, "error": "Order not found" }
```

---

## 5. 재고 반영 방식

```
실시간 재고 = max(0, 크롤 재고 + 누적 델타)
```

- PUZZL은 **매일 아침 공급사 재고를 크롤링** 하여 기본 재고를 세팅합니다.
- 뭉클 주문 웹훅이 들어올 때마다 `delta`(판매 -1, 취소 +1)가 누적됩니다.
- 이후 `GET /api/dresscode/kids` 응답의 `sizes[].stock` 값은 이 누적 델타를 자동 반영한 **실시간 재고** 입니다.
- 재고 0이 되면 `stock: 0` 으로 고정됩니다 (음수 방지).

---

## 6. 운영 관련 참고사항

### 6-1. 멱등성 (Idempotency)
- 동일한 `order_id` 를 두 번 이상 보내면 **두 번째부터는 409 Conflict**가 반환됩니다. 재고는 한 번만 차감됩니다.
- 네트워크 재시도로 안전하게 반복 호출해도 됩니다.

### 6-2. 판매 후 취소 처리
판매와 취소는 **각기 다른 `order_id`** 로 보내주세요. 같은 `order_id` 를 재사용하면 중복으로 거절됩니다.

권장 규칙:
- 판매: `MNKL-YYYYMMDD-NNNNN`
- 취소: `MNKL-YYYYMMDD-NNNNN-CANCEL`

### 6-3. 권장 호출 시점
- **판매**: 결제 완료(주문 확정) 직후 즉시 호출
- **취소**: 환불 승인 / 주문 취소 완료 직후 즉시 호출

### 6-4. Cold Start
서버가 15분 이상 아이들 상태면 잠시 중지됩니다. 이 경우 첫 요청이 **최대 30초~1분 지연**될 수 있습니다. 타임아웃은 **5~10초 이상** 권장합니다.

### 6-5. 재시도 정책
- 5xx 응답 또는 타임아웃 시: **최대 3회** 재시도 (exponential backoff 2s → 5s → 10s)
- 4xx 응답 (400/401/404/409/422): 재시도하지 않음 (비즈니스 로직 오류)

### 6-6. 시간대
응답의 `timestamp` 는 KST(+09:00) 기준 ISO 8601 형식입니다.

---

## 7. 연관 API

본 주문 웹훅과 함께 사용하는 상품 조회 API:
```
GET https://puzzl-kids-api.onrender.com/api/dresscode/kids
GET https://puzzl-kids-api.onrender.com/api/dresscode/kids/count
GET https://puzzl-kids-api.onrender.com/api/puzzl/kids/image/:sku/:idx  (이미지 프록시, 인증 불필요)
```
자세한 내용은 `PUZZL_KIDS_API.md` 문서를 참고해주세요.

---

## 8. 문의

| 구분 | 연락처 |
|------|--------|
| **기술 문의** | *(담당자 이메일)* |
| **webhook 키 재발급** | *(담당자 이메일)* |
| **장애 신고** | *(담당자 이메일)* |

### 변경 이력
| 버전 | 날짜 | 변경 내역 |
|------|------|----------|
| 1.1 | 2026-04-28 | GET `/api/orders/:id` 응답에 발주/배송 상태 필드 추가 (`order_status`, `confirmed_at`, `tracking_carrier`, `tracking_number`) |
| 1.0 | 2026-04-23 | 최초 공개 — POST `/api/orders`, GET `/api/orders/:id` 제공 |

---

© 2026 PUZZL.
