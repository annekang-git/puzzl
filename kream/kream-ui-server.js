/**
 * kream-ui-server.js
 * KREAM 시세 비교 + 마진 필터 웹 UI
 *
 * 사용법:
 *   node kream-ui-server.js               # 포트 3002
 *   PORT=4000 node kream-ui-server.js     # 다른 포트
 *
 * 접속: http://localhost:3002
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3002;
const RESULTS_DIR = path.join(__dirname, 'results');

const app = express();
app.use(express.json());

// 최신 결과 파일 찾기
function findLatestResultFile() {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith('kream_market_') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(RESULTS_DIR, files[0]) : null;
}

// 파일 목록 (드롭다운)
app.get('/api/files', (req, res) => {
  if (!fs.existsSync(RESULTS_DIR)) return res.json({ files: [] });
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith('kream_market_') && f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(RESULTS_DIR, f)).mtime,
      size: fs.statSync(path.join(RESULTS_DIR, f)).size,
    }));
  res.json({ files });
});

// 결과 데이터
app.get('/api/data', (req, res) => {
  const fileName = req.query.file;
  const filePath = fileName ? path.join(RESULTS_DIR, fileName) : findLatestResultFile();
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'No result file found', dir: RESULTS_DIR });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    res.json({ ...data, _file: path.basename(filePath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🍯 꿀단지: 모든 브랜드 최신 파일에서 즉시매도(highest_bid) 마진 > 0% 인 상품만 추출
app.get('/api/honey-data', (req, res) => {
  if (!fs.existsSync(RESULTS_DIR)) return res.json({ brands: [], results: [] });

  const BRAND_RE = /^kream_market_([a-z0-9_]+)_(\d{4})\.json$/;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => BRAND_RE.test(f))
    .map((f) => {
      const m = f.match(BRAND_RE);
      return { f, slug: m[1], date: m[2] };
    });

  // 브랜드별 최신 (파일명의 MMDD 가 큰 것) 파일 1개만 선택
  // git pull 후 mtime 이 모두 동일해질 수 있어 mtime 대신 파일명 날짜로 비교.
  const latestPerBrand = {};
  for (const item of files) {
    if (!latestPerBrand[item.slug] || latestPerBrand[item.slug].date < item.date) {
      latestPerBrand[item.slug] = item;
    }
  }

  const allResults = [];
  const brandsList = [];
  for (const slug of Object.keys(latestPerBrand).sort()) {
    const info = latestPerBrand[slug];
    brandsList.push({ slug, file: info.f, date: info.date });
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, info.f), 'utf-8'));
      for (const r of (data.results || [])) {
        // 매칭 + EUR 가격 + 즉시매도 bid 존재 (양수 마진은 frontend 에서 EUR rate/fee 적용해서 계산)
        if (!r.matched || r.eur_price == null) continue;
        const bid = r.market?.highest_bid;
        if (bid == null || bid <= 0) continue;
        allResults.push({ ...r, brand_slug: slug, _file: info.f });
      }
    } catch (_) {}
  }

  res.json({ fetched_at: new Date().toISOString(), brands: brandsList, total_with_bid: allResults.length, results: allResults });
});

// 🎯 자동입찰: 모든 브랜드 최신 파일에서 매칭+EUR가격 있는 상품 전체 반환
//    (빈집=판매입찰 없음 도 포함해야 하므로 bid 필터 없음. 조건 판정은 frontend)
app.get('/api/autobid-data', (req, res) => {
  if (!fs.existsSync(RESULTS_DIR)) return res.json({ brands: [], results: [] });
  const BRAND_RE = /^kream_market_([a-z0-9_]+)_(\d{4})\.json$/;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => BRAND_RE.test(f))
    .map((f) => { const m = f.match(BRAND_RE); return { f, slug: m[1], date: m[2] }; });
  const latestPerBrand = {};
  for (const item of files) {
    if (!latestPerBrand[item.slug] || latestPerBrand[item.slug].date < item.date) latestPerBrand[item.slug] = item;
  }
  const allResults = [];
  const brandsList = [];
  for (const slug of Object.keys(latestPerBrand).sort()) {
    const info = latestPerBrand[slug];
    brandsList.push({ slug, file: info.f, date: info.date });
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, info.f), 'utf-8'));
      for (const r of (data.results || [])) {
        if (!r.matched || r.eur_price == null) continue;
        allResults.push({ ...r, brand_slug: slug, _file: info.f });
      }
    } catch (_) {}
  }
  res.json({ fetched_at: new Date().toISOString(), brands: brandsList, total: allResults.length, results: allResults });
});

// 메인 UI
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KREAM 시세 비교</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Pretendard', sans-serif;
    margin: 0; background: #fafafa; color: #222; font-size: 14px;
  }
  header { background: #222; color: #fff; padding: 16px 24px; display: flex; align-items: center; gap: 24px; }
  header h1 { margin: 0; font-size: 18px; }
  header .meta { font-size: 12px; opacity: 0.7; }
  main { padding: 20px; max-width: 1500px; margin: 0 auto; }

  .controls {
    background: #fff; border: 1px solid #e0e0e0; border-radius: 8px;
    padding: 16px; margin-bottom: 16px; display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-end;
  }
  .control-group { display: flex; flex-direction: column; gap: 4px; }
  .control-group label { font-size: 11px; color: #666; font-weight: 600; text-transform: uppercase; }
  .control-group input, .control-group select {
    padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px;
    background: #fff; min-width: 120px;
  }
  .control-group input:focus, .control-group select:focus { outline: 2px solid #ef6253; }
  .stat { background: #f4f4f4; padding: 6px 12px; border-radius: 6px; font-size: 12px; }
  .stat strong { color: #ef6253; }

  table { width: 100%; background: #fff; border-collapse: collapse; border: 1px solid #e0e0e0; border-radius: 8px; }
  thead { background: #f8f8f8; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #ebebeb; }
  th { font-size: 11px; color: #666; font-weight: 700; text-transform: uppercase; cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { background: #f0f0f0; }
  th.sorted::after { content: ' ▼'; color: #ef6253; font-size: 9px; }
  th.sorted.asc::after { content: ' ▲'; }
  tbody tr:hover { background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.sku { font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #555; }
  td.sku a { color: #555; text-decoration: none; border-bottom: 1px dotted #aaa; }
  td.sku a:hover { color: #ef6253; border-bottom-color: #ef6253; }
  td.name { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td a { color: #ef6253; text-decoration: none; }
  td a:hover { text-decoration: underline; }

  .margin { font-weight: 700; padding: 2px 8px; border-radius: 4px; display: inline-block; }
  .margin.positive { background: #e8f7ee; color: #22aa55; }
  .margin.negative { background: #fcecec; color: #cc3344; }
  .margin.zero { background: #f0f0f0; color: #888; }

  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.error { background: #fee; color: #c33; }
  .badge.warn { background: #fff8e1; color: #b8860b; }

  details summary { cursor: pointer; color: #666; }
  details summary:hover { color: #222; }
  /* 상세는 좁은 셀에 안 갇히게 팝오버로 — 셀 폭과 무관하게 읽히도록 */
  td details { position: relative; }
  details[open] .sales-list {
    position: absolute; z-index: 20; right: 0; top: 100%;
    background: #fff; border: 1px solid #ddd; border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.18);
    padding: 12px 14px; min-width: 260px; max-width: 340px;
    max-height: 420px; overflow-y: auto; text-align: left;
  }
  details .sales-list { font-size: 12px; color: #555; margin-top: 6px; padding-left: 0; white-space: normal; }
  details .sales-list div { margin: 2px 0; }

  .empty { padding: 60px; text-align: center; color: #888; }
  .file-info { color: #ddd; font-size: 11px; }

  /* 탭 */
  .tabs { display: flex; gap: 4px; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 4px; margin-bottom: 16px; }
  .tab { flex: 0 0 auto; padding: 10px 20px; border: none; background: transparent; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; color: #666; transition: all 0.15s; }
  .tab:hover { background: #f4f4f4; color: #222; }
  .tab.active { background: #ef6253; color: white; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* 꿀단지 — 브랜드 컬럼 강조 */
  td.brand { font-size: 11px; font-weight: 700; color: #ef6253; text-transform: uppercase; white-space: nowrap; }

  /* 넓은 테이블은 컨테이너 안에서 가로 스크롤 (페이지 자체는 안 깨지게) */
  #table-container, #honey-table-container, #ab-table-container {
    overflow-x: auto; -webkit-overflow-scrolling: touch;
  }

  /* ── 모바일 (≤768px) ── */
  @media (max-width: 768px) {
    body { font-size: 13px; }
    header { padding: 12px 14px; flex-wrap: wrap; gap: 8px; }
    header h1 { font-size: 16px; }
    main { padding: 12px 10px; }

    /* 탭 — 가로 스크롤 가능하게 */
    .tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tab { padding: 9px 14px; font-size: 13px; white-space: nowrap; }

    /* 컨트롤 — 세로로 쌓고 input 폭 100% */
    .controls { padding: 12px; gap: 12px; }
    .control-group { flex: 1 1 100%; min-width: 0; }
    .control-group input, .control-group select { width: 100%; min-width: 0; }
    .stat { flex: 1 1 45%; text-align: center; }

    /* 테이블 — 셀 여백/폰트 축소, 상품명 폭 제한 완화 */
    th, td { padding: 7px 8px; }
    th { font-size: 10px; }
    td.name { max-width: 160px; }
    td.sku { font-size: 11px; }

    /* 자동입찰 조건 체크박스 줄바꿈 */
    .control-group > div { flex-wrap: wrap; }
  }
</style>
</head>
<body>
<header>
  <h1>💰 KREAM 시세 비교</h1>
  <div class="meta">
    <span id="file-name">-</span> ·
    <span id="fetched-at">-</span>
  </div>
</header>

<main>
  <div class="tabs">
    <button class="tab active" data-tab="normal" onclick="switchTab('normal')">📊 브랜드별</button>
    <button class="tab"        data-tab="honey"  onclick="switchTab('honey')">🍯 꿀단지</button>
    <button class="tab"        data-tab="autobid" onclick="switchTab('autobid')">🎯 자동입찰</button>
  </div>

  <div id="tab-normal" class="tab-content active">
  <div class="controls">
    <div class="control-group">
      <label>결과 파일</label>
      <select id="file-select" onchange="loadData(this.value)"></select>
    </div>
    <div class="control-group">
      <label>EUR → KRW 환율</label>
      <input id="eur-rate" type="number" value="1740" step="10" onchange="render()">
    </div>
    <div class="control-group">
      <label>KREAM 수수료 (%)</label>
      <input id="fee-pct" type="number" value="0" step="0.5" onchange="render()">
    </div>
    <div class="control-group">
      <label>최소 마진율 (%)</label>
      <input id="min-margin" type="number" value="" step="1" placeholder="없음" onchange="render()">
    </div>
    <div class="control-group">
      <label>마진 기준</label>
      <select id="margin-basis" onchange="render()">
        <option value="bid">즉시 매도 (highest_bid)</option>
        <option value="ask">판매입찰 매칭 (lowest_ask - 100)</option>
        <option value="sale">최근 체결가 (last_sale)</option>
      </select>
    </div>
    <div class="control-group">
      <label>SKU 검색</label>
      <input id="sku-filter" type="text" placeholder="필터..." oninput="render()">
    </div>
    <div class="control-group">
      <label>상태</label>
      <select id="status-filter" onchange="render()">
        <option value="all">전체</option>
        <option value="matched">매칭만</option>
        <option value="failed">실패만</option>
      </select>
    </div>
    <div class="stat">총: <strong id="stat-total">0</strong></div>
    <div class="stat">표시: <strong id="stat-shown">0</strong></div>
  </div>

  <div id="table-container">
    <div class="empty">데이터 로딩중...</div>
  </div>
  </div><!-- /tab-normal -->

  <div id="tab-honey" class="tab-content">
    <div class="controls">
      <div class="control-group">
        <label>EUR → KRW 환율</label>
        <input id="honey-eur-rate" type="number" value="1740" step="10" onchange="renderHoney()">
      </div>
      <div class="control-group">
        <label>KREAM 수수료 (%)</label>
        <input id="honey-fee-pct" type="number" value="0" step="0.5" onchange="renderHoney()">
      </div>
      <div class="control-group">
        <label>최소 마진율 (%)</label>
        <input id="honey-min-margin" type="number" value="0" step="1" placeholder="0" onchange="renderHoney()">
      </div>
      <div class="control-group">
        <label>브랜드 필터</label>
        <select id="honey-brand-filter" onchange="renderHoney()">
          <option value="">전체 브랜드</option>
        </select>
      </div>
      <div class="control-group">
        <label>SKU 검색</label>
        <input id="honey-sku-filter" type="text" placeholder="필터..." oninput="renderHoney()">
      </div>
      <div class="stat">전체 입찰존재: <strong id="honey-total">0</strong></div>
      <div class="stat">표시(흑자): <strong id="honey-shown">0</strong></div>
    </div>

    <div id="honey-table-container">
      <div class="empty">꿀단지 로딩중...</div>
    </div>
  </div><!-- /tab-honey -->

  <div id="tab-autobid" class="tab-content">
    <div class="controls">
      <div class="control-group">
        <label>EUR → KRW 환율</label>
        <input id="ab-eur-rate" type="number" value="1740" step="10" onchange="renderAutobid()">
      </div>
      <div class="control-group">
        <label>브랜드 필터</label>
        <select id="ab-brand-filter" onchange="renderAutobid()">
          <option value="">전체 브랜드</option>
        </select>
      </div>
      <div class="control-group">
        <label>SKU 검색</label>
        <input id="ab-sku-filter" type="text" placeholder="필터..." oninput="renderAutobid()">
      </div>
      <div class="control-group">
        <label>조건 필터 (하나라도 충족 시 표시)</label>
        <div style="display:flex; gap:12px; padding-top:4px;">
          <label style="font-weight:400; text-transform:none; font-size:13px; cursor:pointer;"><input type="checkbox" id="ab-c1" checked onchange="renderAutobid()"> ① 순마진 25%↑</label>
          <label style="font-weight:400; text-transform:none; font-size:13px; cursor:pointer;"><input type="checkbox" id="ab-c2" checked onchange="renderAutobid()"> ② 절대마진 15만↑</label>
          <label style="font-weight:400; text-transform:none; font-size:13px; cursor:pointer;"><input type="checkbox" id="ab-c3" checked onchange="renderAutobid()"> ③ 빈집</label>
        </div>
      </div>
      <div class="stat">전체 매칭: <strong id="ab-total">0</strong></div>
      <div class="stat">표시: <strong id="ab-shown">0</strong></div>
    </div>

    <div style="font-size:12px; color:#777; margin-bottom:10px; line-height:1.7;">
      ① <b>순마진 25%↑</b> — 즉시매도 기준 최종 순마진 25% 이상 (빠른 판매 후보) ·
      ② <b>절대마진 15만↑</b> — 순이익 150,000원 이상 (고수익) ·
      ③ <b>빈집</b> — 판매입찰 없음(경쟁 판매자 X):
      <span style="color:#d4a017;">★★★★★ 구매입찰 있음</span>(즉시 진입) /
      <span style="color:#999;">★★★☆☆ 구매입찰 없음</span>(시장 선점)
    </div>

    <div id="ab-table-container">
      <div class="empty">자동입찰 로딩중...</div>
    </div>
  </div><!-- /tab-autobid -->
</main>

<script>
let RAW = null;
let SORT_KEY = 'margin';
let SORT_DESC = true;

const fmt = (n) => n == null ? '-' : Number(n).toLocaleString('ko-KR');
const fmtPct = (n) => n == null ? '-' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

// 사이즈 별칭 — 의미적으로 같은 사이즈 그룹
const UNIVERSAL_SIZES = new Set(['U', 'UNICA', 'FREE', 'ONE SIZE', 'ONESIZE', 'OS', 'F', 'UNI', 'UNIVERSAL']);
const SIZE_REGION_RE = /^(EU|US|UK|IT|FR|JP|JPN|KR|KOR|EUR)\s+|\s+(EU|US|UK|IT|FR|JP|JPN|KR|KOR|EUR)$/i;
function normalizeSize(s) { return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' '); }
function stripSizeRegion(s) { return normalizeSize(s).replace(SIZE_REGION_RE, '').trim(); }
function isOptionEffectivelyMatched(row) {
  // 1) 그냥 일치
  if (!row.option_mismatch) return true;
  // 2) KREAM 옵션이 1개뿐 → 그게 무엇이든 매칭으로 간주 (단일사이즈 상품)
  if (row.kream_options_available?.length === 1) return true;
  // 3) 요청-KREAM 모두 universal one-size 그룹이면 매칭
  const req = normalizeSize(row.option);
  const got = normalizeSize(row.kream_option);
  if (UNIVERSAL_SIZES.has(req) && UNIVERSAL_SIZES.has(got)) return true;
  // 4) 지역 접두/접미사 (EU 42 ↔ 42, 42 IT ↔ 42) 떼고 같으면 매칭
  const sReq = stripSizeRegion(req), sGot = stripSizeRegion(got);
  if (sReq && sGot && sReq === sGot) return true;
  return false;
}

function computeMargin(row, eurRate, feePct, basis) {
  if (!row.matched) return { _no: 'matchFail' };
  if (row.eur_price == null) return { _no: 'noEur' };
  const cost = row.eur_price * eurRate;
  if (cost <= 0) return { _no: 'badCost' };
  let sellPrice, basisLabel;
  if (basis === 'bid') {
    sellPrice = row.market?.highest_bid; basisLabel = '즉시매도';
  } else if (basis === 'ask') {
    sellPrice = row.market?.lowest_ask != null ? row.market.lowest_ask - 100 : null; basisLabel = '판매입찰';
  } else {
    sellPrice = row.market?.last_sale_price; basisLabel = '최근체결';
  }
  if (sellPrice == null) {
    // 기준 가격 없음 → 다른 기준이라도 있는지 알려주기
    const available = [];
    if (row.market?.highest_bid != null) available.push('bid');
    if (row.market?.lowest_ask != null) available.push('ask');
    if (row.market?.last_sale_price != null) available.push('sale');
    return { _no: 'noBasisPrice', basisLabel, available };
  }
  const netSell = sellPrice * (1 - feePct / 100);
  // 수수료제외 순익 = (판매금 - 매입액) - 5000원(배송비) - 판매금×5.7%(KREAM 수수료)
  const netProfit = (sellPrice - cost) - 5000 - sellPrice * 0.057;
  const netPct = netProfit / cost * 100;
  return { cost, sellPrice, netSell, profit: netSell - cost, pct: (netSell - cost) / cost * 100, netProfit, netPct };
}

async function loadFiles() {
  const r = await fetch('/api/files');
  const j = await r.json();
  const sel = document.getElementById('file-select');
  sel.innerHTML = '';
  if (j.files.length === 0) {
    sel.innerHTML = '<option>(없음)</option>';
    return null;
  }
  j.files.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.name;
    o.textContent = f.name;
    sel.appendChild(o);
  });
  return j.files[0].name;
}

async function loadData(file) {
  const url = file ? '/api/data?file=' + encodeURIComponent(file) : '/api/data';
  const r = await fetch(url);
  if (!r.ok) {
    document.getElementById('table-container').innerHTML = '<div class="empty">에러: 결과 파일을 찾을 수 없습니다 (' + r.status + ')</div>';
    return;
  }
  RAW = await r.json();
  document.getElementById('file-name').textContent = RAW._file || '-';
  document.getElementById('fetched-at').textContent = RAW.fetched_at ? new Date(RAW.fetched_at).toLocaleString('ko-KR') : '-';
  render();
}

function sortBy(key) {
  if (SORT_KEY === key) SORT_DESC = !SORT_DESC;
  else { SORT_KEY = key; SORT_DESC = true; }
  render();
}

function render() {
  if (!RAW) return;
  const eurRate = Number(document.getElementById('eur-rate').value) || 0;
  const feePct = Number(document.getElementById('fee-pct').value) || 0;
  const minMargin = document.getElementById('min-margin').value;
  const basis = document.getElementById('margin-basis').value;
  const skuFilter = document.getElementById('sku-filter').value.toUpperCase().trim();
  const statusFilter = document.getElementById('status-filter').value;

  // 마진 계산 & 필터
  let rows = (RAW.results || []).map((r) => {
    const m = computeMargin(r, eurRate, feePct, basis);
    const optOk = isOptionEffectivelyMatched(r);
    return { ...r, _margin: m, _optOk: optOk };
  });

  if (statusFilter === 'matched') rows = rows.filter((r) => r.matched);
  if (statusFilter === 'failed') rows = rows.filter((r) => !r.matched);
  if (skuFilter) rows = rows.filter((r) => (r.sku || '').toUpperCase().includes(skuFilter) || (r.b2b_sku || '').toUpperCase().includes(skuFilter));
  if (minMargin !== '') {
    const min = Number(minMargin);
    rows = rows.filter((r) => r._margin && typeof r._margin.pct === 'number' && r._margin.pct >= min);
  }

  // 정렬 — 일반 컬럼 기준
  {
    rows.sort((a, b) => {
      const get = (r) => {
        switch (SORT_KEY) {
          case 'sku': return r.sku || '';
          case 'option': return r.option || '';
          case 'stock': return r.stock ?? -1;
          case 'eur': return r.eur_price ?? -1;
          case 'cost': return r._margin?.cost ?? -1;
          case 'last': return r.market?.last_sale_price ?? -1;
          case 'ask': return r.market?.lowest_ask ?? -1;
          case 'bid': return r.market?.highest_bid ?? -1;
          case 'margin': return r._margin?.pct ?? -Infinity;
          case 'profit': return r._margin?.profit ?? -Infinity;
          case 'netprofit': return r._margin?.netProfit ?? -Infinity;
          case 'netpct': return r._margin?.netPct ?? -Infinity;
          default: return 0;
        }
      };
      const av = get(a), bv = get(b);
      if (typeof av === 'number') return SORT_DESC ? bv - av : av - bv;
      return SORT_DESC ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
    });
  }

  document.getElementById('stat-total').textContent = (RAW.results || []).length;
  document.getElementById('stat-shown').textContent = rows.length;

  // 테이블 렌더
  const ths = (key, label) => {
    const cls = key === SORT_KEY ? 'sorted ' + (SORT_DESC ? '' : 'asc') : '';
    return '<th class="' + cls + '" onclick="sortBy(\\''+ key +'\\')">' + label + '</th>';
  };

  let html = '<table><thead><tr>';
  html += ths('sku', 'SKU');
  html += ths('option', '옵션');
  html += ths('stock', '재고');
  html += '<th>상품명</th>';
  html += ths('eur', 'EUR');
  html += ths('cost', '원가(₩)');
  html += ths('last', '최근체결');
  html += ths('ask', '판매입찰');
  html += ths('bid', '구매입찰');
  html += ths('profit', '순익(₩)');
  html += ths('margin', '마진%');
  html += ths('netprofit', '수수료제외 순익');
  html += ths('netpct', '순 마진%');
  html += '<th>상세</th>';
  html += '</tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="14" class="empty">표시할 행이 없습니다</td></tr>';
  } else {
    const REASON_LABEL = {
      noEur: '<span class="badge warn">EUR가격없음</span>',
      noBasisPrice: '<span class="badge warn">기준가없음</span>',
      matchFail: '<span class="badge error">매칭실패</span>',
    };
    for (const r of rows) {
      if (!r.matched) {
        html += '<tr>';
        html += '<td class="sku">' + b2bLink(r) + '</td>';
        html += '<td>' + escapeHtml(r.option || '-') + '</td>';
        html += '<td class="num">' + (r.stock != null ? r.stock : '-') + '</td>';
        html += '<td colspan="10"><span class="badge error">매칭 실패</span> ' + escapeHtml(r.error || '') + '</td>';
        html += '<td>-</td>';
        html += '</tr>';
        continue;
      }
      const m = r._margin;
      const hasMargin = m && typeof m.pct === 'number';
      const marginCls = hasMargin ? (m.pct >= 0 ? 'positive' : 'negative') : 'zero';
      // 옵션 표시 — 효과적 매칭이면 깔끔히, 진짜 불일치만 빨간 뱃지
      let optionCell = escapeHtml(r.option || '-');
      if (r.option_mismatch && r._optOk) {
        // 의미적으론 같지만 이름 다름 (예: U ↔ ONE SIZE)
        optionCell += ' <span style="color:#888;font-size:11px;">→' + escapeHtml(r.kream_option) + '</span>';
      } else if (r.option_mismatch && !r._optOk) {
        optionCell += ' <span class="badge warn" title="요청 옵션이 KREAM에 없음. 대체: ' + escapeHtml(r.kream_option || '-') + '">옵션≠</span>';
      }
      // 마진 셀 — 사유 분기
      let marginCell;
      if (hasMargin) {
        marginCell = '<span class="margin ' + marginCls + '">' + fmtPct(m.pct) + '</span>';
      } else if (m && m._no === 'noBasisPrice') {
        const altHint = m.available && m.available.length ? (' (다른기준: ' + m.available.join('/') + ')') : '';
        marginCell = '<span class="badge warn" title="' + escapeHtml(m.basisLabel) + ' 가격 없음' + altHint + '">' + escapeHtml(m.basisLabel) + '없음</span>';
      } else if (m && m._no === 'noEur') {
        marginCell = REASON_LABEL.noEur;
      } else if (!r.kream_options_available?.length) {
        marginCell = '<span class="badge warn">거래없음</span>';
      } else {
        marginCell = '<span class="badge warn">계산불가</span>';
      }
      // 재고 셀 — 숫자로 표시, 1 이하면 빨간색 강조
      const stockCell = r.stock != null
        ? '<span style="' + (r.stock <= 1 ? 'color:#cc3344;font-weight:600;' : '') + '">' + r.stock + '</span>'
        : '-';
      html += '<tr>';
      html += '<td class="sku">' + b2bLink(r) + '</td>';
      html += '<td>' + optionCell + '</td>';
      html += '<td class="num">' + stockCell + '</td>';
      html += '<td class="name"><a href="' + (r.product_url || '#') + '" target="_blank">' + escapeHtml(r.product_name_ko || r.name || ('pid=' + r.product_id)) + '</a></td>';
      html += '<td class="num">' + (r.eur_price != null ? fmt(r.eur_price) + '€' : '-') + '</td>';
      html += '<td class="num">' + (r.eur_price != null ? fmt(Math.round(r.eur_price * eurRate)) : '-') + '</td>';
      html += '<td class="num">' + fmt(r.market?.last_sale_price) + '</td>';
      html += '<td class="num">' + fmt(r.market?.lowest_ask) + '</td>';
      html += '<td class="num">' + fmt(r.market?.highest_bid) + '</td>';
      html += '<td class="num">' + (hasMargin ? fmt(Math.round(m.profit)) : '-') + '</td>';
      html += '<td class="num">' + marginCell + '</td>';
      // 수수료제외 순익 = (판매금-매입액) - 5000 - 판매금×5.7%
      if (hasMargin) {
        const npCls = m.netProfit >= 0 ? 'positive' : 'negative';
        html += '<td class="num">' + fmt(Math.round(m.netProfit)) + '</td>';
        html += '<td class="num"><span class="margin ' + npCls + '">' + fmtPct(m.netPct) + '</span></td>';
      } else {
        html += '<td class="num">-</td><td class="num">-</td>';
      }
      html += '<td><details><summary>📊</summary>' + renderDetail(r) + '</details></td>';
      html += '</tr>';
    }
  }
  html += '</tbody></table>';
  document.getElementById('table-container').innerHTML = html;
}

function renderDetail(r) {
  let s = '<div class="sales-list">';
  if (r.kream_options_available && r.kream_options_available.length > 0) {
    s += '<div><b>KREAM 옵션:</b> 요청="' + escapeHtml(r.option || '-') + '" → 채택="' + escapeHtml(r.kream_option || '-') + '"</div>';
    s += '<div><b>사용가능:</b> ' + r.kream_options_available.map(escapeHtml).join(', ') + '</div>';
    if (r.option_mismatch) s += '<div style="color:#cc3344;"><b>⚠️ 요청 옵션 KREAM에 없음</b></div>';
  } else if (r.matched) {
    s += '<div style="color:#888;"><b>거래 데이터 없음</b> — KREAM 상품 페이지에 체결/입찰 기록 0건 (모달도 안 열림)</div>';
  }
  s += '<div style="margin-top:6px;"><b>최근 체결 ' + (r.totals?.sales || 0) + '건:</b></div>';
  for (const x of (r.sales || [])) s += '<div>· ' + fmt(x.price) + '원 (' + (x.date_text || x.date_created) + ')</div>';
  s += '<div style="margin-top:6px;"><b>판매 입찰 ' + (r.totals?.asks || 0) + '건 (top 5):</b></div>';
  for (const x of (r.asks || [])) s += '<div>· ' + fmt(x.price) + '원 × ' + (x.quantity || 1) + '</div>';
  s += '<div style="margin-top:6px;"><b>구매 입찰 ' + (r.totals?.bids || 0) + '건 (top 5):</b></div>';
  for (const x of (r.bids || [])) s += '<div>· ' + fmt(x.price) + '원 × ' + (x.quantity || 1) + '</div>';
  if (r.market?.change_text) s += '<div style="margin-top:6px; color:#ef6253;">전일 대비: ' + escapeHtml(r.market.change_text) + '</div>';
  s += '</div>';
  return s;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// SKU 클릭 시 b2bfashion 검색 페이지로 이동.
// 검색어는 원본 reference (b2b_sku) 우선, 없으면 sku.
function b2bLink(row) {
  const q = row.b2b_sku || row.sku || '';
  const url = 'https://b2bfashion.online/search?controller=search&orderby=position&orderway=desc&s=' + encodeURIComponent(q) + '&submit_search=';
  const title = 'B2B: ' + (row.b2b_sku || '-') + '  (click → b2bfashion 검색)';
  return '<a href="' + url + '" target="_blank" rel="noopener" title="' + escapeHtml(title) + '">' + escapeHtml(row.sku || '') + '</a>';
}

// ─────────────────────────────────────────────
// 🍯 꿀단지 탭 — 모든 브랜드 즉시매도 흑자 통합
// ─────────────────────────────────────────────
let HONEY = null;
let HONEY_SORT_KEY = 'bidPct';
let HONEY_SORT_DESC = true;

async function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === 'tab-' + name));
  if (name === 'honey' && !HONEY) await loadHoneyData();
  if (name === 'autobid' && !AUTOBID) await loadAutobidData();
}

