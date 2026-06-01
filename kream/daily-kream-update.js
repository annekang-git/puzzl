/**
 * daily-kream-update.js
 * cron 용 KREAM 일일 갱신 스크립트.
 *
 * 흐름:
 *  1) kream/.env 에서 KREAM_EMAIL / KREAM_PASSWORD 로드
 *  2) 최신 dresscode 크롤링에서 지정 브랜드들 targets 재빌드
 *  3) 각 브랜드 fetch (headless) → results/kream_market_{slug}_MMDD.json 저장
 *  4) 같은 브랜드의 오래된 결과 KEEP_DAYS 일치 초과분 삭제 (rotation)
 *  5) 변경분 git commit & push → Render 자동 재배포
 *
 * crontab 예:
 *   0 4 * * * cd /Users/anne/.../kream && /opt/homebrew/bin/node daily-kream-update.js >> ~/logs/kream-$(date +\%Y\%m\%d).log 2>&1
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

// ── 설정 ──────────────────────────────────────────
const BRANDS = [
  { dresscode: 'CARHARTT WIP', slug: 'carhartt' },
  { dresscode: 'STONE ISLAND', slug: 'stoneisland' },
  { dresscode: 'THOM BROWNE',  slug: 'tombrown' },
];
const KEEP_DAYS = 7; // 브랜드당 최근 N개 결과만 유지

// ── .env 로드 ─────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  console.log(`📄 .env 로드`);
}

// KREAM 이 headless 를 차단해서 cron 도 headed 로 실행 (Mac mini 로그인 유지 필요).
// 새벽 4am 에 실제 Chrome 창이 떴다 닫힘 — 사용자는 자고있어 안 보임.
// 환경변수로 명시적 override 가능: KREAM_HEADLESS=1 로 외부에서 강제 시 headless 사용.
if (!('KREAM_HEADLESS' in process.env)) process.env.KREAM_HEADLESS = '0';

if (!process.env.KREAM_EMAIL || !process.env.KREAM_PASSWORD) {
  console.error('❌ KREAM_EMAIL / KREAM_PASSWORD 환경변수 없음 (.env 파일 확인)');
  process.exit(1);
}

// ── 유틸 ─────────────────────────────────────────
const nowKstStamp = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(5, 10).replace('-', ''); // MMDD
};
const DATE_TAG = nowKstStamp();

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: process.env, cwd: __dirname, ...opts });
  if (r.status !== 0) throw new Error(`exit=${r.status}: ${cmd} ${args.join(' ')}`);
}

function runQuiet(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', env: process.env, cwd: __dirname, ...opts });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── 1) targets 재빌드 ────────────────────────────
console.log(`\n${'='.repeat(60)}\n📅 KREAM 일일 갱신  ${new Date().toISOString()}  tag=${DATE_TAG}\n${'='.repeat(60)}`);
const specs = BRANDS.map((b) => `${b.dresscode}:${b.slug}`);
run('node', ['build-targets-by-brand.js', ...specs]);

// ── 2) 브랜드별 fetch ────────────────────────────
const summary = [];
for (const b of BRANDS) {
  console.log(`\n\n${'─'.repeat(60)}\n🏷  ${b.dresscode} → ${b.slug}\n${'─'.repeat(60)}`);
  try {
    // fetch 실행
    run('node', ['fetch-product-market.js', `targets-${b.slug}.json`]);

    // fetch 가 만든 최신 kream_market_YYYY-* 파일 찾기
    const created = fs.readdirSync(RESULTS_DIR)
      .filter((f) => /^kream_market_\d{4}-\d{2}-\d{2}_/.test(f) && f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
      .sort((a, c) => c.t - a.t);
    if (created.length === 0) {
      console.error(`⚠️  ${b.slug}: 생성된 결과 파일 없음`);
      summary.push({ brand: b.slug, ok: false, reason: 'no output' });
      continue;
    }
    const src = created[0].f;
    const dst = `kream_market_${b.slug}_${DATE_TAG}.json`;
    fs.renameSync(path.join(RESULTS_DIR, src), path.join(RESULTS_DIR, dst));
    console.log(`✅ ${src} → ${dst}`);

    // 매칭 수 요약
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, dst), 'utf-8'));
      summary.push({ brand: b.slug, ok: true, matched: data.matched, failed: data.failed, total: data.total_targets });
    } catch (_) {
      summary.push({ brand: b.slug, ok: true });
    }
  } catch (e) {
    console.error(`❌ ${b.slug} 실패: ${e.message}`);
    summary.push({ brand: b.slug, ok: false, reason: e.message });
  }
}

// ── 3) 결과 파일 rotation (브랜드당 KEEP_DAYS 개만 유지) ─────
console.log(`\n${'─'.repeat(60)}\n🗑  rotation — 브랜드당 최근 ${KEEP_DAYS}개만 유지\n${'─'.repeat(60)}`);
for (const b of BRANDS) {
  const re = new RegExp(`^kream_market_${b.slug}_\\d{4}\\.json$`);
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => re.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
    .sort((a, c) => c.t - a.t);
  while (files.length > KEEP_DAYS) {
    const old = files.pop();
    fs.unlinkSync(path.join(RESULTS_DIR, old.f));
    console.log(`   - ${old.f}`);
  }
  console.log(`   ${b.slug}: ${Math.min(files.length, KEEP_DAYS)}개 유지`);
}

// ── 4) 요약 출력 ─────────────────────────────────
console.log(`\n${'='.repeat(60)}\n📊 요약\n${'='.repeat(60)}`);
for (const s of summary) {
  if (s.ok) console.log(`  ✅ ${s.brand}: matched ${s.matched}/${s.total} (failed ${s.failed})`);
  else      console.log(`  ❌ ${s.brand}: ${s.reason}`);
}

// ── 5) git commit & push ─────────────────────────
console.log(`\n${'─'.repeat(60)}\n📤 git commit & push\n${'─'.repeat(60)}`);
const status = runQuiet('git', ['status', '--porcelain', 'kream/results/'], { cwd: REPO_ROOT });
if (!status.stdout.trim()) {
  console.log('변경된 결과 파일 없음 — commit 생략');
  process.exit(0);
}
console.log(status.stdout);

run('git', ['add', 'kream/results/'], { cwd: REPO_ROOT });
run('git', ['commit', '-m', `chore(kream): daily update ${DATE_TAG}`], { cwd: REPO_ROOT });
run('git', ['push'], { cwd: REPO_ROOT });

console.log(`\n✅ 완료 ${new Date().toISOString()}`);
