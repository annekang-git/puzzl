# VPS 운영 가이드 — puzzl 클라우드 서버

Hetzner Cloud **CPX21** (3 vCPU AMD / 4 GB RAM / 80 GB SSD, **약 $7.65/월**) 위에서
Mac mini 의 cron 작업 9개를 모두 대신 실행하기 위한 설정·운영 스크립트 모음.

## 디렉토리 구조

```
infra/vps/
├── README.md                 ← 이 파일
├── setup-root.sh             ← 최초 1회 (root) — OS·시스템 패키지·유저
├── setup-user.sh             ← 최초 1회 (puzzl) — repo clone + npm install
├── sync-secrets-from-mac.sh  ← Mac mini → VPS 자격증명/세션 rsync (Mac 에서 실행)
├── update.sh                 ← 코드 즉시 반영 (git pull + npm install if changed)
└── crontab.txt               ← Linux crontab (KST 타임존, 9개 작업)
```

## 초기 설치 가이드 (Hetzner 새 인스턴스)

### Phase 0 — Hetzner Cloud 가입 & 인스턴스 생성

1. https://www.hetzner.com/cloud 가입 (verification 완료까지 대기)
2. 콘솔에서 **Project 생성** (예: `puzzl-prod`)
3. **SSH key 등록**:
   - 로컬 Mac 에서: `cat ~/.ssh/id_ed25519.pub` (없으면 `ssh-keygen -t ed25519` 로 먼저 생성)
   - 출력을 복사해 Hetzner Console → Security → SSH keys 에 추가
4. **CPX21 서버 주문**:
   - Image: **Ubuntu 24.04**
   - Type: **CPX21** (3 vCPU AMD, 4 GB, 80 GB)
   - Location: **Falkenstein** (FSN) 또는 **Helsinki** (HEL) — KREAM 응답 차이 거의 없음
   - SSH key: 방금 등록한 키 선택
5. 서버 생성 후 **IPv4 주소** 확인
6. SSH 접속 테스트: `ssh root@<IPv4>`

### Phase 1 — root 셋업 (1회)

옵션 A: 로컬 에서 한 줄로 (repo 가 GitHub 에 push 된 상태)
```bash
curl -fsSL https://raw.githubusercontent.com/annekang-git/puzzl/main/infra/vps/setup-root.sh | ssh root@<VPS_IP> bash
```

옵션 B: 수동
```bash
ssh root@<VPS_IP>
# VPS 안에서
curl -fsSL https://raw.githubusercontent.com/annekang-git/puzzl/main/infra/vps/setup-root.sh | bash
```

설치 시간: ~5분 (Node, Chrome, Xvfb 등)

### Phase 2 — 사용자(puzzl) 셋업 (1회)

```bash
ssh puzzl@<VPS_IP>
git clone https://github.com/annekang-git/puzzl.git
bash puzzl/infra/vps/setup-user.sh
```

설치 시간: ~5분 (npm install + Playwright Chromium 다운로드 ~200MB)

### Phase 3 — 자격증명·세션 복사 (Mac mini → VPS)

**Mac mini 에서** 실행:
```bash
cd /Users/anne/CascadeProjects/windsurf-project-2/cafe24-oauth
bash infra/vps/sync-secrets-from-mac.sh <VPS_IP>
```

자동 복사 항목:
- `kream/.env` (KREAM 자격증명 + Slack webhook)
- `kream/.browser-data/` (KREAM 로그인 세션 — 캡차 회피 핵심)
- `tokens.json` (Cafe24 OAuth)
- `service-account.json` (Google API)
- `smartstore/tokens.json`
- `grifo-crawler/.env`, `.browser-data/` (있다면)

권한도 자동 조정 (.env → 600, .browser-data → 700).

### Phase 4 — 각 cron 1회씩 수동 검증

가장 빠른 검증 (작은 브랜드 1개):
```bash
ssh puzzl@<VPS_IP>
cd ~/puzzl/kream
xvfb-run -a node fetch-product-market.js targets-tomford.json
# 정상 매칭 나오는지 확인
```

전체 daily 한 번 돌려보기:
```bash
xvfb-run -a node daily-kream-update.js
# ~3시간 — Slack 알림까지 확인
```