async function loadHoneyData() {
  document.getElementById('honey-table-container').innerHTML = '<div class="empty">꿀단지 데이터 수집중...</div>';
  const r = await fetch('/api/honey-data');
  if (!r.ok) {
    document.getElementById('honey-table-container').innerHTML = '<div class="empty">에러: ' + r.status + '</div>';
    return;
  }
  HONEY = await r.json();
  // 브랜드 필터 옵션 채우기
  const sel = document.getElementById('honey-brand-filter');
  sel.innerHTML = '<option value="">전체 브랜드 (' + (HONEY.brands?.length || 0) + ')</option>';
  for (const b of (HONEY.brands || [])) {
    const o = document.createElement('option');
    o.value = b.slug;
    o.textContent = b.slug + '  (' + b.date + ')';
    sel.appendChild(o);
  }
  renderHoney();
}

function sortHoney(key) {
  if (HONEY_SORT_KEY === key) HONEY_SORT_DESC = !HONEY_SORT_DESC;
  else { HONEY_SORT_KEY = key; HONEY_SORT_DESC = true; }
  renderHoney();
}

function renderHoney() {
  if (!HONEY) return;
  const eurRate = Number(document.getElementById('honey-eur-rate').value) || 0;
  const feePct = Number(document.getElementById('honey-fee-pct').value) || 0;
  const minMargin = Number(document.getElementById('honey-min-margin').value);
  const brandFilter = document.getElementById('honey-brand-filter').value;
  const skuFilter = document.getElementById('honey-sku-filter').value.toUpperCase().trim();

  // 각 row 의 즉시매도 마진 계산 + 옵션 매칭 보정
  let rows = (HONEY.results || []).map((r) => {
    const cost = (r.eur_price || 0) * eurRate;
    const bid = r.market?.highest_bid;
    const net = bid * (1 - feePct / 100);
    const bidPct = (cost > 0) ? (net - cost) / cost * 100 : null;
    const profit = (cost > 0) ? Math.round(net - cost) : null;
    // 수수료제외 순익 = (판매금-매입액) - 5000 - 판매금×5.7%
    const netProfit = (cost > 0 && bid != null) ? Math.round((bid - cost) - 5000 - bid * 0.057) : null;
    const netPct = (netProfit != null) ? netProfit / cost * 100 : null;
    const optOk = isOptionEffectivelyMatched(r);
    return { ...r, _cost: cost, _bidPct: bidPct, _profit: profit, _netProfit: netProfit, _netPct: netPct, _optOk: optOk };
  });
  // 흑자만 (즉시매도 마진 >= minMargin)
  rows = rows.filter((r) => r._bidPct != null && r._bidPct >= minMargin);
  if (brandFilter) rows = rows.filter((r) => r.brand_slug === brandFilter);
  if (skuFilter)   rows = rows.filter((r) => (r.sku || '').toUpperCase().includes(skuFilter) || (r.b2b_sku || '').toUpperCase().includes(skuFilter));

  // 정렬
  rows.sort((a, b) => {
    const get = (r) => {
      switch (HONEY_SORT_KEY) {
        case 'brand':   return r.brand_slug || '';
        case 'sku':     return r.sku || '';
        case 'option':  return r.option || '';
        case 'stock':   return r.stock ?? -1;
        case 'eur':     return r.eur_price ?? -1;
        case 'cost':    return r._cost ?? -1;
        case 'last':    return r.market?.last_sale_price ?? -1;
        case 'ask':     return r.market?.lowest_ask ?? -1;
        case 'bid':     return r.market?.highest_bid ?? -1;
        case 'bidPct':  return r._bidPct ?? -Infinity;
        case 'profit':  return r._profit ?? -Infinity;
        case 'netprofit': return r._netProfit ?? -Infinity;
        case 'netpct':    return r._netPct ?? -Infinity;
        default: return 0;
      }
    };
    const av = get(a), bv = get(b);
    if (typeof av === 'number') return HONEY_SORT_DESC ? bv - av : av - bv;
    return HONEY_SORT_DESC ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
  });

  document.getElementById('honey-total').textContent = (HONEY.results || []).length;
  document.getElementById('honey-shown').textContent = rows.length;

  // 테이블
  const ths = (key, label) => {
    const cls = key === HONEY_SORT_KEY ? 'sorted ' + (HONEY_SORT_DESC ? '' : 'asc') : '';
    return '<th class="' + cls + '" onclick="sortHoney(\\'' + key + '\\')">' + label + '</th>';
  };

  let html = '<table><thead><tr>';
  html += ths('brand', '브랜드');
  html += ths('sku', 'SKU');
  html += ths('option', '옵션');
  html += ths('stock', '재고');
  html += '<th>상품명</th>';
  html += ths('eur', 'EUR');
  html += ths('cost', '원가(₩)');
  html += ths('last', '최근체결');
  html += ths('ask', '판매입찰');
  html += ths('bid', '구매입찰');
  html += ths('profit', '순익(₩)');
  html += ths('bidPct', '마진%');
  html += ths('netprofit', '수수료제외 순익');
  html += ths('netpct', '순 마진%');
  html += '<th>상세</th>';
  html += '</tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="15" class="empty">표시할 행이 없습니다 (흑자 즉시매도 없음)</td></tr>';
  } else {
    for (const r of rows) {
      const stockCell = r.stock != null
        ? '<span style="' + (r.stock <= 1 ? 'color:#cc3344;font-weight:600;' : '') + '">' + r.stock + '</span>'
        : '-';
      // 옵션 미스매치 표시 (브랜드별 탭 과 동일 패턴)
      let optionCell = escapeHtml(r.option || '-');
      if (r.option_mismatch && r._optOk) {
        optionCell += ' <span style="color:#888;font-size:11px;">→' + escapeHtml(r.kream_option) + '</span>';
      } else if (r.option_mismatch && !r._optOk) {
        optionCell += ' <span class="badge warn" title="요청 옵션이 KREAM에 없음. 대체: ' + escapeHtml(r.kream_option || '-') + '">옵션≠</span>';
      }
      html += '<tr>';
      html += '<td class="brand">' + escapeHtml(r.brand_slug) + '</td>';
      html += '<td class="sku">' + b2bLink(r) + '</td>';
      html += '<td>' + optionCell + '</td>';
      html += '<td class="num">' + stockCell + '</td>';
      html += '<td class="name"><a href="' + (r.product_url || '#') + '" target="_blank">' + escapeHtml(r.product_name_ko || ('pid=' + r.product_id)) + '</a></td>';
      html += '<td class="num">' + (r.eur_price != null ? fmt(r.eur_price) + '€' : '-') + '</td>';
      html += '<td class="num">' + fmt(Math.round(r._cost)) + '</td>';
      html += '<td class="num">' + fmt(r.market?.last_sale_price) + '</td>';
      html += '<td class="num">' + fmt(r.market?.lowest_ask) + '</td>';
      html += '<td class="num">' + fmt(r.market?.highest_bid) + '</td>';
      html += '<td class="num">' + fmt(r._profit) + '</td>';
      html += '<td class="num"><span class="margin positive">' + fmtPct(r._bidPct) + '</span></td>';
      if (r._netProfit != null) {
        const npCls = r._netProfit >= 0 ? 'positive' : 'negative';
        html += '<td class="num">' + fmt(r._netProfit) + '</td>';
        html += '<td class="num"><span class="margin ' + npCls + '">' + fmtPct(r._netPct) + '</span></td>';
      } else {
        html += '<td class="num">-</td><td class="num">-</td>';
      }
      html += '<td><details><summary>📊</summary>' + renderDetail(r) + '</details></td>';
      html += '</tr>';
    }
  }
  html += '</tbody></table>';
  document.getElementById('honey-table-container').innerHTML = html;
}

