/**
 * daily-giglio-update.js
 * giglio CSV 피드 브랜드 전용 KREAM 갱신 — VPS 01:00 KST cron.
 * dresscode 파이프라인 (daily-kream-update.js) 과 독립.
 *
 * 흐름:
 *  1) build-targets-giglio-feeds.js — 피드 다운로드 (프록시) + targets 재빌드 (1회)
 *  2) 브랜드를 LANES 개 병렬 레인으로 나눠 fetch — 벽시계 시간 단축
 *     · 각 레인은 전용 브라우저 프로파일 (.browser-data-giglio-laneN) 사용 → Chrome 충돌 없음
 *     · fetch 는 KREAM_OUT_FILE 로 결과 경로를 직접 지정 → 병렬 파일명 충돌 없음
 *     · git commit/push 는 뮤텍스로 직렬화 (index.lock 경합 방지)
 *  3) cleanup + Slack 알림
 *
 * crontab (VPS):
 *   0 1 * * * cd $HOME/puzzl/kream && /usr/bin/xvfb-run -a /usr/bin/node daily-giglio-update.js >> $HOME/logs/kream-giglio-$(date +\%Y\%m\%d).log 2>&1
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

// 병렬 레인 구성 — 각 레인은 브랜드 목록을 순차 처리. 레인끼리는 동시 실행.
// VPS 2 vCPU / 4GB RAM 기준 2 레인이 최적 (부하 균형: 큰 브랜드를 서로 다른 레인에 배치).
const LANES = [
  [ // 레인 0
    { brand: 'MONCLER', slug: 'giglio_moncler' },
  ],
  [ // 레인 1
    { brand: 'C.P. COMPANY',   slug: 'giglio_cpcompany' },
    { brand: 'BOTTEGA VENETA', slug: 'giglio_bottega' },
    { brand: 'MIU MIU',        slug: 'giglio_miumiu' },
    { brand: 'DIOR',           slug: 'giglio_dior' },
  ],
];
const ALL_BRANDS = LANES.flat();
const KEEP_DAYS = 2;

// ── .env ─────────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log('📄 .env 로드');
}
if (!('KREAM_HEADLESS' in process.env)) process.env.KREAM_HEADLESS = '0';
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
function resolveCmd(cmd) { return cmd === 'node' ? NODE : cmd === 'git' ? GIT : cmd; }

// 동기 실행 (피드 빌드, cleanup, git) — stdio 상속
function run(cmd, args, opts = {}) {
  const realCmd = resolveCmd(cmd);
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(realCmd, args, { stdio: 'inherit', env: process.env, cwd: __dirname, ...opts });
  if (r.error) throw new Error(`spawn failed: ${cmd} (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`exit=${r.status} signal=${r.signal}: ${cmd} ${args.join(' ')}`);
}

// 비동기 실행 (병렬 fetch) — 출력 각 줄에 레인 태그 prefix
function runAsync(cmd, args, { env = {}, tag = '' } = {}) {
  return new Promise((resolve, reject) => {
    const realCmd = resolveCmd(cmd);
    const child = spawn(realCmd, args, { env: { ...process.env, ...env }, cwd: __dirname });
    const pipe = (stream, dst) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const ln of lines) dst.write(`${tag}${ln}\n`);
      });
      stream.on('end', () => { if (buf) dst.write(`${tag}${buf}\n`); });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit=${code}: ${cmd} ${args.join(' ')}`)));
  });
}

// ── git 뮤텍스 — 병렬 레인의 commit/push 직렬화 ──
let gitChain = Promise.resolve();
function withGitLock(fn) {
  const result = gitChain.then(fn, fn); // 앞 작업 성패와 무관하게 순차 실행
  gitChain = result.then(() => {}, () => {});
  return result;
}
function commitAndPushSync(files, message) {
  run('git', ['add', ...files], { cwd: REPO_ROOT });
  run('git', ['commit', '-m', message], { cwd: REPO_ROOT });
  try { run('git', ['pull', '--rebase', '--autostash', '-X', 'ours'], { cwd: REPO_ROOT }); }
  catch (e) { console.error(`⚠️  pull --rebase 실패 (push 계속): ${e.message.slice(0, 100)}`); }
  run('git', ['push'], { cwd: REPO_ROOT });
}

// ── Slack ────────────────────────────────────────
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
async function sendSlack(text) {
  if (!SLACK_WEBHOOK) return;
  try {
    const r = await fetch(SLACK_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) console.error(`   ⚠️  Slack 전송 실패: HTTP ${r.status}`);
  } catch (e) { console.error(`   ⚠️  Slack 전송 에러: ${e.message}`); }
}
function fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}시간 ${m}분 ${sec}초` : m > 0 ? `${m}분 ${sec}초` : `${sec}초`;
}

// ── 한 브랜드 처리 (fetch → commit/push) ──────────
const summary = [];
const FETCH_SCRIPT = process.env.KREAM_FETCH_BROWSER === '1' ? 'fetch-product-market.js' : 'fetch-product-market-api.js';

async function processBrand(b, laneIdx) {
  const tag = `[L${laneIdx}:${b.slug.replace('giglio_', '')}] `;
  const tBrand = Date.now();
  const dstRel = `results/kream_market_${b.slug}_${DATE_TAG}.json`;
  try {
    await runAsync('node', [FETCH_SCRIPT, `targets-${b.slug}.json`], {
      tag,
      env: {
        KREAM_OUT_FILE: dstRel,                                  // 결과를 최종 파일명으로 직접 저장
        KREAM_BROWSER_DATA: `.browser-data-giglio-lane${laneIdx}`, // 레인 전용 프로파일
      },
    });

    const dstAbs = path.join(__dirname, dstRel);
    if (!fs.existsSync(dstAbs)) { summary.push({ brand: b.slug, ok: false, reason: 'no output' }); return; }
    const elapsed = fmtElapsed(Date.now() - tBrand);
    console.log(`${tag}⏱  소요: ${elapsed}`);
    try {
      const data = JSON.parse(fs.readFileSync(dstAbs, 'utf-8'));
      summary.push({ brand: b.slug, ok: true, matched: data.matched, total: data.total_targets, elapsed });
    } catch (_) { summary.push({ brand: b.slug, ok: true, elapsed }); }

    await withGitLock(() => {
      try {
        commitAndPushSync([`kream/${dstRel}`], `chore(kream): ${b.slug} ${DATE_TAG}`);
        console.log(`${tag}📤 push 완료`);
      } catch (e) { console.error(`${tag}⚠️  push 실패: ${e.message.slice(0, 120)}`); }
    });
  } catch (e) {
    console.error(`${tag}❌ 실패: ${e.message}`);
    summary.push({ brand: b.slug, ok: false, reason: e.message.slice(0, 100) });
  }
}

async function runLane(brands, laneIdx) {
  for (const b of brands) await processBrand(b, laneIdx);
}

// ── main ─────────────────────────────────────────
const T0 = Date.now();
let fatal = null;

try {
  console.log(`\n${'='.repeat(60)}\n📅 giglio KREAM 갱신  ${new Date().toISOString()}  tag=${DATE_TAG}  (${LANES.length} 레인 병렬)\n${'='.repeat(60)}`);

  // 1) 피드 다운로드 + targets 재빌드 (1회)
  try {
    const specs = ALL_BRANDS.map((b) => `${b.brand}:${b.slug}`);
    run('node', ['build-targets-giglio-feeds.js', ...specs]);
  } catch (e) {
    console.error(`⚠️  giglio 피드 재빌드 실패 (기존 targets 로 진행): ${e.message.slice(0, 120)}`);
  }

  // 2) 레인 병렬 실행
  console.log(`\n🚀 ${LANES.length} 레인 병렬 fetch 시작`);
  LANES.forEach((brs, i) => console.log(`   레인 ${i}: ${brs.map((b) => b.slug.replace('giglio_', '')).join(', ')}`));
  await Promise.all(LANES.map((brands, i) => runLane(brands, i)));

  // 3) cleanup — 로컬 삭제분을 git 에도 반영
  run('node', ['cleanup-old-results.js', `--keep=${KEEP_DAYS}`]);
  try {
    run('git', ['add', '-A', 'kream/results/'], { cwd: REPO_ROOT });
    const st = spawnSync(resolveCmd('git'), ['status', '--porcelain', 'kream/results/'], { encoding: 'utf-8', cwd: REPO_ROOT });
    if ((st.stdout || '').trim()) {
      run('git', ['commit', '-m', `chore(kream): giglio cleanup ${DATE_TAG}`], { cwd: REPO_ROOT });
      try { run('git', ['pull', '--rebase', '--autostash', '-X', 'ours'], { cwd: REPO_ROOT }); } catch (_) {}
      run('git', ['push'], { cwd: REPO_ROOT });
      console.log('📤 cleanup 삭제분 push 완료');
    } else { console.log('   cleanup 변경 없음 — commit 생략'); }
  } catch (e) { console.error(`⚠️  cleanup commit/push 실패: ${e.message.slice(0, 120)}`); }
} catch (e) {
  fatal = e.message.slice(0, 200);
  console.error(`\n❌ 치명적 에러: ${e.message}`);
}

// 4) Slack — 브랜드 순서를 LANES 정의 순으로 정렬
const totalElapsed = fmtElapsed(Date.now() - T0);
const order = ALL_BRANDS.map((b) => b.slug);
summary.sort((a, b) => order.indexOf(a.brand) - order.indexOf(b.brand));
const lines = [`*🧺 giglio KREAM 갱신* — \`${DATE_TAG}\``, ''];
for (const s of summary) {
  const timeNote = s.elapsed ? `  ⏱ ${s.elapsed}` : '';
  if (s.ok && s.total != null) {
    const pct = (s.matched / s.total * 100).toFixed(1);
    lines.push(`✅ *${s.brand}*: ${s.matched}/${s.total} 매칭 (${pct}%)${timeNote}`);
  } else if (s.ok) lines.push(`✅ *${s.brand}*: 완료${timeNote}`);
  else lines.push(`❌ *${s.brand}*: ${s.reason}`);
}
lines.push('', `⏱ *총 소요 시간: ${totalElapsed}* (${LANES.length} 레인 병렬)`);
if (fatal) lines.push('', `⚠️ 치명적 에러: ${fatal}`);
await sendSlack(lines.join('\n'));

console.log(`\n⏱  총 소요 시간: ${totalElapsed}`);
console.log(`${fatal ? '❌' : '✅'} 완료 ${new Date().toISOString()}`);
process.exit(fatal ? 1 : 0);
