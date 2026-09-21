// ============================================================
// utils.js — pure helpers: loyalty math, formatting, IDs
// No Firebase calls in here. Keep this file testable in isolation.
// ============================================================

/**
 * Core loyalty formula (see spec §1, §11):
 *   basePoints  = floor(purchaseAmount / baseSpendAmount) * basePointsAwarded
 *   finalPoints = basePoints * classMultiplier
 * The multiplier is applied to BASE POINTS, never to the naira amount.
 */
function calculatePoints({ purchaseAmount, baseSpendAmount, basePointsAwarded, multiplier }) {
  const units = Math.floor(purchaseAmount / baseSpendAmount);
  const basePoints = units * basePointsAwarded;
  const finalPoints = Math.round(basePoints * multiplier);
  return { units, basePoints, finalPoints };
}

/** Monetary value of a point balance, given the point value at redemption time. */
function pointsToCash(points, pointValue) {
  return points * pointValue;
}

/** Formats a number as Nigerian Naira. */
function formatNaira(amount) {
  const n = Number(amount) || 0;
  return '₦' + n.toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

function formatPoints(points) {
  return Number(points || 0).toLocaleString('en-NG');
}

function formatMultiplier(m) {
  const n = Number(m) || 0;
  return (Number.isInteger(n) ? n : n.toFixed(2)) + '×';
}

function formatDate(d) {
  if (!d) return '—'; // server timestamp not resolved yet
  const dt = d && d.toDate ? d.toDate() : (d instanceof Date ? d : new Date(d));
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' · ' + dt.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
}

/** DRL-000001 style formatting from a raw integer sequence number. */
function formatMemberId(seq) {
  return 'DRL-' + String(seq).padStart(6, '0');
}

/** Short unique transaction reference, e.g. TXN-8F3K2A1Q */
function generateTxnId() {
  return 'TXN-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

function generateId(prefix) {
  return (prefix ? prefix + '-' : '') + Math.random().toString(36).slice(2, 10).toUpperCase();
}

/** Which class a total-spend figure falls into, given a list of classes with min/maxSpend. Returns null if none match (keep current class). */
function classForSpend(totalSpent, classes) {
  const eligible = classes
    .filter(c => c.status === 'active')
    .filter(c => {
      const min = Number(c.minSpend) || 0;
      const max = c.maxSpend === '' || c.maxSpend == null ? Infinity : Number(c.maxSpend);
      return totalSpent >= min && totalSpent <= max;
    })
    .sort((a, b) => (Number(b.minSpend) || 0) - (Number(a.minSpend) || 0));
  return eligible[0] || null;
}

/** Firestore Timestamp | Date | string -> Date (or null). */
function toDate(d) {
  if (!d) return null;
  const dt = d.toDate ? d.toDate() : (d instanceof Date ? d : new Date(d));
  return isNaN(dt.getTime()) ? null : dt;
}

function tsMillis(d) {
  const dt = toDate(d);
  return dt ? dt.getTime() : 0;
}

/** Fills {placeholders} in a message template. Unknown placeholders are left as-is. */
function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));
}

/** Card code for a REISSUED card: member ID plus a random suffix. */
function generateCardToken(memberId) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return memberId + '-R' + a[0].toString(36).toUpperCase().slice(0, 5).padStart(5, '0');
}

function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  // Stop spreadsheet formula injection (=, @, or +/- that isn't a plain number/phone).
  if (/^[=+\-@\t\r]/.test(s) && !/^[+\-]?[\d\s().-]+$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Downloads a CSV (UTF-8 with BOM so Excel shows ₦ and accents correctly). */
function downloadCSV(filename, headers, rows) {
  const lines = [headers, ...rows].map(r => r.map(csvCell).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('');
}

function toast(message, kind = 'default') {
  const host = document.getElementById('toast-host');
  if (!host) { console.log('[toast]', message); return; }
  const el = document.createElement('div');
  el.className = 'toast toast--' + kind;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--in'));
  setTimeout(() => {
    el.classList.remove('toast--in');
    setTimeout(() => el.remove(), 250);
  }, 3600);
}

window.Utils = {
  calculatePoints, pointsToCash, formatNaira, formatPoints, formatMultiplier,
  formatDate, formatMemberId, generateTxnId, generateId, classForSpend,
  debounce, escapeHtml, initials, toast,
  toDate, tsMillis, renderTemplate, generateCardToken, downloadCSV
};