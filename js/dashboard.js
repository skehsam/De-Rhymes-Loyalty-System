// ============================================================
// dashboard.js — admin overview (spec §20)
// ============================================================

const Dashboard = {
  async init() {
    await this.load();
  },

  async load() {
    const s = await DB.dashboardStats();

    document.getElementById('dash-stats').innerHTML = `
      <div class="stat"><div class="stat-label">Total members</div><div class="stat-value">${s.totalMembers}</div><div class="stat-sub">${s.activeMembers} active</div></div>
      <div class="stat gold"><div class="stat-label">Total purchases</div><div class="stat-value">${Utils.formatNaira(s.totalPurchases)}</div></div>
      <div class="stat"><div class="stat-label">Points issued</div><div class="stat-value">${Utils.formatPoints(s.totalPointsIssued)}</div></div>
      <div class="stat"><div class="stat-label">Points redeemed</div><div class="stat-value">${Utils.formatPoints(s.totalPointsRedeemed)}</div></div>
      <div class="stat gold"><div class="stat-label">Outstanding points</div><div class="stat-value">${Utils.formatPoints(s.outstandingPoints)}</div><div class="stat-sub">${Utils.formatNaira(s.totalLoyaltyValue)} loyalty value</div></div>
      <div class="stat"><div class="stat-label">Today's transactions</div><div class="stat-value">${s.todaysTransactions}</div></div>
      <div class="stat"><div class="stat-label">WhatsApp sent</div><div class="stat-value">${s.whatsappSent}</div></div>
      <div class="stat"><div class="stat-label">Email sent</div><div class="stat-value">${s.emailSent}</div></div>`;

    this.renderChart(s.purchases);
    this.renderPointsChart(s.txs);
    this.renderClassMix(s.members);

    document.getElementById('dash-recent').innerHTML = s.recentTx.length ? s.recentTx.map(t => `
      <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line-soft); font-size:13.5px;">
        <span>${t.type} — ${Utils.escapeHtml(t.memberName || '—')}</span>
        <span class="num">${t.finalPoints != null ? (t.finalPoints >= 0 ? '+' : '') + Utils.formatPoints(t.finalPoints) : ''}</span>
      </div>`).join('') : `<div class="empty-state">No activity yet.</div>`;
  },

  renderPointsChart(txs) {
    const days = [...Array(7)].map((_, i) => {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i));
      return d;
    });
    const issued = [], redeemed = [];
    days.forEach(d => {
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const day = txs.filter(t => { const dt = Utils.toDate(t.date); return dt && dt >= d && dt < next; });
      issued.push(day.filter(t => t.finalPoints > 0).reduce((s, t) => s + t.finalPoints, 0));
      redeemed.push(day.filter(t => t.type === 'Points Redeemed').reduce((s, t) => s + Math.abs(t.finalPoints || 0), 0));
    });
    const max = Math.max(1, ...issued, ...redeemed);
    document.getElementById('dash-chart-points').innerHTML = `
      <div class="bar-chart">${days.map((d, i) => `
        <div class="bar-pair">
          <div class="bar" style="height:${(issued[i] / max) * 100}%;" title="Issued: ${Utils.formatPoints(issued[i])}"></div>
          <div class="bar gold" style="height:${(redeemed[i] / max) * 100}%;" title="Redeemed: ${Utils.formatPoints(redeemed[i])}"></div>
        </div>`).join('')}</div>
      <div class="bar-chart-labels">${days.map(d => `<span>${d.toLocaleDateString('en-NG', { weekday: 'short' })}</span>`).join('')}</div>
      <div class="chart-legend"><span><i class="sw"></i>Issued</span><span><i class="sw gold"></i>Redeemed</span></div>`;
  },

  renderClassMix(members) {
    const counts = {};
    members.forEach(m => { const c = m.className || 'Standard'; counts[c] = (counts[c] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = members.length || 1;
    document.getElementById('dash-classes').innerHTML = entries.length ? entries.map(([name, n]) => `
      <div style="padding:7px 0; border-bottom:1px solid var(--line-soft); font-size:13.5px;">
        <div style="display:flex; justify-content:space-between;"><span>${Utils.escapeHtml(name)}</span><span class="num">${n}</span></div>
        <div class="mix-track"><div class="mix-fill" style="width:${(n / total) * 100}%;"></div></div>
      </div>`).join('') : `<div class="empty-state">No members yet.</div>`;
  },

  renderChart(purchases) {
    const host = document.getElementById('dash-chart');
    // last 7 days, purchase count per day
    const days = [...Array(7)].map((_, i) => {
      const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - (6 - i));
      return d;
    });
    const counts = days.map(d => {
      const next = new Date(d); next.setDate(d.getDate() + 1);
      return purchases.filter(p => {
        const dt = p.date && p.date.toDate ? p.date.toDate() : null;
        return dt && dt >= d && dt < next;
      }).length;
    });
    const max = Math.max(1, ...counts);
    host.innerHTML = `
      <div class="bar-chart">${counts.map(c => `<div class="bar" style="height:${(c / max) * 100}%;" title="${c}"></div>`).join('')}</div>
      <div class="bar-chart-labels">${days.map(d => `<span>${d.toLocaleDateString('en-NG', { weekday: 'short' })}</span>`).join('')}</div>`;
  },
};

window.Dashboard = Dashboard;