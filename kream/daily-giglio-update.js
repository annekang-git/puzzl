/**
 * daily-giglio-update.js
 * giglio CSV 피드 브랜드 (보테가 베네타, 미우미우) 전용 KREAM 갱신 스크립트.
 * dresscode 파이프라인 (daily-kream-update.js) 과 독립 — VPS 에서만 11:00 KST cron 으로 실행.
 *
 * 흐름:
 *  1) build-targets-giglio-feeds.js — 피드 다운로드 (프록시) + targets 재빌드
 *  2) 브랜드별 fetch → rename → commit → pull --rebase → push
 *     (04:00 dresscode run 이 아직 돌고 있어도 push 경합 없이 병합)
 *  3) cleanup + Slack 알림
 *
 * crontab (VPS):
 *   0 11 * * * cd $HOME/puzzl/kream && /usr/bin/xvfb-run -a /usr/bin/node daily-giglio-update.js >> $HOME/logs/kream-giglio-$(date +\%Y\%m\%d).log 2>&1
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

const BRANDS = [
  { brand: 'BOTTEGA VENETA', slug: 'giglio_bottega' },
  { brand: 'MIU MIU',        slug: 'giglio_miumiu' },
  { brand: 'C.P. COMPANY',   slug: 'giglio_cpcompany' },
  { brand: 'OFF-WHITE',      slug: 'giglio_offwhite' },
  { brand: 'DIOR',           slug: 'giglio_dior' },
];
const KEEP_DAYS = 2;

// ── .env 로드 ─────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log(`📄 .env 로드`);
}

if (!('KREAM_HEADLESS' in process.env)) process.env.KREAM_HEADLESS = '0';
// giglio 전용 브라우저 프로파일 — 04:00 dresscode run 과 겹쳐도 Chrome 충돌 없음
if (!process.env.KREAM_BROWSER_DATA) process.env.KREAM_BROWSER_DATA = '.browser-data-giglio';
if (!process.env.KREAM_EMAIL || !process.env.KREAM_PASSWORD) {
  console.error('❌ KREAM_EMAIL / KREAM_PASSWORD 환경변수 없음 (.env 파일 확인)');
  process.exit(1);
}

const nowKstStamp = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(5, 10).replace('-', ''); // MMDD
};
const DATE_TAG = nowKstStamp();

const NODE = process.execPath;
const GIT = fs.existsSync('/opt/homebrew/bin/git') ? '/opt/homebrew/bin/git' : '/usr/bin/git';
function resolveCmd(cmd) {
  if (cmd === 'node') return NODE;
  if (cmd === 'git')  return GIT;
  return cmd;
}
function run(cmd, args, opts = {}) {
  const realCmd = resolveCmd(cmd);
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(realCmd, args, { stdio: 'inherit', env: process.env, cwd: __dirname, ...opts });
  if (r.error) throw new Error(`spawn failed: ${cmd} (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`exit=${r.status} signal=${r.signal}: ${cmd} ${args.join(' ')}`);
}

// commit → pull --rebase → push  (다른 머신의 04:00 run 과 push 경합 방지)
function commitAndPush(files, message) {
  run('git', ['add', ...files], { cwd: REPO_ROOT });
  run('git', ['commit', '-m', message], { cwd: REPO_ROOT });
  try {
    run('git', ['pull', '--rebase', '--autostash', '-X', 'ours'], { cwd: REPO_ROOT });
  } catch (e) {
    console.error(`⚠️  pull --rebase 실패 (push 시도는 계속): ${e.message.slice(0, 100)}`);
  }
  run('git', ['push'], { cwd: REPO_ROOT });
}

// ── Slack ────────────────────────────────────────
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
async function sendSlack(text) {
  if (!SLACK_WEBHOOK) return;
  try {
    const r = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) console.error(`   ⚠️  Slack 전송 실패: HTTP ${r.status}`);
  } catch (e) {
    console.error(`   ⚠️  Slack 전송 에러: ${e.message}`);
  }
}

// 경과 시간 포맷 (ms → "1시간 23분 45초")
function fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}시간 ${m}분 ${sec}초` : m > 0 ? `${m}분 ${sec}초` : `${sec}초`;
}

// ── main ─────────────────────────────────────────
const T0 = Date.now();
const summary = [];
let fatal = null;

try {
  console.log(`\n${'='.repeat(60)}\n📅 giglio KREAM 갱신  ${new Date().toISOString()}  tag=${DATE_TAG}\n${'='.repeat(60)}`);

  // 1) 피드 다운로드 + targets 재빌드 (실패해도 기존 targets 로 진행)
  try {
    const specs = BRANDS.map((b) => `${b.brand}:${b.slug}`);
    run('node', ['build-targets-giglio-feeds.js', ...specs]);
  } catch (e) {
    console.error(`⚠️  giglio 피드 재빌드 실패 (기존 targets 로 진행): ${e.message.slice(0, 120)}`);
  }

  // 2) 브랜드별 fetch
  for (const b of BRANDS) {
    console.log(`\n\n${'─'.repeat(60)}\n🏷  ${b.brand} → ${b.slug}\n${'─'.repeat(60)}`);
    const tBrand = Date.now();
    try {
      // API 직접 호출 모드 (2026-07-18 전환) — 브라우저 방식 fallback: KREAM_FETCH_BROWSER=1
      const fetchScript = process.env.KREAM_FETCH_BROWSER === '1' ? 'fetch-product-market.js' : 'fetch-product-market-api.js';
      run('node', [fetchScript, `targets-${b.slug}.json`]);

      const created = fs.readdirSync(RESULTS_DIR)
        .filter((f) => /^kream_market_\d{4}-\d{2}-\d{2}_/.test(f) && f.endsWith('.json'))
        .map((f) => ({ f, t: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
        .sort((a, c) => c.t - a.t);
      if (created.length === 0) {
        summary.push({ brand: b.slug, ok: false, reason: 'no output' });
        continue;
      }
      const dst = `kream_market_${b.slug}_${DATE_TAG}.json`;
      fs.renameSync(path.join(RESULTS_DIR, created[0].f), path.join(RESULTS_DIR, dst));
      console.log(`✅ ${created[0].f} → ${dst}`);

      const elapsed = fmtElapsed(Date.now() - tBrand);
      console.log(`⏱  ${b.slug} 소요: ${elapsed}`);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, dst), 'utf-8'));
        summary.push({ brand: b.slug, ok: true, matched: data.matched, total: data.total_targets, elapsed });
      } catch (_) {
        summary.push({ brand: b.slug, ok: true, elapsed });
      }

      try {
        commitAndPush([`kream/results/${dst}`], `chore(kream): ${b.slug} ${DATE_TAG}`);
        console.log(`📤 ${dst} push 완료`);
      } catch (e) {
        console.error(`⚠️  ${b.slug} push 실패: ${e.message.slice(0, 120)}`);
      }
    } catch (e) {
      console.error(`❌ ${b.slug} 실패: ${e.message}`);
      summary.push({ brand: b.slug, ok: false, reason: e.message.slice(0, 100) });
    }
  }

  // 3) cleanup — 로컬 삭제 후 그 삭제를 git 에도 커밋해야 원격/대시보드에서 사라짐
  run('node', ['cleanup-old-results.js', `--keep=${KEEP_DAYS}`]);
  try {
    run('git', ['add', '-A', 'kream/results/'], { cwd: REPO_ROOT });
    const st = spawnSync(resolveCmd('git'), ['status', '--porcelain', 'kream/results/'], { encoding: 'utf-8', cwd: REPO_ROOT });
    if ((st.stdout || '').trim()) {
      run('git', ['commit', '-m', `chore(kream): giglio cleanup ${DATE_TAG}`], { cwd: REPO_ROOT });
      try {
        run('git', ['pull', '--rebase', '--autostash', '-X', 'ours'], { cwd: REPO_ROOT });
      } catch (_) {}
      run('git', ['push'], { cwd: REPO_ROOT });
      console.log('📤 cleanup 삭제분 push 완료');
    } else {
      console.log('   cleanup 변경 없음 — commit 생략');
    }
  } catch (e) {
    console.error(`⚠️  cleanup commit/push 실패: ${e.message.slice(0, 120)}`);
  }
} catch (e) {
  fatal = e.message.slice(0, 200);
  console.error(`\n❌ 치명적 에러: ${e.message}`);
}

// 4) Slack
const totalElapsed = fmtElapsed(Date.now() - T0);
const lines = [`*🧺 giglio KREAM 갱신* — \`${DATE_TAG}\``, ''];
for (const s of summary) {
  const timeNote = s.elapsed ? `  ⏱ ${s.elapsed}` : '';
  if (s.ok && s.total != null) {
    const pct = (s.matched / s.total * 100).toFixed(1);
    lines.push(`✅ *${s.brand}*: ${s.matched}/${s.total} 매칭 (${pct}%)${timeNote}`);
  } else if (s.ok) lines.push(`✅ *${s.brand}*: 완료${timeNote}`);
  else lines.push(`❌ *${s.brand}*: ${s.reason}`);
}
lines.push('', `⏱ *총 소요 시간: ${totalElapsed}*`);
if (fatal) lines.push('', `⚠️ 치명적 에러: ${fatal}`);
await sendSlack(lines.join('\n'));

console.log(`\n⏱  총 소요 시간: ${totalElapsed}`);
console.log(`${fatal ? '❌' : '✅'} 완료 ${new Date().toISOString()}`);
process.exit(fatal ? 1 : 0);
