// ============================================================
// settings.js — earning rule, point value, redemption limits, expiry,
// business info, notification toggles + editable templates (spec §7, §11, §15)
// ============================================================

const Settings = {
  loadedTemplates: {},

  async init() {
    document.getElementById('btn-save-settings').onclick = () => this.save();
    document.getElementById('btn-run-expiry').onclick = () => this.runExpiry();
    ['set-base-amount', 'set-base-points', 'set-point-value'].forEach(id =>
      document.getElementById(id).addEventListener('input', () => this.updatePreview()));
    await this.load();
  },

  async load() {
    const [s, tpl] = await Promise.all([DB.getSettings(), DB.getTemplates()]);
    const set = (id, v) => { document.getElementById(id).value = v ?? ''; };
    set('set-base-amount', s.baseSpendAmount);
    set('set-base-points', s.basePointsAwarded);
    set('set-point-value', s.pointValue);
    set('set-min-redeem', s.minRedemption || 0);
    set('set-max-redeem', s.maxRedemption || 0);
    set('set-expiry-months', s.pointExpiryMonths || 0);
    set('set-biz-name', s.businessName);
    set('set-biz-address', s.businessAddress);
    set('set-biz-phone', s.businessPhone);
    set('set-biz-email', s.businessEmail);
    document.getElementById('set-whatsapp').checked = !!s.whatsappEnabled;
    document.getElementById('set-email').checked = !!s.emailEnabled;
    document.getElementById('set-birthday').checked = s.birthdayEnabled !== false;
    this.loadedTemplates = tpl;
    this.renderTemplates(tpl);
    this.updatePreview();
  },

  renderTemplates(tpl) {
    document.getElementById('set-templates').innerHTML = Object.entries(DB.TEMPLATE_META).map(([key, meta]) => `
      <div class="field" style="margin-bottom:12px;">
        <label>${Utils.escapeHtml(meta.label)} <span class="hint">— placeholders: ${Utils.escapeHtml(meta.vars)}</span></label>
        <textarea rows="2" data-tpl="${Utils.escapeHtml(key)}">${Utils.escapeHtml(tpl[key])}</textarea>
      </div>`).join('') +
      `<button class="btn btn-sm" type="button" id="btn-reset-templates">Restore default wording</button>`;
    document.getElementById('btn-reset-templates').onclick = () => {
      document.querySelectorAll('[data-tpl]').forEach(t => { t.value = DB.DEFAULT_TEMPLATES[t.dataset.tpl]; });
      Utils.toast('Defaults restored — press Save settings to keep them', 'default');
    };
  },

  updatePreview() {
    const amount = parseFloat(document.getElementById('set-base-amount').value) || 0;
    const pts = parseFloat(document.getElementById('set-base-points').value) || 0;
    const val = parseFloat(document.getElementById('set-point-value').value) || 0;
    document.getElementById('set-rule-preview').textContent = `${Utils.formatNaira(amount)} spent = ${pts} points`;
    document.getElementById('set-value-preview').textContent = `1 point = ${Utils.formatNaira(val)}  ·  500 points = ${Utils.formatNaira(500 * val)}`;
  },

  async save() {
    const num = id => parseFloat(document.getElementById(id).value);
    const txt = id => document.getElementById(id).value.trim();
    const patch = {
      baseSpendAmount: num('set-base-amount'),
      basePointsAwarded: num('set-base-points'),
      pointValue: num('set-point-value'),
      minRedemption: num('set-min-redeem') || 0,
      maxRedemption: num('set-max-redeem') || 0,
      pointExpiryMonths: Math.floor(num('set-expiry-months') || 0),
      businessName: txt('set-biz-name'),
      businessAddress: txt('set-biz-address'),
      businessPhone: txt('set-biz-phone'),
      businessEmail: txt('set-biz-email'),
      whatsappEnabled: document.getElementById('set-whatsapp').checked,
      emailEnabled: document.getElementById('set-email').checked,
      birthdayEnabled: document.getElementById('set-birthday').checked,
    };
    if (!(patch.baseSpendAmount > 0) || !(patch.basePointsAwarded > 0) || !(patch.pointValue >= 0)) {
      return Utils.toast('Check the values — they must be positive numbers', 'error');
    }
    if (patch.minRedemption < 0 || patch.maxRedemption < 0 || patch.pointExpiryMonths < 0) {
      return Utils.toast('Redemption limits and expiry cannot be negative', 'error');
    }
    if (patch.maxRedemption && patch.minRedemption > patch.maxRedemption) {
      return Utils.toast('Minimum redemption cannot be higher than the maximum', 'error');
    }
    try {
      await DB.updateSettings(patch, Auth.currentUser.email);
      const templates = {};
      document.querySelectorAll('[data-tpl]').forEach(t => { templates[t.dataset.tpl] = t.value.trim(); });
      if (JSON.stringify(templates) !== JSON.stringify(this.loadedTemplates)) {
        await DB.saveTemplates(templates, Auth.currentUser.email);
      }
      await this.load();
      Utils.toast('Settings saved. New activity will use these values.', 'success');
    } catch (err) {
      Utils.toast(err.message, 'error');
    }
  },

  async runExpiry() {
    const months = Math.floor(parseFloat(document.getElementById('set-expiry-months').value) || 0);
    if (!months) return Utils.toast('Enter the number of months and save first', 'error');
    if (!confirm(`Expire the ENTIRE points balance of every member with no activity for ${months}+ months? This cannot be undone (each expiry is recorded as a transaction).`)) return;
    const btn = document.getElementById('btn-run-expiry');
    btn.disabled = true; btn.textContent = 'Running…';
    try {
      const r = await DB.expireInactivePoints(Auth.currentUser.email);
      Utils.toast(`Expired ${Utils.formatPoints(r.points)} points from ${r.members} member${r.members === 1 ? '' : 's'}` +
        (r.skipped ? ` (${r.skipped} skipped: no activity date recorded yet)` : ''), 'success');
    } catch (err) {
      Utils.toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Run expiry now';
    }
  },
};

window.Settings = Settings;