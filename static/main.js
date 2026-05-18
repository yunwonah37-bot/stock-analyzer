/* ── 상태 ──────────────────────────────────────────────────── */
let currentCode    = null;
let currentTab     = 'overview';
let currentSub     = 'income';
let currentPeriod  = '3mo';
let hrLoaded       = false;
let execLoaded     = false;
let exportLoaded   = false;
let sectorLoaded   = false;
const charts       = {};

// 경쟁사 직접 추가 상태
let customCompetitors = [];   // [{code, name}]
let compSearchTimer   = null;

/* ── 숫자 포맷 ─────────────────────────────────────────────── */
function fmtNum(n) {
  if (n == null || isNaN(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 100000000) return (n / 100000000).toFixed(1) + '조';
  if (abs >= 10000)     return (n / 10000).toFixed(0) + '억';
  return n.toLocaleString('ko-KR');
}
function fmtOk(n) {                              // 억원 단위 입력 → 십억원 (소수 1자리)
  if (n == null || isNaN(n)) return '-';
  return (n / 10).toLocaleString('ko-KR', {minimumFractionDigits:1, maximumFractionDigits:1}) + '십억원';
}
function fmtMcap(n) {                            // 억원 단위 시가총액 → 조원 표시
  if (!n) return '-';
  const jo = n / 10000;
  if (jo >= 1) return jo.toLocaleString('ko-KR', {minimumFractionDigits:1, maximumFractionDigits:1}) + '조원';
  return (n / 10).toLocaleString('ko-KR', {minimumFractionDigits:1, maximumFractionDigits:1}) + '십억원';
}
function fmtPrice(n) {
  return n == null ? '-' : n.toLocaleString('ko-KR') + '원';
}
function fmtPct(n, decimals = 1) {
  return n == null ? '-' : (n > 0 ? '+' : '') + n.toFixed(decimals) + '%';
}
function fmtRatio(n) {
  return n == null ? '-' : n.toFixed(1) + '배';
}

/* ── 차트 기본 옵션 ─────────────────────────────────────────── */
const FONT = "'Noto Sans KR', sans-serif";
Chart.defaults.font.family = FONT;
Chart.defaults.color        = '#636c76';

function baseOptions(overrides = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { font: { family: FONT, size: 12 }, boxWidth: 12, padding: 16 } },
      tooltip: { titleFont: { family: FONT }, bodyFont: { family: FONT } },
    },
    scales: {
      x: { grid: { color: '#e0e4ea' }, ticks: { font: { family: FONT, size: 11 } } },
      y: { grid: { color: '#e0e4ea' }, ticks: { font: { family: FONT, size: 11 } } },
    },
    ...overrides,
  };
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

/* ── 검색 ──────────────────────────────────────────────────── */
function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

let _searchSeq = 0;   // 진행 중인 검색 세대 — 오래된 응답이 드롭다운을 재오픈하는 것 방지

function closeDropdown() {
  _searchSeq++;   // 진행 중인 fetch가 완료되더라도 렌더링 차단
  document.getElementById('searchDropdown').classList.remove('show');
}

function selectCompany(code) {
  closeDropdown();
  loadCompany(code);
}

function initSearch() {
  const input    = document.getElementById('searchInput');
  const dropdown = document.getElementById('searchDropdown');

  // 검색 API 호출 (try/catch 포함)
  async function fetchSearch(q) {
    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('검색 오류:', err);
      return [];
    }
  }

  function renderDropdown(data) {
    if (!data.length) { closeDropdown(); return; }
    dropdown.innerHTML = data.map(d => `
      <div class="dropdown-item" data-code="${d.code}" onmousedown="selectCompany('${d.code}')">
        <div>
          <div class="name">${d.name}</div>
          <div class="meta">${d.sector} · ${d.market}</div>
        </div>
        <span class="code-badge">${d.code}</span>
      </div>`).join('');
    dropdown.classList.add('show');
  }

  const doSearch = debounce(async (q) => {
    if (!q.trim()) { closeDropdown(); return; }
    const seq = ++_searchSeq;           // 새 세대 번호 캡처
    const data = await fetchSearch(q);
    if (seq === _searchSeq) renderDropdown(data);  // 더 최신 요청이 없을 때만 렌더
  }, 220);

  // 한글 IME 조합 중 여부 추적
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend',   () => {
    composing = false;
    // 한글 조합 완료 후 즉시 드롭다운 업데이트
    const q = input.value.trim();
    if (q) { doSearch.cancel(); doSearch(q); }
  });

  input.addEventListener('input', e => {
    if (!composing) doSearch(e.target.value);
  });

  // keyup 사용 — 한글 IME는 keydown 시점에 value가 미완성일 수 있음
  input.addEventListener('keyup', async e => {
    if (e.key === 'Enter') {
      if (composing) return;
      e.preventDefault();
      doSearch.cancel();
      closeDropdown();           // 즉시 닫기 (세대 번호 증가 → 진행 중 fetch 무효화)
      const q = input.value.trim();
      if (!q) return;
      const first = dropdown.querySelector('.dropdown-item');
      if (first) { loadCompany(first.dataset.code); return; }
      const data = await fetchSearch(q);
      if (data.length) loadCompany(data[0].code);
    } else if (e.key === 'Escape') {
      doSearch.cancel();
      closeDropdown();
      input.blur();
    }
  });

  // 바깥 클릭 시 드롭다운 닫기 (mousedown = blur보다 먼저 발생)
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('.search-wrap')) closeDropdown();
  });
}

/* ── 메인 로드 ─────────────────────────────────────────────── */
async function loadCompany(code) {
  currentCode = code;
  document.getElementById('searchDropdown').classList.remove('show');
  document.getElementById('searchInput').value = '';

  // 빈 상태 숨기고 대시보드 표시
  document.getElementById('emptyState').style.display  = 'none';
  document.getElementById('dashboard').classList.add('show');

  // 첫 탭으로 리셋
  hrLoaded          = false;
  execLoaded        = false;
  exportLoaded      = false;
  sectorLoaded      = false;
  customCompetitors = [];
  document.getElementById('hrContent').innerHTML     = '';
  document.getElementById('execContent').innerHTML   = '';
  document.getElementById('exportContent').innerHTML = '';
  document.getElementById('sectorContent').innerHTML = '';
  switchTab('overview', false);

  // 데이터 병렬 로드
  const [stockRes, finRes, compRes, aiRes, analystRes] = await Promise.all([
    fetch(`/api/stock/${code}`),
    fetch(`/api/financials/${code}`),
    fetch(`/api/competitors/${code}`),
    fetch(`/api/ai-report/${code}`),
    fetch(`/api/analyst/${code}`),
  ]);
  const stock    = await stockRes.json();
  const fin      = await finRes.json();
  const comp     = await compRes.json();
  const ai       = await aiRes.json();
  const analyst  = await analystRes.json();

  renderHeader(stock.info);
  renderOverview(stock);
  renderFinancials(fin);
  renderCapex(fin, stock);
  renderRnd(fin, stock);
  initCompetitorsUI(code, comp);
  renderAnalyst(analyst, stock.info);
  renderAiReport(ai);
}

/* ── 기업 헤더 ─────────────────────────────────────────────── */
function renderHeader(info) {
  const chg    = info.change;
  const pct    = info.change_pct;
  const cls    = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
  const arrow  = chg > 0 ? '▲' : chg < 0 ? '▼' : '―';
  const sign   = chg > 0 ? '+' : '';

  const srcBadge = info._fin_source === 'dart'
    ? '<span class="src-badge dart">DART 실데이터</span>'
    : '<span class="src-badge dummy">더미 데이터</span>';
  const priceBadge = info._price_source === 'realtime'
    ? '<span class="src-badge realtime">실시간 주가</span>'
    : '<span class="src-badge dummy">더미 주가</span>';
  const fr = info.foreign_rate;
  const frCls = fr == null ? '' : fr >= 40 ? 'fo-high' : fr >= 20 ? 'fo-mid' : 'fo-low';
  const frBadge = fr != null
    ? `<span class="ch-meta-item"><span class="label">외국인지분율</span><span class="fo-rate-badge ${frCls}">${fr.toFixed(1)}%</span></span>`
    : '';

  document.getElementById('companyHeader').innerHTML = `
    <div class="ch-top">
      <div>
        <div class="ch-name">${info.name} <span class="ch-market-badge">${info.market}</span> ${srcBadge} ${priceBadge}</div>
        <div class="ch-code">${info.code} · ${info.sector}</div>
      </div>
      <div class="ch-price-block">
        <div class="ch-price">${fmtPrice(info.current_price)}</div>
        <div class="ch-change ${cls}">${arrow} ${sign}${fmtPrice(Math.abs(chg))} (${sign}${pct.toFixed(2)}%)</div>
      </div>
    </div>
    <div class="ch-meta">
      <span class="ch-meta-item"><span class="label">시가총액</span>${fmtMcap(info.market_cap)}</span>
      <span class="ch-meta-item"><span class="label">52주 최고</span>${fmtPrice(info.w52_high)}</span>
      <span class="ch-meta-item"><span class="label">52주 최저</span>${fmtPrice(info.w52_low)}</span>
      <span class="ch-meta-item"><span class="label">상장주식수</span>${Number(info.shares).toLocaleString('ko-KR')}주</span>
      ${frBadge}
    </div>
    <div class="ch-desc">${info.description}</div>`;
}

/* ── 주가 차트 렌더 (기간 전환 공용) ───────────────────────── */
function renderPriceChart(hist, info) {
  destroyChart('price');
  const ctx1   = document.getElementById('priceChart').getContext('2d');
  const prices = hist.prices;
  const isUp   = prices.length >= 2 && prices[prices.length - 1] >= prices[0];
  const color  = isUp ? '#3fb950' : '#f85149';
  const gradient = ctx1.createLinearGradient(0, 0, 0, 280);
  gradient.addColorStop(0, isUp ? 'rgba(63,185,80,0.25)' : 'rgba(248,81,73,0.25)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  // 차트 소스 배지
  const badge = document.getElementById('chartSourceBadge');
  if (badge) {
    badge.style.display = '';
    if (hist._source === 'realtime') {
      badge.className = 'src-badge realtime';
      badge.textContent = '실시간 차트';
    } else {
      badge.className = 'src-badge dummy';
      badge.textContent = '더미 차트';
    }
  }

  charts.price = new Chart(ctx1, {
    type: 'line',
    data: {
      labels: hist.dates,
      datasets: [{
        label: '주가(원)',
        data: prices,
        borderColor: color,
        backgroundColor: gradient,
        borderWidth: 2, pointRadius: 0, fill: true, tension: 0.2,
      }],
    },
    options: {
      ...baseOptions(),
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => fmtPrice(ctx.parsed.y) },
      }},
      scales: {
        x: { grid: { color: '#e0e4ea' }, ticks: { maxTicksLimit: 10, font: { size: 11 } } },
        y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => fmtPrice(v), font: { size: 11 } } },
      },
    },
  });
}

function changePeriod(period, btn) {
  if (!currentCode) return;
  currentPeriod = period;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  fetch(`/api/price-history/${currentCode}?period=${period}`)
    .then(r => r.json())
    .then(hist => renderPriceChart(hist, null))
    .catch(console.error);
}

/* ── 종합대시보드 ───────────────────────────────────────────── */
function renderOverview(data) {
  // KPI 카드 — 시총 / 영업이익률 / PER / 직원수
  const info = data.info;
  const r    = data.ratios;
  const is   = data.income_summary;
  const lastIdx    = is.years.length - 1;
  const opMarginVal = is.revenue[lastIdx]
    ? (is.operating_profit[lastIdx] / is.revenue[lastIdx] * 100).toFixed(1)
    : null;
  const empText = info.employees != null
    ? Number(info.employees).toLocaleString('ko-KR') + '명'
    : '-';

  // 영업이익 전년대비 증가율
  const opCurr = is.operating_profit[lastIdx];
  const opPrev = lastIdx > 0 ? is.operating_profit[lastIdx - 1] : null;
  let opYoyVal = null, opYoyHtml = '';
  if (opCurr != null && opPrev != null && opPrev !== 0) {
    opYoyVal = ((opCurr - opPrev) / Math.abs(opPrev) * 100).toFixed(1);
    const up  = opYoyVal >= 0;
    opYoyHtml = `<span style="color:${up ? 'var(--red)' : 'var(--blue)'}">
      ${up ? '▲' : '▼'}${Math.abs(opYoyVal)}% YoY</span>`;
  }

  const kpiItems = [
    { label: '시가총액',         value: fmtMcap(info.market_cap),                        note: info.market || '' },
    { label: '영업이익률',       value: opMarginVal != null ? opMarginVal + '%' : '-',  note: is.years[lastIdx] + '년 기준' },
    { label: '영업이익 증가율',  value: opYoyHtml || '-',                               note: `${is.years[lastIdx - 1] || ''}→${is.years[lastIdx]} YoY` },
    { label: 'PER',              value: fmtRatio(r.per),                               note: '주가수익비율' },
  ];
  document.getElementById('overviewKPI').innerHTML = kpiItems.map(k => `
    <div class="kpi-card">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('');

  // 주가 차트
  renderPriceChart(data.price_history, data.info);

  // 지표 카드
  const rSrc = r._ratio_source || 'dummy';
  const rBadge = rSrc === 'naver'
    ? '<span class="src-badge realtime" style="font-size:9px;padding:1px 5px">Naver 실시간</span>'
    : rSrc === 'dart'
      ? '<span class="src-badge dart"    style="font-size:9px;padding:1px 5px">DART</span>'
      : '<span class="src-badge dummy"   style="font-size:9px;padding:1px 5px">더미</span>';

  const psrColor = r.psr == null ? '' : r.psr < 1 ? 'color:var(--green)' : r.psr > 3 ? 'color:var(--red)' : '';

  const ratioItems = [
    { label: 'PER',      value: fmtRatio(r.per),   note: '주가수익비율' },
    { label: 'PBR',      value: fmtRatio(r.pbr),   note: '주가순자산비율' },
    { label: 'PSR',      value: r.psr != null ? r.psr.toFixed(2) + 'x' : '-', note: '주가매출비율', style: psrColor },
    { label: 'ROE',      value: r.roe           != null ? r.roe.toFixed(1) + '%'           : '-', note: '자기자본이익률' },
    { label: 'EPS',      value: r.eps           != null ? fmtPrice(r.eps)                  : '-', note: '주당순이익' },
    { label: 'BPS',      value: r.bps           != null ? fmtPrice(r.bps)                  : '-', note: '주당순자산' },
    { label: '부채비율',  value: r.debt_ratio    != null ? r.debt_ratio.toFixed(1) + '%'    : '-', note: '총부채/자기자본' },
    { label: '배당수익률',value: r.dividend_yield!= null ? r.dividend_yield.toFixed(2) + '%': '-', note: '연간배당/주가' },
  ];

  const ratiosEl = document.getElementById('ratiosGrid');
  ratiosEl.innerHTML =
    `<div class="ratios-source-row">${rBadge} 기준 투자지표</div>` +
    ratioItems.map(item => `
      <div class="ratio-item">
        <div class="ratio-label">${item.label}</div>
        <div class="ratio-value" style="${item.style || ''}">${item.value}</div>
        <div class="ratio-note">${item.note}</div>
      </div>`).join('');

  // 연간 실적 차트
  destroyChart('revenue');
  charts.revenue = new Chart(
    document.getElementById('revenueChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: data.income_summary.years,
        datasets: [
          {
            label: '매출액 (십억원)',
            data: data.income_summary.revenue,
            backgroundColor: '#2f81f740',
            borderColor: '#2f81f7',
            borderWidth: 1.5, borderRadius: 4,
          },
          {
            label: '영업이익 (십억원)',
            data: data.income_summary.operating_profit,
            backgroundColor: '#3fb95040',
            borderColor: '#3fb950',
            borderWidth: 1.5, borderRadius: 4,
          },
        ],
      },
      options: {
        ...baseOptions(),
        scales: {
          x: { grid: { color: '#e0e4ea' } },
          y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => fmtOk(v) } },
        },
        plugins: {
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtOk(ctx.parsed.y)}` } },
          legend: { labels: { font: { family: FONT, size: 12 } } },
        },
      },
    }
  );

  // PSR 분석 카드
  renderPsrCard(r);

  // 외국인 지분율 카드
  renderForeignOwnership(data.foreign_ownership);
}