// ─────────────────────────────────────────────
// 🎯 자동입찰 탭 — 순마진/절대마진/빈집 조건
// ─────────────────────────────────────────────
let AUTOBID = null;
let AB_SORT_KEY = 'netProfit';
let AB_SORT_DESC = true;

async function loadAutobidData() {
  document.getElementById('ab-table-container').innerHTML = '<div class="empty">자동입찰 데이터 수집중...</div>';
  const r = await fetch('/api/autobid-data');
  if (!r.ok) { document.getElementById('ab-table-container').innerHTML = '<div class="empty">에러: ' + r.status + '</div>'; return; }
  AUTOBID = await r.json();
  const sel = document.getElementById('ab-brand-filter');
  sel.innerHTML = '<option value="">전체 브랜드 (' + (AUTOBID.brands?.length || 0) + ')</option>';
  for (const b of (AUTOBID.brands || [])) {
    const o = document.createElement('option');
    o.value = b.slug; o.textContent = b.slug + '  (' + b.date + ')';
    sel.appendChild(o);
  }
  renderAutobid();
}

function sortAutobid(key) {
  if (AB_SORT_KEY === key) AB_SORT_DESC = !AB_SORT_DESC;
  else { AB_SORT_KEY = key; AB_SORT_DESC = true; }
  renderAutobid();
}

