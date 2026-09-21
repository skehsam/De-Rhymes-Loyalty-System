// ============================================================
// redeem.js — redeem points for cash value (spec §12)
// ============================================================

const Redeem = {
  member: null,
  settings: null,

  async init() {
    this.settings = await DB.getSettings();
    document.getElementById('redeem-search').addEventListener('input', Utils.debounce((e) => this.search(e.target.value), 250));
  },

  async search(term) {
    const host = document.getElementById('redeem-body');
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
    // Re-read settings so the cash value always matches the current point value.
    this.settings = await DB.getSettings();
    this.member = await DB.getMember(memberId);
    if (!this.member) return Utils.toast('Member not found', 'error');
    if (this.member.status === 'inactive') {
      return Utils.toast(`${this.member.fullName}'s membership is inactive. Reactivate it under Members first.`, 'error');
    }
    const s = this.settings;
    const limits = [
      s.minRedemption ? `Minimum ${Utils.formatPoints(s.minRedemption)} points` : '',
      s.maxRedemption ? `Maximum ${Utils.formatPoints(s.maxRedemption)} points` : '',
    ].filter(Boolean).join(' · ');
    const host = document.getElementById('redeem-body');
    host.innerHTML = `
      <div class="panel" style="margin-top:14px; padding:16px;">
        <div class="serif" style="font-size:18px;">${Utils.escapeHtml(this.member.fullName)}</div>
        <p class="hint">${this.member.memberId} · balance ${Utils.formatPoints(this.member.points)} points · ${Utils.formatNaira(this.settings.pointValue)} per point</p>
        <div class="field" style="margin-top:12px;">
          <label>Points to redeem</label>
          <input type="number" id="rd-points" min="1" max="${s.maxRedemption ? Math.min(this.member.points, s.maxRedemption) : this.member.points}">
        </div>
        <div class="field" style="margin-top:12px;">
          <label>Reason (optional)</label>
          <input type="text" id="rd-reason" placeholder="e.g. Redeemed for store credit">
        </div>
        ${limits ? `<p class="hint" style="margin-top:10px;">${limits}</p>` : ''}
        <p class="hint" id="rd-preview" style="margin-top:10px;"></p>
        <button class="btn btn-primary" style="margin-top:12px;" id="rd-confirm">Redeem points</button>
      </div>`;
    const input = document.getElementById('rd-points');
    const preview = document.getElementById('rd-preview');
    input.addEventListener('input', () => {
      const pts = parseFloat(input.value) || 0;
      preview.textContent = `Cash value: ${Utils.formatNaira(Utils.pointsToCash(pts, this.settings.pointValue))} · Remaining: ${Utils.formatPoints(this.member.points - pts)} points`;
    });
    document.getElementById('rd-confirm').onclick = () => this.confirm();
  },

  async confirm() {
    const points = parseFloat(document.getElementById('rd-points').value);
    const reason = document.getElementById('rd-reason').value.trim();
    if (!points || points <= 0) return Utils.toast('Enter a valid number of points', 'error');
    if (points > this.member.points) return Utils.toast('Cannot redeem more points than the balance', 'error');
    if (this.settings.minRedemption && points < this.settings.minRedemption) {
      return Utils.toast(`Minimum redemption is ${Utils.formatPoints(this.settings.minRedemption)} points`, 'error');
    }
    if (this.settings.maxRedemption && points > this.settings.maxRedemption) {
      return Utils.toast(`Maximum redemption is ${Utils.formatPoints(this.settings.maxRedemption)} points per transaction`, 'error');
    }
    if (!confirm(`Redeem ${Utils.formatPoints(points)} points for ${Utils.formatNaira(Utils.pointsToCash(points, this.settings.pointValue))}?`)) return;
    try {
      const result = await DB.redeemPoints({
        memberId: this.member.memberId, pointsToRedeem: points, reason,
        staffUid: Auth.currentUser.uid, staffName: Auth.profile.name,
      });
      Utils.toast(`Redeemed ${Utils.formatPoints(points)} points — ${Utils.formatNaira(result.cashValue)}`, 'success');
      document.getElementById('redeem-search').value = '';
      document.getElementById('redeem-body').innerHTML = '';
    } catch (err) {
      Utils.toast(err.message, 'error');
    }
  },
};

window.Redeem = Redeem;