function renderPsrCard(r) {
  const card = document.getElementById('psrCard');
  if (!card) return;

  const psr       = r.psr;
  const sectorPsr = r.sector_psr;
  const history   = r.psr_history || [];
  const years     = r.psr_years   || [];

  if (psr == null) { card.innerHTML = ''; return; }

  let chipCls, chipTxt;
  if      (psr < 1) { chipCls = 'chip-green';  chipTxt = '저평가'; }
  else if (psr <= 3){ chipCls = 'chip-yellow'; chipTxt = '적정';   }
  else              { chipCls = 'chip-red';    chipTxt = '고평가'; }

  const maxV  = Math.max(psr, sectorPsr || 0, 1);
  const psrW  = Math.min((psr / maxV) * 100, 100).toFixed(1);
  const secW  = sectorPsr ? Math.min((sectorPsr / maxV) * 100, 100).toFixed(1) : 0;

  const secRow = sectorPsr != null ? `
    <div class="psr-bar-row">
      <span class="psr-bar-label">업종 평균</span>
      <div class="psr-bar-track"><div class="psr-bar-fill psr-sec" style="width:${secW}%"></div></div>
      <span class="psr-bar-val">${sectorPsr.toFixed(1)}x</span>
    </div>` : '';

  const premium = (sectorPsr && sectorPsr > 0)
    ? ((psr - sectorPsr) / sectorPsr * 100).toFixed(1)
    : null;
  const premiumTxt = premium != null
    ? `<span class="psr-premium ${parseFloat(premium) > 0 ? 'over' : 'under'}">${parseFloat(premium) > 0 ? '+' : ''}${premium}% 업종 대비</span>`
    : '';

  card.innerHTML = `
    <div class="card">
      <div class="card-header">
        PSR (주가매출비율)
        <span class="psr-chip ${chipCls}">${chipTxt}</span>
        <span class="card-sub">시가총액 ÷ 연간 매출액</span>
      </div>
      <div class="psr-body">
        <div class="psr-left">
          <div class="psr-main-wrap">
            <div class="psr-main-val">${psr.toFixed(2)}<span class="psr-unit">x</span></div>
            ${premiumTxt}
          </div>
          <div class="psr-bars">
            <div class="psr-bar-row">
              <span class="psr-bar-label">현재 PSR</span>
              <div class="psr-bar-track"><div class="psr-bar-fill psr-cur" style="width:${psrW}%"></div></div>
              <span class="psr-bar-val">${psr.toFixed(2)}x</span>
            </div>
            ${secRow}
          </div>
          <div class="psr-legend">
            <span class="psr-legend-item psr-lg-green">1x 이하 저평가</span>
            <span class="psr-legend-item psr-lg-yellow">1~3x 적정</span>
            <span class="psr-legend-item psr-lg-red">3x 이상 고평가</span>
          </div>
        </div>
        <div class="psr-right">
          <div class="psr-chart-title">PSR 추이 <span style="font-size:11px;color:var(--text-faint)">(현재 시총 기준)</span></div>
          <div class="chart-wrap h180"><canvas id="psrTrendChart"></canvas></div>
        </div>
      </div>
    </div>`;

  if (history.length > 0) {
    destroyChart('psrTrend');
    charts.psrTrend = new Chart(
      document.getElementById('psrTrendChart').getContext('2d'),
      {
        type: 'bar',
        data: {
          labels: years,
          datasets: [{
            label: 'PSR',
            data: history,
            backgroundColor: history.map(v =>
              v == null ? 'transparent' : v < 1 ? '#1a7f3730' : v <= 3 ? '#9a670030' : '#cf222e30'
            ),
            borderColor: history.map(v =>
              v == null ? 'transparent' : v < 1 ? '#1a7f37' : v <= 3 ? '#9a6700' : '#cf222e'
            ),
            borderWidth: 1.5, borderRadius: 4,
          }],
        },
        options: {
          ...baseOptions(),
          scales: {
            x: { grid: { color: '#e0e4ea' } },
            y: {
              grid: { color: '#e0e4ea' },
              ticks: { callback: v => v.toFixed(1) + 'x' },
            },
          },
          plugins: {
            tooltip: { callbacks: {
              label: ctx => `PSR: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(2) + 'x' : '-'}`
            }},
            legend: { display: false },
          },
        },
      }
    );
  }
}

/* ── 외국인 지분율 ──────────────────────────────────────────── */
function renderForeignOwnership(fo) {
  const el = document.getElementById('foreignOwnershipCard');
  if (!el) return;
  if (!fo || fo.foreign_rate == null) { el.innerHTML = ''; return; }

  const rate  = fo.foreign_rate;
  const other = Math.max(0, 100 - rate);
  const rateCls = rate >= 40 ? 'fo-high' : rate >= 20 ? 'fo-mid' : 'fo-low';

  const net20Frgn = fo.net_20d_foreign;
  const net20Inst = fo.net_20d_inst;
  const netFrgnCls = net20Frgn > 0 ? 'up' : net20Frgn < 0 ? 'down' : '';
  const netInstCls = net20Inst > 0 ? 'up' : net20Inst < 0 ? 'down' : '';

  const fmtNet = v => v != null
    ? (v > 0 ? '+' : '') + Number(v).toLocaleString('ko-KR') + '주'
    : '-';

  el.innerHTML = `
    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-header">외국인 보유현황 <span class="card-sub">지분율 도넛</span></div>
        <div class="fo-donut-wrap">
          <div class="chart-wrap h220" style="flex:1"><canvas id="foreignDonutChart"></canvas></div>
          <div>
            <div class="fo-legend-item">
              <span class="fo-legend-dot" style="background:#2f81f7"></span>
              외국인 ${rate.toFixed(1)}%
            </div>
            <div class="fo-legend-item">
              <span class="fo-legend-dot" style="background:#e0e4ea"></span>
              기타(기관+개인) ${other.toFixed(1)}%
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">외국인 투자 지표</div>
        <div class="fo-metrics">
          <div class="fo-metric-item">
            <div class="fo-metric-label">외국인 지분율</div>
            <div class="fo-metric-value ${rateCls}">${rate.toFixed(2)}%</div>
          </div>
          <div class="fo-metric-item">
            <div class="fo-metric-label">최근 기간 최고</div>
            <div class="fo-metric-value">${fo.rate_period_high != null ? fo.rate_period_high.toFixed(2) + '%' : '-'}</div>
          </div>
          <div class="fo-metric-item">
            <div class="fo-metric-label">최근 기간 최저</div>
            <div class="fo-metric-value">${fo.rate_period_low != null ? fo.rate_period_low.toFixed(2) + '%' : '-'}</div>
          </div>
          <div class="fo-metric-item">
            <div class="fo-metric-label">외국인 보유주식수</div>
            <div class="fo-metric-value fo-sm">${fo.foreign_shares ? Number(fo.foreign_shares).toLocaleString('ko-KR') + '주' : '-'}</div>
          </div>
          <div class="fo-metric-item">
            <div class="fo-metric-label">20일 외국인 순매수</div>
            <div class="fo-metric-value ${netFrgnCls}">${fmtNet(net20Frgn)}</div>
          </div>
          <div class="fo-metric-item">
            <div class="fo-metric-label">20일 기관 순매수</div>
            <div class="fo-metric-value ${netInstCls}">${fmtNet(net20Inst)}</div>
          </div>
        </div>
      </div>
    </div>`;

  // 도넛 차트
  destroyChart('foreignDonut');
  charts.foreignDonut = new Chart(
    document.getElementById('foreignDonutChart').getContext('2d'),
    {
      type: 'doughnut',
      data: {
        labels: ['외국인', '기타(기관+개인)'],
        datasets: [{
          data: [rate, other],
          backgroundColor: ['#2f81f7', '#e0e4ea'],
          borderWidth: 0,
        }],
      },
      options: {
        ...baseOptions({ scales: {} }),
        cutout: '65%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toFixed(1)}%` } },
        },
      },
    }
  );

  // 추이 차트
  const hist = fo.history || [];
  if (hist.length > 0) {
    const trendDiv = document.createElement('div');
    trendDiv.className = 'card';
    trendDiv.style.marginTop = '16px';
    trendDiv.innerHTML = `
      <div class="card-header">외국인 지분율 추이 <span class="card-sub">최근 ${hist.length}일</span></div>
      <div class="chart-wrap h220"><canvas id="foreignTrendChart"></canvas></div>`;
    el.appendChild(trendDiv);

    const dates = hist.map(h => h.date).reverse();
    const rates = hist.map(h => h.foreign_rate).reverse();
    destroyChart('foreignTrend');
    charts.foreignTrend = new Chart(
      document.getElementById('foreignTrendChart').getContext('2d'),
      {
        type: 'line',
        data: {
          labels: dates,
          datasets: [{
            label: '외국인 지분율 (%)',
            data: rates,
            borderColor: '#2f81f7',
            backgroundColor: 'rgba(47,129,247,0.1)',
            borderWidth: 2, pointRadius: 3, fill: true, tension: 0.2,
          }],
        },
        options: {
          ...baseOptions(),
          scales: {
            x: { grid: { color: '#e0e4ea' }, ticks: { font: { size: 10 }, maxRotation: 45 } },
            y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => v + '%', font: { size: 11 } } },
          },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ctx.parsed.y.toFixed(2) + '%' } },
          },
        },
      }
    );
  }
}

/* ── 재무상세 ───────────────────────────────────────────────── */
function renderFinancials(fin) {
  renderIncomeStatement(fin);
  renderBalanceSheet(fin);
  renderCashFlow(fin);
  renderTurnover(fin);
}

function renderIncomeStatement(fin) {
  // 차트
  destroyChart('income');
  charts.income = new Chart(
    document.getElementById('incomeChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: fin.income_statement.years,
        datasets: [
          { label: '매출액 (십억원)',   data: fin.income_statement.revenue,          backgroundColor: '#2f81f740', borderColor: '#2f81f7', borderWidth: 1.5, borderRadius: 4 },
          { label: '영업이익 (십억원)', data: fin.income_statement.operating_profit,  backgroundColor: '#3fb95040', borderColor: '#3fb950', borderWidth: 1.5, borderRadius: 4 },
          { label: '순이익 (십억원)',   data: fin.income_statement.net_income,        backgroundColor: '#d2992240', borderColor: '#d29922', borderWidth: 1.5, borderRadius: 4 },
        ],
      },
      options: {
        ...baseOptions(),
        scales: {
          x: { grid: { color: '#e0e4ea' } },
          y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => fmtOk(v) } },
        },
        plugins: { tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtOk(ctx.parsed.y)}` } } },
      },
    }
  );

  // 테이블
  const is = fin.income_statement;

  // 영업이익 YoY 계산
  const opYoy = is.operating_profit.map((v, i) => {
    if (i === 0) return '-';
    const prev = is.operating_profit[i - 1];
    if (v == null || prev == null || prev === 0) return '-';
    const pct = ((v - prev) / Math.abs(prev) * 100).toFixed(1);
    const up  = pct >= 0;
    return `<span style="color:${up ? 'var(--red)' : 'var(--blue)'}">${up ? '▲' : '▼'}${Math.abs(pct)}%</span>`;
  });

  // 매출액 YoY 계산
  const revYoy = is.revenue.map((v, i) => {
    if (i === 0) return '-';
    const prev = is.revenue[i - 1];
    if (v == null || prev == null || prev === 0) return '-';
    const pct = ((v - prev) / Math.abs(prev) * 100).toFixed(1);
    const up  = pct >= 0;
    return `<span style="color:${up ? 'var(--red)' : 'var(--blue)'}">${up ? '▲' : '▼'}${Math.abs(pct)}%</span>`;
  });

  const rows = [
    { label: '매출액',          vals: is.revenue,           type: 'money' },
    { label: '매출 증가율',      vals: revYoy,               type: 'html'  },
    { label: '영업이익',        vals: is.operating_profit,   type: 'money' },
    { label: '영업이익 증가율',  vals: opYoy,                type: 'html'  },
    { label: '순이익',          vals: is.net_income,         type: 'money' },
    { label: '영업이익률',      vals: is.operating_margin.map(v => v != null ? v.toFixed(1) + '%' : '-'), type: 'str' },
    ...(is.roe        ? [{ label: 'ROE',     vals: is.roe.map(v => v != null ? v.toFixed(1) + '%' : '-'),        type: 'str' }] : []),
    ...(is.debt_ratio ? [{ label: '부채비율', vals: is.debt_ratio.map(v => v != null ? v.toFixed(1) + '%' : '-'), type: 'str' }] : []),
  ];
  const thead = `<thead><tr><th>항목</th>${is.years.map(y => `<th>${y}</th>`).join('')}</tr></thead>`;
  const tbody = rows.map(row => {
    const cells = row.vals.map(v => {
      if (row.type === 'html')  return `<td>${v}</td>`;
      if (row.type === 'str')   return `<td>${v}</td>`;
      const num = Number(v);
      return `<td class="${num < 0 ? 'neg' : ''}">${fmtOk(num)}</td>`;
    }).join('');
    const isYoy = row.label.includes('증가율');
    return `<tr style="${isYoy ? 'background:rgba(255,255,255,0.02);font-size:12px' : ''}">
      <td style="${isYoy ? 'color:var(--text-muted);padding-left:18px' : ''}">${row.label}</td>${cells}</tr>`;
  }).join('');
  document.getElementById('incomeTable').innerHTML = thead + '<tbody>' + tbody + '</tbody>';

  // 판매관리비 세부 항목 + 비용 구조
  const sgaEl = document.getElementById('sgaBreakdown');
  if (!sgaEl) return;

  const sga      = is.sga     || 0;
  const cogs     = is.cogs    || 0;
  const sgaSubs  = is.sga_breakdown || [];
  const sgaYear  = is.years[is.years.length - 1];
  const revenue  = is.revenue[is.revenue.length - 1] || 0;
  const opProfit = is.operating_profit[is.operating_profit.length - 1] || 0;
  const rndAmt   = fin.rnd?.expense?.[fin.rnd.expense.length - 1] || 0;

  // SGA 세부 항목: DART에서 의미있는 항목이 있으면 사용, 아니면 R&D + 기타로 구성
  const OTHER_THRESHOLD = 0.92; // 기타가 92% 이상이면 의미없는 세부항목
  const hasRealSubs = sgaSubs.length > 0 &&
    (sgaSubs.find(s => s.name !== '기타')?.amount || 0) /
    (sga || 1) > (1 - OTHER_THRESHOLD);

  let displaySubs = [];
  if (hasRealSubs) {
    // DART에서 실제 세부 항목 추출됨
    displaySubs = sgaSubs;
  } else {
    // R&D + 기타판관비 구성
    if (rndAmt > 0 && sga > 0) {
      displaySubs = [
        { name: '연구개발비', amount: rndAmt },
        { name: '기타 판관비', amount: Math.max(0, sga - rndAmt) },
      ];
    }
  }

  const COLORS = ['#2f81f7','#3fb950','#d29922','#f85149','#58a6ff',
                  '#56d364','#e3b341','#ff7b72','#79c0ff','#85e89d',
                  '#ffa657','#aaa'];

  function sgaBarRows(items, total) {
    if (!items.length) return '';
    const maxAmt = Math.max(...items.map(s => s.amount));
    const rows = items.map((s, i) => {
      const pct    = total > 0 ? (s.amount / total * 100).toFixed(1) : 0;
      const barPct = maxAmt > 0 ? (s.amount / maxAmt * 100).toFixed(1) : 0;
      return `<div class="sga-row">
        <div class="sga-name">${s.name}</div>
        <div class="sga-bar-wrap">
          <div class="sga-bar-fill" style="width:${barPct}%;background:${COLORS[i % COLORS.length]}99"></div>
        </div>
        <div class="sga-pct">${pct}%</div>
        <div class="sga-amt">${fmtOk(s.amount)}</div>
      </div>`;
    }).join('');
    const totalRow = `<div class="sga-row sga-total-row">
      <div class="sga-name">판관비 합계</div>
      <div class="sga-bar-wrap"></div>
      <div class="sga-pct">100%</div>
      <div class="sga-amt">${fmtOk(total)}</div>
    </div>`;
    return rows + totalRow;
  }

  // 비용 구조 (매출원가 + 판관비 + 영업이익 = 매출액 기준)
  let costHtml = '';
  if (revenue > 0 && (cogs > 0 || sga > 0)) {
    const costItems = [];
    if (cogs     > 0) costItems.push({ name: '매출원가',    amount: cogs,                color: '#2f81f7' });
    if (rndAmt   > 0) costItems.push({ name: '연구개발비',   amount: rndAmt,             color: '#d29922' });
    const sgaRest = sga > 0 ? Math.max(0, sga - rndAmt) : 0;
    if (sgaRest  > 0) costItems.push({ name: '기타 판관비', amount: sgaRest,             color: '#58a6ff' });
    if (opProfit > 0) costItems.push({ name: '영업이익',    amount: opProfit,            color: '#3fb950' });
    if (opProfit < 0) costItems.push({ name: '영업손실',    amount: Math.abs(opProfit),  color: '#f85149' });

    const costRows = costItems.map(item => {
      const pct    = (item.amount / revenue * 100).toFixed(1);
      const barPct = (item.amount / revenue * 100).toFixed(1);
      return `<div class="sga-row">
        <div class="sga-name">${item.name}</div>
        <div class="sga-bar-wrap">
          <div class="sga-bar-fill" style="width:${barPct}%;background:${item.color}99"></div>
        </div>
        <div class="sga-pct">${pct}%</div>
        <div class="sga-amt">${fmtOk(item.amount)}</div>
      </div>`;
    }).join('');

    costHtml = `<div class="card">
      <div class="card-header">📊 비용 구조 분석 <span class="card-sub">${sgaYear}년 · 매출액 대비 비율</span></div>
      <div class="sga-list">
        ${costRows}
        <div class="sga-row sga-total-row">
          <div class="sga-name">매출액</div>
          <div class="sga-bar-wrap"></div>
          <div class="sga-pct">100%</div>
          <div class="sga-amt">${fmtOk(revenue)}</div>
        </div>
      </div>
    </div>`;
  }

  // 판관비 세부 항목 카드
  const srcNote = hasRealSubs
    ? `DART 공시 세부항목 · ${sgaYear}년 · 십억원`
    : (rndAmt > 0 ? `연구개발비 별도 산출 · ${sgaYear}년 · 십억원` : `${sgaYear}년 · 십억원`);

  const subHtml = sga > 0 ? `<div class="card">
    <div class="card-header">📂 판매관리비 세부 항목 <span class="card-sub">${srcNote}</span></div>
    ${displaySubs.length > 0
      ? `<div class="sga-list">${sgaBarRows(displaySubs, sga)}</div>`
      : `<div style="padding:16px 0 4px;color:var(--text-muted);font-size:13px">
           DART 세부 항목 미공시 — 판매비와관리비 합계(${fmtOk(sga)})만 공시된 기업입니다.
         </div>`
    }
  </div>` : '';

  sgaEl.innerHTML = costHtml + subHtml;
}

function renderBalanceSheet(fin) {
  const bs     = fin.balance_sheet;
  const is_    = fin.income_statement;
  const opA    = bs.operating_assets;
  const nonA   = bs.non_operating_assets;
  const noi    = bs.non_op_income || {};
  const opTotal  = opA['합계'];
  const nonTotal = nonA['합계'];
  const total    = bs.total_assets;

  // 최신 연도 영업이익
  const opProfit = is_ && is_.operating_profit ? is_.operating_profit[is_.operating_profit.length - 1] : null;
  const revenue  = is_ && is_.revenue         ? is_.revenue[is_.revenue.length - 1]                   : null;
  const opMargin = (opProfit && revenue && revenue > 0) ? (opProfit / revenue * 100).toFixed(1) : null;
  const rooa     = (opProfit && opTotal > 0)  ? (opProfit / opTotal * 100).toFixed(1)            : null;

  // 비영업자산 수익
  const noiTotal  = noi['합계'] || 0;
  const noiYield  = (noiTotal > 0 && nonTotal > 0) ? (noiTotal / nonTotal * 100).toFixed(2) : null;
  const noiItems  = Object.entries(noi)
    .filter(([k, v]) => k !== '합계' && v > 0)
    .map(([k, v]) => `<span><span class="aim-label">${k}</span> <span class="aim-val">${fmtOk(v)}</span></span>`);

  // 자산 분석 섹션
  function assetRows(items, cls) {
    return Object.entries(items)
      .filter(([k, v]) => k !== '합계' && v > 0)
      .map(([k, v]) => {
        const pct    = ((v / items['합계']) * 100).toFixed(1);
        const isEtc  = k.startsWith('기타');
        const nameHtml = isEtc
          ? `${k} <span style="font-size:10px;color:var(--text-faint)">(미분류 잔여)</span>`
          : k;
        return `
          <div class="asset-row">
            <div class="asset-row-top">
              <span class="asset-row-name">${nameHtml}</span>
              <span class="asset-row-value">${fmtOk(v)} <span class="asset-row-pct">${pct}%</span></span>
            </div>
            <div class="asset-bar-track">
              <div class="asset-bar-fill ${cls}" style="width:${pct}%"></div>
            </div>
          </div>`;
      }).join('');
  }

  // 영업자산 수익 박스
  const opIncomeBox = opProfit != null ? `
    <div class="asset-income-box op">
      <div class="aim-title">📊 영업자산 수익 창출</div>
      <div class="aim-row">
        <span><span class="aim-label">영업이익</span> <span class="aim-val">${fmtOk(opProfit)}</span></span>
        ${opMargin != null ? `<span><span class="aim-label">영업이익률</span> <span class="aim-val">${opMargin}%</span></span>` : ''}
        ${rooa != null ? `<span><span class="aim-label">ROOA (영업자산수익률)</span> <span class="aim-val rooa">${rooa}%</span></span>` : ''}
      </div>
    </div>` : '';

  // 비영업자산 수익 박스
  const nonOpIncomeBox = noiTotal > 0 ? `
    <div class="asset-income-box nonop">
      <div class="aim-title">💰 비영업자산 수익 창출</div>
      <div class="aim-row">
        ${noiItems.join('')}
        <span><span class="aim-label">합계</span> <span class="aim-val">${fmtOk(noiTotal)}</span></span>
        ${noiYield != null ? `<span><span class="aim-label">비영업자산수익률</span> <span class="aim-val">${noiYield}%</span></span>` : ''}
      </div>
    </div>` : `
    <div class="asset-income-box nonop no-data">
      <div class="aim-title">💰 비영업자산 수익 창출</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px">공시 데이터 없음 (이자수익·배당금 별도 미공시)</div>
    </div>`;

  document.getElementById('assetBreakdown').innerHTML = `
    <div class="asset-group">
      <div class="asset-group-title">
        영업자산 <span class="badge badge-op">Operating Assets</span>
      </div>
      ${assetRows(opA, 'op')}
      ${opIncomeBox}
      <div class="asset-total">
        <span>영업자산 합계</span>
        <span>${fmtOk(opTotal)} (${((opTotal/total)*100).toFixed(1)}%)</span>
      </div>
    </div>
    <div class="asset-group">
      <div class="asset-group-title">
        비영업자산 <span class="badge badge-nonop">Non-Operating Assets</span>
      </div>
      ${assetRows(nonA, 'nonop')}
      ${nonOpIncomeBox}
      <div class="asset-total">
        <span>비영업자산 합계</span>
        <span>${fmtOk(nonTotal)} (${((nonTotal/total)*100).toFixed(1)}%)</span>
      </div>
    </div>`;

  // 도넛 차트
  destroyChart('assetPie');
  charts.assetPie = new Chart(
    document.getElementById('assetPieChart').getContext('2d'),
    {
      type: 'doughnut',
      data: {
        labels: ['영업자산', '비영업자산'],
        datasets: [{
          data: [opTotal, nonTotal],
          backgroundColor: ['#2f81f7aa', '#3fb950aa'],
          borderColor:     ['#2f81f7',   '#3fb950'],
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: FONT, size: 12 } } },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtOk(ctx.parsed)} (${((ctx.parsed/total)*100).toFixed(1)}%)` } },
        },
        cutout: '65%',
      },
    }
  );

  // 부채/자본 테이블
  const liabRows = [
    ['총자산',   bs.total_assets],
    ['총부채',   bs.total_liabilities],
    ['총자본',   bs.total_equity],
    ['부채비율', Math.round(bs.total_liabilities / bs.total_equity * 100) + '%'],
  ];
  const lThead = `<thead><tr><th>항목</th><th>금액</th></tr></thead>`;
  const lTbody = liabRows.map(([label, val], i) => {
    const isStr = typeof val === 'string';
    return `<tr${i === liabRows.length - 1 ? '' : ''}><td>${label}</td><td>${isStr ? val : fmtOk(val)}</td></tr>`;
  }).join('');
  document.getElementById('liabilityTable').innerHTML = lThead + '<tbody>' + lTbody + '</tbody>';
}

