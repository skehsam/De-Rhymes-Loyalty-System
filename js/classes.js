// ============================================================
// classes.js — customer class CRUD + auto-assignment toggle
// ============================================================

const Classes = {
  async init() {
    document.getElementById('btn-add-class').onclick = () => this.openForm();
    document.getElementById('class-form').addEventListener('submit', (e) => this.save(e));
    document.getElementById('auto-class-toggle').addEventListener('change', async (e) => {
      await DB.updateSettings({ autoClassAssignment: e.target.checked }, Auth.currentUser.email);
      Utils.toast('Setting saved', 'success');
    });
    await this.load();
  },

  async load() {
    const [classes, settings] = await Promise.all([DB.listClasses(), DB.getSettings()]);
    document.getElementById('auto-class-toggle').checked = !!settings.autoClassAssignment;
    const tbody = document.getElementById('classes-tbody');
    if (!classes.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><span class="serif">No classes yet</span>Create Standard, Silver, Gold — whatever tiers fit your store.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = classes.map(c => `
      <tr>
        <td><b>${Utils.escapeHtml(c.name)}</b><div class="hint">${Utils.escapeHtml(c.description || '')}</div></td>
        <td class="num">${Utils.formatMultiplier(c.multiplier)}</td>
        <td class="num">${Utils.formatNaira(c.minSpend || 0)}</td>
        <td class="num">${c.maxSpend ? Utils.formatNaira(c.maxSpend) : '—'}</td>
        <td><span class="pill ${c.status === 'active' ? 'positive' : 'muted'}">${c.status}</span></td>
        <td style="text-align:right;">
          <button class="btn btn-sm" data-edit="${c.id}">Edit</button>
          <button class="btn btn-sm" data-toggle="${c.id}" data-status="${c.status === 'active' ? 'inactive' : 'active'}">${c.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-sm btn-danger" data-delete="${c.id}" data-name="${Utils.escapeHtml(c.name)}">Delete</button>
        </td>
      </tr>`).join('');

    tbody.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.openForm(b.dataset.edit));
    tbody.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      await DB.setClassStatus(b.dataset.toggle, b.dataset.status, Auth.currentUser.email);
      this.load();
    });
    tbody.querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => {
      if (!confirm(`Delete class "${b.dataset.name}"? This cannot be undone.`)) return;
      await DB.deleteClass(b.dataset.delete, b.dataset.name, Auth.currentUser.email);
      this.load();
    });
  },

  async openForm(id) {
    const form = document.getElementById('class-form');
    form.reset();
    document.getElementById('cf-id').value = id || '';
    document.getElementById('class-form-title').textContent = id ? 'Edit class' : 'New class';
    if (id) {
      const c = await DB.getClass(id);
      document.getElementById('cf-name').value = c.name;
      document.getElementById('cf-description').value = c.description || '';
      document.getElementById('cf-multiplier').value = c.multiplier;
      document.getElementById('cf-minSpend').value = c.minSpend || 0;
      document.getElementById('cf-maxSpend').value = c.maxSpend || '';
      document.getElementById('cf-minPoints').value = c.minPoints || '';
      document.getElementById('cf-benefits').value = c.benefits || '';
    }
    document.getElementById('modal-class-form').classList.add('open');
  },

  async save(e) {
    e.preventDefault();
    const id = document.getElementById('cf-id').value;
    const data = {
      name: document.getElementById('cf-name').value.trim(),
      description: document.getElementById('cf-description').value.trim(),
      multiplier: parseFloat(document.getElementById('cf-multiplier').value),
      minSpend: parseFloat(document.getElementById('cf-minSpend').value) || 0,
      maxSpend: document.getElementById('cf-maxSpend').value ? parseFloat(document.getElementById('cf-maxSpend').value) : '',
      minPoints: document.getElementById('cf-minPoints').value ? parseFloat(document.getElementById('cf-minPoints').value) : '',
      benefits: document.getElementById('cf-benefits').value.trim(),
      status: 'active',
    };
    await DB.saveClass(id, data, Auth.currentUser.email);
    document.getElementById('modal-class-form').classList.remove('open');
    Utils.toast('Class saved', 'success');
    this.load();
  },
};

window.Classes = Classes;
