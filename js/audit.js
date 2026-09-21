// ============================================================
// audit.js — read-only trail of admin actions with before/after values (spec §14)
// ============================================================

const AuditView = {
  rows: [],

  async init() {
    document.getElementById('audit-search').addEventListener('input', Utils.debounce(() => this.render(), 200));
    document.getElementById('btn-export-audit').onclick = () => this.exportCsv();
    await this.load();
  },

  async load() {
    this.rows = await DB.listAuditLog({ limit: 500 });
    this.render();
  },

  text(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, (k, val) => (val && val.toDate ? val.toDate().toISOString() : val));
    } catch (e) { return String(v); }
  },

  cell(v) {
    const full = this.text(v);
    if (!full) return '—';
    const short = full.length > 90 ? full.slice(0, 90) + '…' : full;
    return `<span title="${Utils.escapeHtml(full)}" style="font-size:12px;">${Utils.escapeHtml(short)}</span>`;
  },

  filtered() {
    const q = document.getElementById('audit-search').value.trim().toLowerCase();
    if (!q) return this.rows;
    return this.rows.filter(a => `${a.action} ${a.actor} ${a.reason || ''}`.toLowerCase().includes(q));
  },

  render() {
    const rows = this.filtered();
    const tbody = document.getElementById('audit-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">${this.rows.length ? 'No entries match.' : 'Nothing logged yet.'}</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(a => `
      <tr>
        <td>${Utils.escapeHtml(a.action)}</td>
        <td>${Utils.escapeHtml(a.actor || '—')}</td>
        <td>${Utils.escapeHtml(a.reason || '—')}</td>
        <td>${this.cell(a.previousValue)}</td>
        <td>${this.cell(a.newValue)}</td>
        <td>${Utils.formatDate(a.date)}</td>
      </tr>`).join('');
  },

  exportCsv() {
    const rows = this.filtered().map(a => {
      const d = Utils.toDate(a.date);
      return [a.action, a.actor || '', a.reason || '', this.text(a.previousValue), this.text(a.newValue), d ? d.toISOString() : ''];
    });
    Utils.downloadCSV(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Action', 'By', 'Reason', 'Previous value', 'New value', 'Date'], rows);
  },
};

window.AuditView = AuditView;