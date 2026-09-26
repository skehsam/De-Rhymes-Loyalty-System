// ============================================================
// members.js — member list, add/edit, and full profile view
// ============================================================

const Members = {
  classesCache: [],
  currentProfileId: null,

  async init() {
    document.getElementById('btn-open-scanner-2').onclick = () =>
      Scanner.open((code) => this.openProfileByCode(code));
    document.getElementById('members-search').addEventListener('input', Utils.debounce((e) => this.search(e.target.value), 250));
    document.getElementById('member-form').addEventListener('submit', (e) => this.save(e));
    document.getElementById('btn-back-members').onclick = () => App.go('members');
    document.getElementById('mp-charge').onclick = () => App.go('checkout', { memberId: this.currentProfileId, skipToStep: 2 });
    document.getElementById('mp-edit').onclick = () => this.openForm(this.currentProfileId);
    document.getElementById('mp-toggle-status').onclick = () => this.toggleStatus();
    document.getElementById('mp-reissue').onclick = () => this.reissueCard();
    document.getElementById('btn-export-members').onclick = () => this.exportCsv();
    ['members-filter-status', 'members-filter-class'].forEach(id =>
      document.getElementById(id).addEventListener('change', () => this.search(document.getElementById('members-search').value)));
    document.querySelectorAll('#mp-tabs .tab').forEach(t => t.onclick = () => this.selectTab(t.dataset.tab));
    await this.loadList();
  },

  async loadList() {
    await this.refreshClassFilter();
    const members = await DB.listMembers({ limit: this.filtersActive() ? 500 : 100 });
    this.renderTable(this.applyFilters(members));
  },

  async search(term) {
    if (!term.trim()) return this.loadList();
    const results = await DB.searchMembers(term);
    this.renderTable(this.applyFilters(results));
  },

  renderTable(members) {
    this.shownRows = members;
    const tbody = document.getElementById('members-tbody');
    if (!members.length && (this.filtersActive() || document.getElementById('members-search').value.trim())) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No members match.</div></td></tr>`;
      return;
    }
    if (!members.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="serif">No members yet</span>Add your first loyalty member to get started.<div style="margin-top:14px;"><button class="btn btn-primary btn-sm" data-add-member>+ Add member</button></div></div></td></tr>`;
      return;
    }
    tbody.innerHTML = members.map(m => `
      <tr class="row-link" data-id="${m.memberId}">
        <td><div style="display:flex;align-items:center;gap:10px;">
          <div class="avatar">${Utils.initials(m.fullName)}</div>
          <div><div>${Utils.escapeHtml(m.fullName)}</div><div class="hint">${Utils.escapeHtml(m.phone || '')}</div></div>
        </div></td>
        <td class="num">${m.memberId}</td>
        <td>${Utils.escapeHtml(m.className || '—')}</td>
        <td class="num">${Utils.formatPoints(m.points)}</td>
        <td class="num">${Utils.formatNaira(m.totalSpent)}</td>
        <td><span class="pill ${m.status === 'active' ? 'positive' : 'muted'}">${m.status}</span></td>
      </tr>`).join('');
    tbody.querySelectorAll('tr[data-id]').forEach(row => {
      row.onclick = () => this.openProfile(row.dataset.id);
    });
  },

  filtersActive() {
    return !!(document.getElementById('members-filter-status').value || document.getElementById('members-filter-class').value);
  },

  applyFilters(rows) {
    const status = document.getElementById('members-filter-status').value;
    const cls = document.getElementById('members-filter-class').value;
    return rows.filter(m => (!status || (m.status || 'active') === status) && (!cls || (m.className || 'Standard') === cls));
  },

  async refreshClassFilter() {
    const sel = document.getElementById('members-filter-class');
    const current = sel.value;
    const classes = await DB.listClasses().catch(() => []);
    const names = ['Standard', ...classes.map(c => c.name).filter(n => n !== 'Standard')];
    sel.innerHTML = '<option value="">All classes</option>' +
      names.map(n => `<option value="${Utils.escapeHtml(n)}">${Utils.escapeHtml(n)}</option>`).join('');
    sel.value = names.includes(current) ? current : '';
  },

  exportCsv() {
    const rows = (this.shownRows || []).map(m => [
      m.memberId, m.fullName, m.phone || '', m.email || '', m.className || 'Standard',
      m.points || 0, m.totalSpent || 0, m.status || 'active',
      Utils.toDate(m.registrationDate) ? Utils.toDate(m.registrationDate).toISOString().slice(0, 10) : '',
    ]);
    Utils.downloadCSV(`members-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Member ID', 'Name', 'Phone', 'Email', 'Class', 'Points', 'Total spent (NGN)', 'Status', 'Registered'], rows);
  },

  /** Scanner result -> profile. Only the code on the member's current card works. */
  async openProfileByCode(code) {
    const m = await DB.findMemberByCode(code);
    if (!m) return Utils.toast('No member found for that card. It may have been replaced by a newer card.', 'error');
    return this.openProfile(m.memberId);
  },

  async toggleStatus() {
    const m = this.currentMember;
    if (!m) return;
    const deactivating = (m.status || 'active') !== 'inactive';
    if (!confirm(deactivating
      ? `Deactivate ${m.fullName}? They will not be able to earn or redeem points until reactivated. Their history and balance are kept.`
      : `Reactivate ${m.fullName}?`)) return;
    const reason = prompt('Reason (optional):');
    if (reason === null) return;
    try {
      await DB.setMemberStatus(m.memberId, deactivating ? 'inactive' : 'active', reason.trim(), Auth.currentUser.email);
      Utils.toast(deactivating ? 'Member deactivated' : 'Member reactivated', 'success');
      this.loadList();
      await this.openProfile(m.memberId);
    } catch (err) { Utils.toast(err.message, 'error'); }
  },

  async reissueCard() {
    const m = this.currentMember;
    if (!m) return;
    const reason = prompt(`Reissue ${m.fullName}'s card? The old card's QR/barcode will stop working.\n\nReason (e.g. lost, damaged):`);
    if (reason === null) return;
    if (!reason.trim()) return Utils.toast('A reason is required to reissue a card', 'error');
    try {
      await DB.reissueCard(m.memberId, reason.trim(), Auth.currentUser.email);
      Utils.toast('New card issued. The old card no longer works.', 'success');
      await this.openProfile(m.memberId, true); // opens the printable card
    } catch (err) { Utils.toast(err.message, 'error'); }
  },

  cardFooter() {
    const s = this.settings || {};
    const bits = [s.businessName, s.businessPhone].filter(Boolean).map(Utils.escapeHtml);
    return bits.length ? `<div class="mc-foot">${bits.join(' · ')}</div>` : '';
  },

  /** Turns whatever was typed in a search box into form prefill (phone / email / name). */
  prefillFromSearch(term) {
    const t = (term || '').trim();
    if (!t) return {};
    if (t.includes('@')) return { email: t };
    if (/^[+\d][\d\s-]{6,}$/.test(t)) return { phone: t.replace(/[\s-]/g, '') };
    return { fullName: t };
  },

  async openForm(memberId, prefill = {}) {
    if (!Auth.can('manageMembers')) return Utils.toast('You don\'t have access to that', 'error');
    this.classesCache = await DB.listClasses().catch(err => { console.error(err); return []; });
    const sel = document.getElementById('mf-classId');
    sel.innerHTML = this.classesCache.map(c => `<option value="${c.id}">${Utils.escapeHtml(c.name)} (${Utils.formatMultiplier(c.multiplier)})</option>`).join('')
      || '<option value="">No classes yet — create one first</option>';

    const form = document.getElementById('member-form');
    form.reset();
    document.getElementById('mf-id').value = memberId || '';
    document.getElementById('member-form-title').textContent = memberId ? 'Edit member' : 'Add member';

    const hint = document.getElementById('mf-class-hint');
    hint.style.display = this.classesCache.length ? 'none' : '';
    hint.textContent = Auth.can('manageClasses')
      ? 'No classes yet — this member will be saved as Standard (1×). Create tiers under Customer Classes.'
      : 'No classes set up yet — this member will be saved as Standard (1×).';

    if (!memberId) {
      if (prefill.fullName) document.getElementById('mf-fullName').value = prefill.fullName;
      if (prefill.phone) document.getElementById('mf-phone').value = prefill.phone;
      if (prefill.email) document.getElementById('mf-email').value = prefill.email;
    }

    if (memberId) {
      const m = await DB.getMember(memberId);
      document.getElementById('mf-fullName').value = m.fullName || '';
      document.getElementById('mf-phone').value = m.phone || '';
      document.getElementById('mf-email').value = m.email || '';
      document.getElementById('mf-dob').value = m.dob || '';
      document.getElementById('mf-address').value = m.address || '';
      document.getElementById('mf-gender').value = m.gender || '';
      document.getElementById('mf-status').value = m.status || 'active';
      document.getElementById('mf-notes').value = m.notes || '';
      document.getElementById('mf-notif-whatsapp').checked = m.notificationPrefs?.whatsapp !== false;
      document.getElementById('mf-notif-email').checked = m.notificationPrefs?.email !== false;
      if (m.classId) sel.value = m.classId;
    }
    document.getElementById('modal-member-form').classList.add('open');
    document.getElementById('mf-fullName').focus();
  },

  async save(e) {
    e.preventDefault();
    if (this.saving) return; // a double-tap must not register the same person twice
    const id = document.getElementById('mf-id').value;
    const cls = this.classesCache.find(c => c.id === document.getElementById('mf-classId').value);
    const data = {
      fullName: document.getElementById('mf-fullName').value.trim(),
      phone: document.getElementById('mf-phone').value.trim(),
      email: document.getElementById('mf-email').value.trim(),
      dob: document.getElementById('mf-dob').value,
      address: document.getElementById('mf-address').value.trim(),
      gender: document.getElementById('mf-gender').value,
      status: document.getElementById('mf-status').value,
      notes: document.getElementById('mf-notes').value.trim(),
      classId: cls ? cls.id : null,
      className: cls ? cls.name : 'Standard',
      notificationPrefs: {
        whatsapp: document.getElementById('mf-notif-whatsapp').checked,
        email: document.getElementById('mf-notif-email').checked,
      },
    };
    const btn = document.querySelector('#member-form button[type="submit"]');
    this.saving = true; btn.disabled = true;
    try {
      if (id) {
        const before = await DB.getMember(id);
        await DB.updateMember(id, data, Auth.currentUser.email);
        if (before && (before.classId || null) !== (data.classId || null)) {
          // keep the class history honest when a class is changed by hand
          await DB.logClassChange({
            memberId: id, previousClass: before.className || 'Standard', newClass: data.className,
            reason: 'Changed manually by ' + (Auth.profile.name || Auth.currentUser.email),
          }).catch(err => console.error('Class history not written', err));
        }
        Utils.toast('Member updated', 'success');
        document.getElementById('modal-member-form').classList.remove('open');
        this.loadList();
        if (this.currentProfileId === id) await this.openProfile(id);
      } else {
        const memberId = await DB.createMember(data, Auth.currentUser.email);
        Utils.toast(`Member registered as ${memberId}`, 'success');
        document.getElementById('modal-member-form').classList.remove('open');
        await this.openProfile(memberId, true);
      }
    } catch (err) {
      Utils.toast(err.message, 'error');
    } finally {
      this.saving = false; btn.disabled = false;
    }
  },

  async openProfile(memberId, showCardFirst) {
    const member = await DB.getMember(memberId);
    if (!member) return Utils.toast('Member not found', 'error');
    this.currentProfileId = memberId;
    this.currentMember = member;
    const settings = await DB.getSettings().catch(() => ({ pointValue: 1 }));
    this.settings = settings;

    document.getElementById('mp-name').textContent = member.fullName;
    document.getElementById('mp-sub').textContent = `${member.memberId} · ${member.className || 'Standard'} · registered ${Utils.formatDate(member.registrationDate)}`;

    this.renderCard(member);
    document.getElementById('mp-toggle-status').textContent = member.status === 'inactive' ? 'Reactivate member' : 'Deactivate member';

    document.getElementById('mp-stats').innerHTML = `
      <div class="stat"><div class="stat-label">Current points</div><div class="stat-value">${Utils.formatPoints(member.points)}</div><div class="stat-sub">Loyalty value ${Utils.formatNaira((member.points || 0) * (settings.pointValue || 1))}</div></div>
      <div class="stat gold"><div class="stat-label">Class</div><div class="stat-value">${Utils.escapeHtml(member.className || 'Standard')}</div></div>
      <div class="stat"><div class="stat-label">Total spent</div><div class="stat-value">${Utils.formatNaira(member.totalSpent)}</div></div>`;

    App.go('member-profile');
    this.selectTab('overview');
    if (showCardFirst) this.openPrintCard();
  },

  renderCard(member) {
    const host = document.getElementById('mp-card-host');
    host.innerHTML = `
      <div class="member-card">
        <img class="mc-badge" src="assets/logo-badge.png" alt="">
        <div class="mc-brand">DE RHYMES</div>
        <div class="mc-name">${Utils.escapeHtml(member.fullName)}</div>
        <div class="mc-id">${member.memberId}</div>
        <div class="mc-row">
          <div><span class="mc-class">${Utils.escapeHtml((member.className || 'STANDARD').toUpperCase())}</span></div>
          <div class="mc-points"><div class="n">${Utils.formatPoints(member.points)}</div><div class="l">POINTS</div></div>
        </div>
        <div class="mc-codes">
          <canvas id="mp-qr"></canvas>
          <svg id="mp-barcode"></svg>
        </div>
      </div>
      <button class="btn btn-block" style="margin-top:12px;" id="mp-print-btn">Print / view full card</button>`;
    Codes.renderQR(document.getElementById('mp-qr'), member.qrValue || member.memberId);
    Codes.renderBarcode(document.getElementById('mp-barcode'), member.barcodeValue || member.memberId);
    document.getElementById('mp-print-btn').onclick = () => this.openPrintCard();
  },

  openPrintCard() {
    const member = this.currentMember;
    document.getElementById('print-area').innerHTML = `
      <div class="member-card" style="width:100%;">
        <img class="mc-badge" src="assets/logo-badge.png" alt="">
        <div class="mc-brand">DE RHYMES</div>
        <div class="mc-name">${Utils.escapeHtml(member.fullName)}</div>
        <div class="mc-id">${member.memberId}</div>
        <div class="mc-row">
          <div><span class="mc-class">${Utils.escapeHtml((member.className || 'STANDARD').toUpperCase())}</span></div>
          <div class="mc-points"><div class="n">${Utils.formatPoints(member.points)}</div><div class="l">POINTS</div></div>
        </div>
        <div class="mc-codes"><canvas id="pc-qr"></canvas><svg id="pc-barcode"></svg></div>
        ${this.cardFooter()}
      </div>`;
    Codes.renderQR(document.getElementById('pc-qr'), member.qrValue || member.memberId);
    Codes.renderBarcode(document.getElementById('pc-barcode'), member.barcodeValue || member.memberId);
    document.getElementById('modal-print-card').classList.add('open');
  },

  async selectTab(tab) {
    try {
      await this._renderTab(tab);
    } catch (err) {
      console.error(err);
      document.getElementById('mp-tab-content').innerHTML = `<div class="empty-state">Couldn't load this tab: ${Utils.escapeHtml(err.message)}</div>`;
    }
  },

  async _renderTab(tab) {
    document.querySelectorAll('#mp-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const host = document.getElementById('mp-tab-content');
    const member = this.currentMember;
    host.innerHTML = '<p class="hint">Loading…</p>';

    if (tab === 'overview') {
      host.innerHTML = `
        <div class="grid grid-2">
          <div><p class="hint">Phone</p><p>${Utils.escapeHtml(member.phone || '—')}</p></div>
          <div><p class="hint">Email</p><p>${Utils.escapeHtml(member.email || '—')}</p></div>
          <div><p class="hint">Address</p><p>${Utils.escapeHtml(member.address || '—')}</p></div>
          <div><p class="hint">Date of birth</p><p>${member.dob || '—'}</p></div>
          <div><p class="hint">Notes</p><p>${Utils.escapeHtml(member.notes || '—')}</p></div>
          <div><p class="hint">Membership status</p><p>${Utils.escapeHtml(member.status || 'active')}</p></div>
          <div><p class="hint">Card</p><p>Version ${member.cardVersion || 1}</p></div>
        </div>`;
      return;
    }
    if (tab === 'purchases' || tab === 'points' || tab === 'redemptions') {
      const all = await DB.listTransactions({ memberId: member.memberId });
      const rows = tab === 'purchases' ? all.filter(t => t.type === 'Purchase')
        : tab === 'redemptions' ? all.filter(t => t.type === 'Points Redeemed')
        : all; // points tab shows everything point-related
      host.innerHTML = this.txTable(rows);
      return;
    }
    if (tab === 'notifications') {
      const notifs = await DB.listNotifications({ limit: 300 });
      const mine = notifs.filter(n => n.memberId === member.memberId);
      host.innerHTML = mine.length ? `<table class="ledger"><thead><tr><th>Channel</th><th>Type</th><th>Message</th><th>Status</th><th>Date</th></tr></thead><tbody>${
        mine.map(n => `<tr><td>${n.channel}</td><td>${n.type}</td><td>${Utils.escapeHtml(n.message)}</td><td><span class="pill ${n.status==='Failed'?'negative':n.status==='Delivered'?'positive':'muted'}">${n.status}</span></td><td>${Utils.formatDate(n.sentDate)}</td></tr>`).join('')
      }</tbody></table>` : `<div class="empty-state">No notifications sent yet.</div>`;
      return;
    }
    if (tab === 'installments') {
      if (window.Installments && Installments.renderCustomerTab) {
        host.innerHTML = await Installments.renderCustomerTab(member.memberId);
      } else {
        host.innerHTML = `<div class="empty-state">Installments module not loaded.</div>`;
      }
      return;
    }
    if (tab === 'membership') {
      const history = await DB.getClassHistory(member.memberId);
      host.innerHTML = `
        <p class="hint">QR value: <b class="num">${member.qrValue}</b> · Barcode value: <b class="num">${member.barcodeValue}</b></p>
        <table class="ledger" style="margin-top:10px;"><thead><tr><th>Date</th><th>Previous</th><th>New</th><th>Reason</th></tr></thead><tbody>${
          history.length ? history.map(h => `<tr><td>${Utils.formatDate(h.date)}</td><td>${Utils.escapeHtml(h.previousClass)}</td><td>${Utils.escapeHtml(h.newClass)}</td><td>${Utils.escapeHtml(h.reason||'')}</td></tr>`).join('')
          : `<tr><td colspan="4"><div class="empty-state">No class changes recorded.</div></td></tr>`
        }</tbody></table>`;
      return;
    }
  },

  txTable(rows) {
    if (!rows.length) return `<div class="empty-state">Nothing here yet.</div>`;
    return `<table class="ledger"><thead><tr><th>Type</th><th class="num">Amount</th><th class="num">Points</th><th>Date</th></tr></thead><tbody>${
      rows.map(t => `<tr>
        <td>${t.type}</td>
        <td class="num">${t.purchaseAmount ? Utils.formatNaira(t.purchaseAmount) : '—'}</td>
        <td class="num"><span class="pill ${t.finalPoints >= 0 ? 'positive' : 'negative'}">${t.finalPoints >= 0 ? '+' : ''}${Utils.formatPoints(t.finalPoints)}</span></td>
        <td>${Utils.formatDate(t.date)}</td>
      </tr>`).join('')
    }</tbody></table>`;
  },
};

window.Members = Members;