function renderCashFlow(fin) {
  const cf = fin.cash_flow;

  destroyChart('cashflow');
  charts.cashflow = new Chart(
    document.getElementById('cashflowChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: cf.years,
        datasets: [
          { label: '영업활동 (십억원)', data: cf.operating_cf, backgroundColor: '#3fb95050', borderColor: '#3fb950', borderWidth: 1.5, borderRadius: 4 },
          { label: '투자활동 (십억원)', data: cf.investing_cf,  backgroundColor: '#f8514950', borderColor: '#f85149', borderWidth: 1.5, borderRadius: 4 },
          { label: '재무활동 (십억원)', data: cf.financing_cf,  backgroundColor: '#d2992250', borderColor: '#d29922', borderWidth: 1.5, borderRadius: 4 },
        ],
      },
      options: {
        ...baseOptions(),
        scales: {
          x: { grid: { color: '#e0e4ea' } },
          y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => fmtOk(v) } },
        },
        plugins: { tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtOk(ctx.parsed.y)}` } } },
      },
    }
  );

  const cfThead = `<thead><tr><th>항목</th>${cf.years.map(y => `<th>${y}</th>`).join('')}</tr></thead>`;
  const cfRows  = [
    ['영업활동CF', cf.operating_cf],
    ['투자활동CF', cf.investing_cf],
    ['재무활동CF', cf.financing_cf],
  ];
  const cfTbody = cfRows.map(([label, vals]) => {
    const cells = vals.map(v => `<td class="${v < 0 ? 'neg' : 'pos'}">${fmtOk(v)}</td>`).join('');
    return `<tr><td>${label}</td>${cells}</tr>`;
  }).join('');
  document.getElementById('cashflowTable').innerHTML = cfThead + '<tbody>' + cfTbody + '</tbody>';
}

/* ── 총자산 회전율 분석 ─────────────────────────────────────── */
function renderTurnover(fin) {
  const el = document.getElementById('turnoverContent');
  if (!el) return;

  const at = fin.asset_turnover;
  if (!at || at.tat == null) {
    el.innerHTML = `<div class="card" style="padding:32px;text-align:center;color:var(--text-muted)">
      <div style="font-size:28px;margin-bottom:10px">📊</div>
      <div>자산회전율 데이터가 없습니다. DART 재무제표 연결 후 조회 바랍니다.</div>
    </div>`;
    return;
  }

  const f2  = v  => v  != null ? v.toFixed(2)  : '-';
  const f3  = v  => v  != null ? v.toFixed(3)  : '-';
  const fP  = v  => v  != null ? (v * 100).toFixed(1) + '%' : '-';
  const sgn = v  => v >= 0 ? '+' : '';

  // ── 1. KPI 카드 ─────────────────────────────────────────────
  const tat3  = at.tat_3y || [];
  const tatC  = at.tat;
  const tatP  = tat3.length >= 2 ? tat3[tat3.length - 2] : null;
  const yoyD  = tatC != null && tatP ? tatC - tatP : null;
  const yoyPct= tatP  ? (tatC - tatP) / Math.abs(tatP) * 100 : null;
  const sAvg  = at.sector_avg;
  const vsS   = tatC != null && sAvg ? (tatC / sAvg - 1) * 100 : null;

  const kpiHtml = `
    <div class="tat-kpi-row">
      <div class="tat-kpi-card main">
        <div class="tat-kpi-label">총자산 회전율</div>
        <div class="tat-kpi-value">${f2(tatC)}<span class="tat-kpi-unit">회/년</span></div>
        <div class="tat-kpi-note">${(at.years || fin.income_statement?.years || []).slice(-1)[0] || ''}년 기준</div>
      </div>
      <div class="tat-kpi-card" style="${yoyD != null ? `border-color:${yoyD >= 0 ? 'var(--green)' : 'var(--red)'};background:${yoyD >= 0 ? 'var(--green-dim)' : 'var(--red-dim)'}` : ''}">
        <div class="tat-kpi-label">전년 대비</div>
        <div class="tat-kpi-value" style="${yoyD != null ? `color:${yoyD >= 0 ? 'var(--green)' : 'var(--red)'}` : ''}">${yoyD != null ? sgn(yoyD) + yoyD.toFixed(3) : '-'}</div>
        <div class="tat-kpi-note">${yoyPct != null ? (yoyPct >= 0 ? '▲' : '▼') + Math.abs(yoyPct).toFixed(1) + '%' : '전년도 데이터 없음'}</div>
      </div>
      <div class="tat-kpi-card" style="${vsS != null ? `border-color:${vsS >= 0 ? 'var(--green)' : 'var(--red)'};background:${vsS >= 0 ? 'var(--green-dim)' : 'var(--red-dim)'}` : ''}">
        <div class="tat-kpi-label">업종 평균 대비</div>
        <div class="tat-kpi-value" style="${vsS != null ? `color:${vsS >= 0 ? 'var(--green)' : 'var(--red)'}` : ''}">${vsS != null ? sgn(vsS) + vsS.toFixed(1) + '%' : '-'}</div>
        <div class="tat-kpi-note">업종 평균 ${f2(sAvg)}회/년</div>
      </div>
    </div>`;

  // ── 2. 추이 차트 + 세부 회전율 테이블 ──────────────────────
  const chartCard = `
    <div class="card">
      <div class="card-header">📈 총자산 회전율 3개년 추이
        <span class="card-sub">업종 평균 포함</span>
      </div>
      <div class="chart-wrap h240"><canvas id="turnoverTrendChart"></canvas></div>
    </div>`;

  const MAX_SCALE = 15;
  const detailItems = [
    { label: '총자산 회전율',    formula: '매출 ÷ 총자산',    val: at.tat,  main: true  },
    { label: '유동자산 회전율',  formula: '매출 ÷ 유동자산',  val: at.cat                },
    { label: '비유동자산 회전율',formula: '매출 ÷ 비유동자산',val: at.ncat               },
    { label: '영업자산 회전율',  formula: '매출 ÷ 영업자산',  val: at.oat                },
    { label: '재고자산 회전율',  formula: '매출 ÷ 재고자산',  val: at.invt               },
    { label: '매출채권 회전율',  formula: '매출 ÷ 매출채권',  val: at.art                },
  ];
  const detailRows = detailItems.map(r => {
    const v = r.val;
    const barW = v != null ? Math.min(v / MAX_SCALE * 100, 100).toFixed(1) : 0;
    const bar = v != null
      ? `<div class="tat-bar-track"><div class="tat-bar-fill${r.main ? ' main' : ''}" style="width:${barW}%"></div></div>`
      : '';
    return `<tr class="${r.main ? 'tat-main-row' : ''}">
      <td><strong>${r.label}</strong></td>
      <td class="tat-formula">${r.formula}</td>
      <td class="tat-val">${v != null ? f2(v) + ' 회' : '-'}</td>
      <td class="tat-bar-cell">${bar}</td>
    </tr>`;
  }).join('');
  const detailHtml = `
    <div class="card">
      <div class="card-header">🔍 세부 회전율 분석</div>
      <div class="comp-table-wrap">
        <table class="tat-table">
          <thead><tr><th>지표</th><th>산식</th><th>값</th><th>상대 크기 (최대 ${MAX_SCALE}회 기준)</th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </div>`;

  // ── 3. DuPont 분석 ──────────────────────────────────────────
  const npm = at.npm;
  const tat = at.tat;
  const fl  = at.fl;
  const roeCalc = npm != null && tat != null && fl != null
    ? (npm * tat * fl * 100).toFixed(1) : null;
  const roeAct = (fin.income_statement?.roe || []).filter(v => v != null).slice(-1)[0];

  // ROE 주도 요인: 각 요소를 베이스라인 대비 비율로 비교
  let dominant = null;
  if (npm != null && tat != null && fl != null) {
    const scores = {
      npm: Math.abs(npm) / 0.06,
      tat: Math.abs(tat) / 0.55,
      fl:  Math.abs(fl)  / 2.0,
    };
    dominant = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }
  const factorMeta = {
    npm: { name: '수익성',   desc: '순이익률이 높아 적은 매출에서도 큰 이익을 냅니다.' },
    tat: { name: '효율성',   desc: '자산 활용도가 높아 같은 자산으로 더 많은 매출을 창출합니다.' },
    fl:  { name: '레버리지', desc: '부채를 적극 활용해 자기자본 수익률을 높이고 있습니다.' },
  };

  const dupFactor = (label, val, unit, isDominant, isResult) => `
    <div class="dupont-factor${isDominant ? ' dominant' : ''}${isResult ? ' result' : ''}">
      <div class="dupont-factor-name">${label}</div>
      <div class="dupont-factor-val">${val != null ? val : '-'}${val != null ? `<small>${unit}</small>` : ''}</div>
    </div>`;

  const dupHtml = `
    <div class="card">
      <div class="card-header">⚗️ DuPont 분석
        <span class="card-sub">ROE = 순이익률 × 총자산 회전율 × 재무레버리지</span>
      </div>
      <div class="dupont-equation">
        ${dupFactor('순이익률',     npm != null ? (npm*100).toFixed(1) : null, '%',    dominant==='npm', false)}
        <div class="dupont-op">×</div>
        ${dupFactor('총자산 회전율', tat != null ? f2(tat) : null,             '회',   dominant==='tat', false)}
        <div class="dupont-op">×</div>
        ${dupFactor('재무레버리지',  fl  != null ? f2(fl)  : null,             '배',   dominant==='fl',  false)}
        <div class="dupont-op">=</div>
        ${dupFactor('ROE (추산)',   roeCalc,                                    '%',   false,            true)}
      </div>
      ${roeAct != null ? `<div class="dupont-actual">실제 ROE: <strong>${roeAct}%</strong> · 추산 ROE: ${roeCalc != null ? roeCalc + '%' : '-'}</div>` : ''}
      ${dominant ? `<div class="dupont-insight">💡 ROE 주도 요인: <strong>${factorMeta[dominant].name}</strong> — ${factorMeta[dominant].desc}</div>` : ''}
    </div>`;

  // ── 4. AI 평가 ──────────────────────────────────────────────
  const aiHtml = at.ai_comment ? `
    <div class="card tat-ai-card">
      <div class="card-header">🤖 AI 자산 활용 평가</div>
      <div class="tat-ai-comment">${at.ai_comment}</div>
    </div>` : '';

  el.innerHTML = kpiHtml + chartCard + detailHtml + dupHtml + aiHtml;

  // Chart.js 차트 그리기
  const years3 = (at.years || []).slice(-3);
  const tat3v  = tat3.slice(-3);
  destroyChart('turnoverTrend');
  charts.turnoverTrend = new Chart(
    document.getElementById('turnoverTrendChart').getContext('2d'),
    {
      type: 'line',
      data: {
        labels: years3,
        datasets: [
          {
            label: '총자산 회전율',
            data: tat3v,
            borderColor: '#2f81f7', backgroundColor: '#2f81f718',
            borderWidth: 2.5, pointRadius: 5, pointBackgroundColor: '#2f81f7',
            tension: 0.35, fill: true,
          },
          sAvg != null ? {
            label: `업종 평균 (${f2(sAvg)}회)`,
            data: years3.map(() => sAvg),
            borderColor: '#d29922', borderWidth: 1.5,
            borderDash: [6, 4], pointRadius: 0, tension: 0,
          } : null,
        ].filter(Boolean),
      },
      options: {
        ...baseOptions(),
        scales: {
          x: { grid: { color: '#e0e4ea' } },
          y: {
            grid: { color: '#e0e4ea' },
            ticks: { callback: v => f2(v) + '회' },
            suggestedMin: 0,
          },
        },
        plugins: {
          tooltip: { callbacks: {
            label: ctx => `${ctx.dataset.label}: ${(ctx.parsed.y ?? 0).toFixed(3)}회/년`,
          }},
        },
      },
    }
  );
}

/* ── 시설투자 ──────────────────────────────────────────────── */
function renderCapex(fin, stock) {
  const cf  = fin.cash_flow;
  const is_ = fin.income_statement;
  const years = cf.years;

  // CAPEX: DART 파싱값 우선, 없으면 투자CF 절대값 × 0.8 추정
  const capex = (cf.capex && cf.capex.some(v => v > 0))
    ? cf.capex
    : cf.investing_cf.map(v => Math.round(Math.abs(v) * 0.8));

  const ocf = cf.operating_cf;
  const fcf = ocf.map((o, i) => o - capex[i]);

  // ── 차트 ──────────────────────────────────────────────────
  destroyChart('capex');
  charts.capex = new Chart(
    document.getElementById('capexChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: years,
        datasets: [
          {
            label: '영업현금흐름(OCF) (십억원)',
            data: ocf,
            backgroundColor: '#3fb95044', borderColor: '#3fb950',
            borderWidth: 1.5, borderRadius: 4, order: 2,
          },
          {
            label: 'CAPEX (십억원)',
            data: capex,
            backgroundColor: '#f0883e44', borderColor: '#f0883e',
            borderWidth: 1.5, borderRadius: 4, order: 2,
          },
          {
            label: 'FCF (십억원)',
            type: 'line',
            data: fcf,
            borderColor: '#2f81f7', backgroundColor: '#2f81f720',
            borderWidth: 2, pointRadius: 4, tension: 0.3,
            fill: false, order: 1,
          },
        ],
      },
      options: {
        ...baseOptions(),
        scales: {
          x: { grid: { color: '#e0e4ea' } },
          y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => fmtOk(v) } },
        },
        plugins: {
          tooltip: { callbacks: {
            label: ctx => `${ctx.dataset.label}: ${fmtOk(ctx.parsed.y)}`,
          }},
        },
      },
    }
  );

  // ── 핵심지표 ───────────────────────────────────────────────
  const lastIdx   = years.length - 1;
  const lastRev   = is_.revenue[lastIdx] || 1;
  const lastOcf   = ocf[lastIdx];
  const lastCapex = capex[lastIdx];
  const lastFcf   = fcf[lastIdx];

  const capexRatio  = lastRev  ? (lastCapex / lastRev  * 100).toFixed(1) + '%' : '-';
  const capexOcfRat = lastOcf  ? (lastCapex / lastOcf  * 100).toFixed(1) + '%' : '-';
  const fcfMargin   = lastRev  ? (lastFcf   / lastRev  * 100).toFixed(1) + '%' : '-';
  const cumFcf      = fcf.reduce((a, b) => a + b, 0);
  const avgCapex    = Math.round(capex.reduce((a, b) => a + b, 0) / capex.length);

  const isCapexSrc  = cf.capex && cf.capex.some(v => v > 0) ? 'DART' : '추정';

  const metrics = [
    { label: `CAPEX (${years[lastIdx]})`,   value: fmtOk(lastCapex),  note: isCapexSrc + ' 기준' },
    { label: 'CAPEX / 매출',                value: capexRatio,        note: '설비투자 강도' },
    { label: 'CAPEX / OCF',                 value: capexOcfRat,       note: '현금흐름 대비' },
    { label: `FCF (${years[lastIdx]})`,     value: fmtOk(lastFcf),   note: lastFcf >= 0 ? '양(+) FCF' : '음(-) FCF' },
    { label: 'FCF 마진',                    value: fcfMargin,          note: 'FCF / 매출액' },
    { label: '연평균 CAPEX',                value: fmtOk(avgCapex),   note: years[0] + '~' + years[lastIdx] },
  ];

  document.getElementById('capexMetrics').innerHTML = metrics.map(m => `
    <div class="ratio-item">
      <div class="ratio-label">${m.label}</div>
      <div class="ratio-value">${m.value}</div>
      <div class="ratio-note">${m.note}</div>
    </div>`).join('');

  // ── 연도별 상세 테이블 ─────────────────────────────────────
  const thead = `<thead><tr>
    <th>연도</th><th>OCF</th><th>CAPEX</th><th>FCF</th>
    <th>CAPEX/매출</th><th>FCF마진</th>
  </tr></thead>`;

  const tbody = years.map((y, i) => {
    const rev = is_.revenue[i] || 1;
    const cr  = (capex[i] / rev * 100).toFixed(1) + '%';
    const fm  = (fcf[i]   / rev * 100).toFixed(1) + '%';
    return `<tr>
      <td style="text-align:center">${y}</td>
      <td class="pos">${fmtOk(ocf[i])}</td>
      <td>${fmtOk(capex[i])}</td>
      <td class="${fcf[i] >= 0 ? 'pos' : 'neg'}">${fmtOk(fcf[i])}</td>
      <td>${cr}</td>
      <td class="${fcf[i] >= 0 ? 'pos' : 'neg'}">${fm}</td>
    </tr>`;
  }).join('');

  document.getElementById('capexTable').innerHTML = thead + '<tbody>' + tbody + '</tbody>';
}

/* ── R&D ────────────────────────────────────────────────────── */
function renderRnd(fin, stock) {
  const container = document.getElementById('rndContent');
  const rnd = fin.rnd;

  // R&D 데이터 없는 경우 (더미 데이터 or DART 미공시)
  if (!rnd || !rnd.expense || !rnd.expense.some(v => v > 0)) {
    const devAsset = rnd?.dev_asset || 0;
    const devPrev  = rnd?.dev_asset_prev || 0;
    const sga      = rnd?.sga || [];
    const years    = rnd?.years || fin.income_statement.years;
    const hasSga   = sga.some(v => v > 0);

    let sgaSection = '';
    if (hasSga) {
      const sgaRows = years.map((y, i) => {
        const rev = fin.income_statement.revenue[i] || 1;
        return `<tr>
          <td style="text-align:center">${y}</td>
          <td>${fmtOk(sga[i])}</td>
          <td>${(sga[i] / rev * 100).toFixed(1)}%</td>
        </tr>`;
      }).join('');
      sgaSection = `
        <div class="card" style="margin-top:16px">
          <div class="card-header">판매비와관리비 추이 <span class="card-sub">R&D 포함 — 십억원</span></div>
          <table class="fin-table">
            <thead><tr><th>연도</th><th>SG&amp;A</th><th>SG&amp;A/매출</th></tr></thead>
            <tbody>${sgaRows}</tbody>
          </table>
        </div>`;
    }

    const devSection = devAsset > 0 ? `
      <div class="rnd-dev-row">
        <span class="rnd-dev-label">개발비 자산 (BS 무형자산)</span>
        <span class="rnd-dev-val">${fmtOk(devAsset)}</span>
        <span class="rnd-dev-chg ${devAsset >= devPrev ? '' : 'neg'}">
          ${devPrev ? (devAsset >= devPrev ? '▲' : '▼') + fmtOk(Math.abs(devAsset - devPrev)) : '-'}
        </span>
      </div>` : '';

    container.innerHTML = `
      <div class="card">
        <div class="card-header">R&amp;D 비용</div>
        <div class="rnd-nodata">
          <div class="rnd-nodata-icon">🔬</div>
          <div class="rnd-nodata-title">DART 공시 기준 R&amp;D 비용 별도 항목 없음</div>
          <div class="rnd-nodata-desc">
            해당 기업은 연구개발비를 판매비와관리비(SG&amp;A)에 통합 공시합니다.<br>
            정확한 R&amp;D 금액은 사업보고서 주석을 확인하세요.
          </div>
          ${devSection}
        </div>
      </div>
      ${sgaSection}`;
    return;
  }

  // R&D 데이터 있는 경우
  const years   = rnd.years;
  const expense = rnd.expense;
  const rev     = fin.income_statement.revenue;
  const op      = fin.income_statement.operating_profit;
  const rndRatio = expense.map((v, i) => rev[i] ? +(v / rev[i] * 100).toFixed(2) : 0);

  // ── 핵심지표 ───────────────────────────────────────────────
  const li = years.length - 1;
  const yoy = li > 0 && expense[li - 1]
    ? ((expense[li] / expense[li - 1] - 1) * 100).toFixed(1) + '%'
    : '-';
  const rndOp = op[li] ? (expense[li] / op[li] * 100).toFixed(1) + '%' : '-';
  const avg   = Math.round(expense.reduce((a, b) => a + b, 0) / expense.length);

  const metrics = [
    { label: `R&D (${years[li]})`,   value: fmtOk(expense[li]), note: 'DART 비용처리분' },
    { label: 'R&D 집중도',           value: rndRatio[li].toFixed(2) + '%', note: 'R&D / 매출액' },
    { label: 'R&D / 영업이익',       value: rndOp,              note: '이익 대비 투자' },
    { label: 'YoY 증감',             value: yoy,                note: '전년 대비' },
    { label: '연평균 R&D',           value: fmtOk(avg),         note: years[0] + '~' + years[li] },
    { label: '개발비 자산',          value: rnd.dev_asset ? fmtOk(rnd.dev_asset) : '-', note: 'BS 자산화분' },
  ];

  const metricsHtml = metrics.map(m => `
    <div class="ratio-item">
      <div class="ratio-label">${m.label}</div>
      <div class="ratio-value">${m.value}</div>
      <div class="ratio-note">${m.note}</div>
    </div>`).join('');

  // ── 연도별 테이블 ──────────────────────────────────────────
  const thead = `<thead><tr>
    <th>연도</th><th>R&amp;D 비용</th><th>R&amp;D 집중도</th>
    <th>R&amp;D / 영업이익</th><th>YoY</th>
  </tr></thead>`;
  const tbody = years.map((y, i) => {
    const rat = rndRatio[i].toFixed(2) + '%';
    const rop = op[i] ? (expense[i] / op[i] * 100).toFixed(1) + '%' : '-';
    const yy  = i > 0 && expense[i - 1]
      ? ((expense[i] / expense[i - 1] - 1) * 100).toFixed(1) + '%'
      : '-';
    return `<tr>
      <td style="text-align:center">${y}</td>
      <td>${fmtOk(expense[i])}</td>
      <td>${rat}</td>
      <td>${rop}</td>
      <td class="${i > 0 && expense[i] >= expense[i-1] ? 'pos' : 'neg'}">${yy}</td>
    </tr>`;
  }).join('');

  const acctBadge = rnd.account_nm
    ? `<span class="src-badge" style="display:inline-block;margin-left:8px">${rnd.account_nm}</span>`
    : '';

  container.innerHTML = `
    <div class="card">
      <div class="card-header">R&amp;D 비용 추이 <span class="card-sub">십억원 / 집중도(%)</span>${acctBadge}</div>
      <div class="chart-wrap h280"><canvas id="rndChartCanvas"></canvas></div>
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-header">R&amp;D 핵심지표</div>
        <div class="ratios-grid">${metricsHtml}</div>
      </div>
      <div class="card">
        <div class="card-header">연도별 상세</div>
        <table class="fin-table">${thead}<tbody>${tbody}</tbody></table>
      </div>
    </div>`;

  // 차트 캔버스가 DOM에 삽입된 후 렌더링
  requestAnimationFrame(() => {
    destroyChart('rnd');
    charts.rnd = new Chart(
      document.getElementById('rndChartCanvas').getContext('2d'),
      {
        type: 'bar',
        data: {
          labels: years,
          datasets: [
            {
              label: 'R&D 비용 (십억원)',
              data: expense,
              backgroundColor: '#a371f744', borderColor: '#a371f7',
              borderWidth: 1.5, borderRadius: 4,
              yAxisID: 'y', order: 2,
            },
            {
              label: 'R&D 집중도',
              type: 'line',
              data: rndRatio,
              borderColor: '#f0883e', backgroundColor: 'transparent',
              borderWidth: 2, pointRadius: 4, tension: 0.3,
              yAxisID: 'y1', order: 1,
            },
          ],
        },
        options: {
          ...baseOptions(),
          scales: {
            y:  { position: 'left',  grid: { color: '#e0e4ea' }, ticks: { callback: v => fmtOk(v) } },
            y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } },
            x:  { grid: { color: '#e0e4ea' } },
          },
          plugins: {
            tooltip: { callbacks: {
              label: ctx => ctx.dataset.yAxisID === 'y1'
                ? `R&D 집중도: ${ctx.parsed.y.toFixed(2)}%`
                : `R&D 비용: ${fmtOk(ctx.parsed.y)}`,
            }},
          },
        },
      }
    );
  });
}

/* ── 인력변동 분석 ──────────────────────────────────────────── */
function renderHR(hr) {
  const container = document.getElementById('hrContent');

  if (!hr.years || hr.years.length === 0) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">직원현황</div>
        <div class="rnd-nodata">
          <div class="rnd-nodata-icon">👥</div>
          <div class="rnd-nodata-title">직원현황 데이터 없음</div>
          <div class="rnd-nodata-desc">DART 사업보고서에서 직원현황 데이터를 찾을 수 없습니다.<br>상장 초기 기업이거나 공시 대상이 아닐 수 있습니다.</div>
        </div>
      </div>`;
    return;
  }

  const li     = hr.years.length - 1;
  const tot    = hr.total[li]      || 0;
  const reg    = hr.regular[li]    || 0;
  const con    = hr.contract[li]   || 0;
  const mal    = hr.male[li]       || 0;
  const fem    = hr.female[li]     || 0;
  const sal    = hr.avg_salary[li];
  const tenure = hr.avg_tenure ? hr.avg_tenure[li] : null;
  const mSal   = hr.male_salary   ? hr.male_salary[li]   : null;
  const fSal   = hr.female_salary ? hr.female_salary[li] : null;

  const rnd          = hr.rnd || {};
  const rndRatio     = rnd.rnd_ratio     ?? null;
  const rndHeadcount = rnd.rnd_headcount ?? null;
  const rndExpense   = rnd.rnd_expense   ?? null;

  const perRev = hr.per_emp_revenue;  // 억원/명
  const perOp  = hr.per_emp_op;       // 억원/명

  const regRatio = tot > 0 ? (reg / tot * 100).toFixed(1) : null;
  const femRatio = (mal + fem) > 0 ? (fem / (mal + fem) * 100).toFixed(1) : null;
  const rndRatioOfEmp = (rndHeadcount && tot > 0) ? (rndHeadcount / tot * 100).toFixed(1) : null;

  const prevTot = li > 0 ? (hr.total[li - 1] || 0) : null;
  const yoyPct  = prevTot && prevTot > 0
    ? ((tot - prevTot) / prevTot * 100).toFixed(1) : null;
  const totNote = yoyPct != null
    ? (parseFloat(yoyPct) >= 0 ? `▲ ${yoyPct}% YoY` : `▼ ${Math.abs(parseFloat(yoyPct))}% YoY`)
    : hr.years[li] + '년 기준';

  // KPI 카드
  const kpiItems = [
    { label: '전체 직원수',  value: tot.toLocaleString('ko-KR') + '명', note: totNote },
    { label: '정규직 비율',  value: regRatio != null ? regRatio + '%' : '-',
      note: reg > 0 ? `정규직 ${reg.toLocaleString('ko-KR')}명` : '-' },
    { label: '여성 비율',    value: femRatio != null ? femRatio + '%' : '-',
      note: (mal > 0 || fem > 0) ? `남 ${mal.toLocaleString('ko-KR')} · 여 ${fem.toLocaleString('ko-KR')}명` : '-' },
    { label: '평균급여',     value: sal != null ? Math.round(sal) + '백만원' : '-',
      note: sal != null ? '연간 1인 기준' : 'DART 미공시' },
    { label: '평균근속연수', value: tenure != null ? tenure.toFixed(1) + '년' : '-',
      note: tenure != null ? hr.years[li] + '년 기준' : 'DART 미공시' },
    { label: 'R&D 비용비율', value: rndRatio != null ? rndRatio.toFixed(1) + '%' : '-',
      note: rndExpense != null ? `R&D ${Math.round(rndExpense/1000).toLocaleString('ko-KR')}십억원` : '매출 대비' },
  ];

  // 1인당 생산성 섹션
  const productivityHtml = (perRev != null || perOp != null) ? `
    <div class="card">
      <div class="card-header">1인당 생산성 <span class="card-sub">${hr.years[li]}년 기준</span></div>
      <div class="hr-productivity">
        ${perRev != null ? `
        <div class="hr-prod-item">
          <div class="hr-prod-label">1인당 매출액</div>
          <div class="hr-prod-value">${(perRev * 10).toLocaleString('ko-KR', {minimumFractionDigits:1, maximumFractionDigits:1})}십억원</div>
          <div class="hr-prod-note">연결 매출 ÷ 전체 인원</div>
        </div>` : ''}
        ${perOp != null ? `
        <div class="hr-prod-item">
          <div class="hr-prod-label">1인당 영업이익</div>
          <div class="hr-prod-value ${parseFloat(perOp) >= 0 ? 'up' : 'down'}">${(perOp * 10).toLocaleString('ko-KR', {minimumFractionDigits:1, maximumFractionDigits:1})}십억원</div>
          <div class="hr-prod-note">연결 영업이익 ÷ 전체 인원</div>
        </div>` : ''}
        ${(mSal != null || fSal != null) ? `
        <div class="hr-prod-item">
          <div class="hr-prod-label">남성 평균급여</div>
          <div class="hr-prod-value">${mSal != null ? Math.round(mSal) + '백만원' : '-'}</div>
          <div class="hr-prod-note">여성: ${fSal != null ? Math.round(fSal) + '백만원' : '-'}</div>
        </div>` : ''}
      </div>
    </div>` : '';

  // R&D 섹션
  const rndSection = (rndRatio != null || rndHeadcount != null) ? `
    <div class="card">
      <div class="card-header">연구개발(R&D) 인력 <span class="src-badge dart" style="font-size:9px">DART</span></div>
      <div class="hr-rnd-body">
        <div class="hr-rnd-stats">
          ${rndHeadcount != null ? `
          <div class="hr-rnd-stat">
            <div class="hr-rnd-stat-val">${rndHeadcount.toLocaleString('ko-KR')}명</div>
            <div class="hr-rnd-stat-lbl">R&D 인력</div>
          </div>` : ''}
          ${rndRatioOfEmp != null ? `
          <div class="hr-rnd-stat">
            <div class="hr-rnd-stat-val">${rndRatioOfEmp}%</div>
            <div class="hr-rnd-stat-lbl">전체 중 R&D 비중</div>
          </div>` : ''}
          ${rndRatio != null ? `
          <div class="hr-rnd-stat">
            <div class="hr-rnd-stat-val">${rndRatio.toFixed(1)}%</div>
            <div class="hr-rnd-stat-lbl">매출 대비 R&D 비용</div>
          </div>` : ''}
          ${rndExpense != null ? `
          <div class="hr-rnd-stat">
            <div class="hr-rnd-stat-val">${(rndExpense/1000).toLocaleString('ko-KR', {minimumFractionDigits:0, maximumFractionDigits:0})}십억원</div>
            <div class="hr-rnd-stat-lbl">R&D 비용 (${hr.years[li]})</div>
          </div>` : ''}
        </div>
        ${rndHeadcount != null && tot > 0 ? `
        <div class="hr-rnd-donut-wrap">
          <div class="chart-wrap" style="height:160px;max-width:260px"><canvas id="hrRndChart"></canvas></div>
        </div>` : ''}
      </div>
    </div>` : '';

  container.innerHTML = `
    <div class="kpi-row">
      ${kpiItems.map(k => `
        <div class="kpi-card">
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-value">${k.value}</div>
          <div class="kpi-note">${k.note}</div>
        </div>`).join('')}
    </div>
    ${rndSection}
    ${productivityHtml}
    <div class="grid-2-1">
      <div class="card">
        <div class="card-header">연도별 직원수 추이 <span class="card-sub">명</span></div>
        <div class="chart-wrap h260"><canvas id="hrTrendChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header">인력구성 <span class="card-sub">${hr.years[li]}년</span></div>
        <div class="hr-pie-label">고용형태</div>
        <div class="chart-wrap" style="height:112px"><canvas id="hrEmplChart"></canvas></div>
        <div class="hr-pie-label" style="margin-top:10px">성별</div>
        <div class="chart-wrap" style="height:112px"><canvas id="hrGenderChart"></canvas></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">연도별 상세</div>
      <table class="fin-table" id="hrTable"></table>
    </div>`;

  requestAnimationFrame(() => {
    // 직원수 추이 바 차트
    destroyChart('hrTrend');
    const datasets = [
      { label: '전체',   data: hr.total,    backgroundColor: '#2f81f740', borderColor: '#2f81f7', borderWidth: 1.5, borderRadius: 4 },
    ];
    if (hr.regular.some(v => v > 0))
      datasets.push({ label: '정규직', data: hr.regular,  backgroundColor: '#3fb95040', borderColor: '#3fb950', borderWidth: 1.5, borderRadius: 4 });
    if (hr.contract.some(v => v > 0))
      datasets.push({ label: '계약직', data: hr.contract, backgroundColor: '#d2992240', borderColor: '#d29922', borderWidth: 1.5, borderRadius: 4 });

    charts.hrTrend = new Chart(
      document.getElementById('hrTrendChart').getContext('2d'), {
        type: 'bar',
        data: { labels: hr.years, datasets },
        options: {
          ...baseOptions(),
          scales: {
            x: { grid: { color: '#e0e4ea' } },
            y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => v.toLocaleString('ko-KR') } },
          },
          plugins: {
            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString('ko-KR')}명` } },
            legend: { labels: { font: { family: FONT, size: 12 } } },
          },
        },
      }
    );

    // R&D 도넛 (headcount 있을 때만)
    destroyChart('hrRnd');
    if (rndHeadcount != null && tot > 0 && document.getElementById('hrRndChart')) {
      const nonRnd = Math.max(0, tot - rndHeadcount);
      charts.hrRnd = new Chart(
        document.getElementById('hrRndChart').getContext('2d'), {
          type: 'doughnut',
          data: {
            labels: ['R&D 인력', '비R&D'],
            datasets: [{ data: [rndHeadcount, nonRnd],
              backgroundColor: ['#2f81f7aa', '#e0e4eaaa'],
              borderColor:     ['#2f81f7',   '#c8d3dc'], borderWidth: 1.5 }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'right', labels: { font: { family: FONT, size: 11 }, boxWidth: 10, padding: 6 } },
              tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString('ko-KR')}명 (${(ctx.parsed/tot*100).toFixed(1)}%)` } },
            },
            cutout: '60%',
          },
        }
      );
    }

    // 고용형태 도넛
    destroyChart('hrEmpl');
    if (reg > 0 || con > 0) {
      charts.hrEmpl = new Chart(
        document.getElementById('hrEmplChart').getContext('2d'), {
          type: 'doughnut',
          data: {
            labels: ['정규직', '계약직'],
            datasets: [{ data: [reg, con],
              backgroundColor: ['#3fb950aa', '#d29922aa'],
              borderColor:     ['#3fb950',   '#d29922'], borderWidth: 1.5 }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'right', labels: { font: { family: FONT, size: 11 }, boxWidth: 10, padding: 6 } },
              tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString('ko-KR')}명 (${tot > 0 ? (ctx.parsed/tot*100).toFixed(1) : '-'}%)` } },
            },
            cutout: '62%',
          },
        }
      );
    }

    // 성별 도넛
    destroyChart('hrGender');
    if (mal > 0 || fem > 0) {
      charts.hrGender = new Chart(
        document.getElementById('hrGenderChart').getContext('2d'), {
          type: 'doughnut',
          data: {
            labels: ['남성', '여성'],
            datasets: [{ data: [mal, fem],
              backgroundColor: ['#2f81f7aa', '#f7855aaa'],
              borderColor:     ['#2f81f7',   '#f7855a'], borderWidth: 1.5 }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'right', labels: { font: { family: FONT, size: 11 }, boxWidth: 10, padding: 6 } },
              tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString('ko-KR')}명 (${(mal+fem) > 0 ? (ctx.parsed/(mal+fem)*100).toFixed(1) : '-'}%)` } },
            },
            cutout: '62%',
          },
        }
      );
    }
  });

  // 연도별 상세 테이블
  const tHead = `<thead><tr>
    <th>연도</th><th>전체</th><th>정규직</th><th>계약직</th><th>남성</th><th>여성</th><th>평균급여</th><th>근속연수</th>
  </tr></thead>`;
  const tBody = hr.years.map((y, i) => {
    const t  = hr.total[i]      || 0;
    const r  = hr.regular[i]    || 0;
    const c  = hr.contract[i]   || 0;
    const m  = hr.male[i]       || 0;
    const f  = hr.female[i]     || 0;
    const s  = hr.avg_salary[i];
    const tn = hr.avg_tenure ? hr.avg_tenure[i] : null;
    const regPct = t > 0 && r > 0 ? `<span style="font-size:10px;color:var(--text-faint)">(${(r/t*100).toFixed(1)}%)</span>` : '';
    return `<tr>
      <td style="text-align:center">${y}</td>
      <td>${t.toLocaleString('ko-KR')}</td>
      <td>${r > 0 ? r.toLocaleString('ko-KR') + ' ' + regPct : '-'}</td>
      <td>${c > 0 ? c.toLocaleString('ko-KR') : '-'}</td>
      <td>${m > 0 ? m.toLocaleString('ko-KR') : '-'}</td>
      <td>${f > 0 ? f.toLocaleString('ko-KR') : '-'}</td>
      <td>${s != null ? Math.round(s) + '백만원' : '-'}</td>
      <td>${tn != null ? tn.toFixed(1) + '년' : '-'}</td>
    </tr>`;
  }).join('');
  document.getElementById('hrTable').innerHTML = tHead + '<tbody>' + tBody + '</tbody>';
}

