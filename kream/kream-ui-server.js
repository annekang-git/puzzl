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

// 메인 UI
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
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

  table { width: 100%; background: #fff; border-collapse: collapse; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
  thead { background: #f8f8f8; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #ebebeb; }
  th { font-size: 11px; color: #666; font-weight: 700; text-transform: uppercase; cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { background: #f0f0f0; }
  th.sorted::after { content: ' ▼'; color: #ef6253; font-size: 9px; }
  th.sorted.asc::after { content: ' ▲'; }
  tbody tr:hover { background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.sku { font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #555; }
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
  details .sales-list { font-size: 12px; color: #555; margin-top: 6px; padding-left: 12px; }
  details .sales-list div { margin: 2px 0; }

  .empty { padding: 60px; text-align: center; color: #888; }
  .file-info { color: #ddd; font-size: 11px; }
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
        <option value="honey">🍯 꿀단지 (Honey Pot)</option>
        <option value="bid">즉시 매도 (highest_bid)</option>
        <option value="ask">최저호가 매칭 (lowest_ask - 100)</option>
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
</main>

<script>
let RAW = null;
let SORT_KEY = 'margin';
let SORT_DESC = true;

const fmt = (n) => n == null ? '-' : Number(n).toLocaleString('ko-KR');
const fmtPct = (n) => n == null ? '-' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

// 사이즈 별칭 — 의미적으로 같은 사이즈 그룹
const UNIVERSAL_SIZES = new Set(['U', 'UNICA', 'FREE', 'ONE SIZE', 'ONESIZE', 'OS', 'F', 'UNI', 'UNIVERSAL']);
function normalizeSize(s) { return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' '); }
function isOptionEffectivelyMatched(row) {
  // 1) 그냥 일치
  if (!row.option_mismatch) return true;
  // 2) KREAM 옵션이 1개뿐 → 그게 무엇이든 매칭으로 간주 (단일사이즈 상품)
  if (row.kream_options_available?.length === 1) return true;
  // 3) 요청-KREAM 모두 universal one-size 그룹이면 매칭
  const req = normalizeSize(row.option);
  const got = normalizeSize(row.kream_option);
  if (UNIVERSAL_SIZES.has(req) && UNIVERSAL_SIZES.has(got)) return true;
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
    sellPrice = row.market?.lowest_ask != null ? row.market.lowest_ask - 100 : null; basisLabel = '최저호가';
  } else if (basis === 'honey') {
    // 🍯 꿀단지: 마진 계산은 최저호가 - 100 우선, 없으면 체결가, 없으면 입찰가
    // (실제 판매 가능성에 가까운 기준)
    if (row.market?.lowest_ask != null) { sellPrice = row.market.lowest_ask - 100; basisLabel = '최저호가'; }
    else if (row.market?.last_sale_price != null) { sellPrice = row.market.last_sale_price; basisLabel = '최근체결'; }
    else { sellPrice = row.market?.highest_bid; basisLabel = '입찰'; }
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
  return { cost, sellPrice, netSell, profit: netSell - cost, pct: (netSell - cost) / cost * 100 };
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

  // 정렬 — basis 가 'honey' 이고 SORT_KEY 가 'margin' 이면 특수 multi-tier 정렬
  // (헤더 클릭으로 다른 컬럼 정렬할 땐 일반 정렬 적용)
  if (basis === 'honey' && SORT_KEY === 'margin') {
    // Tier 부여:
    //   1 = 양수 마진 (초록)
    //   2 = 판매호가 없고 구매입찰만 있는 것 (마진 부호 무관)
    //   3 = 음수 마진인데 구매입찰은 있는 것
    //   4 = 입찰도 호가도 없거나, 마진 계산 불가
    rows.forEach((r) => {
      const m = r._margin;
      const hasBid = r.market?.highest_bid != null && r.market.highest_bid > 0;
      const hasAsk = r.market?.lowest_ask != null && r.market.lowest_ask > 0;
      const pct = (m && typeof m.pct === 'number') ? m.pct : null;
      const cost = m?.cost ?? null;
      const bidGap = (hasBid && cost != null) ? Math.abs(cost - r.market.highest_bid) : Infinity;
      // 즉시매도(highest_bid) 기준 마진 % — tier 1 정렬에 사용
      const bidPct = (hasBid && cost != null && cost > 0)
        ? ((r.market.highest_bid * (1 - feePct / 100)) - cost) / cost * 100
        : null;

      let tier;
      if (pct != null && pct >= 0)              tier = 1;
      else if (!hasAsk && hasBid)               tier = 2;
      else if (pct != null && pct < 0 && hasBid) tier = 3;
      else                                       tier = 4;
      r._honeyTier = tier;
      r._honeyBidGap = bidGap;
      r._honeyPct = pct;
      r._honeyBidPct = bidPct;
    });
    rows.sort((a, b) => {
      // 1. tier 작은 게 먼저
      if (a._honeyTier !== b._honeyTier) return a._honeyTier - b._honeyTier;
      // 2. tier 1: 즉시매도(highest_bid) 기준 마진 큰 순.
      //    bid 없는 항목은 honey 마진 fallback (그래도 없으면 맨 아래).
      if (a._honeyTier === 1) {
        const av = a._honeyBidPct ?? a._honeyPct ?? -Infinity;
        const bv = b._honeyBidPct ?? b._honeyPct ?? -Infinity;
        return bv - av;
      }
      // 3. tier 2, 3: |원가 - 입찰가| 작은 순 (오름차순)
      if (a._honeyTier === 2 || a._honeyTier === 3) return a._honeyBidGap - b._honeyBidGap;
      // 4. tier 4: 마진 큰 순 (있으면)
      return (b._honeyPct ?? -Infinity) - (a._honeyPct ?? -Infinity);
    });
  } else {
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
  html += ths('ask', '최저호가');
  html += ths('bid', '최고입찰');
  html += ths('profit', '순익(₩)');
  html += ths('margin', '마진%');
  html += '<th>상세</th>';
  html += '</tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="12" class="empty">표시할 행이 없습니다</td></tr>';
  } else {
    const REASON_LABEL = {
      noEur: '<span class="badge warn">EUR가격없음</span>',
      noBasisPrice: '<span class="badge warn">기준가없음</span>',
      matchFail: '<span class="badge error">매칭실패</span>',
    };
    for (const r of rows) {
      if (!r.matched) {
        html += '<tr>';
        html += '<td class="sku">' + escapeHtml(r.sku) + '</td>';
        html += '<td>' + escapeHtml(r.option || '-') + '</td>';
        html += '<td class="num">' + (r.stock != null ? r.stock : '-') + '</td>';
        html += '<td colspan="8"><span class="badge error">매칭 실패</span> ' + escapeHtml(r.error || '') + '</td>';
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
      html += '<td class="sku" title="B2B: ' + escapeHtml(r.b2b_sku || '-') + '">' + escapeHtml(r.sku) + '</td>';
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
