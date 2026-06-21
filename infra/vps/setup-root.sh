#!/bin/bash
# ============================================================
# Hetzner CPX21 (Ubuntu 24.04) 초기 셋업 — root 권한 필요
#
# 사용법 (로컬 Mac 에서):
#   ssh root@<VPS_IP> "bash -s" < infra/vps/setup-root.sh
#
# 또는 VPS 에 SSH 접속 후 직접:
#   curl -fsSL https://raw.githubusercontent.com/annekang-git/puzzl/main/infra/vps/setup-root.sh | bash
# ============================================================
set -euo pipefail

step() { echo ""; echo "════════════════════════════════════════"; echo "🔧 $*"; echo "════════════════════════════════════════"; }

step "[1/9] 시스템 업데이트"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y -o Dpkg::Options::="--force-confold"

step "[2/9] 타임존 → Asia/Seoul (Mac mini 와 동일 시간대로 crontab 호환)"
timedatectl set-timezone Asia/Seoul
echo "현재 시각: $(date)"

step "[3/9] 기본 도구 설치 (git, curl, rsync, build-essential, python3 등)"
apt-get install -y \
  curl wget git vim unzip \
  ca-certificates gnupg lsb-release apt-transport-https \
  rsync htop tmux jq \
  python3 python3-pip \
  build-essential \
  ufw fail2ban

step "[4/9] Node.js 20 LTS 설치"
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node -v)  npm: $(npm -v)"

step "[5/9] Google Chrome 설치 (KREAM headless 차단 우회용 — channel:'chrome')"
if ! command -v google-chrome &>/dev/null; then
  wget -q -O /usr/share/keyrings/google-chrome.gpg.armored https://dl-ssl.google.com/linux/linux_signing_key.pub
  gpg --dearmor < /usr/share/keyrings/google-chrome.gpg.armored > /usr/share/keyrings/google-chrome.gpg
  rm /usr/share/keyrings/google-chrome.gpg.armored
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
fi
google-chrome --version

step "[6/9] Xvfb (가상 디스플레이) + 한글 폰트"
# Xvfb 로 가상 X 서버 만들면 Chrome 이 'headed' 모드로 동작 → KREAM 정상 응답
# 한글 폰트는 KREAM 페이지 텍스트 정상 렌더링 (셀렉터 매칭 정확도 ↑)
apt-get install -y xvfb x11vnc fonts-noto-cjk fonts-noto-cjk-extra

step "[7/9] swap 2GB 추가 (Chromium 장시간 실행 메모리 마진)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # vm.swappiness 낮게 (RAM 우선 사용, swap 은 비상용)
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
  sysctl --system >/dev/null
fi
free -h

step "[8/9] 방화벽 (ufw) — SSH 만 허용"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable
ufw status

step "[9/9] puzzl 유저 생성 + SSH key 복사"
if ! id -u puzzl &>/dev/null; then
  adduser --disabled-password --gecos "" puzzl
  usermod -aG sudo puzzl
  # sudo 패스워드 없이 (cron 운영 편의)
  echo 'puzzl ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/puzzl
  chmod 0440 /etc/sudoers.d/puzzl
fi
# root 의 SSH key 를 puzzl 로 복사
mkdir -p /home/puzzl/.ssh
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/puzzl/.ssh/
fi
chown -R puzzl:puzzl /home/puzzl/.ssh
chmod 700 /home/puzzl/.ssh
chmod 600 /home/puzzl/.ssh/authorized_keys 2>/dev/null || true

# logs 폴더
sudo -u puzzl mkdir -p /home/puzzl/logs

cat <<'EOF'

╔════════════════════════════════════════════════════════════╗
║  ✅ root 셋업 완료                                          ║
╠════════════════════════════════════════════════════════════╣
║  다음 단계:                                                 ║
║                                                            ║
║  1) puzzl 유저로 접속:                                       ║
║     ssh puzzl@<VPS_IP>                                     ║
║                                                            ║
║  2) repo clone + 사용자 셋업:                                ║
║     git clone https://github.com/annekang-git/puzzl.git     ║
║     bash puzzl/infra/vps/setup-user.sh                     ║
║                                                            ║
║  3) Mac mini → VPS 자격증명/세션 rsync (Mac mini 에서)        ║
║     (infra/vps/README.md 참고)                              ║
║                                                            ║
║  4) crontab 등록 + 1회씩 수동 검증                            ║
╚════════════════════════════════════════════════════════════╝
EOF