/* ── 경쟁사 직접 추가 UI ─────────────────────────────────── */
function initCompetitorsUI(code, initialRows) {
  renderCompSearchBar(code);
  renderCompetitors(initialRows);
}

function renderCompSearchBar(code) {
  const bar = document.getElementById('compSearchBar');
  if (!bar) return;
  bar.innerHTML = `
    <div class="comp-add-panel">
      <div class="comp-add-header">
        <span class="comp-add-title">경쟁사 직접 추가</span>
        <span class="comp-add-count" id="compAddCount">${customCompetitors.length}/5</span>
      </div>
      <div class="comp-add-row">
        <div class="comp-search-wrap">
          <input id="compSearchInput" class="comp-search-input"
            placeholder="기업명 또는 종목코드 검색…"
            autocomplete="off"
            oninput="onCompSearch(this.value)"
            onkeydown="onCompSearchKey(event)" />
          <div id="compSearchDropdown" class="comp-search-dropdown hidden"></div>
        </div>
        <button class="comp-btn-ai" onclick="recommendCompetitors('${code}')">
          ✨ AI 추천
        </button>
      </div>
      <div id="compChips" class="comp-chips"></div>
    </div>`;
  renderCompChips(code);
}

function renderCompChips(code) {
  const el = document.getElementById('compChips');
  const countEl = document.getElementById('compAddCount');
  if (!el) return;
  if (countEl) countEl.textContent = `${customCompetitors.length}/5`;
  if (customCompetitors.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = customCompetitors.map(c => `
    <span class="comp-chip">
      ${c.name} <span class="comp-chip-code">${c.code}</span>
      <button class="comp-chip-x" data-remove="${c.code}" title="제거">×</button>
    </span>`).join('');
  el.querySelectorAll('.comp-chip-x').forEach(btn => {
    btn.addEventListener('click', () => removeCustomCompetitor(code, btn.dataset.remove));
  });
}

function onCompSearch(q) {
  clearTimeout(compSearchTimer);
  const dd = document.getElementById('compSearchDropdown');
  if (!q.trim()) { dd.classList.add('hidden'); dd.innerHTML = ''; return; }
  compSearchTimer = setTimeout(async () => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
    const results = await res.json();
    if (!results.length) { dd.classList.add('hidden'); dd.innerHTML = ''; return; }
    const addedCodes = new Set([currentCode, ...customCompetitors.map(c => c.code)]);
    const filtered = results.filter(r => !addedCodes.has(r.code));
    if (!filtered.length) { dd.classList.add('hidden'); dd.innerHTML = ''; return; }
    // data-* 속성으로 코드·이름 전달해 인라인 이스케이프 문제 방지
    dd.innerHTML = filtered.map(r => `
      <div class="comp-dd-item" data-code="${r.code}" data-name="${r.name.replace(/"/g,'&quot;')}">
        <span class="comp-dd-name">${r.name}</span>
        <span class="comp-dd-code">${r.code} · ${r.sector}</span>
      </div>`).join('');
    dd.querySelectorAll('.comp-dd-item').forEach(el => {
      el.addEventListener('click', () => addCustomCompetitor(el.dataset.code, el.dataset.name));
    });
    dd.classList.remove('hidden');
  }, 250);
}