// 자동입찰 판정: 각 row 에 조건/빈집등급 계산.
// 순익 = (판매금-매입액) - 5000 - 판매금×5.7%.  판매금 = 즉시매도(구매입찰 highest_bid).
function abCompute(r, eurRate) {
  const cost = (r.eur_price || 0) * eurRate;
  const ask = r.market?.lowest_ask;
  const bid = r.market?.highest_bid;
  const hasAsk = ask != null && ask > 0;   // 판매입찰(경쟁 판매자) 존재
  const hasBid = bid != null && bid > 0;   // 구매입찰(대기 수요) 존재
  const emptyHouse = !hasAsk;              // 빈집 = 판매입찰 없음
  // 순마진 — 즉시매도(구매입찰) 가격 기준. 구매입찰 없으면 계산 불가.
  let netProfit = null, netPct = null;
  if (hasBid && cost > 0) {
    netProfit = Math.round((bid - cost) - 5000 - bid * 0.057);
    netPct = netProfit / cost * 100;
  }
  const c1 = netPct != null && netPct >= 25;      // ① 순마진 25%↑
  const c2 = netProfit != null && netProfit >= 150000; // ② 절대마진 15만↑
  const c3 = emptyHouse;                            // ③ 빈집
  const stars = emptyHouse ? (hasBid ? 5 : 3) : 0;  // ★★★★★ 구매입찰있음 / ★★★☆☆ 없음
  return { cost, ask, bid, hasAsk, hasBid, emptyHouse, netProfit, netPct, c1, c2, c3, stars };
}

