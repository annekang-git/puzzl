# KREAM 시세 / 마진 비교

KREAM 상품코드로 시세를 수집하고 공급가(EUR) 대비 마진율을 비교하는 도구.

## 구성

| 파일 | 용도 | 실행 위치 |
|---|---|---|
| `fetch-product-market.js` | KREAM 로그인 → 상품코드 검색 → 시세 수집 (Playwright) | **로컬만** |
| `build-targets-from-tsv.js` | TSV (사이즈/B2B/KREAM코드) → targets 자동 생성 | 로컬 |
| `build-targets-from-diff.js` | dresscode diff `to_add[]` → targets 자동 생성 | 로컬 |
| `kream-ui-server.js` | `results/*.json` 을 읽어 마진 비교 웹 UI | **로컬 & Render** |

## Render 배포

레포 루트의 `render.yaml` 에 `puzzl-kream-ui` 서비스가 정의돼 있어, `main` 브랜치 push 시 자동 배포된다. `rootDir: kream` 으로 이 폴더만 사용.

- 빌드: `npm install --omit=dev` (Playwright 제외, Express 만 설치)
- 시작: `node kream-ui-server.js` (Render 가 주입한 `PORT` 사용)
- 헬스체크: `/`

UI 서버는 `results/kream_market_*.json` 파일을 직접 읽는다 → **데이터는 레포에 commit 되어 있어야 화면에 보인다.**

## 데이터 갱신 흐름 (수동)

```bash
# 1) 자격증명 환경변수 (셸에 export 해두면 편함)
export KREAM_EMAIL='you@example.com'
export KREAM_PASSWORD='...'

# 2) 입력 만들기 — 셋 중 택1
#    (a) TSV 일괄
node build-targets-from-tsv.js input-kream-codes.tsv
#    → targets-from-tsv.json
#    (b) diff 자동 (cafe24에 없는 신규 상품)
node build-targets-from-diff.js
#    → targets-from-diff.json
#    (c) 즉석 한두 건 (스킬 헬퍼)
node ~/.claude/skills/kream-margin/scripts/build-adhoc-targets.js \
  'SSX03L101N:40mm:1200' > targets-adhoc.json

# 3) 시세 수집 — 브라우저 창이 떠서 KREAM 로그인 + 캡차 처리
node fetch-product-market.js targets-from-tsv.json
# → results/kream_market_YYYY-MM-DD_HHMMSS.json 저장

# 4) 결과 commit & push → Render 자동 재배포
git add results/kream_market_*.json
git commit -m "chore(kream): update market data $(date +%F)"
git push
```

## 로컬에서 UI만 미리보기

```bash
npm install
node kream-ui-server.js   # http://localhost:3002
PORT=4000 node kream-ui-server.js   # 다른 포트
```

## 보안 / 커밋 주의사항

`.gitignore` 에 다음이 제외돼 있다 — 절대 force-add 하지 말 것:

- `.browser-data/` — KREAM 로그인 세션 쿠키
- `kream-tokens.json` — JWT 토큰
- `results/login-*.png` — 로그인 폼 스크린샷
- `kream-error.png`, `explore-output*/` — 디버그 산출물
- `kream_selling_bids_*.json` — 이전 실험 큰 덤프
- `targets-adhoc.json`, `input-kream-codes.tsv` — 임시 입력 (공급가 포함 가능)

자격증명은 **환경변수로만** 주입 (`fetch-product-market.js` 가 없으면 즉시 실패).

## 공개되는 것 / 안 되는 것

레포가 public 이므로 commit 되는 `results/kream_market_*.json` 의 내용(공급가 EUR / 마진율 포함)은 **인터넷에 그대로 노출**된다. 민감한 가격 정보를 숨기고 싶으면:

1. 결과를 commit 하지 않고 `results/.gitkeep` 만 두기 → UI 는 "결과 없음" 상태
2. 또는 UI 서버에 basic-auth 추가 (express 미들웨어 10줄)
3. 또는 `eur_price` 컬럼을 가리는 별도 "public" 결과 파일 생성 스크립트 추가

현재는 1·2·3 모두 적용하지 않은 **완전 공개** 상태로 설정돼 있다.