function onCompSearchKey(e) {
  if (e.key === 'Escape') {
    document.getElementById('compSearchDropdown').classList.add('hidden');
  }
}

async function addCustomCompetitor(code, name) {
  if (customCompetitors.length >= 5) {
    alert('최대 5개까지 추가할 수 있습니다.');
    return;
  }
  if (customCompetitors.some(c => c.code === code) || code === currentCode) return;
  customCompetitors.push({ code, name });
  const dd = document.getElementById('compSearchDropdown');
  if (dd) { dd.classList.add('hidden'); dd.innerHTML = ''; }
  const inp = document.getElementById('compSearchInput');
  if (inp) inp.value = '';
  renderCompChips(currentCode);
  await refreshCompetitors();
}

async function removeCustomCompetitor(mainCode, removeCode) {
  customCompetitors = customCompetitors.filter(c => c.code !== removeCode);
  renderCompChips(mainCode);
  await refreshCompetitors();
}

async function refreshCompetitors() {
  const tableEl = document.getElementById('competitorTable');
  if (tableEl) {
    tableEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center">⏳ 데이터 갱신 중…</div>';
  }
  const extra = customCompetitors.map(c => c.code).join(',');
  const url   = extra
    ? `/api/competitors/${currentCode}?extra=${extra}`
    : `/api/competitors/${currentCode}`;
  const rows  = await fetch(url).then(r => r.json());
  renderCompetitors(rows);
}

async function recommendCompetitors(code) {
  const btn = document.querySelector('.comp-btn-ai');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 추천 중…'; }
  try {
    const peers = await fetch(`/api/peers/${code}`).then(r => r.json());
    const addedCodes = new Set([currentCode, ...customCompetitors.map(c => c.code)]);
    let added = 0;
    for (const p of peers) {
      if (added >= 3) break;
      if (addedCodes.has(p.code) || customCompetitors.length >= 5) continue;
      customCompetitors.push({ code: p.code, name: p.name });
      addedCodes.add(p.code);
      added++;
    }
    renderCompChips(code);
    if (added > 0) await refreshCompetitors();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ AI 추천'; }
  }
}

// 경쟁사 검색 외부 클릭 시 드롭다운 닫기
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.comp-search-wrap')) {
    const dd = document.getElementById('compSearchDropdown');
    if (dd) dd.classList.add('hidden');
  }
});

/* ── 경쟁사 비교 ────────────────────────────────────────────── */
function renderCompetitors(rows) {
  // 시총 내림차순 정렬 (전체)
  rows = [...rows].sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));

  // 테이블
  const thead = `<thead><tr>
    <th>기업명</th>
    <th>기준연도</th>
    <th>시가총액</th>
    <th>매출액</th>
    <th>영업이익</th>
    <th>영업이익률</th>
    <th>순이익</th>
    <th>ROE</th>
    <th>PER</th>
    <th>PBR</th>
    <th>외국인%</th>
  </tr></thead>`;

  const tbody = rows.map(r => {
    const finBadge   = r._source === 'dart'
      ? '<span class="comp-src dart">D</span>'
      : '<span class="comp-src dummy">M</span>';
    const priceBadge = r._price_source === 'realtime'
      ? '<span class="comp-src realtime">R</span>'
      : '';
    const roe  = r.roe        != null ? r.roe.toFixed(1) + '%' : '-';
    const per  = r.per        != null ? fmtRatio(r.per)        : '-';
    const pbr  = r.pbr        != null ? fmtRatio(r.pbr)        : '-';
    const mcap = r.market_cap ? fmtMcap(r.market_cap) : '-';
    const fr   = r.foreign_rate;
    const frCls = fr == null ? '' : fr >= 40 ? 'fo-high' : fr >= 20 ? 'fo-mid' : 'fo-low';
    const frHtml = fr != null
      ? `<span class="fo-rate-badge ${frCls}">${fr.toFixed(1)}%</span>`
      : '-';
    return `
      <tr class="${r.is_main ? 'main-row' : ''}">
        <td>
          <div class="comp-name">${r.name} ${finBadge}${priceBadge}</div>
          <div class="comp-code">${r.code} · ${r.sector}</div>
        </td>
        <td style="text-align:center">${r.year}년</td>
        <td>${mcap}</td>
        <td>${fmtOk(r.revenue)}</td>
        <td>${fmtOk(r.op_profit)}</td>
        <td>${r.op_margin.toFixed(1)}%</td>
        <td>${fmtOk(r.net_income)}</td>
        <td>${roe}</td>
        <td>${per}</td>
        <td>${pbr}</td>
        <td style="text-align:center">${frHtml}</td>
      </tr>`;
  }).join('');

  // 데이터 출처 안내
  const allRealtime = rows.every(r => r._price_source === 'realtime');
  const note = `<div class="comp-note">
    <span class="comp-src dart">D</span> DART 재무(실데이터) &nbsp;
    <span class="comp-src realtime">R</span> Naver 실시간(시총·PER·PBR) &nbsp;
    <span class="comp-src dummy">M</span> 더미 &nbsp;
    ${allRealtime ? '| 시가총액·PER·PBR 실시간 적용' : '| 일부 항목 실시간 미적용'}
  </div>`;

  document.getElementById('competitorTable').innerHTML =
    note +
    `<div class="comp-table-wrap">
       <table class="comp-table">${thead}<tbody>${tbody}</tbody></table>
     </div>`;

  // ── 시가총액 비교 (수평 바) ────────────────────────────────
  const mcapRows = rows.filter(r => r.market_cap > 0);
  destroyChart('compMcap');
  charts.compMcap = new Chart(
    document.getElementById('compMcapChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: mcapRows.map(r => r.name),
        datasets: [{
          label: '시가총액 (조원)',
          data:  mcapRows.map(r => +(r.market_cap / 10000).toFixed(1)),
          backgroundColor: mcapRows.map(r => r.is_main ? '#2f81f7' : '#2f81f740'),
          borderColor: '#2f81f7', borderWidth: 1.5, borderRadius: 4,
        }],
      },
      options: {
        ...baseOptions({ indexAxis: 'y' }),
        layout: { padding: { left: 8, right: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: ctx => {
              const조 = ctx.parsed.x;
              return 조 >= 1
                ? `${조.toLocaleString('ko-KR', {maximumFractionDigits:1})}조원`
                : `${(조 * 1000).toLocaleString('ko-KR')}십억원`;
            },
          }},
        },
        scales: {
          x: {
            grid: { color: '#e0e4ea' },
            ticks: { callback: v => v >= 1 ? v + '조' : (v * 1000) + '십억' },
          },
          y: {
            grid: { color: '#e0e4ea' },
            ticks: {
              font: { family: "'Noto Sans KR', sans-serif", size: 11 },
              maxRotation: 0,
            },
            afterFit: axis => { axis.width = Math.max(axis.width, 90); },
          },
        },
      },
    }
  );

  // ── 매출액 비교 (수평 바) ──────────────────────────────────
  destroyChart('compRevenue');
  charts.compRevenue = new Chart(
    document.getElementById('compRevenueChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name),
        datasets: [{
          label: '매출액 (십억원)',
          data:  rows.map(r => r.revenue),
          backgroundColor: rows.map(r => r.is_main ? '#2f81f7' : '#2f81f740'),
          borderColor: '#2f81f7', borderWidth: 1.5, borderRadius: 4,
        }],
      },
      options: {
        ...baseOptions({ indexAxis: 'y' }),
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: ctx => `${fmtOk(ctx.parsed.x)}  (${rows[ctx.dataIndex].year}년)`,
          }},
        },
        scales: {
          x: { grid: { color: '#e0e4ea' }, ticks: { callback: v => fmtOk(v) } },
          y: {
            grid: { color: '#e0e4ea' },
            ticks: { maxRotation: 0 },
            afterFit: axis => { axis.width = Math.max(axis.width, 90); },
          },
        },
        layout: { padding: { left: 8, right: 8 } },
      },
    }
  );

  // ── 수익성 비교 (OPM + ROE) ───────────────────────────────
  destroyChart('compProfit');
  charts.compProfit = new Chart(
    document.getElementById('compProfitChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name),
        datasets: [
          {
            label: '영업이익률 (%)',
            data: rows.map(r => r.op_margin),
            backgroundColor: rows.map(r => r.is_main ? '#2f81f7' : '#2f81f740'),
            borderColor: '#2f81f7', borderWidth: 1.5, borderRadius: 4,
          },
          {
            label: 'ROE (%)',
            data: rows.map(r => r.roe ?? 0),
            backgroundColor: rows.map(r => r.is_main ? '#3fb950' : '#3fb95040'),
            borderColor: '#3fb950', borderWidth: 1.5, borderRadius: 4,
          },
        ],
      },
      options: {
        ...baseOptions(),
        scales: {
          x: { grid: { color: '#e0e4ea' } },
          y: { grid: { color: '#e0e4ea' }, ticks: { callback: v => v + '%' } },
        },
        plugins: {
          tooltip: { callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          }},
        },
      },
    }
  );

  // ── 외국인 지분율 비교 차트 ────────────────────────────────
  const frRows = rows.filter(r => r.foreign_rate != null);
  const frCard = document.getElementById('compForeignCard');
  if (frRows.length > 0 && frCard) {
    frCard.style.display = '';
    destroyChart('compForeign');
    charts.compForeign = new Chart(
      document.getElementById('compForeignChart').getContext('2d'),
      {
        type: 'bar',
        data: {
          labels: frRows.map(r => r.name),
          datasets: [{
            label: '외국인 지분율 (%)',
            data:  frRows.map(r => r.foreign_rate),
            backgroundColor: frRows.map(r => {
              const v = r.foreign_rate;
              const base = r.is_main ? 1 : 0.4;
              if (v >= 40) return `rgba(26,127,55,${base})`;
              if (v >= 20) return `rgba(47,129,247,${base})`;
              return `rgba(99,108,118,${base})`;
            }),
            borderColor: frRows.map(r => {
              const v = r.foreign_rate;
              if (v >= 40) return '#1a7f37';
              if (v >= 20) return '#2f81f7';
              return '#636c76';
            }),
            borderWidth: 1.5, borderRadius: 4,
          }],
        },
        options: {
          ...baseOptions({ indexAxis: 'y' }),
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => `${ctx.parsed.x.toFixed(2)}%` } },
          },
          scales: {
            x: {
              grid: { color: '#e0e4ea' },
              ticks: { callback: v => v + '%' },
              max: Math.min(100, Math.ceil(Math.max(...frRows.map(r => r.foreign_rate)) / 5) * 5 + 5),
            },
            y: {
              grid: { color: '#e0e4ea' },
              ticks: { maxRotation: 0 },
              afterFit: axis => { axis.width = Math.max(axis.width, 90); },
            },
          },
          layout: { padding: { left: 8, right: 8 } },
        },
      }
    );
  } else if (frCard) {
    frCard.style.display = 'none';
  }
}

