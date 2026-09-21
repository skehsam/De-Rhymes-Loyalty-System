// ============================================================
// transactions.js — full ledger, filters (date/member/type/staff/class), CSV export, refund
// ============================================================

const Transactions = {
  rows: [],
  filtered: [],

  async init() {
    ['tx-filter-type', 'tx-filter-staff', 'tx-filter-class', 'tx-filter-from', 'tx-filter-to']
      .forEach(id => document.getElementById(id).addEventListener('change', () => this.render()));
    document.getElementById('tx-filter-member').addEventListener('input', Utils.debounce(() => this.render(), 200));
    document.getElementById('btn-export-tx').onclick = () => this.exportCsv();
    await this.load();
  },

  async load() {
    this.rows = await DB.listTransactions({ limit: 500 });
    this.fillOptions('tx-filter-staff', 'staffName', 'All staff');
    this.fillOptions('tx-filter-class', 'className', 'All classes');
    this.render();
  },

  fillOptions(id, field, allLabel) {
    const sel = document.getElementById(id);
    const current = sel.value;
    const values = [...new Set(this.rows.map(r => r[field]).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      values.map(v => `<option value="${Utils.escapeHtml(v)}">${Utils.escapeHtml(v)}</option>`).join('');
    sel.value = values.includes(current) ? current : '';
  },

  applyFilters() {
    const val = id => document.getElementById(id).value;
    const type = val('tx-filter-type'), staff = val('tx-filter-staff'), cls = val('tx-filter-class');
    const q = val('tx-filter-member').trim().toLowerCase();
    const from = val('tx-filter-from') ? new Date(val('tx-filter-from') + 'T00:00:00') : null;
    const to = val('tx-filter-to') ? new Date(val('tx-filter-to') + 'T23:59:59.999') : null;
    return this.rows.filter(t => {
      if (type && t.type !== type) return false;
      if (staff && t.staffName !== staff) return false;
      if (cls && t.className !== cls) return false;
      if (q && !((t.memberName || '').toLowerCase().includes(q) || (t.memberId || '').toLowerCase().includes(q))) return false;
      if (from || to) {
        const d = Utils.toDate(t.date);
        if (!d || (from && d < from) || (to && d > to)) return false;
      }
      return true;
    });
  },

  render() {
    const rows = this.filtered = this.applyFilters();
    const refunded = new Set(this.rows.filter(r => r.type === 'Refund').map(r => r.relatedTxId));
    const tbody = document.getElementById('tx-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No transactions match.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(t => `
      <tr>
        <td class="num">${t.transactionId}</td>
        <td><span class="pill ${this.pillClass(t.type)}">${Utils.escapeHtml(t.adjustmentType || t.type)}</span></td>
        <td>${Utils.escapeHtml(t.memberName || '—')}</td>
        <td class="num">${t.purchaseAmount ? Utils.formatNaira(t.purchaseAmount) : '—'}</td>
        <td class="num">${t.finalPoints != null ? (t.finalPoints >= 0 ? '+' : '') + Utils.formatPoints(t.finalPoints) : '—'}</td>
        <td>${Utils.escapeHtml(t.staffName || '—')}</td>
        <td>${Utils.formatDate(t.date)}</td>
        <td>${t.type !== 'Purchase' || !Auth.can('refund') ? ''
          : refunded.has(t.transactionId) ? '<span class="pill muted">Refunded</span>'
          : `<button class="btn btn-sm btn-danger" data-refund="${t.transactionId}">Refund</button>`}</td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-refund]').forEach(b => b.onclick = () => this.refund(b.dataset.refund));
  },

  pillClass(type) {
    if (type === 'Purchase') return 'positive';
    if (type === 'Points Redeemed' || type === 'Refund' || type === 'Points Expired') return 'negative';
    if (type === 'Class Upgrade') return 'gold';
    return 'muted';
  },

  exportCsv() {
    const rows = this.filtered.map(t => {
      const d = Utils.toDate(t.date);
      return [
        t.transactionId, t.type, t.adjustmentType || '', t.memberName || '', t.memberId || '', t.className || '',
        t.purchaseAmount ?? '', t.finalPoints ?? '', t.staffName || '', t.reason || '', d ? d.toISOString() : '',
      ];
    });
    Utils.downloadCSV(`transactions-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Transaction ID', 'Type', 'Adjustment type', 'Member', 'Member ID', 'Class', 'Amount (NGN)', 'Points', 'Staff', 'Reason', 'Date'], rows);
  },

  async refund(txId) {
    const reason = prompt('Reason for this refund (required):');
    if (reason === null) return;
    if (!reason.trim()) return Utils.toast('A reason is required for refunds', 'error');
    if (!confirm('Reverse the points earned on this purchase? This keeps both transactions in history.')) return;
    try {
      await DB.refundPurchase({ originalTxId: txId, reason: reason.trim(), staffUid: Auth.currentUser.uid, staffName: Auth.profile.name });
      Utils.toast('Purchase refunded and points reversed', 'success');
      this.load();
    } catch (err) {
      Utils.toast(err.message, 'error');
    }
  },
};

window.Transactions = Transactions;