// ============================================================
// reports.js — reports & analytics with CSV export (spec §12)
// ============================================================

const Reports = {
  data: null,
  sets: {},

  async init() {
    document.getElementById('rp-range').addEventListener('change', () => this.render());
    document.getElementById('view-reports').addEventListener('click', (e) => {
      const b = e.target.closest('[data-export]');
      if (b) this.exportSet(b.dataset.export);
    });
    await this.load();
  },

  async load() {
    this.data = await DB.reportData();
    this.render();
  },

  // ----- helpers -----
  dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
  monthKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; },
  monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' });
  },
  sum(arr, fn) { return arr.reduce((s, x) => s + (fn(x) || 0), 0); },
  fmt(type, v) {
    if (type === 'naira') return Utils.formatNaira(v);
    if (type === 'num') return Utils.formatPoints(v);
    return Utils.escapeHtml(v);
  },

  bars(values, labels) {
    const max = Math.max(1, ...values);
    return `<div class="bar-chart">${values.map((v, i) => `<div class="bar" style="height:${(v / max) * 100}%;" title="${Utils.escapeHtml(labels[i])}: ${Utils.formatPoints(v)}"></div>`).join('')}</div>
      <div class="bar-chart-labels">${labels.map(l => `<span>${Utils.escapeHtml(l)}</span>`).join('')}</div>`;
  },

  /** cols: [[header, 'text'|'naira'|'num'], ...]; rows hold raw values (used as-is for CSV). */
  section(key, title, cols, rows, extraHtml = '') {
    this.sets[key] = { headers: cols.map(c => c[0]), rows };
    const body = rows.length
      ? `<div style="overflow-x:auto;"><table class="ledger"><thead><tr>${cols.map(c => `<th class="${c[1] === 'text' ? '' : 'num'}">${Utils.escapeHtml(c[0])}</th>`).join('')}</tr></thead><tbody>${
          rows.map(r => `<tr>${r.map((v, i) => `<td class="${cols[i][1] === 'text' ? '' : 'num'}">${this.fmt(cols[i][1], v)}</td>`).join('')}</tr>`).join('')
        }</tbody></table></div>`
      : `<div class="empty-state">No data for this period.</div>`;
    return `<div class="panel" style="margin-top:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
        <p class="panel-title" style="margin:0; padding:0; border:0;">${Utils.escapeHtml(title)}</p>
        <button class="btn btn-sm" data-export="${key}">Export CSV</button>
      </div>${extraHtml}${body}</div>`;
  },

  exportSet(key) {
    const s = this.sets[key];
    if (!s) return;
    Utils.downloadCSV(`${key}-${new Date().toISOString().slice(0, 10)}.csv`, s.headers, s.rows);
  },

  range() {
    const v = document.getElementById('rp-range').value;
    if (v === 'all') return null;
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - parseInt(v, 10) + 1);
    return d;
  },

  // ----- main render -----
  render() {
    if (!this.data) return;
    this.sets = {};
    const { members, txs, truncated, pointValue } = this.data;
    const from = this.range();
    const inRange = txs.filter(t => { const d = Utils.toDate(t.date); return d && (!from || d >= from); });
    const purchases = inRange.filter(t => t.type === 'Purchase');
    const refunds = inRange.filter(t => t.type === 'Refund');
    const redeems = inRange.filter(t => t.type === 'Points Redeemed');
    const netSales = this.sum(purchases, t => t.purchaseAmount) + this.sum(refunds, t => t.purchaseAmount);
    const issued = this.sum(inRange.filter(t => t.finalPoints > 0), t => t.finalPoints);
    const redeemed = this.sum(redeems, t => Math.abs(t.finalPoints));
    const outstanding = this.sum(members, m => m.points);

    let html = '';
    if (truncated) html += `<p class="hint" style="margin-bottom:10px;">Figures are based on the most recent 2,000 transactions.</p>`;

    html += `<div class="grid grid-4">
      <div class="stat gold"><div class="stat-label">Loyalty sales (net of refunds)</div><div class="stat-value">${Utils.formatNaira(netSales)}</div><div class="stat-sub">${purchases.length} purchases</div></div>
      <div class="stat"><div class="stat-label">Points issued</div><div class="stat-value">${Utils.formatPoints(issued)}</div></div>
      <div class="stat"><div class="stat-label">Points redeemed</div><div class="stat-value">${Utils.formatPoints(redeemed)}</div><div class="stat-sub">${redeems.length} redemptions</div></div>
      <div class="stat gold"><div class="stat-label">Outstanding loyalty value</div><div class="stat-value">${Utils.formatNaira(outstanding * pointValue)}</div><div class="stat-sub">${Utils.formatPoints(outstanding)} points</div></div>
    </div>`;

    // Daily loyalty sales — always the last 30 days
    const days = [...Array(30)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (29 - i)); return d; });
    const byDay = {};
    txs.forEach(t => {
      const d = Utils.toDate(t.date); if (!d) return;
      const k = this.dayKey(d); byDay[k] = byDay[k] || { n: 0, sales: 0, pts: 0 };
      if (t.type === 'Purchase') { byDay[k].n++; byDay[k].sales += t.purchaseAmount || 0; }
      if (t.type === 'Refund') byDay[k].sales += t.purchaseAmount || 0;
      if (t.finalPoints > 0) byDay[k].pts += t.finalPoints;
    });
    const dailyRows = days.map(d => { const v = byDay[this.dayKey(d)] || { n: 0, sales: 0, pts: 0 }; return [this.dayKey(d), v.n, v.sales, v.pts]; });
    html += this.section('daily-loyalty-sales', 'Daily loyalty sales (last 30 days)',
      [['Date', 'text'], ['Purchases', 'num'], ['Sales', 'naira'], ['Points issued', 'num']],
      dailyRows.filter(r => r[1] || r[2]).reverse(),
      this.bars(dailyRows.map(r => r[2]), days.map(d => String(d.getDate()))));

    // Monthly activity + redemption trends
    const months = {};
    inRange.forEach(t => {
      const d = Utils.toDate(t.date); if (!d) return;
      const m = months[this.monthKey(d)] = months[this.monthKey(d)] || { n: 0, sales: 0, issued: 0, rn: 0, rp: 0, rc: 0 };
      if (t.type === 'Purchase') { m.n++; m.sales += t.purchaseAmount || 0; }
      if (t.type === 'Refund') m.sales += t.purchaseAmount || 0;
      if (t.finalPoints > 0) m.issued += t.finalPoints;
      if (t.type === 'Points Redeemed') { m.rn++; m.rp += Math.abs(t.finalPoints); m.rc += t.cashValue || 0; }
    });
    const monthKeys = Object.keys(months).sort().slice(-24);
    html += this.section('monthly-loyalty-activity', 'Monthly loyalty activity',
      [['Month', 'text'], ['Purchases', 'num'], ['Sales', 'naira'], ['Points issued', 'num']],
      monthKeys.map(k => [this.monthLabel(k), months[k].n, months[k].sales, months[k].issued]));
    html += this.section('redemption-trends', 'Redemption trends',
      [['Month', 'text'], ['Redemptions', 'num'], ['Points redeemed', 'num'], ['Cash value', 'naira']],
      monthKeys.map(k => [this.monthLabel(k), months[k].rn, months[k].rp, months[k].rc]),
      monthKeys.length ? this.bars(monthKeys.map(k => months[k].rp), monthKeys.map(k => this.monthLabel(k).split(' ')[0])) : '');

    // Members: most active / highest spending
    const per = {};
    [...purchases, ...refunds].forEach(t => {
      const p = per[t.memberId] = per[t.memberId] || { name: t.memberName || '', n: 0, spent: 0 };
      if (t.type === 'Purchase') p.n++;
      p.spent += t.purchaseAmount || 0;
    });
    const list = Object.entries(per);
    html += `<div class="grid grid-2">` +
      this.section('most-active-members', 'Most active members',
        [['Member', 'text'], ['Member ID', 'text'], ['Purchases', 'num'], ['Spent', 'naira']],
        list.filter(([, p]) => p.n).sort((a, b) => b[1].n - a[1].n || b[1].spent - a[1].spent).slice(0, 10).map(([id, p]) => [p.name, id, p.n, p.spent])) +
      this.section('highest-spending-members', 'Highest-spending members',
        [['Member', 'text'], ['Member ID', 'text'], ['Spent', 'naira'], ['Purchases', 'num']],
        list.sort((a, b) => b[1].spent - a[1].spent).slice(0, 10).filter(([, p]) => p.spent > 0).map(([id, p]) => [p.name, id, p.spent, p.n])) +
      `</div>`;

    // Members by class (current)
    const byClass = {};
    members.forEach(m => { const c = m.className || 'Standard'; const o = byClass[c] = byClass[c] || { n: 0, pts: 0 }; o.n++; o.pts += m.points || 0; });
    html += this.section('members-by-class', 'Members by class',
      [['Class', 'text'], ['Members', 'num'], ['Points held', 'num']],
      Object.entries(byClass).sort((a, b) => b[1].n - a[1].n).map(([c, o]) => [c, o.n, o.pts]));

    // Member growth (all time)
    const joins = {};
    members.forEach(m => { const d = Utils.toDate(m.registrationDate); if (d) joins[this.monthKey(d)] = (joins[this.monthKey(d)] || 0) + 1; });
    let running = 0;
    const growth = Object.keys(joins).sort().map(k => { running += joins[k]; return [this.monthLabel(k), joins[k], running]; });
    const shown = growth.slice(-24);
    html += this.section('member-growth', 'Member growth',
      [['Month', 'text'], ['New members', 'num'], ['Total members', 'num']], shown,
      shown.length ? this.bars(shown.map(r => r[1]), shown.map(r => r[0].split(' ')[0])) : '');

    document.getElementById('rp-body').innerHTML = html;
  },
};

window.Reports = Reports;