/* ── 애널리스트 컨센서스 ────────────────────────────────────── */
function renderAnalyst(data, info) {
  const el = document.getElementById('analystContent');
  if (!el) return;

  const hk  = data.hankyung || {};
  const nv  = data.naver    || {};

  const curPrice = nv.cur_price || hk.cur_price || info?.current_price || 0;
  const nvTgt    = nv.target_price;
  const hkTgt    = hk.target_price;
  const nvUpside = nv.upside;
  const hkUpside = hk.upside;
  const opinion  = nv.opinion || hk.opinion || '-';
  const rm       = nv.recomm_mean;
  const reports  = hk.reports || [];

  // 투자의견 색상
  const opCls = { '강력매수':'chip-green','매수':'chip-green','중립':'chip-yellow',
                  '비중축소':'chip-red','매도':'chip-red' };
  const opChip = opinion !== '-'
    ? `<span class="analyst-chip ${opCls[opinion]||'chip-yellow'}">${opinion}</span>` : '';

  // 상승여력 표시
  function upsideHtml(u) {
    if (u == null) return '-';
    const cls = u >= 0 ? 'up' : 'down';
    return `<span class="${cls}">${u >= 0 ? '+' : ''}${u.toFixed(1)}%</span>`;
  }

  // 목표주가 게이지
  function gaugeHtml(cur, tgt, label) {
    if (!cur || !tgt) return '';
    const lo  = Math.min(cur, tgt) * 0.85;
    const hi  = Math.max(cur, tgt) * 1.15;
    const rng = hi - lo;
    const curPct = ((cur - lo) / rng * 100).toFixed(1);
    const tgtPct = ((tgt - lo) / rng * 100).toFixed(1);
    const upside = ((tgt - cur) / cur * 100).toFixed(1);
    const uCls   = tgt >= cur ? 'up' : 'down';
    return `
      <div class="analyst-gauge-wrap">
        <div class="analyst-gauge-label">${label}</div>
        <div class="analyst-gauge-track">
          <div class="analyst-gauge-fill ${tgt>=cur?'positive':'negative'}" style="left:${Math.min(curPct,tgtPct)}%;width:${Math.abs(tgtPct-curPct)}%"></div>
          <div class="analyst-gauge-cur"  style="left:${curPct}%">
            <div class="analyst-gauge-dot cur"></div>
            <div class="analyst-gauge-cur-lbl">${fmtPrice(cur)}</div>
          </div>
          <div class="analyst-gauge-tgt"  style="left:${tgtPct}%">
            <div class="analyst-gauge-dot tgt"></div>
            <div class="analyst-gauge-tgt-lbl">${fmtPrice(tgt)}<span class="${uCls}" style="font-size:11px;margin-left:4px">${tgt>=cur?'+':''}${upside}%</span></div>
          </div>
        </div>
        <div class="analyst-gauge-axis">
          <span>${fmtPrice(Math.round(lo))}</span>
          <span>${fmtPrice(Math.round(hi))}</span>
        </div>
      </div>`;
  }

  // 리포트 테이블
  const reportRows = reports.map(r => `
    <tr>
      <td><span class="analyst-brokerage">${r.brokerage || '-'}</span></td>
      <td class="analyst-analyst-name">${r.analyst || '-'}</td>
      <td class="analyst-date">${r.date || '-'}</td>
      <td>${r.url
        ? `<a class="analyst-report-link" href="${r.url}" target="_blank" rel="noopener">${r.title || '리포트 보기'} ↗</a>`
        : (r.title || '-')}</td>
    </tr>`).join('');

  // 추천점수 바 (1~5)
  const rmBar = rm != null ? `
    <div class="analyst-rm-wrap">
      <div class="analyst-rm-labels"><span>매도</span><span>비중축소</span><span>중립</span><span>매수</span><span>강력매수</span></div>
      <div class="analyst-rm-track">
        <div class="analyst-rm-fill" style="width:${((rm-1)/4*100).toFixed(1)}%"></div>
        <div class="analyst-rm-dot"  style="left:${((rm-1)/4*100).toFixed(1)}%"></div>
      </div>
      <div class="analyst-rm-score">${rm.toFixed(2)} / 5.00</div>
    </div>` : '';

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        📊 애널리스트 컨센서스
        <span class="src-badge dart" style="font-size:9px">한경+Naver</span>
      </div>
      <div class="analyst-body">
        <div class="analyst-summary">
          <div class="analyst-kpis">
            <div class="analyst-kpi">
              <div class="analyst-kpi-label">투자의견</div>
              <div class="analyst-kpi-value">${opChip || opinion}</div>
              ${rmBar}
            </div>
            <div class="analyst-kpi">
              <div class="analyst-kpi-label">컨센서스 목표가 <span class="analyst-src">Naver</span></div>
              <div class="analyst-kpi-value">${nvTgt ? fmtPrice(nvTgt) : '-'}</div>
              <div class="analyst-kpi-note">상승여력 ${upsideHtml(nvUpside)}</div>
            </div>
            <div class="analyst-kpi">
              <div class="analyst-kpi-label">한경 컨센서스 목표가</div>
              <div class="analyst-kpi-value">${hkTgt ? fmtPrice(hkTgt) : '-'}</div>
              <div class="analyst-kpi-note">상승여력 ${upsideHtml(hkUpside)}</div>
            </div>
          </div>
          ${gaugeHtml(curPrice, nvTgt, 'Naver 컨센서스 목표주가')}
          ${nvTgt !== hkTgt ? gaugeHtml(curPrice, hkTgt, '한경 컨센서스 목표주가') : ''}
        </div>
        ${reportRows ? `
        <div class="analyst-reports">
          <div class="analyst-reports-title">최근 리포트 <span class="analyst-src">한경 컨센서스</span></div>
          <table class="analyst-table">
            <thead><tr><th>증권사</th><th>애널리스트</th><th>날짜</th><th>제목</th></tr></thead>
            <tbody>${reportRows}</tbody>
          </table>
        </div>` : ''}
      </div>
    </div>`;
}

/* ── AI 보고서 ─────────────────────────────────────────────── */
function fmtFcf(n) {
  if (n == null) return '-';
  const sign = n > 0 ? '+' : '';
  return sign + (n / 10).toLocaleString('ko-KR', {minimumFractionDigits:1, maximumFractionDigits:1}) + '십억원';
}

function renderAiReport(ai) {
  const RATING_CLS = {
    '강력매수': 'strong-buy', '매수': 'buy',
    '중립': 'hold', '비중축소': 'reduce', '매도': 'sell',
  };
  const ratingCls = RATING_CLS[ai.rating] || 'hold';
  const upCls     = (ai.upside ?? 0) >= 0 ? 'up' : 'down';
  const srcBadge  = ai._source === 'dart'
    ? '<span class="src-badge dart">DART 실데이터</span>'
    : '<span class="src-badge dummy">더미 데이터</span>';

  // 목표주가 출처 배지
  const tgtSrcBadge = ai.target_source === 'consensus'
    ? '<span class="src-badge realtime" style="font-size:9px;padding:1px 5px;vertical-align:middle">애널리스트 컨센서스</span>'
    : ai.target_source === 'pb_model'
      ? '<span class="src-badge dart"    style="font-size:9px;padding:1px 5px;vertical-align:middle">P/B 모델</span>'
      : '';
  // 투자의견 출처 배지
  const ratingSrcBadge = ai.rating_source === 'consensus'
    ? '<span class="src-badge realtime" style="font-size:9px;padding:1px 5px;vertical-align:middle">컨센서스</span>'
    : '<span class="src-badge dart"     style="font-size:9px;padding:1px 5px;vertical-align:middle">재무모델</span>';

  const listItems = (items, dotCls) =>
    items.map(t => `<li><span class="ai-dot ${dotCls}"></span>${t}</li>`).join('');

  // ── 핵심 지표 미니카드 ───────────────────────────────────
  let metricsHtml = '';
  if (ai.metrics) {
    const m = ai.metrics;
    const metricItems = [
      {
        label: '매출성장(YoY)',
        value: (m.rev_yoy > 0 ? '+' : '') + m.rev_yoy + '%',
        note:  `CAGR ${m.cagr}%`,
        cls:   m.rev_yoy > 5 ? 'up' : m.rev_yoy < 0 ? 'down' : '',
      },
      {
        label: '영업이익률',
        value: m.opm + '%',
        note:  `추세 ${m.opm_trend > 0 ? '+' : ''}${m.opm_trend}%p`,
        cls:   m.opm > 15 ? 'up' : m.opm < 5 ? 'down' : '',
      },
      {
        label: 'ROE',
        value: m.roe + '%',
        note:  '자기자본이익률',
        cls:   m.roe > 15 ? 'up' : m.roe < 5 ? 'down' : '',
      },
      {
        label: 'FCF',
        value: fmtFcf(m.fcf),
        note:  '영업CF + 투자CF',
        cls:   m.fcf >= 0 ? 'up' : 'down',
      },
      {
        label: '부채비율',
        value: m.debt_ratio + '%',
        note:  '재무건전성',
        cls:   m.debt_ratio < 50 ? 'up' : m.debt_ratio > 150 ? 'down' : '',
      },
    ];
    metricsHtml = `
      <div class="ai-metrics-strip">
        ${metricItems.map(it => `
          <div class="ai-metric-item">
            <div class="ai-metric-label">${it.label}</div>
            <div class="ai-metric-value ${it.cls}">${it.value}</div>
            <div class="ai-metric-note">${it.note}</div>
          </div>`).join('')}
      </div>`;
  }

  const disclaimer = ai._source === 'dart'
    ? `* DART 전자공시 실재무 기반 자동 분석입니다. 실제 투자 권유가 아닙니다.`
    : `* 더미 데이터 기반 시뮬레이션이며 실제 투자 권유가 아닙니다.`;

  document.getElementById('aiReportContent').innerHTML = `
    ${metricsHtml}
    <div class="ai-report">
      <div class="ai-left">
        <div class="ai-rating-card">
          <div class="ai-rating-badge ${ratingCls}">${ai.rating} ${ratingSrcBadge}</div>
          <div class="ai-target">
            <div class="label">적정매도가격 ${tgtSrcBadge}</div>
            <div class="price">${fmtPrice(ai.target_price)}</div>
          </div>
          <div class="ai-upside ${upCls}">현재가 대비 ${(ai.upside ?? 0) >= 0 ? '+' : ''}${(ai.upside ?? 0).toFixed(1)}%</div>
          ${ai.recomm_mean != null ? `<div class="ai-recomm">애널리스트 추천지수 <strong>${ai.recomm_mean.toFixed(2)}</strong> / 5.00</div>` : ''}
        </div>
        <div class="ai-meta-card">
          <div class="label">현재가 (실시간)</div>
          <div class="value">${fmtPrice(ai.current_price)}</div>
        </div>
        ${ai.pb_target && ai.target_source === 'consensus' ? `
        <div class="ai-meta-card">
          <div class="label">P/B 모델 참고가</div>
          <div class="value">${fmtPrice(ai.pb_target)}
            <span style="font-size:11px;color:var(--text-muted)">
              (${ai.pb_target > ai.current_price ? '+' : ''}${((ai.pb_target - ai.current_price)/ai.current_price*100).toFixed(1)}%)
            </span>
          </div>
        </div>` : ''}
        <div class="ai-meta-card">
          <div class="label">EPS / BPS</div>
          <div class="value">${ai.metrics?.eps ? fmtPrice(ai.metrics.eps) : '-'} / ${ai.metrics?.bps ? fmtPrice(ai.metrics.bps) : '-'}</div>
        </div>
        <div class="ai-meta-card">
          <div class="label">분석 기준</div>
          <div class="value">${ai.years ? ai.years[ai.years.length-1] + '년' : '-'} ${srcBadge}</div>
        </div>
        <div class="ai-meta-card">
          <div class="label">분석 엔진</div>
          <div class="value">${ai.analyst}</div>
        </div>
      </div>
      <div class="ai-right">
        <div class="ai-section-card">
          <div class="ai-section-title">종합 투자의견</div>
          <p class="ai-summary">${ai.summary}</p>
        </div>
        <div class="ai-section-card">
          <div class="ai-section-title">투자 강점</div>
          <ul class="ai-list">${listItems(ai.strengths, 'green')}</ul>
        </div>
        <div class="ai-section-card">
          <div class="ai-section-title">리스크 요인</div>
          <ul class="ai-list">${listItems(ai.risks, 'red')}</ul>
        </div>
        <div class="ai-section-card">
          <div class="ai-section-title">주가 상승 촉매</div>
          <ul class="ai-list">${listItems(ai.catalysts, 'yellow')}</ul>
          <div class="ai-analyst">${disclaimer}</div>
        </div>
      </div>
    </div>`;
}

/* ── 탭 전환 ───────────────────────────────────────────────── */
function switchTab(tab, animate = true) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('hidden', pane.id !== `tab-${tab}`);
  });
  if (tab === 'hr'     && !hrLoaded     && currentCode) loadHRData();
  if (tab === 'exec'   && !execLoaded   && currentCode) loadExecData();
  if (tab === 'export' && !exportLoaded && currentCode) loadExportData();
  if (tab === 'sector' && !sectorLoaded && currentCode) loadSectorData();
}

/* ── 인력분석 지연 로딩 ──────────────────────────────────────── */
async function loadHRData() {
  const container = document.getElementById('hrContent');
  container.innerHTML = `
    <div class="card" style="text-align:center;padding:48px;color:var(--text-muted)">
      <div style="font-size:24px;margin-bottom:10px">⏳</div>
      <div>DART 직원현황 데이터 로딩 중...</div>
    </div>`;
  try {
    const hr = await fetch(`/api/employees/${currentCode}`).then(r => r.json());
    hrLoaded = true;
    renderHR(hr);
  } catch (e) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">직원현황</div>
        <div class="rnd-nodata">
          <div class="rnd-nodata-icon">⚠️</div>
          <div class="rnd-nodata-title">데이터 로드 실패</div>
          <div class="rnd-nodata-desc">네트워크 오류 또는 DART API 문제가 발생했습니다.</div>
        </div>
      </div>`;
  }
}

function switchSubTab(sub) {
  currentSub = sub;
  document.querySelectorAll('.sub-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sub === sub);
  });
  document.querySelectorAll('.subtab-pane').forEach(pane => {
    pane.classList.toggle('hidden', pane.id !== `subtab-${sub}`);
  });
}

function switchNewsTab(tabId, lang) {
  const nav = document.getElementById(tabId);
  if (!nav) return;
  nav.querySelectorAll('.news-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  nav.parentElement.querySelectorAll('.news-pane').forEach(pane => {
    pane.style.display = pane.dataset.lang === lang ? '' : 'none';
  });
}

