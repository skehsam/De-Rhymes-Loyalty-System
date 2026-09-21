// ============================================================
// staff.js — add / deactivate staff, roles, activity history (spec §13, §24)
// ============================================================

const Staff = {
  rows: [],
  saving: false,

  async init() {
    document.getElementById('btn-add-staff').onclick = () => {
      document.getElementById('staff-form').reset();
      document.getElementById('modal-staff-form').classList.add('open');
      document.getElementById('sf-name').focus();
    };
    document.getElementById('staff-form').addEventListener('submit', (e) => this.save(e));
    await this.load();
  },

  async load() {
    const rows = this.rows = await DB.listStaff();
    const tbody = document.getElementById('staff-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No staff accounts yet.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(s => {
      const me = s.uid === Auth.currentUser.uid;
      return `
      <tr>
        <td>${Utils.escapeHtml(s.name || '—')} ${me ? '<span class="pill muted">You</span>' : ''}</td>
        <td>${Utils.escapeHtml(s.email || '—')}</td>
        <td>
          <select data-role="${s.uid}" ${me ? 'disabled title="You cannot change your own role"' : ''}>
            <option value="staff" ${s.role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="manager" ${s.role === 'manager' ? 'selected' : ''}>Manager</option>
            <option value="superadmin" ${s.role === 'superadmin' ? 'selected' : ''}>Super Admin</option>
          </select>
        </td>
        <td><span class="pill ${s.deactivated ? 'negative' : 'positive'}">${s.deactivated ? 'Deactivated' : 'Active'}</span></td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn btn-sm" data-activity="${s.uid}">Activity</button>
          ${me ? '' : `<button class="btn btn-sm ${s.deactivated ? '' : 'btn-danger'}" data-toggle="${s.uid}" data-to="${s.deactivated ? 'active' : 'inactive'}">${s.deactivated ? 'Reactivate' : 'Deactivate'}</button>`}
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-role]').forEach(sel => sel.onchange = async () => {
      try {
        await DB.upsertStaff(sel.dataset.role, { role: sel.value }, Auth.currentUser.email);
        Utils.toast('Role updated', 'success');
      } catch (err) { Utils.toast(err.message, 'error'); this.load(); }
    });
    tbody.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const activate = b.dataset.to === 'active';
      if (!confirm(activate ? 'Reactivate this account?' : 'Deactivate this account? They will be signed out and unable to log in.')) return;
      try {
        await DB.setStaffActive(b.dataset.toggle, activate, Auth.currentUser.email);
        Utils.toast(activate ? 'Account reactivated' : 'Account deactivated', 'success');
        this.load();
      } catch (err) { Utils.toast(err.message, 'error'); }
    });
    tbody.querySelectorAll('[data-activity]').forEach(b => b.onclick = () => this.showActivity(b.dataset.activity));
  },

  async save(e) {
    e.preventDefault();
    if (this.saving) return;
    const name = document.getElementById('sf-name').value.trim();
    const email = document.getElementById('sf-email').value.trim();
    const role = document.getElementById('sf-role').value;
    const btn = document.querySelector('#staff-form button[type="submit"]');
    this.saving = true; btn.disabled = true;
    try {
      await DB.createStaffAccount({ name, email, role }, Auth.currentUser.email);
      Utils.toast(`${name} added. A link to set their password was emailed to ${email}.`, 'success');
      document.getElementById('modal-staff-form').classList.remove('open');
      this.load();
    } catch (err) {
      const msg = {
        'auth/email-already-in-use': 'That email already has a login. Ask them to sign in once — they will then appear in this list and you can set their role.',
        'auth/invalid-email': 'That email address does not look right.',
      }[err.code] || err.message;
      Utils.toast(msg, 'error');
    } finally {
      this.saving = false; btn.disabled = false;
    }
  },

  async showActivity(uid) {
    const s = this.rows.find(r => r.uid === uid);
    document.getElementById('sa-title').textContent = `Activity — ${s ? (s.name || s.email) : uid}`;
    const body = document.getElementById('sa-body');
    body.innerHTML = '<p class="hint">Loading…</p>';
    document.getElementById('modal-staff-activity').classList.add('open');
    try {
      const { transactions, audit } = await DB.staffActivity(uid, s && s.email);
      const count = t => transactions.filter(x => x.type === t).length;
      body.innerHTML = `
        <div class="grid grid-3" style="margin-bottom:14px;">
          <div class="stat"><div class="stat-label">Purchases</div><div class="stat-value">${count('Purchase')}</div></div>
          <div class="stat"><div class="stat-label">Redemptions</div><div class="stat-value">${count('Points Redeemed')}</div></div>
          <div class="stat"><div class="stat-label">Adjustments / refunds</div><div class="stat-value">${count('Manual Adjustment') + count('Refund')}</div></div>
        </div>
        <p class="panel-title">Recent transactions</p>
        ${transactions.length ? `<table class="ledger"><tbody>${transactions.slice(0, 15).map(t => `
          <tr><td>${Utils.escapeHtml(t.adjustmentType || t.type)}</td><td>${Utils.escapeHtml(t.memberName || '—')}</td>
          <td class="num">${t.finalPoints != null ? (t.finalPoints >= 0 ? '+' : '') + Utils.formatPoints(t.finalPoints) : '—'}</td>
          <td>${Utils.formatDate(t.date)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">No transactions recorded by this person.</div>'}
        <p class="panel-title" style="margin-top:18px;">Administrative actions</p>
        ${audit.length ? `<table class="ledger"><tbody>${audit.slice(0, 15).map(a => `
          <tr><td>${Utils.escapeHtml(a.action)}</td><td>${Utils.formatDate(a.date)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">None logged.</div>'}
        <p class="hint" style="margin-top:8px;">Showing the most recent entries only. Full history is under Transactions and Audit Log.</p>`;
    } catch (err) {
      body.innerHTML = `<div class="empty-state">Couldn't load activity: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },
};

window.Staff = Staff;