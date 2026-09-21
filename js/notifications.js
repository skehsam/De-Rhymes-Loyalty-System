// ============================================================
// notifications.js — WhatsApp/email delivery log, filters, retry (spec §11)
// ============================================================

const Notifications = {
  rows: [],

  async init() {
    ['nf-channel', 'nf-status', 'nf-type'].forEach(id => document.getElementById(id).addEventListener('change', () => this.render()));
    document.getElementById('nf-retry-all').onclick = () => this.retryAll();
    await this.load();
  },

  async load() {
    this.rows = await DB.listNotifications({ limit: 500 });
    this.render();
  },

  filtered() {
    const ch = document.getElementById('nf-channel').value;
    const st = document.getElementById('nf-status').value;
    const ty = document.getElementById('nf-type').value;
    return this.rows.filter(n => (!ch || n.channel === ch) && (!st || n.status === st) && (!ty || n.type === ty));
  },

  render() {
    const failedAll = this.rows.filter(n => n.status === 'Failed');
    const btn = document.getElementById('nf-retry-all');
    btn.style.display = failedAll.length ? '' : 'none';
    btn.textContent = `Retry all failed (${failedAll.length})`;

    const rows = this.filtered();
    const tbody = document.getElementById('notif-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">${this.rows.length ? 'No notifications match these filters.' : 'No notifications queued yet — they appear here after a registration, purchase, redemption, bonus, or class change.'}</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(n => `
      <tr>
        <td>${Utils.escapeHtml(n.memberName || n.memberId)}</td>
        <td>${Utils.escapeHtml(n.channel)}</td>
        <td>${Utils.escapeHtml(n.type)}</td>
        <td style="max-width:320px;">${Utils.escapeHtml(n.message)}</td>
        <td><span class="pill ${n.status === 'Failed' ? 'negative' : n.status === 'Delivered' || n.status === 'Sent' ? 'positive' : 'muted'}" ${n.error ? `title="${Utils.escapeHtml(n.error)}"` : ''}>${Utils.escapeHtml(n.status)}</span></td>
        <td>${Utils.formatDate(n.sentDate)}</td>
        <td>${n.status === 'Failed' ? `<button class="btn btn-sm" data-retry="${n.id}">Retry</button>` : ''}</td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
      await DB.retryNotification(b.dataset.retry);
      Utils.toast('Queued for retry', 'success');
      this.load();
    });
  },

  async retryAll() {
    const ids = this.rows.filter(n => n.status === 'Failed').map(n => n.id);
    if (!ids.length) return;
    if (!confirm(`Queue ${ids.length} failed notification${ids.length === 1 ? '' : 's'} for retry?`)) return;
    try {
      await DB.retryNotifications(ids);
      Utils.toast(`${ids.length} queued for retry`, 'success');
      this.load();
    } catch (err) {
      Utils.toast(err.message, 'error');
    }
  },
};

window.Notifications = Notifications;