/* ── 경영자 성과 탭 ─────────────────────────────────────────── */
function renderExec(data) {
  const execs   = data.executives       || [];
  const comp    = data.compensation     || [];
  const compPrev= data.compensation_prev|| [];
  const year    = data.year             || '-';
  const src     = data._source          || 'dummy';
  const ceo     = data.ceo              || null;
  const m       = data.metrics          || {};
  const grade   = data.grade            || {};
  const holders = data.shareholders     || [];
  const owners  = data.owner_execs      || [];

  const regComp    = data.reg_comp         || [];
  const regExecs   = execs.filter(e => e.registered);
  const outside    = regExecs.filter(e => (e.position||'').includes('사외') || (e.position||'').includes('감사위원')).length;
  const maxComp    = comp.length > 0 ? Math.max(...comp.map(c => c.amount_ok)) : 0;
  const maxRegComp = regComp.length > 0 ? Math.max(...regComp.map(c => c.amount_ok)) : maxComp;
  const srcBadge   = src === 'dart'
    ? '<span class="src-badge dart" style="font-size:9px;padding:1px 5px">DART 실데이터</span>'
    : '<span class="src-badge dummy" style="font-size:9px;padding:1px 5px">더미</span>';

  /* ── 커리어 파싱 (◇ 구분자 제거) ── */
  function fmtCareer(raw) {
    if (!raw) return '';
    return raw.replace(/◇/g, '\n').replace(/\n+/g, '\n').trim()
              .split('\n').filter(Boolean)
              .map(l => `<li>${l.trim()}</li>`).join('');
  }

  /* ── helpers ── */
  function gauge(val, max, color) {
    const pct = max > 0 ? Math.min(val / max * 100, 100).toFixed(0) : 0;
    return `<div class="gauge-track"><div class="gauge-fill" style="width:${pct}%;background:${color}"></div></div>`;
  }
  function yoyArrow(v) {
    if (v == null) return '<span style="color:var(--text-muted)">-</span>';
    const cls = v > 0 ? 'up' : (v < 0 ? 'down' : '');
    return `<span class="${cls}">${v > 0 ? '▲' : v < 0 ? '▼' : ''}${Math.abs(v).toFixed(1)}%</span>`;
  }
  function okFmt(v, digits=1) { return v != null ? v.toFixed(digits) + '억' : '-'; }

  let html = '';

  /* ═══════════════════════════════════════════════════════════
     1. CEO 프로필 카드
  ═══════════════════════════════════════════════════════════ */
  if (ceo) {
    const careerHtml = fmtCareer(ceo.career);
    /* 취임일: tenure 필드에서 날짜 형식(YYYY.MM.DD) 추출 */
    function parseTenureDate(t) {
      if (!t) return null;
      const m2 = t.match(/(\d{4}[.\-]\d{2}[.\-]\d{2})/);
      return m2 ? m2[1].replace(/\./g,'.') : null;
    }
    const appointDate = parseTenureDate(ceo.tenure);
    const payText     = data.ceo_pay_ok != null
      ? `<strong>${(data.ceo_pay_ok / 10).toFixed(2)}십억원</strong> <span style="color:var(--text-muted);font-size:12px">(${year}년 세전)</span>`
      : '<span style="color:var(--text-muted)">미공시 <span style="font-size:11px">(5억 미만 또는 공시 제외)</span></span>';
    html += `<div class="card exec-profile-card">
      <div class="exec-profile-grid">
        <div class="exec-avatar">${(ceo.name||'?')[0]}</div>
        <div class="exec-info">
          <div class="exec-name">${ceo.name} <span class="exec-pos-badge">${ceo.position||''}</span></div>
          <div class="exec-role">${ceo.role||''}</div>
          <div class="exec-meta-row">
            ${appointDate    ? `<span class="exec-meta-item">📅 취임 ${appointDate}</span>` : ceo.tenure ? `<span class="exec-meta-item">📅 재임 ${ceo.tenure}</span>` : ''}
            ${ceo.tenure_end ? `<span class="exec-meta-item">⏳ 임기만료 ${ceo.tenure_end}</span>` : ''}
            ${ceo.birth_ym   ? `<span class="exec-meta-item">🎂 ${ceo.birth_ym}</span>` : ''}
          </div>
          <div class="exec-pay-row">💰 연간 보수 ${payText}</div>
        </div>
        ${careerHtml ? `<div class="exec-career">
          <div class="exec-career-title">주요 경력</div>
          <ul class="exec-career-list">${careerHtml}</ul>
        </div>` : ''}
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     2. 핵심 지표 행 (KPI 4개)
  ═══════════════════════════════════════════════════════════ */
  const avgSalOk  = data.avg_salary_won != null ? (data.avg_salary_won / 1_000_000_000).toFixed(2) : null;
  const kpis = [
    { label: '등기임원',       value: regExecs.length + '명',               note: year + '년 사업보고서' },
    { label: '사외이사 비율',   value: regExecs.length ? (outside/regExecs.length*100).toFixed(0)+'%' : '-', note: '독립성 지표' },
    { label: '직원 평균급여',   value: avgSalOk ? avgSalOk + '십억원' : '-',   note: '연간 세전' },
    { label: '1인당 영업이익',  value: m.per_employee_op_ok != null ? (m.per_employee_op_ok / 10).toFixed(3)+'십억원' : '-', note: '직원 생산성' },
  ];
  html += `<div class="kpi-row">${kpis.map(k => `
    <div class="kpi-card">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('')}</div>`;

  /* ═══════════════════════════════════════════════════════════
     2-B. CEO vs 직원 평균급여 시각화
  ═══════════════════════════════════════════════════════════ */
  if (data.ceo_pay_ok != null && data.avg_salary_won != null) {
    const ceoPay   = data.ceo_pay_ok / 10;                          // 십억원
    const avgSal   = data.avg_salary_won / 1_000_000_000;           // 십억원
    const ratio    = m.ceo_to_avg_salary_x;
    const maxVal   = Math.max(ceoPay, avgSal * 1.05);
    const ceoPct   = (ceoPay / maxVal * 100).toFixed(1);
    const avgPct   = (avgSal / maxVal * 100).toFixed(1);
    const rColor   = ratio == null ? '#7d8590' : ratio < 30 ? '#3fb950' : ratio < 80 ? '#d29922' : '#f85149';
    const rLabel   = ratio == null ? '-' : `${ratio.toFixed(1)}배`;
    html += `<div class="card">
      <div class="card-header">👤 CEO vs 직원 평균급여 비교 <span class="card-sub">${year}년 · 연간 세전</span></div>
      <div class="salary-compare">
        <div class="salary-row">
          <span class="salary-name">CEO (${ceo ? ceo.name : '대표이사'})</span>
          <div class="salary-track"><div class="salary-fill ceo" style="width:${ceoPct}%"></div></div>
          <span class="salary-val">${ceoPay.toFixed(2)}십억원</span>
        </div>
        <div class="salary-row">
          <span class="salary-name">직원 평균급여</span>
          <div class="salary-track"><div class="salary-fill emp" style="width:${avgPct}%"></div></div>
          <span class="salary-val">${avgSal.toFixed(3)}십억원</span>
        </div>
        <div class="salary-ratio-row">
          <span style="color:var(--text-muted);font-size:13px">CEO / 직원 평균</span>
          <span class="salary-ratio-badge" style="background:${rColor}22;color:${rColor};border:1px solid ${rColor}44">${rLabel}</span>
          <span style="color:var(--text-muted);font-size:12px">${ratio != null ? (ratio < 30 ? '(글로벌 평균 수준)' : ratio < 80 ? '(주의)' : '(높음)') : ''}</span>
        </div>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     3. 보수 대비 성과 + 지배구조 (2열)
  ═══════════════════════════════════════════════════════════ */
  /* — 보수 대비 성과 카드 — */
  const payToOp   = m.ceo_pay_to_op_pct;
  const salaryX   = m.ceo_to_avg_salary_x;
  const payYoy    = m.pay_yoy_pct;
  const opYoy     = m.op_profit_yoy_pct;

  const toOpColor  = payToOp == null ? '#7d8590' : payToOp < 0.5 ? '#3fb950' : payToOp < 2 ? '#d29922' : '#f85149';
  const salColor   = salaryX == null ? '#7d8590' : salaryX < 30  ? '#3fb950' : salaryX  < 80 ? '#d29922' : '#f85149';

  let perfHtml = `<div class="perf-metric">
    <div class="perf-label">CEO 보수 / 영업이익</div>
    <div class="perf-value" style="color:${toOpColor}">${payToOp != null ? payToOp.toFixed(3)+'%' : '-'}</div>
    ${gauge(payToOp||0, 5, toOpColor)}
    <div class="perf-note">낮을수록 좋음 (기준: &lt;0.5% 우수)</div>
  </div>
  <div class="perf-metric">
    <div class="perf-label">CEO 보수 / 직원 평균급여</div>
    <div class="perf-value" style="color:${salColor}">${salaryX != null ? salaryX.toFixed(1)+'배' : '-'}</div>
    ${gauge(salaryX||0, 100, salColor)}
    <div class="perf-note">낮을수록 좋음 (기준: &lt;30배 낮음)</div>
  </div>
  <div class="perf-metric">
    <div class="perf-label">전년 대비 보수 증가율</div>
    <div class="perf-yoy-row">
      <div><div class="perf-note">CEO 보수</div><div class="perf-yoy-val">${yoyArrow(payYoy)}</div></div>
      <div class="perf-yoy-vs">vs</div>
      <div><div class="perf-note">영업이익</div><div class="perf-yoy-val">${yoyArrow(opYoy)}</div></div>
    </div>
    ${(payYoy != null && opYoy != null)
      ? `<div class="perf-note" style="margin-top:6px">${payYoy > 0 && opYoy < -10 ? '⚠️ 실적 하락에도 보수 증가' : payYoy <= opYoy ? '✅ 이익 성장률이 보수 증가율 상회' : '이익 성장과 보수 비교'}</div>`
      : ''}
  </div>`;

  /* 이전 연도 최고보수자 비교 */
  if (comp.length > 0 && compPrev.length > 0) {
    const topCur  = comp[0];
    const topPrev = compPrev.find(c => c.name === topCur.name);
    if (topPrev) {
      const diff = topCur.amount_ok - topPrev.amount_ok;
      const cls  = diff > 0 ? 'up' : 'down';
      perfHtml += `<div class="perf-metric">
        <div class="perf-label">${topCur.name} 보수 전년 비교</div>
        <div class="perf-value">${topCur.amount_ok.toFixed(1)}억 <span class="${cls}" style="font-size:13px">(${diff>0?'+':''}${diff.toFixed(1)}억)</span></div>
        <div class="perf-note">${year-1}년 ${topPrev.amount_ok.toFixed(1)}억 → ${year}년 ${topCur.amount_ok.toFixed(1)}억</div>
      </div>`;
    }
  }

  /* — 지배구조 카드 — */
  const ownerFlag = owners.length > 0;
  let govHtml = '';

  /* 최대주주 목록 */
  if (holders.length > 0) {
    govHtml += `<div class="gov-section-title">최대주주 현황</div>
    <div class="holders-list">${holders.map(h => {
      const pct = holders[0].ratio > 0 ? (h.ratio / holders[0].ratio * 100).toFixed(0) : 0;
      return `<div class="holder-row">
        <span class="holder-name">${h.name}</span>
        <div class="holder-bar-wrap"><div class="holder-bar" style="width:${pct}%"></div></div>
        <span class="holder-pct">${h.ratio.toFixed(2)}%</span>
      </div>`;
    }).join('')}</div>`;
  }

  /* 오너일가 임원 */
  govHtml += `<div class="gov-section-title" style="margin-top:16px">오너일가 등기임원</div>
  <div class="gov-tag-row">
    ${ownerFlag
      ? owners.map(n => `<span class="gov-tag warn">${n}</span>`).join('')
      : '<span class="gov-tag ok">해당 없음</span>'}
  </div>`;

  html += `<div class="grid-2">
    <div class="card">
      <div class="card-header">💰 보수 대비 성과 ${srcBadge}</div>
      <div class="perf-metrics">${perfHtml}</div>
    </div>
    <div class="card">
      <div class="card-header">🏛️ 지배구조</div>
      ${govHtml}
    </div>
  </div>`;

  /* ═══════════════════════════════════════════════════════════
     4. 재임 기간 성과 차트 (ROE 추이 + 매출/영업이익)
  ═══════════════════════════════════════════════════════════ */
  const yrs  = m.years_fin  || [];
  const revL = m.rev_list   || [];
  const opL  = m.op_list    || [];
  const roeL = m.roe_vals   || [];

  /* CEO 재임 시작연도 파싱 */
  function parseTenureYear(t) {
    if (!t) return null;
    const m2 = t.match(/(\d{4})/);
    return m2 ? parseInt(m2[1]) : null;
  }
  const tenureYear = ceo ? parseTenureYear(ceo.tenure) : null;
  const tenureNote = tenureYear ? `<span class="card-sub" style="color:#d29922">▶ CEO 재임 시작: ${tenureYear}년 (진한 색)</span>` : '';

  if (yrs.length > 0) {
    html += `<div class="grid-2">
      <div class="card">
        <div class="card-header">📊 매출·영업이익 추이 <span class="card-sub">십억원</span> ${tenureNote}</div>
        <div class="chart-wrap"><canvas id="execRevChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header">📈 ROE 추이 <span class="card-sub">%</span></div>
        <div class="chart-wrap"><canvas id="execRoeChart"></canvas></div>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     5. 등기임원 개인별 보수 현황
     reg_comp: hmvAuditIndvdlBySttus (등기임원 전체)
     comp    : indvdlByPay (5억+ 공시)
  ═══════════════════════════════════════════════════════════ */
  const displayList = regComp.length > 0 ? regComp : comp;
  const displayMax  = regComp.length > 0 ? maxRegComp : maxComp;
  const displaySub  = regComp.length > 0
    ? '등기임원 전체 · 세전 · 십억원'
    : '5억 이상 공시분 · 세전 · 십억원';

  if (displayList.length > 0) {
    html += `<div class="card">
      <div class="card-header">등기임원 개인별 보수 현황 <span class="card-sub">${displaySub}</span></div>
      <div class="comp-list">${displayList.map(c => {
        const pct   = displayMax > 0 ? (c.amount_ok / displayMax * 100).toFixed(0) : 0;
        const prev  = comp.find(p => p.name === c.name);
        const diff  = prev ? c.amount_ok - prev.amount_ok : null;
        const isCeo = ceo && c.name === ceo.name;
        return `<div class="comp-row${isCeo ? ' ceo-row' : ''}">
          <div class="comp-info">
            <span class="comp-name">${c.name}${isCeo ? ' <span style="font-size:10px;background:#2f81f722;color:#2f81f7;border-radius:3px;padding:1px 5px">CEO</span>' : ''}</span>
            <span class="comp-pos">${c.position}</span>
            ${diff != null ? `<span class="comp-period ${diff>=0?'up':'down'}">${diff>0?'▲':'▼'}${Math.abs(diff).toFixed(1)}억 vs ${year-1}년</span>` : ''}
          </div>
          <div class="comp-bar-wrap"><div class="comp-bar${isCeo ? ' ceo' : ''}" style="width:${pct}%"></div></div>
          <div class="comp-amount">${c.amount_ok.toFixed(1)}<span>억</span></div>
        </div>`;
      }).join('')}</div>
    </div>`;
  } else {
    html += `<div class="card">
      <div class="card-header">등기임원 개인별 보수 현황</div>
      <div style="padding:28px 20px;display:flex;align-items:center;gap:14px;color:var(--text-muted)">
        <span style="font-size:28px">📋</span>
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">보수 공시 정보 없음</div>
          <div style="font-size:13px;line-height:1.6">
            DART 공시 기준: 개인별 보수 5억원 미만이거나 해당 법인이 공시 제외 대상입니다.<br>
            (상법 제542조의8 — 소규모 상장사 면제 가능)
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     6. 등기임원 현황 테이블
  ═══════════════════════════════════════════════════════════ */
  html += `<div class="card">
    <div class="card-header">등기임원 현황 <span class="card-sub">${year}년 사업보고서</span></div>
    <div style="overflow-x:auto">
    <table class="fin-table exec-table">
      <thead><tr>
        <th>성명</th><th>직위</th><th>상근</th><th>담당업무</th><th>최대주주관계</th><th>임기만료</th>
      </tr></thead>
      <tbody>${regExecs.length ? regExecs.map(e => `
        <tr>
          <td><strong>${e.name}</strong>${owners.includes(e.name)?'<span class="gov-tag warn" style="margin-left:4px;font-size:10px">오너</span>':''}</td>
          <td>${e.position||'-'}</td>
          <td><span class="badge ${e.full_time?'badge-blue':'badge-gray'}">${e.full_time?'상근':'비상근'}</span></td>
          <td>${e.role||'-'}</td>
          <td>${e.shareholder_rel||'-'}</td>
          <td>${e.tenure_end||'-'}</td>
        </tr>`).join('') :
        '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">데이터 없음</td></tr>'}
      </tbody>
    </table>
    </div>
  </div>`;

  /* ═══════════════════════════════════════════════════════════
     7. AI 종합 평가
  ═══════════════════════════════════════════════════════════ */
  const g = grade;
  html += `<div class="card exec-grade-card">
    <div class="card-header">🎯 AI 종합 경영자 평가</div>
    <div class="grade-body">
      <div class="grade-circle" style="border-color:${g.color||'#7d8590'};color:${g.color||'#7d8590'}">${g.grade||'-'}</div>
      <div class="grade-detail">
        <div class="grade-comment">${g.comment||''}</div>
        ${(g.strengths||[]).length ? `<div class="grade-section"><span class="grade-dot green"></span> 강점</div>
          <ul class="grade-list">${(g.strengths||[]).map(s=>`<li>${s}</li>`).join('')}</ul>` : ''}
        ${(g.issues||[]).length ? `<div class="grade-section"><span class="grade-dot red"></span> 리스크</div>
          <ul class="grade-list">${(g.issues||[]).map(i=>`<li>${i}</li>`).join('')}</ul>` : ''}
        <div class="grade-note">* DART 공시 재무데이터 기반 자동 산출 · 투자 조언 아님</div>
      </div>
    </div>
  </div>`;

  document.getElementById('execContent').innerHTML = html;

  /* ── 차트 렌더링 ── */
  if (yrs.length > 0) {
    const revBarColors = yrs.map(yr =>
      (!tenureYear || parseInt(yr) >= tenureYear) ? 'rgba(47,129,247,0.75)' : 'rgba(47,129,247,0.22)');
    const opBarColors  = yrs.map(yr =>
      (!tenureYear || parseInt(yr) >= tenureYear) ? 'rgba(63,185,80,0.80)'  : 'rgba(63,185,80,0.22)');

    destroyChart('execRev');
    charts.execRev = new Chart(document.getElementById('execRevChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: yrs,
        datasets: [
          { label: '매출액 (십억원)',   data: revL, backgroundColor: revBarColors, borderRadius: 3 },
          { label: '영업이익 (십억원)', data: opL,  backgroundColor: opBarColors,  borderRadius: 3 },
        ],
      },
      options: baseOptions({ scales: { y: { ticks: { callback: v => fmtOk(v) }}}})
    });

    const roeData = roeL.map(v => v != null ? v : null);
    destroyChart('execRoe');
    charts.execRoe = new Chart(document.getElementById('execRoeChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: yrs,
        datasets: [{
          label: 'ROE (%)', data: roeData,
          borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,0.15)',
          tension: 0.3, pointRadius: 5, fill: true,
        }],
      },
      options: baseOptions({ scales: { y: { ticks: { callback: v => v + '%' }}}})
    });
  }
}

async function loadExecData() {
  const container = document.getElementById('execContent');
  container.innerHTML = `
    <div class="card" style="text-align:center;padding:48px;color:var(--text-muted)">
      <div style="font-size:24px;margin-bottom:10px">⏳</div>
      <div>DART 임원현황 로딩 중...</div>
    </div>`;
  try {
    const data = await fetch(`/api/executives/${currentCode}`).then(r => r.json());
    execLoaded = true;
    renderExec(data);
  } catch (e) {
    container.innerHTML = `
      <div class="card">
        <div class="card-header">경영자 성과</div>
        <div style="padding:32px;text-align:center;color:var(--text-muted)">데이터 로드 실패</div>
      </div>`;
  }
}

/* ── 수출국·고객사 탭 ───────────────────────────────────────── */
const REGION_COLORS = ['#2f81f7','#f85149','#3fb950','#d29922','#a5d6ff','#ff7b72','#7d8590'];

function renderExport(data) {
  const regions  = data.regions        || [];
  const cust     = data.customers      || [];
  const countries= data.key_countries  || [];
  const bases    = data.production_base|| [];
  const src      = data._source        || 'partial';
  const expRatio = data.export_ratio;
  const desc     = data.company_desc   || '';
  const sector   = data.sector         || '';

  const isPartial = src === 'partial';
  const srcBadge  = '<span class="src-badge dart" style="font-size:9px;padding:1px 5px">IR 공시 기반</span>';

  let html = '';

  /* ── 부분 데이터 안내 ── */
  if (isPartial) {
    const finYears = data.fin_years   || [];
    const finRev   = data.fin_revenue || [];
    const finOp    = data.fin_op_profit || [];

    html += `<div class="card" style="padding:20px 24px 16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <span style="font-size:28px">🗺️</span>
        <div>
          <div style="font-size:15px;font-weight:700">${data.sector || '해당 종목'} · 수출국·고객사 데이터</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
            상세 공시 데이터가 아직 등록되지 않은 종목입니다.
          </div>
        </div>
      </div>
      ${desc ? `<div style="font-size:13px;line-height:1.8;color:var(--text-muted);padding:12px 14px;background:var(--bg);border-radius:6px">${desc}</div>` : ''}
    </div>`;

    if (finYears.length > 0) {
      html += `<div class="card">
        <div class="card-header">📊 매출·영업이익 추이 <span class="card-sub">십억원 · DART 재무데이터</span></div>
        <div class="chart-wrap h240"><canvas id="partialRevChart"></canvas></div>
      </div>`;
    }

    document.getElementById('exportContent').innerHTML = html;

    if (finYears.length > 0) {
      destroyChart('partialRev');
      charts.partialRev = new Chart(
        document.getElementById('partialRevChart').getContext('2d'), {
          type: 'bar',
          data: {
            labels: finYears,
            datasets: [
              { label: '매출액 (십억원)',   data: finRev, backgroundColor: 'rgba(47,129,247,0.55)', borderRadius: 3 },
              { label: '영업이익 (십억원)', data: finOp,  backgroundColor: 'rgba(63,185,80,0.75)',  borderRadius: 3 },
            ],
          },
          options: baseOptions({ scales: { y: { ticks: { callback: v => fmtOk(v) }}}})
        }
      );
    }
    return;
  }

  /* ── KPI 4개 ── */
  const kpis = [
    { label: '수출 비중',   value: expRatio != null ? expRatio + '%' : '-',  note: '매출 기준' },
    { label: '주요 수출국', value: countries.length + '개국',                note: '핵심 시장' },
    { label: '주요 고객사', value: cust.length + '개사',                     note: '공시·IR 기반' },
    { label: '생산 기지',   value: bases.length + '개',                      note: '글로벌 거점' },
  ];
  html += `<div class="kpi-row">${kpis.map(k => `
    <div class="kpi-card">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('')}</div>`;

  /* ── 지역별 매출 비중 + 수출국 ── */
  html += `<div class="grid-2">
    <div class="card">
      <div class="card-header">🌍 지역별 매출 비중 ${srcBadge}</div>
      <div class="region-chart-wrap">
        <div class="chart-wrap h220"><canvas id="regionChart"></canvas></div>
        <div class="region-legend">${regions.map((r, i) => `
          <div class="region-leg-row">
            <span class="region-dot" style="background:${REGION_COLORS[i % REGION_COLORS.length]}"></span>
            <span class="region-leg-name">${r.flag} ${r.name}</span>
            <span class="region-leg-val">${r.ratio}%</span>
          </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">🗺️ 주요 수출국 · 시장</div>
      <div class="country-grid">${countries.map(c => `
        <div class="country-tag">${c}</div>`).join('')}
      </div>
      ${bases.length ? `<div class="card-header" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">🏭 생산 · 영업 기지</div>
      <div class="country-grid">${bases.map(b => `
        <div class="country-tag base-tag">${b}</div>`).join('')}
      </div>` : ''}
    </div>
  </div>`;

  /* ── 주요 고객사 카드 ── */
  if (cust.length > 0) {
    html += `<div class="card">
      <div class="card-header">🤝 주요 고객사 · 파트너</div>
      <div class="customer-grid">${cust.map(c => `
        <div class="customer-card">
          <div class="customer-flag">${c.flag}</div>
          <div class="customer-name">${c.name}</div>
          <div class="customer-segment">${c.segment}</div>
          <div class="customer-note">${c.note}</div>
        </div>`).join('')}
      </div>
    </div>`;
  }

  /* ── 사업 개요 ── */
  if (desc) {
    html += `<div class="card">
      <div class="card-header">📋 사업 개요</div>
      <div style="font-size:13px;line-height:1.8;color:var(--text-muted)">${desc}</div>
      <div style="font-size:11px;color:var(--text-faint);margin-top:12px">출처: ${data.source || 'DART 공시'}</div>
    </div>`;
  }

  document.getElementById('exportContent').innerHTML = html;

  /* ── 도넛 차트 ── */
  if (regions.length > 0) {
    destroyChart('regionChart');
    charts.regionChart = new Chart(
      document.getElementById('regionChart').getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: regions.map(r => `${r.flag} ${r.name}`),
          datasets: [{
            data:            regions.map(r => r.ratio),
            backgroundColor: regions.map((_, i) => REGION_COLORS[i % REGION_COLORS.length]),
            borderWidth: 2,
            borderColor: '#ffffff',
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '62%',
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => ` ${ctx.label}: ${ctx.parsed}%`,
              },
              titleFont: { family: FONT }, bodyFont: { family: FONT },
            },
          },
        },
      }
    );
  }
}

async function loadExportData() {
  const container = document.getElementById('exportContent');
  container.innerHTML = `
    <div class="card" style="text-align:center;padding:48px;color:var(--text-muted)">
      <div style="font-size:24px;margin-bottom:10px">🌍</div>
      <div>수출국·고객사 데이터 로딩 중...</div>
    </div>`;
  try {
    const data = await fetch(`/api/export-markets/${currentCode}`).then(r => r.json());
    exportLoaded = true;
    renderExport(data);
  } catch (e) {
    container.innerHTML = `<div class="card"><div style="padding:32px;text-align:center;color:var(--text-muted)">데이터 로드 실패</div></div>`;
  }
}

/* ── 섹터 동향 탭 ───────────────────────────────────────────── */
function renderSector(data) {
  const items     = data.items       || [];
  const theme     = data.theme       || null;
  const mainFin   = data.main_fin    || {};
  const sector    = data.sector      || '-';
  const mainItem  = items.find(x => x.is_main) || {};

  function vFmt(v, suf = '') {
    return v != null ? v.toFixed(1) + suf : '-';
  }
  function vsColor(main, avg) {
    if (main == null || avg == null) return '#7d8590';
    return main <= avg ? '#3fb950' : '#f85149';   // 낮을수록 좋은 PER/PBR 기준
  }

  let html = '';

  /* ── 1. KPI 행 ── */
  const rankLabel = data.mcap_rank ? `${data.mcap_rank}위 / ${data.peer_count}개사` : '-';
  const totalMcapTr = data.total_mcap ? (data.total_mcap / 10000).toFixed(0) + '조' : '-';
  const kpis = [
    { label: '업종 내 시총 순위', value: rankLabel,                       note: '시가총액 기준' },
    { label: '섹터 평균 PER',     value: vFmt(data.sector_per, '배'),      note: '동종업종 평균' },
    { label: '섹터 평균 PBR',     value: vFmt(data.sector_pbr, '배'),      note: '동종업종 평균' },
    { label: '업종 합산 시총',    value: totalMcapTr,                      note: sector },
  ];
  html += `<div class="kpi-row">${kpis.map(k => `
    <div class="kpi-card">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('')}</div>`;

  /* ── 2. 시총 순위 차트 + 지표 비교 ── */
  const top10 = items.slice(0, 10);
  const maxMcap = Math.max(...top10.map(x => x.market_cap || 0));

  html += `<div class="grid-2">
    <div class="card">
      <div class="card-header">🏆 업종 내 시총 순위 <span class="card-sub">조원</span></div>
      <div class="sector-rank-list">${top10.map((x, i) => {
        const pct   = maxMcap > 0 ? (x.market_cap / maxMcap * 100).toFixed(1) : 0;
        const mcapStr = fmtMcap(x.market_cap);
        return `<div class="sector-rank-row${x.is_main ? ' is-main' : ''}">
          <span class="sector-rank-no">${i+1}</span>
          <span class="sector-rank-name">${x.name}${x.is_main ? ' <span class="me-badge">나</span>' : ''}</span>
          <div class="sector-rank-bar-wrap">
            <div class="sector-rank-bar${x.is_main ? ' main' : ''}" style="width:${pct}%"></div>
          </div>
          <span class="sector-rank-val">${mcapStr}</span>
        </div>`;
      }).join('')}</div>
    </div>
    <div class="card">
      <div class="card-header">📊 업종 내 가치지표 비교</div>
      <table class="fin-table">
        <thead><tr><th>지표</th><th>${data.name}</th><th>섹터 평균</th><th>평가</th></tr></thead>
        <tbody>
          ${[
            ['PER', data.main_per, data.sector_per, '배', true],
            ['PBR', data.main_pbr, data.sector_pbr, '배', true],
            ['ROE', data.main_roe, data.sector_roe, '%',  false],
          ].map(([label, val, avg, suf, lowerBetter]) => {
            const valStr = val != null ? val.toFixed(1) + suf : '-';
            const avgStr = avg != null ? avg.toFixed(1) + suf : '-';
            let evalStr = '-', evalColor = '#7d8590';
            if (val != null && avg != null) {
              const better = lowerBetter ? val < avg : val > avg;
              evalStr  = better ? '▲ 저평가' : '▽ 고평가';
              evalColor= better ? '#3fb950' : '#f85149';
              if (label === 'ROE') {
                evalStr  = val > avg ? '▲ 우수' : '▽ 하회';
                evalColor= val > avg ? '#3fb950' : '#f85149';
              }
            }
            return `<tr>
              <td><strong>${label}</strong></td>
              <td>${valStr}</td>
              <td style="color:var(--text-muted)">${avgStr}</td>
              <td style="color:${evalColor};font-weight:600">${evalStr}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${mainItem.change_pct != null ? `<div style="margin-top:14px;padding:10px 12px;background:var(--bg);border-radius:6px;font-size:13px">
        오늘 등락: <span style="color:${mainItem.change_pct >= 0 ? 'var(--red)' : 'var(--blue)'}">
          ${mainItem.change_pct >= 0 ? '▲' : '▼'}${Math.abs(mainItem.change_pct).toFixed(2)}%
        </span> · 현재가 ${(mainItem.current_price||0).toLocaleString()}원
      </div>` : ''}
    </div>
  </div>`;

  /* ── 3. 동종업종 전체 종목 테이블 ── */
  html += `<div class="card">
    <div class="card-header">📋 동종업종 종목 현황 <span class="card-sub">Naver 기준 · 시총순</span></div>
    <div style="overflow-x:auto">
    <table class="fin-table">
      <thead><tr>
        <th>#</th><th>종목</th><th>시가총액</th><th>현재가</th>
        <th>PER</th><th>PBR</th><th>ROE</th><th>등락</th>
      </tr></thead>
      <tbody>${items.map((x, i) => {
        const mcapStr = fmtMcap(x.market_cap);
        const chg = x.change_pct;
        const chgStr = chg != null
          ? `<span style="color:${chg>=0?'var(--red)':'var(--blue)'}">${chg>=0?'▲':'▼'}${Math.abs(chg).toFixed(2)}%</span>`
          : '-';
        return `<tr${x.is_main ? ' style="background:rgba(47,129,247,0.06)"' : ''}>
          <td style="color:var(--text-muted)">${i+1}</td>
          <td><strong>${x.name}</strong>${x.is_main ? ' <span class="me-badge">나</span>' : ''}</td>
          <td>${mcapStr}</td>
          <td>${x.current_price ? x.current_price.toLocaleString() : '-'}</td>
          <td>${x.per != null ? x.per.toFixed(1) : '-'}</td>
          <td>${x.pbr != null ? x.pbr.toFixed(2) : '-'}</td>
          <td>${x.roe != null ? x.roe.toFixed(1)+'%' : '-'}</td>
          <td>${chgStr}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>
    </div>
  </div>`;

  /* ── 4. 매출·영업이익 추이 (DART 기반) ── */
  if (mainFin.years && mainFin.years.length > 0) {
    html += `<div class="card">
      <div class="card-header">📈 ${data.name} 실적 추이 <span class="card-sub">십억원 · DART 재무데이터</span></div>
      <div class="chart-wrap h240"><canvas id="sectorRevChart"></canvas></div>
    </div>`;
  }

  /* ── 5. 섹터 테마 카드 ── */
  if (theme) {
    html += `<div class="card sector-theme-card">
      <div class="card-header">${theme.icon || '🏭'} ${sector} 섹터 동향 — ${theme.theme}</div>
      <div class="theme-desc">${theme.desc}</div>
      <div class="theme-grid">
        <div class="theme-col">
          <div class="theme-col-title green">▲ 핵심 촉매</div>
          <ul class="theme-list">${(theme.catalysts||[]).map(c => `<li>${c}</li>`).join('')}</ul>
        </div>
        <div class="theme-col">
          <div class="theme-col-title red">▽ 주요 리스크</div>
          <ul class="theme-list">${(theme.risks||[]).map(r => `<li>${r}</li>`).join('')}</ul>
        </div>
      </div>
    </div>`;
  } else {
    html += `<div class="card" style="padding:24px;text-align:center;color:var(--text-muted)">
      <div style="font-size:24px;margin-bottom:8px">🏭</div>
      <div><strong>${sector}</strong> 섹터 테마 데이터가 준비되지 않았습니다.</div>
    </div>`;
  }

  /* ── 6. 관련 뉴스 (한국 / 해외 탭) ── */
  const news        = data.news         || [];
  const newsForeign = data.news_foreign || [];
  const hasKr = news.length > 0;
  const hasEn = newsForeign.length > 0;

  function newsItemHtml(n, lang) {
    const cls = lang === 'en' ? ' en' : '';
    const flag = lang === 'en' ? '🌐 ' : '';
    return `
      <a class="news-item" href="${n.url}" target="_blank" rel="noopener">
        <div class="news-meta">
          <span class="news-source${cls}">${flag}${n.source}</span>
          <span class="news-dt">${n.dt}</span>
        </div>
        <div class="news-title">${n.title}</div>
        ${n.body ? `<div class="news-body">${n.body}…</div>` : ''}
      </a>`;
  }

  if (hasKr || hasEn) {
    const firstLang = hasKr ? 'kr' : 'en';
    const tabId = `newsTab_${data.code}`;
    html += `<div class="card">
      <div class="card-header">📰 관련 뉴스</div>
      <div class="news-tab-nav" id="${tabId}">
        ${hasKr ? `<button class="news-tab-btn${firstLang==='kr'?' active':''}" data-lang="kr"
          onclick="switchNewsTab('${tabId}','kr')">
          🇰🇷 한국 <span class="news-tab-cnt">${news.length}</span></button>` : ''}
        ${hasEn ? `<button class="news-tab-btn${firstLang==='en'?' active':''}" data-lang="en"
          onclick="switchNewsTab('${tabId}','en')">
          🌐 해외 <span class="news-tab-cnt">${newsForeign.length}</span></button>` : ''}
      </div>
      <div class="news-pane" data-lang="kr" style="${firstLang==='kr'?'':'display:none'}">
        <div class="news-list">${news.map(n => newsItemHtml(n,'kr')).join('')}</div>
      </div>
      <div class="news-pane" data-lang="en" style="${firstLang==='en'?'':'display:none'}">
        <div class="news-list">${newsForeign.map(n => newsItemHtml(n,'en')).join('')}</div>
      </div>
    </div>`;
  }

  document.getElementById('sectorContent').innerHTML = html;

  /* ── 매출 차트 ── */
  if (mainFin.years && mainFin.years.length > 0) {
    destroyChart('sectorRev');
    charts.sectorRev = new Chart(
      document.getElementById('sectorRevChart').getContext('2d'), {
        type: 'bar',
        data: {
          labels: mainFin.years,
          datasets: [
            { label: '매출액 (십억원)',   data: mainFin.revenue,   backgroundColor: 'rgba(47,129,247,0.55)', borderRadius: 3 },
            { label: '영업이익 (십억원)', data: mainFin.op_profit, backgroundColor: 'rgba(63,185,80,0.75)',  borderRadius: 3 },
          ],
        },
        options: baseOptions({ scales: { y: { ticks: { callback: v => fmtOk(v) }}}})
      }
    );
  }
}

async function loadSectorData() {
  const container = document.getElementById('sectorContent');
  container.innerHTML = `
    <div class="card" style="text-align:center;padding:48px;color:var(--text-muted)">
      <div style="font-size:24px;margin-bottom:10px">⏳</div>
      <div>섹터 동향 로딩 중...</div>
    </div>`;
  try {
    const data = await fetch(`/api/sector-trend/${currentCode}`).then(r => r.json());
    sectorLoaded = true;
    renderSector(data);
  } catch (e) {
    container.innerHTML = `<div class="card"><div style="padding:32px;text-align:center;color:var(--text-muted)">데이터 로드 실패</div></div>`;
  }
}

/* ── 초기화 ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initSearch();
});