function renderAutobid() {
  if (!AUTOBID) return;
  const eurRate = Number(document.getElementById('ab-eur-rate').value) || 0;
  const brandFilter = document.getElementById('ab-brand-filter').value;
  const skuFilter = document.getElementById('ab-sku-filter').value.toUpperCase().trim();
  const useC1 = document.getElementById('ab-c1').checked;
  const useC2 = document.getElementById('ab-c2').checked;
  const useC3 = document.getElementById('ab-c3').checked;

  let rows = (AUTOBID.results || []).map((r) => ({ ...r, _ab: abCompute(r, eurRate), _optOk: isOptionEffectivelyMatched(r) }));

  // 조건: 선택된 것 중 하나라도 충족 (OR)
  rows = rows.filter((r) => {
    const a = r._ab;
    return (useC1 && a.c1) || (useC2 && a.c2) || (useC3 && a.c3);
  });
  if (brandFilter) rows = rows.filter((r) => r.brand_slug === brandFilter);
  if (skuFilter) rows = rows.filter((r) => (r.sku || '').toUpperCase().includes(skuFilter) || (r.b2b_sku || '').toUpperCase().includes(skuFilter));

  rows.sort((a, b) => {
    const get = (r) => {
      switch (AB_SORT_KEY) {
        case 'brand':     return r.brand_slug || '';
        case 'sku':       return r.sku || '';
        case 'stock':     return r.stock ?? -1;
        case 'cost':      return r._ab.cost ?? -1;
        case 'ask':       return r.market?.lowest_ask ?? -1;
        case 'bid':       return r.market?.highest_bid ?? -1;
        case 'netProfit': return r._ab.netProfit ?? -Infinity;
        case 'netPct':    return r._ab.netPct ?? -Infinity;
        case 'stars':     return r._ab.stars ?? -1;
        default: return 0;
      }
    };
    const av = get(a), bv = get(b);
    if (typeof av === 'number') return AB_SORT_DESC ? bv - av : av - bv;
    return AB_SORT_DESC ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
  });

  document.getElementById('ab-total').textContent = (AUTOBID.results || []).length;
  document.getElementById('ab-shown').textContent = rows.length;

  const ths = (key, label) => {
    const cls = key === AB_SORT_KEY ? 'sorted ' + (AB_SORT_DESC ? '' : 'asc') : '';
    return '<th class="' + cls + '" onclick="sortAutobid(\\'' + key + '\\')">' + label + '</th>';
  };

  let html = '<table><thead><tr>';
  html += ths('brand', '브랜드');
  html += ths('sku', 'SKU');
  html += '<th>옵션</th>';
  html += ths('stock', '재고');
  html += '<th>상품명</th>';
  html += ths('cost', '원가(₩)');
  html += ths('ask', '판매입찰');
  html += ths('bid', '구매입찰');
  html += ths('netProfit', '수수료제외 순익');
  html += ths('netPct', '순 마진%');
  html += ths('stars', '빈집');
  html += '<th>조건</th>';
  html += '<th>상세</th>';
  html += '</tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="13" class="empty">조건에 맞는 상품이 없습니다</td></tr>';
  } else {
    for (const r of rows) {
      const a = r._ab;
      const stockCell = r.stock != null
        ? '<span style="' + (r.stock <= 1 ? 'color:#cc3344;font-weight:600;' : '') + '">' + r.stock + '</span>' : '-';
      let optionCell = escapeHtml(r.option || '-');
      if (r.option_mismatch && r._optOk) optionCell += ' <span style="color:#888;font-size:11px;">→' + escapeHtml(r.kream_option) + '</span>';
      else if (r.option_mismatch && !r._optOk) optionCell += ' <span class="badge warn">옵션≠</span>';

      // 빈집 별점
      let starCell = '-';
      if (a.emptyHouse) {
        starCell = a.stars === 5
          ? '<span title="구매입찰 있음 — 즉시 진입" style="color:#d4a017;font-weight:700;">★★★★★</span>'
          : '<span title="구매입찰 없음 — 시장 선점" style="color:#999;">★★★☆☆</span>';
      }
      // 조건 뱃지
      let condCell = '';
      if (a.c1) condCell += '<span class="badge" style="background:#e8f7ee;color:#22aa55;">①25%↑</span> ';
      if (a.c2) condCell += '<span class="badge" style="background:#fff3e0;color:#e6820e;">②15만↑</span> ';
      if (a.c3) condCell += '<span class="badge" style="background:#eef3fc;color:#4a76c4;">③빈집</span>';

      const npCls = a.netProfit == null ? '' : (a.netProfit >= 0 ? 'positive' : 'negative');
      html += '<tr>';
      html += '<td class="brand">' + escapeHtml(r.brand_slug) + '</td>';
      html += '<td class="sku">' + b2bLink(r) + '</td>';
      html += '<td>' + optionCell + '</td>';
      html += '<td class="num">' + stockCell + '</td>';
      html += '<td class="name"><a href="' + (r.product_url || '#') + '" target="_blank">' + escapeHtml(r.product_name_ko || ('pid=' + r.product_id)) + '</a></td>';
      html += '<td class="num">' + fmt(Math.round(a.cost)) + '</td>';
      html += '<td class="num">' + (a.hasAsk ? fmt(a.ask) : '<span style="color:#4a76c4;">없음</span>') + '</td>';
      html += '<td class="num">' + (a.hasBid ? fmt(a.bid) : '-') + '</td>';
      html += '<td class="num">' + (a.netProfit != null ? fmt(a.netProfit) : '-') + '</td>';
      html += '<td class="num">' + (a.netPct != null ? '<span class="margin ' + npCls + '">' + fmtPct(a.netPct) + '</span>' : '-') + '</td>';
      html += '<td class="num">' + starCell + '</td>';
      html += '<td>' + condCell + '</td>';
      html += '<td><details><summary>📊</summary>' + renderDetail(r) + '</details></td>';
      html += '</tr>';
    }
  }
  html += '</tbody></table>';
  document.getElementById('ab-table-container').innerHTML = html;
}

(async () => {
  const f = await loadFiles();
  await loadData(f);
})();
</script>
</body>
</html>
`;

app.listen(PORT, () => {
  console.log('═'.repeat(60));
  console.log('💰 KREAM 시세 비교 UI');
  console.log('═'.repeat(60));
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`📁 결과 디렉토리: ${RESULTS_DIR}`);
  const latest = findLatestResultFile();
  if (latest) console.log(`📄 최신 결과: ${path.basename(latest)}`);
  else console.log('⚠️  결과 파일 없음 — fetch-product-market.js 먼저 실행하세요');
  console.log('═'.repeat(60));
});
