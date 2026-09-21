// ============================================================
// checkout.js — the 4-step fast purchase workflow (spec §8)
// ============================================================

const Checkout = {
  member: null,
  settings: null,
  classes: [],
  calc: null,

  async init() {
    document.getElementById('checkout-search').addEventListener('input', Utils.debounce((e) => this.search(e.target.value), 250));
    document.getElementById('btn-open-scanner').onclick = () => Scanner.open((code) => this.identifyByScan(code));
    await this.refreshConfig();
    this.reset();
  },

  /** Settings and classes can change any time; re-read so the preview always matches what will be saved. */
  async refreshConfig() {
    [this.settings, this.classes] = await Promise.all([DB.getSettings(), DB.listClasses()]);
  },

  reset(prefillMemberId) {
    this.member = null;
    this.calc = null;
    this.setStep(1);
    document.getElementById('checkout-search').value = '';
    document.getElementById('checkout-search-results').innerHTML = '';
    if (prefillMemberId) this.identify(prefillMemberId);
  },

  setStep(n) {
    document.querySelectorAll('#checkout-steps .step').forEach(s => {
      const i = parseInt(s.dataset.step, 10);
      s.classList.toggle('active', i === n);
      s.classList.toggle('done', i < n);
    });
    [1, 2, 3, 4].forEach(i => {
      document.getElementById('checkout-step-' + i).style.display = i === n ? '' : 'none';
    });
  },

  async search(term) {
    const host = document.getElementById('checkout-search-results');
    if (!term.trim()) { host.innerHTML = ''; return; }
    const results = await DB.searchMembers(term);
    if (!results.length) {
      host.innerHTML = `<div class="empty-state" style="margin-top:12px;">
        <span class="serif">No member found</span>
        Not registered yet?
        <div style="margin-top:12px;"><button class="btn btn-primary btn-sm" id="ck-register">Register “${Utils.escapeHtml(term.trim())}” as a new member</button></div>
      </div>`;
      document.getElementById('ck-register').onclick = () => Members.openForm(null, Members.prefillFromSearch(term));
      return;
    }
    host.innerHTML = `<table class="ledger" style="margin-top:12px;"><tbody>${
      results.slice(0, 8).map(m => `<tr class="row-link" data-id="${m.memberId}">
        <td><div style="display:flex;align-items:center;gap:10px;"><div class="avatar">${Utils.initials(m.fullName)}</div>${Utils.escapeHtml(m.fullName)}</div></td>
        <td class="num">${m.memberId}</td><td>${Utils.escapeHtml(m.className||'Standard')}</td><td class="num">${Utils.formatPoints(m.points)} pts</td>
      </tr>`).join('')
    }</tbody></table>`;
    host.querySelectorAll('[data-id]').forEach(row => row.onclick = () => this.identify(row.dataset.id));
  },

  async identify(memberIdOrCode) {
    const member = await DB.getMember(memberIdOrCode.toUpperCase());
    if (!member) return Utils.toast('No member found for that code', 'error');
    if (member.status === 'inactive') {
      return Utils.toast(`${member.fullName}'s membership is inactive. Set it back to Active under Members first.`, 'error');
    }
    await this.refreshConfig();
    this.member = member;
    this.showProfile();
  },

  /** A scanned card: only the code currently on the member's card is accepted. */
  async identifyByScan(code) {
    const m = await DB.findMemberByCode(code);
    if (!m) return Utils.toast('No member found for that card. It may have been replaced by a newer card.', 'error');
    return this.identify(m.memberId);
  },

  showProfile() {
    const m = this.member;
    document.getElementById('checkout-step-2').innerHTML = `
      <p class="panel-title">Member</p>
      <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
        <div class="avatar" style="width:52px;height:52px;font-size:18px;">${Utils.initials(m.fullName)}</div>
        <div>
          <div class="serif" style="font-size:19px;">${Utils.escapeHtml(m.fullName)}</div>
          <div class="hint">${m.memberId} · <span class="pill gold">${Utils.escapeHtml(m.className||'Standard')} — ${Utils.formatMultiplier((this.classes.find(c=>c.id===m.classId)||{multiplier:1}).multiplier)}</span></div>
        </div>
      </div>
      <div class="grid grid-3">
        <div class="stat"><div class="stat-label">Current points</div><div class="stat-value">${Utils.formatPoints(m.points)}</div></div>
        <div class="stat"><div class="stat-label">Point value</div><div class="stat-value">₦${this.settings.pointValue}</div><div class="stat-sub">per point</div></div>
        <div class="stat"><div class="stat-label">Loyalty value</div><div class="stat-value">${Utils.formatNaira(m.points * this.settings.pointValue)}</div></div>
      </div>
      <button class="btn btn-primary" style="margin-top:16px;" id="ck-next-1">Continue to purchase</button>`;
    document.getElementById('checkout-step-2').style.display = '';
    document.getElementById('ck-next-1').onclick = () => { this.setStep(3); this.showAmountEntry(); };
    this.setStep(2);
  },

  showAmountEntry() {
    document.getElementById('checkout-step-3').innerHTML = `
      <p class="panel-title">Enter purchase</p>
      <div class="field" style="max-width:280px;">
        <label>Purchase amount (₦)</label>
        <input type="number" id="ck-amount" min="1" step="1" placeholder="e.g. 25000" autofocus>
      </div>
      <button class="btn btn-primary" style="margin-top:14px;" id="ck-calc">Calculate points</button>`;
    document.getElementById('checkout-step-3').style.display = '';
    document.getElementById('ck-calc').onclick = () => this.calculate();
    document.getElementById('ck-amount').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.calculate(); });
  },

  calculate() {
    const amount = parseFloat(document.getElementById('ck-amount').value);
    if (!amount || amount <= 0) return Utils.toast('Enter a valid purchase amount', 'error');
    const cls = this.classes.find(c => c.id === this.member.classId) || { name: 'Standard', multiplier: 1 };
    const { basePoints, finalPoints } = Utils.calculatePoints({
      purchaseAmount: amount,
      baseSpendAmount: this.settings.baseSpendAmount,
      basePointsAwarded: this.settings.basePointsAwarded,
      multiplier: cls.multiplier,
    });
    this.calc = { amount, basePoints, finalPoints, cls };
    const newBalance = (this.member.points || 0) + finalPoints;

    document.getElementById('checkout-step-4').innerHTML = `
      <p class="panel-title">Confirm transaction</p>
      <div class="calc-line"><span>Purchase</span><span class="v">${Utils.formatNaira(amount)}</span></div>
      <div class="calc-line"><span>Base rule</span><span class="v">${Utils.formatNaira(this.settings.baseSpendAmount)} = ${this.settings.basePointsAwarded} pts</span></div>
      <div class="calc-line"><span>Base points</span><span class="v">${Utils.formatPoints(basePoints)}</span></div>
      <div class="calc-line"><span>Class</span><span class="v">${Utils.escapeHtml(cls.name)} — ${Utils.formatMultiplier(cls.multiplier)}</span></div>
      <div class="calc-line"><span>Previous balance</span><span class="v">${Utils.formatPoints(this.member.points)}</span></div>
      <div class="calc-line total"><span>Points earned</span><span class="v">+${Utils.formatPoints(finalPoints)}</span></div>
      <div class="calc-line total"><span>New balance</span><span class="v">${Utils.formatPoints(newBalance)}</span></div>
      <div style="display:flex; gap:10px; margin-top:16px;">
        <button class="btn" id="ck-back">Back</button>
        <button class="btn btn-primary" id="ck-confirm">Confirm transaction</button>
      </div>`;
    document.getElementById('checkout-step-4').style.display = '';
    document.getElementById('ck-back').onclick = () => this.setStep(3);
    document.getElementById('ck-confirm').onclick = () => this.confirm();
    this.setStep(4);
  },

  async confirm() {
    const btn = document.getElementById('ck-confirm');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const result = await DB.recordPurchase({
        memberId: this.member.memberId,
        purchaseAmount: this.calc.amount,
        staffUid: Auth.currentUser.uid,
        staffName: Auth.profile.name,
      });
      Utils.toast(`+${Utils.formatPoints(result.finalPoints)} points recorded for ${this.member.fullName}`, 'success');
      this.reset();
    } catch (err) {
      Utils.toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Confirm transaction';
    }
  },
};

window.Checkout = Checkout;