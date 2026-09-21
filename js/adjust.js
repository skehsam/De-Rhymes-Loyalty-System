// ============================================================
// adjust.js — manual point add / bonus / remove / reverse with reason (spec §9)
// ============================================================

const Adjust = {
  member: null,

  async init() {
    document.getElementById('adjust-search').addEventListener('input', Utils.debounce((e) => this.search(e.target.value), 250));
  },

  async search(term) {
    const host = document.getElementById('adjust-body');
    if (!term.trim()) { host.innerHTML = ''; return; }
    const results = await DB.searchMembers(term);
    if (!results.length) { host.innerHTML = `<p class="hint">No matches.</p>`; return; }
    host.innerHTML = `<div style="margin-top:12px;">${results.slice(0, 6).map(m => `
      <div class="row-link" data-id="${m.memberId}" style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--line-soft); cursor:pointer;">
        <span>${Utils.escapeHtml(m.fullName)} <span class="hint">${m.memberId}</span></span>
        <span class="num">${Utils.formatPoints(m.points)} pts</span>
      </div>`).join('')}</div>`;
    host.querySelectorAll('[data-id]').forEach(row => row.onclick = () => this.selectMember(row.dataset.id));
  },

  async selectMember(memberId) {
    this.member = await DB.getMember(memberId);
    if (!this.member) return Utils.toast('Member not found', 'error');
    const host = document.getElementById('adjust-body');
    const typeOptions = Object.keys(DB.ADJUSTMENT_TYPES).map(t => `<option value="${t}">${t}</option>`).join('');
    host.innerHTML = `
      <div class="panel" style="margin-top:14px; padding:16px;">
        <div class="serif" style="font-size:18px;">${Utils.escapeHtml(this.member.fullName)}</div>
        <p class="hint">${this.member.memberId} · balance ${Utils.formatPoints(this.member.points)} points</p>
        <div class="field-row" style="margin-top:12px;">
          <div class="field"><label>Adjustment type</label><select id="aj-type">${typeOptions}</select></div>
          <div class="field"><label>Number of points</label><input type="number" id="aj-points" min="1"></div>
        </div>
        <div class="field" style="margin-top:12px;"><label>Reason</label><input type="text" id="aj-reason" required placeholder="e.g. Customer appreciation reward"></div>
        <div class="field" id="aj-related-wrap" style="margin-top:12px; display:none;"><label>Original transaction ID (optional)</label><input type="text" id="aj-related" placeholder="e.g. TXN-8F3K2A1Q"></div>
        <div class="field" style="margin-top:12px;"><label>Notes (optional)</label><textarea id="aj-notes" rows="2"></textarea></div>
        <p class="hint" id="aj-preview" style="margin-top:10px;"></p>
        <button class="btn btn-primary" style="margin-top:12px;" id="aj-confirm">Apply adjustment</button>
      </div>`;
    const typeSel = document.getElementById('aj-type');
    const pts = document.getElementById('aj-points');
    const preview = document.getElementById('aj-preview');
    const refresh = () => {
      document.getElementById('aj-related-wrap').style.display = typeSel.value === 'Reverse Points' ? '' : 'none';
      const n = parseFloat(pts.value) || 0;
      const after = Math.max(0, (this.member.points || 0) + DB.ADJUSTMENT_TYPES[typeSel.value] * n);
      preview.textContent = n ? `New balance would be ${Utils.formatPoints(after)} points.` : '';
    };
    typeSel.onchange = refresh; pts.addEventListener('input', refresh);
    document.getElementById('aj-confirm').onclick = () => this.confirm();
  },

  async confirm() {
    const adjustmentType = document.getElementById('aj-type').value;
    const points = parseFloat(document.getElementById('aj-points').value);
    const reason = document.getElementById('aj-reason').value.trim();
    const notes = document.getElementById('aj-notes').value.trim();
    const relatedTxId = document.getElementById('aj-related').value.trim().toUpperCase();
    if (!points || points <= 0) return Utils.toast('Enter a valid number of points', 'error');
    if (!reason) return Utils.toast('A reason is required for manual adjustments', 'error');
    const removing = DB.ADJUSTMENT_TYPES[adjustmentType] < 0;
    if (removing && points > (this.member.points || 0) &&
        !confirm(`${this.member.fullName} only has ${Utils.formatPoints(this.member.points)} points. This will set the balance to 0. Continue?`)) return;
    const btn = document.getElementById('aj-confirm');
    btn.disabled = true;
    try {
      const result = await DB.adjustPoints({
        memberId: this.member.memberId, points, adjustmentType, reason, notes,
        relatedTxId: adjustmentType === 'Reverse Points' ? relatedTxId : '',
        staffUid: Auth.currentUser.uid, staffName: Auth.profile.name,
      });
      Utils.toast(`${adjustmentType}: ${result.applied > 0 ? '+' : ''}${Utils.formatPoints(result.applied)} points. New balance: ${Utils.formatPoints(result.newBalance)}`, 'success');
      document.getElementById('adjust-search').value = '';
      document.getElementById('adjust-body').innerHTML = '';
    } catch (err) {
      Utils.toast(err.message, 'error');
      btn.disabled = false;
    }
  },
};

window.Adjust = Adjust;