다른 cron 도 비슷하게:
```bash
node grifo-crawler/sync/refresh-cafe24-token.js
node grifo-crawler/sync/ensure-whitelist-uploaded.js
node smartstore/cleanup-smartstore-vs-cafe24.js
xvfb-run -a node grifo-crawler/sync/daily-full-sync.js  # 가장 큼 (4시간)
```

### Phase 5 — crontab 등록 + Mac mini 비활성화

```bash
# VPS 에서
crontab ~/puzzl/infra/vps/crontab.txt
crontab -l   # 9개 + cleanup 11개 라인 확인

# 며칠 양쪽 동시 운영하며 로그 비교 — 안정 확인 후
# Mac mini 에서 crontab -e → 라인들 # 으로 주석 처리
```

---

## 일상 유지보수

### 시나리오 1 — 코드 수정해서 VPS 에 반영

1. Mac mini 로컬에서 Claude 로 수정 작업 (지금처럼)
2. `git add ... && git commit -m "..." && git push`
3. VPS 는 **매일 새벽 01:00 자동 git pull** (crontab 첫 라인)
   - 즉시 반영 필요하면 SSH 접속 후 `bash ~/puzzl/infra/vps/update.sh`

### 시나리오 2 — `crontab.txt` 자체를 수정

`update.sh` 가 자동 감지해서 새 crontab 으로 재등록. 즉시 반영하려면:
```bash
ssh puzzl@<VPS_IP> bash puzzl/infra/vps/update.sh
```

### 시나리오 3 — `setup-*.sh` 수정 (드물게)

자동 재실행 안 함 (위험). 수동:
```bash
ssh puzzl@<VPS_IP>
bash puzzl/infra/vps/setup-user.sh   # 또는 setup-root.sh
```

### 시나리오 4 — 로그 확인

```bash
ssh puzzl@<VPS_IP>
tail -200 ~/logs/kream-$(date +%Y%m%d).log
tail -200 ~/logs/daily-sync-$(date +%Y%m%d).log
tail -200 ~/logs/whitelist-$(date +%Y%m%d).log
```

### 시나리오 5 — KREAM 로그인 만료 / 캡차 (드물지만)

`.browser-data/` 세션이 만료되면 cron 의 fetch 가 로그인 단계에서 막힐 수 있음.
복구:
```bash
# VPS 에서 한 번 수동 fetch 돌려서 로그 확인
xvfb-run -a node ~/puzzl/kream/fetch-product-market.js targets-tomford.json
# 캡차 뜨면 — VNC 로 GUI 접속해서 수동 해제 (아래)
```

### 시나리오 6 — VNC 로 GUI 보면서 디버그 (캡차 등)

```bash
# VPS 에서
xvfb-run -a x11vnc -display :99 -nopw -listen localhost &
# 로컬 Mac 에서 SSH 터널
ssh -L 5900:localhost:5900 puzzl@<VPS_IP>
# Mac 의 Screen Sharing 으로 vnc://localhost:5900 접속
```

---

## 리소스 모니터링

```bash
ssh puzzl@<VPS_IP>
htop                  # CPU/RAM 실시간
df -h                 # 디스크
du -sh ~/puzzl/*      # 폴더별 용량
crontab -l            # 등록된 cron
systemctl status cron # cron 데몬 상태
```

---

## 비상 — Mac mini 로 즉시 롤백

VPS 문제 발생 시 Mac mini cron 다시 활성화:
```bash
# Mac mini 에서
crontab -e
# 모든 # 주석 제거 후 저장
```

VPS 와 Mac mini 양쪽이 동시에 push 하면 commit conflict 가능 — 한쪽만 활성화 권장.

---

## 비용 요약

| 항목 | 비용 |
|---|---|
| Hetzner CPX21 | €7.05/월 (≈ $7.65 ≈ 약 10,500 원) |
| (옵션) Korean residential proxy | $10~20/월 — KREAM 이 해외 IP 차단 시에만 추가 |
| (옵션) 백업 — Hetzner snapshots | €0.01/GB/월 (~$0.50/월 추가) |
| **합계** | **연 약 9~15만 원** |

Mac mini 전기세 (8W × 24시간 × 365일 × 200원/kWh ≈ 14,000원/년) 대비 ~10배 비싸지만,
- 인터넷 끊김 영향 없음
- Mac 켜둘 필요 없음
- 어디서나 SSH 관리
- 장애 시 다른 데이터센터로 빠르게 이전 가능

가치가 있다고 판단되어 진행.
