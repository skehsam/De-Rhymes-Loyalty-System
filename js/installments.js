// ============================================================
// installments.js — Installment Payment Management
//
// This file is additive: it extends the existing global `DB` and `Utils`
// objects (defined in db.js / utils.js) with an `Installments` namespace
// and a new `installments` / `installmentPayments` Firestore collection,
// then provides its own UI module (`window.Installments`) following the
// same pattern as members.js / transactions.js / redeem.js.
//
// It never touches the existing purchase, redemption, member, class or
// reporting logic — new activity (payments, points, notifications, audit
// entries) is written using the SAME collections those pages already read
// (transactions, notifications, auditLog), so it shows up there for free.
// ============================================================

const INSTALLMENT_FREQUENCIES = ['Weekly', 'Bi-weekly', 'Monthly', 'Custom'];
const INSTALLMENT_PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'POS', 'Card', 'Other'];

const DEFAULT_INSTALLMENT_SETTINGS = {
  notifUpcoming: true,
  notifDueToday: true,
  notifOverdue: true,
  notifReceived: true,
  notifCompleted: true,
  upcomingReminderDays: 3,
};

// ---------------------------------------------------------------
// Utils extensions (pure helpers — safe to share the same object)
// ---------------------------------------------------------------
Object.assign(window.Utils, {
  /** Rounds to 2dp so repeated additions/subtractions of money never drift. */
  roundMoney(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  },

  /** Next due date for a given frequency. `date` is a Date or ISO string. */
  addInterval(date, frequency, customDays) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    if (frequency === 'Weekly') d.setDate(d.getDate() + 7);
    else if (frequency === 'Bi-weekly') d.setDate(d.getDate() + 14);
    else if (frequency === 'Custom') d.setDate(d.getDate() + (parseInt(customDays, 10) || 30));
    else d.setMonth(d.getMonth() + 1); // Monthly (default)
    return d;
  },

  formatInstallmentId(seq, year) {
    return 'INS-' + year + '-' + String(seq).padStart(5, '0');
  },

  /**
   * The stored `status` only flips to Completed/Cancelled by explicit action.
   * "Overdue" is derived on read from nextPaymentDate vs today, rather than
   * needing a scheduled job to rewrite every installment doc every night.
   */
  installmentDisplayStatus(inst) {
    if (!inst) return '';
    if (inst.status !== 'Active') return inst.status;
    if (!inst.nextPaymentDate) return inst.status;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(inst.nextPaymentDate + 'T00:00:00');
    return due < today ? 'Overdue' : 'Active';
  },

  daysOverdue(inst) {
    if (!inst || !inst.nextPaymentDate) return 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(inst.nextPaymentDate + 'T00:00:00');
    return Math.max(0, Math.round((today - due) / 86400000));
  },

  progressBar(paid, total) {
    const pct = total > 0 ? Math.min(100, Math.max(0, (paid / total) * 100)) : 0;
    return `<div class="progress-track"><div class="progress-fill" style="width:${pct.toFixed(1)}%;"></div></div>`;
  },

  installmentStatusPill(status) {
    const cls = status === 'Completed' ? 'positive' : status === 'Overdue' ? 'negative' : status === 'Cancelled' ? 'muted' : 'gold';
    return `<span class="pill ${cls}">${Utils.escapeHtml(status)}</span>`;
  },
});

// ---------------------------------------------------------------
// DB.Installments — all Firestore reads/writes for this feature
// ---------------------------------------------------------------
DB.Installments = {

  // ---------- settings (notification toggles, reminder window) ----------
  async getSettings() {
    const snap = await db.collection('settings').doc('installments').get();
    if (!snap.exists) {
      await db.collection('settings').doc('installments').set(DEFAULT_INSTALLMENT_SETTINGS);
      return { ...DEFAULT_INSTALLMENT_SETTINGS };
    }
    return { ...DEFAULT_INSTALLMENT_SETTINGS, ...snap.data() };
  },

  async updateSettings(patch, actor) {
    const before = await this.getSettings();
    await db.collection('settings').doc('installments').set(patch, { merge: true });
    await DB.logAudit({
      action: 'Updated installment notification settings',
      previousValue: before, newValue: { ...before, ...patch }, actor,
    });
  },

  // ---------- IDs ----------
  async nextInstallmentId() {
    const year = new Date().getFullYear();
    const ref = db.collection('counters').doc('installmentId-' + year);
    return db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const last = snap.exists ? (snap.data().lastNumber || 0) : 0;
      const next = last + 1;
      t.set(ref, { lastNumber: next }, { merge: true });
      return Utils.formatInstallmentId(next, year);
    });
  },

  // ---------- Create ----------
  /**
   * Creates the installment record, then (if there's an initial payment)
   * runs it straight through addPayment() so balances, loyalty points,
   * notifications and completion logic are computed in exactly one place.
   */
  async createInstallment({
    memberId, productName, productCode, quantity, totalPrice, initialPayment,
    frequency, customDays, expectedPaymentAmount, startDate, expectedCompletionDate,
    notes, itemPhoto, staffUid, staffName,
  }) {
    totalPrice = Utils.roundMoney(totalPrice);
    initialPayment = Utils.roundMoney(initialPayment || 0);
    if (!memberId) throw new Error('Select a customer');
    if (!productName) throw new Error('Enter the item / product');
    if (!(totalPrice > 0)) throw new Error('Enter a valid total purchase price');
    if (initialPayment < 0) throw new Error('Initial payment cannot be negative');
    if (initialPayment > totalPrice) throw new Error('Initial payment cannot exceed the total purchase price');
    if (!INSTALLMENT_FREQUENCIES.includes(frequency)) throw new Error('Choose an installment frequency');
    if (frequency === 'Custom' && !(parseInt(customDays, 10) > 0)) throw new Error('Enter the custom interval in days');

    const member = await DB.getMember(memberId);
    if (!member) throw new Error('Customer not found');
    if (member.status === 'inactive') throw new Error(`${member.fullName}'s membership is inactive — reactivate it under Members first.`);

    const installmentId = await this.nextInstallmentId();
    const nextPaymentDate = Utils.addInterval(new Date(startDate || Date.now()), frequency, customDays);

    const doc = {
      installmentId,
      customerId: memberId, memberId, memberName: member.fullName,
      productName, productCode: productCode || '',
      quantity: Number(quantity) || 1,
      totalPrice, totalPaid: 0, outstandingBalance: totalPrice, percentagePaid: 0,
      frequency, customDays: frequency === 'Custom' ? (parseInt(customDays, 10) || 0) : null,
      expectedPaymentAmount: Utils.roundMoney(expectedPaymentAmount || 0),
      startDate: startDate || new Date().toISOString().slice(0, 10),
      nextPaymentDate: nextPaymentDate ? nextPaymentDate.toISOString().slice(0, 10) : null,
      expectedCompletionDate: expectedCompletionDate || null,
      status: 'Active',
      notes: notes || '',
      itemPhoto: itemPhoto || null, // optional data-URL snapshot of the item, resized/compressed client-side
      createdBy: staffName, createdByUid: staffUid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      completedAt: null, cancelledAt: null, reopenedAt: null,
    };
    await db.collection('installments').doc(installmentId).set(doc);
    await DB.logAudit({
      action: `Created installment ${installmentId} for ${member.fullName} (${productName})`,
      newValue: { totalPrice, initialPayment, frequency }, actor: staffName,
    });

    if (initialPayment > 0) {
      try {
        await this.addPayment({
          installmentId, amount: initialPayment, paymentMethod: 'Cash',
          transactionReference: '', collectedByUid: staffUid, collectedByName: staffName,
          paymentDate: doc.startDate, notes: 'Initial payment at purchase', isInitial: true,
        });
      } catch (err) { console.error('Initial payment not recorded', err); }
    } else {
      try { await this.queueInstallmentNotification({ memberId, type: 'Installment Created', vars: { item: productName } }); }
      catch (err) { console.error(err); }
    }
    return installmentId;
  },

  // ---------- Payments ----------
  /**
   * Records one payment. Never overwrites a previous payment: each call
   * writes a brand-new doc to installmentPayments and only ever ADDS to
   * totalPaid. Also credits loyalty points on the actual amount paid,
   * queues a notification, and flips the installment to Completed the
   * moment the outstanding balance reaches ₦0.
   */
  async addPayment({ installmentId, amount, paymentMethod, transactionReference, collectedByUid, collectedByName, paymentDate, notes, isInitial }) {
    amount = Utils.roundMoney(amount);
    if (!(amount > 0)) throw new Error('Enter a valid payment amount');
    if (!INSTALLMENT_PAYMENT_METHODS.includes(paymentMethod)) throw new Error('Select a payment method');
    if (!collectedByUid) throw new Error('Every payment must have a collector');
    paymentDate = paymentDate || new Date().toISOString().slice(0, 10);

    const paymentId = Utils.generateId('PAY');

    const result = await db.runTransaction(async (t) => {
      const instRef = db.collection('installments').doc(installmentId);
      const snap = await t.get(instRef);
      if (!snap.exists) throw new Error('Installment not found');
      const inst = snap.data();
      if (!isInitial && inst.status === 'Completed') {
        throw new Error('This installment is already completed. An administrator must reopen it before adding more payments.');
      }
      if (inst.status === 'Cancelled') throw new Error('This installment was cancelled.');
      if (amount > inst.outstandingBalance + 0.005) {
        throw new Error(`Payment of ${Utils.formatNaira(amount)} exceeds the outstanding balance of ${Utils.formatNaira(inst.outstandingBalance)}.`);
      }

      const previousBalance = inst.outstandingBalance;
      const newTotalPaid = Utils.roundMoney((inst.totalPaid || 0) + amount);
      const newOutstanding = Utils.roundMoney(Math.max(0, inst.totalPrice - newTotalPaid));
      const newPercentage = inst.totalPrice ? Utils.roundMoney((newTotalPaid / inst.totalPrice) * 100) : 0;
      const completed = newOutstanding <= 0;
      const nextPaymentDate = completed ? null : Utils.addInterval(new Date(paymentDate), inst.frequency, inst.customDays);

      t.update(instRef, {
        totalPaid: newTotalPaid, outstandingBalance: newOutstanding, percentagePaid: newPercentage,
        status: completed ? 'Completed' : 'Active',
        nextPaymentDate: nextPaymentDate ? nextPaymentDate.toISOString().slice(0, 10) : null,
        completedAt: completed ? firebase.firestore.FieldValue.serverTimestamp() : (inst.completedAt || null),
      });

      t.set(db.collection('installmentPayments').doc(paymentId), {
        paymentId, installmentId,
        customerId: inst.memberId, memberId: inst.memberId, memberName: inst.memberName,
        productName: inst.productName,
        amount, paymentMethod, transactionReference: transactionReference || '',
        collectedBy: collectedByName, collectedByUid,
        paymentDate, notes: notes || '',
        loyaltyPointsEarned: 0, loyaltyTxId: null,
        status: 'Completed', voidedAt: null, voidReason: null, authorizedBy: null, authorizedByUid: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      return {
        previousBalance, newOutstanding, newTotalPaid, newPercentage, completed,
        memberId: inst.memberId, memberName: inst.memberName, productName: inst.productName, totalPrice: inst.totalPrice,
      };
    });

    // Loyalty points from the amount actually paid (spec §8) — never for unpaid amounts.
    try {
      const credit = await this._creditLoyaltyForPayment({
        memberId: result.memberId, amount, installmentId, paymentId,
        staffUid: collectedByUid, staffName: collectedByName,
      });
      if (credit) {
        await db.collection('installmentPayments').doc(paymentId).update({
          loyaltyPointsEarned: credit.finalPoints, loyaltyTxId: credit.txId,
        });
      }
    } catch (err) { console.error('Loyalty credit for installment payment failed', err); }

    try {
      await DB.logAudit({
        action: `${isInitial ? 'Initial payment' : 'Payment'} of ${Utils.formatNaira(amount)} recorded on ${installmentId}`,
        previousValue: { outstandingBalance: result.previousBalance },
        newValue: { outstandingBalance: result.newOutstanding },
        actor: collectedByName,
      });
      await this.queueInstallmentNotification({
        memberId: result.memberId, type: 'Installment Payment',
        vars: {
          item: result.productName, amount: Utils.formatNaira(amount),
          totalPaid: Utils.formatNaira(result.newTotalPaid), balance: Utils.formatNaira(result.newOutstanding),
        },
      });
      if (result.completed) {
        await DB.logAudit({ action: `Installment ${installmentId} completed`, actor: 'System' });
        await this.queueInstallmentNotification({ memberId: result.memberId, type: 'Installment Completed', vars: { item: result.productName } });
      }
    } catch (err) { console.error(err); }

    return { paymentId, ...result };
  },

  /**
   * Void/correct a payment (spec §4/§17). The original document is kept —
   * only its status changes to Voided — and the installment balance plus
   * any loyalty points earned on it are reversed with their own audit trail.
   */
  async voidPayment({ paymentId, reason, authorizedByUid, authorizedByName }) {
    if (!reason || !reason.trim()) throw new Error('A reason is required to void a payment');
    const payRef = db.collection('installmentPayments').doc(paymentId);
    const paySnap = await payRef.get();
    if (!paySnap.exists) throw new Error('Payment not found');
    const payment = paySnap.data();
    if (payment.status === 'Voided') throw new Error('This payment has already been voided');

    const result = await db.runTransaction(async (t) => {
      const instRef = db.collection('installments').doc(payment.installmentId);
      const instSnap = await t.get(instRef);
      if (!instSnap.exists) throw new Error('Installment not found');
      const inst = instSnap.data();
      const wasCompleted = inst.status === 'Completed';
      const newTotalPaid = Utils.roundMoney(Math.max(0, (inst.totalPaid || 0) - payment.amount));
      const newOutstanding = Utils.roundMoney(Math.max(0, inst.totalPrice - newTotalPaid));
      const newPercentage = inst.totalPrice ? Utils.roundMoney((newTotalPaid / inst.totalPrice) * 100) : 0;
      const newStatus = inst.status === 'Cancelled' ? 'Cancelled' : (newOutstanding > 0 ? 'Active' : inst.status);
      const nextPaymentDate = newOutstanding > 0 ? Utils.addInterval(new Date(), inst.frequency, inst.customDays) : null;

      t.update(instRef, {
        totalPaid: newTotalPaid, outstandingBalance: newOutstanding, percentagePaid: newPercentage,
        status: newStatus,
        completedAt: newOutstanding > 0 ? null : inst.completedAt,
        nextPaymentDate: nextPaymentDate ? nextPaymentDate.toISOString().slice(0, 10) : null,
        reopenedAt: wasCompleted && newOutstanding > 0 ? firebase.firestore.FieldValue.serverTimestamp() : (inst.reopenedAt || null),
      });
      t.update(payRef, {
        status: 'Voided', voidedAt: firebase.firestore.FieldValue.serverTimestamp(),
        voidReason: reason.trim(), authorizedBy: authorizedByName, authorizedByUid,
      });

      return { memberId: inst.memberId, memberName: inst.memberName, productName: inst.productName, newOutstanding, newTotalPaid, wasCompleted };
    });

    if (payment.loyaltyPointsEarned) {
      try {
        await this._reverseLoyaltyForPayment({
          memberId: result.memberId, points: payment.loyaltyPointsEarned,
          installmentId: payment.installmentId, paymentId, reason: reason.trim(), actor: authorizedByName,
        });
      } catch (err) { console.error('Loyalty reversal failed', err); }
    }

    try {
      await DB.logAudit({
        action: `Voided payment ${paymentId} on ${payment.installmentId} (${Utils.formatNaira(payment.amount)})`,
        previousValue: { status: 'Completed' }, newValue: { status: 'Voided' },
        reason: reason.trim(), actor: authorizedByName,
      });
      await this.queueInstallmentNotification({
        memberId: result.memberId, type: 'Installment Payment Voided',
        vars: { item: result.productName, amount: Utils.formatNaira(payment.amount), balance: Utils.formatNaira(result.newOutstanding) },
      });
    } catch (err) { console.error(err); }

    return result;
  },

  async reopenInstallment({ installmentId, reason, actor }) {
    const ref = db.collection('installments').doc(installmentId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Installment not found');
    const inst = snap.data();
    if (inst.status !== 'Completed' && inst.status !== 'Cancelled') throw new Error('Only a completed or cancelled installment can be reopened');
    const nextPaymentDate = Utils.addInterval(new Date(), inst.frequency, inst.customDays);
    await ref.update({
      status: 'Active', completedAt: null, cancelledAt: null,
      nextPaymentDate: nextPaymentDate ? nextPaymentDate.toISOString().slice(0, 10) : null,
      reopenedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await DB.logAudit({ action: `Reopened installment ${installmentId}`, previousValue: { status: inst.status }, newValue: { status: 'Active' }, reason, actor });
  },

  /** Add or replace the optional item photo after an installment already exists. */
  async setItemPhoto(installmentId, photoDataUrl, actor) {
    const ref = db.collection('installments').doc(installmentId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Installment not found');
    await ref.update({ itemPhoto: photoDataUrl || null });
    await DB.logAudit({ action: `${photoDataUrl ? 'Updated' : 'Removed'} item photo on ${installmentId}`, actor });
  },

  async cancelInstallment({ installmentId, reason, actor }) {
    const ref = db.collection('installments').doc(installmentId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Installment not found');
    const inst = snap.data();
    if (inst.status === 'Completed') throw new Error('A completed installment cannot be cancelled');
    await ref.update({ status: 'Cancelled', nextPaymentDate: null, cancelledAt: firebase.firestore.FieldValue.serverTimestamp() });
    await DB.logAudit({ action: `Cancelled installment ${installmentId}`, previousValue: { status: inst.status }, newValue: { status: 'Cancelled' }, reason, actor });
  },

  // ---------- internal: loyalty integration ----------
  async _creditLoyaltyForPayment({ memberId, amount, installmentId, paymentId, staffUid, staffName }) {
    const settings = await DB.getSettings();
    const classes = await DB.listClasses();
    return db.runTransaction(async (t) => {
      const memberRef = db.collection('members').doc(memberId);
      const snap = await t.get(memberRef);
      if (!snap.exists) return null;
      const member = snap.data();
      const cls = classes.find(c => c.id === member.classId) || { id: null, name: 'Standard', multiplier: 1 };
      const { basePoints, finalPoints } = Utils.calculatePoints({
        purchaseAmount: amount, baseSpendAmount: settings.baseSpendAmount,
        basePointsAwarded: settings.basePointsAwarded, multiplier: cls.multiplier,
      });
      const previousBalance = member.points || 0;
      const newBalance = previousBalance + finalPoints;
      t.update(memberRef, { points: newBalance, totalSpent: (member.totalSpent || 0) + amount, lastActivityDate: firebase.firestore.FieldValue.serverTimestamp() });
      const txId = Utils.generateTxnId();
      t.set(db.collection('transactions').doc(txId), {
        transactionId: txId, type: 'Installment Payment',
        memberId, memberName: member.fullName,
        purchaseAmount: amount,
        classId: cls.id || null, className: cls.name, multiplier: cls.multiplier,
        basePoints, finalPoints, pointValueAtTime: settings.pointValue,
        previousBalance, newBalance,
        installmentId, paymentId,
        staffUid, staffName, status: 'Completed',
        date: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return { txId, finalPoints, newBalance };
    });
  },

  async _reverseLoyaltyForPayment({ memberId, points, installmentId, paymentId, reason, actor }) {
    if (!points) return null;
    return db.runTransaction(async (t) => {
      const memberRef = db.collection('members').doc(memberId);
      const snap = await t.get(memberRef);
      if (!snap.exists) return null;
      const member = snap.data();
      const previousBalance = member.points || 0;
      const newBalance = Math.max(0, previousBalance - points);
      t.update(memberRef, { points: newBalance });
      const txId = Utils.generateTxnId();
      t.set(db.collection('transactions').doc(txId), {
        transactionId: txId, type: 'Manual Adjustment', adjustmentType: 'Reverse Points',
        memberId, memberName: member.fullName,
        finalPoints: -(previousBalance - newBalance), requestedPoints: -points,
        reason: `Installment payment voided (${installmentId} / ${paymentId}): ${reason}`,
        previousBalance, newBalance, staffName: actor, status: 'Completed',
        date: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return { txId, newBalance };
    });
  },

  // ---------- notifications ----------
  async queueInstallmentNotification({ memberId, type, vars = {} }) {
    const settings = await this.getSettings();
    const gate = {
      'Installment Payment': settings.notifReceived,
      'Installment Upcoming': settings.notifUpcoming,
      'Installment Due': settings.notifDueToday,
      'Installment Overdue': settings.notifOverdue,
      'Installment Completed': settings.notifCompleted,
    };
    if (gate[type] === false) return;
    const templates = {
      'Installment Created': v => `Thank you for choosing De Rhymes! Your installment plan for ${v.item} has been set up. We'll remind you as payments come due.`,
      'Installment Payment': v => `Dear customer, your payment of ${v.amount} for your ${v.item} installment has been recorded. Total paid: ${v.totalPaid}. Remaining balance: ${v.balance}.`,
      'Installment Upcoming': v => `Reminder: your next payment of ${v.amount} for your ${v.item} installment is due on ${v.dueDate}. Current balance: ${v.balance}.`,
      'Installment Due': v => `Your payment of ${v.amount} for your ${v.item} installment is due today. Current balance: ${v.balance}.`,
      'Installment Overdue': v => `Your ${v.item} installment payment is now overdue by ${v.days} day(s). Outstanding balance: ${v.balance}. Please make a payment as soon as possible.`,
      'Installment Completed': v => `Congratulations! You have fully paid off your ${v.item} installment. Thank you for shopping with De Rhymes.`,
      'Installment Payment Voided': v => `A payment of ${v.amount} on your ${v.item} installment was corrected by our staff. Updated balance: ${v.balance}.`,
    };
    const build = templates[type];
    if (!build) return;
    await DB.queueNotification({ memberId, type, message: build(vars) });
  },

  /**
   * Manual trigger for upcoming/due-today/overdue reminders. True automatic
   * daily reminders need a scheduled Cloud Function (the same "needs a
   * server" caveat as WhatsApp/email sending itself — see README §5); this
   * button lets a manager fire that scan on demand from the dashboard.
   */
  async sendDueReminders(actor) {
    const settings = await this.getSettings();
    const installments = await this.listInstallments({ limit: 1000 });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let sent = 0;
    for (const inst of installments) {
      if (inst.status !== 'Active' || !inst.nextPaymentDate) continue;
      const due = new Date(inst.nextPaymentDate + 'T00:00:00');
      const diffDays = Math.round((due - today) / 86400000);
      try {
        if (diffDays === (settings.upcomingReminderDays || 0) && settings.notifUpcoming) {
          await this.queueInstallmentNotification({
            memberId: inst.memberId, type: 'Installment Upcoming',
            vars: { item: inst.productName, amount: Utils.formatNaira(inst.expectedPaymentAmount || inst.outstandingBalance), dueDate: inst.nextPaymentDate, balance: Utils.formatNaira(inst.outstandingBalance) },
          });
          sent++;
        } else if (diffDays === 0 && settings.notifDueToday) {
          await this.queueInstallmentNotification({
            memberId: inst.memberId, type: 'Installment Due',
            vars: { item: inst.productName, amount: Utils.formatNaira(inst.expectedPaymentAmount || inst.outstandingBalance), balance: Utils.formatNaira(inst.outstandingBalance) },
          });
          sent++;
        } else if (diffDays < 0 && settings.notifOverdue) {
          await this.queueInstallmentNotification({
            memberId: inst.memberId, type: 'Installment Overdue',
            vars: { item: inst.productName, days: Math.abs(diffDays), balance: Utils.formatNaira(inst.outstandingBalance) },
          });
          sent++;
        }
      } catch (err) { console.error('Reminder failed for', inst.installmentId, err); }
    }
    await DB.logAudit({ action: `Sent ${sent} installment reminder notification(s)`, actor });
    return sent;
  },

  // ---------- reads ----------
  async getInstallment(id) {
    const s = await db.collection('installments').doc(id).get();
    return s.exists ? s.data() : null;
  },

  async listInstallments({ limit = 500 } = {}) {
    const snap = await db.collection('installments').orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  },

  async listByCustomer(memberId) {
    const snap = await db.collection('installments').where('memberId', '==', memberId).get();
    return snap.docs.map(d => d.data()).sort((a, b) => Utils.tsMillis(b.createdAt) - Utils.tsMillis(a.createdAt));
  },

  async searchInstallments(term) {
    const t = (term || '').trim().toLowerCase();
    const all = await this.listInstallments({ limit: 1000 });
    if (!t) return all;
    return all.filter(i => [i.installmentId, i.memberName, i.memberId, i.productName, i.productCode, i.createdBy]
      .some(v => (v || '').toLowerCase().includes(t)));
  },

  async getPayments(installmentId) {
    const snap = await db.collection('installmentPayments').where('installmentId', '==', installmentId).get();
    return snap.docs.map(d => d.data()).sort((a, b) => Utils.tsMillis(b.createdAt) - Utils.tsMillis(a.createdAt));
  },

  async listAllPayments({ limit = 500 } = {}) {
    const snap = await db.collection('installmentPayments').orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  },

  async customerSummary(memberId) {
    const list = await this.listByCustomer(memberId);
    const active = list.filter(i => i.status === 'Active');
    const completed = list.filter(i => i.status === 'Completed');
    return {
      installments: list,
      activeCount: active.length,
      completedCount: completed.length,
      totalPurchased: list.reduce((s, i) => s + (i.totalPrice || 0), 0),
      totalPaid: list.reduce((s, i) => s + (i.totalPaid || 0), 0),
      totalOutstanding: list.reduce((s, i) => s + (i.outstandingBalance || 0), 0),
    };
  },

  async dashboardStats() {
    const [installments, payments] = await Promise.all([
      this.listInstallments({ limit: 1000 }),
      this.listAllPayments({ limit: 500 }),
    ]);
    const withDisplay = installments.map(i => ({ ...i, displayStatus: Utils.installmentDisplayStatus(i) }));
    const active = withDisplay.filter(i => i.displayStatus === 'Active');
    const overdue = withDisplay.filter(i => i.displayStatus === 'Overdue');
    const completed = withDisplay.filter(i => i.status === 'Completed');
    const totalSales = installments.reduce((s, i) => s + (i.totalPrice || 0), 0);
    const totalCollected = installments.reduce((s, i) => s + (i.totalPaid || 0), 0);
    const totalOutstanding = installments.reduce((s, i) => s + (i.outstandingBalance || 0), 0);
    const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    const validPayments = payments.filter(p => p.status !== 'Voided');
    const paymentsThisMonth = validPayments.filter(p => { const d = Utils.toDate(p.createdAt); return d && d >= startOfMonth; }).length;
    const upcoming = active.filter(i => i.nextPaymentDate).sort((a, b) => new Date(a.nextPaymentDate) - new Date(b.nextPaymentDate)).slice(0, 10);
    const overdueList = overdue.sort((a, b) => new Date(a.nextPaymentDate) - new Date(b.nextPaymentDate)).slice(0, 10);
    const recentPayments = validPayments.slice(0, 10);
    return { installments: withDisplay, active, overdue, completed, totalSales, totalCollected, totalOutstanding, paymentsThisMonth, upcoming, overdueList, recentPayments };
  },

  async staffCollectionReport({ from, to, staffName, method } = {}) {
    const payments = (await this.listAllPayments({ limit: 2000 })).filter(p => p.status !== 'Voided');
    const filtered = payments.filter(p => {
      const d = Utils.toDate(p.createdAt);
      if (from && (!d || d < from)) return false;
      if (to && (!d || d > to)) return false;
      if (staffName && p.collectedBy !== staffName) return false;
      if (method && p.paymentMethod !== method) return false;
      return true;
    });
    const byStaff = {};
    filtered.forEach(p => { const s = byStaff[p.collectedBy || 'Unknown'] = byStaff[p.collectedBy || 'Unknown'] || { n: 0, amount: 0 }; s.n++; s.amount += p.amount || 0; });
    return { rows: Object.entries(byStaff).map(([name, s]) => ({ name, count: s.n, amount: s.amount })), filtered };
  },
};

// ---------------------------------------------------------------
// UI module
// ---------------------------------------------------------------
const Installments = {
  formCustomer: null,
  formPhoto: null, // data-URL of the (optional) item photo, resized/compressed before it's ever set
  currentInstallment: null,
  currentPayments: [],
  shownList: [], shownPayments: [], allPayments: [], reportSets: {},

  async init() {
    document.getElementById('ins-dash-add')?.addEventListener('click', () => this.openForm());
    document.getElementById('ins-list-add')?.addEventListener('click', () => this.openForm());
    document.getElementById('installment-form').addEventListener('submit', (e) => this.save(e));
    document.getElementById('if-customer-search').addEventListener('input', Utils.debounce((e) => this.searchCustomer(e.target.value), 250));
    document.getElementById('if-frequency').addEventListener('change', () => this.toggleCustomDays());
    ['if-totalPrice', 'if-initialPayment', 'if-quantity'].forEach(id => document.getElementById(id).addEventListener('input', () => this.updateFormPreview()));
    document.getElementById('if-photo-btn').addEventListener('click', () => document.getElementById('if-photo-input').click());
    document.getElementById('if-photo-input').addEventListener('change', (e) => this.handlePhotoSelect(e));
    document.getElementById('if-photo-remove').addEventListener('click', () => this.clearPhoto());

    document.getElementById('ins-search').addEventListener('input', Utils.debounce(() => this.renderList(), 250));
    document.getElementById('ins-filter-status').addEventListener('change', () => this.renderList());
    document.getElementById('ins-export').addEventListener('click', () => this.exportListCsv());
    document.getElementById('ins-back').addEventListener('click', () => App.go('installments'));

    ['insp-filter-method', 'insp-filter-staff', 'insp-filter-from', 'insp-filter-to'].forEach(id =>
      document.getElementById(id).addEventListener('change', () => this.renderPaymentsLog()));
    document.getElementById('insp-search').addEventListener('input', Utils.debounce(() => this.renderPaymentsLog(), 250));
    document.getElementById('insp-export').addEventListener('click', () => this.exportPaymentsCsv());

    document.getElementById('insr-range').addEventListener('change', () => this.loadReports());

    document.getElementById('installment-payment-form').addEventListener('submit', (e) => this.confirmPayment(e));
    document.getElementById('void-payment-form').addEventListener('submit', (e) => this.confirmVoid(e));

    await this.wireInstallmentSettings();
  },

  async wireInstallmentSettings() {
    if (!Auth.can('manageInstallmentSettings')) return;
    const s = await DB.Installments.getSettings();
    document.getElementById('set-ins-upcoming').checked = !!s.notifUpcoming;
    document.getElementById('set-ins-due').checked = !!s.notifDueToday;
    document.getElementById('set-ins-overdue').checked = !!s.notifOverdue;
    document.getElementById('set-ins-received').checked = !!s.notifReceived;
    document.getElementById('set-ins-completed').checked = !!s.notifCompleted;
    document.getElementById('set-ins-remind-days').value = s.upcomingReminderDays;
    document.getElementById('btn-save-installment-settings').onclick = async () => {
      try {
        await DB.Installments.updateSettings({
          notifUpcoming: document.getElementById('set-ins-upcoming').checked,
          notifDueToday: document.getElementById('set-ins-due').checked,
          notifOverdue: document.getElementById('set-ins-overdue').checked,
          notifReceived: document.getElementById('set-ins-received').checked,
          notifCompleted: document.getElementById('set-ins-completed').checked,
          upcomingReminderDays: parseInt(document.getElementById('set-ins-remind-days').value, 10) || 0,
        }, Auth.currentUser.email);
        Utils.toast('Installment notification settings saved', 'success');
      } catch (err) { Utils.toast(err.message, 'error'); }
    };
  },

  // ---------- Add installment form ----------
  toggleCustomDays() {
    document.getElementById('if-custom-days-wrap').style.display =
      document.getElementById('if-frequency').value === 'Custom' ? '' : 'none';
  },

  openForm(prefillMemberId) {
    document.getElementById('installment-form').reset();
    document.getElementById('if-memberId').value = '';
    document.getElementById('if-customer-results').innerHTML = '';
    document.getElementById('if-customer-selected').textContent = '';
    this.formCustomer = null;
    document.getElementById('if-startDate').value = new Date().toISOString().slice(0, 10);
    this.toggleCustomDays();
    document.getElementById('if-preview').textContent = '';
    this.formPhoto = null;
    this.renderPhotoPreview();
    if (prefillMemberId) this.selectCustomer(prefillMemberId);
    document.getElementById('modal-installment-form').classList.add('open');
  },

  /**
   * Shrinks and JPEG-compresses whatever the camera/file picker returned so a
   * photo stays a small embedded data-URL (Firestore documents cap at 1MB).
   * Falls back to a smaller pass if the first result is still large.
   */
  async resizeImage(file, maxDim = 900, quality = 0.7) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
            else { width = Math.round(width * (maxDim / height)); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('Could not read that image'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Could not read that file'));
      reader.readAsDataURL(file);
    });
    return dataUrl;
  },

  async handlePhotoSelect(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // so picking the same file again still fires 'change'
    if (!file) return;
    if (!file.type.startsWith('image/')) return Utils.toast('Please choose an image file', 'error');
    try {
      let dataUrl = await this.resizeImage(file, 900, 0.7);
      if (dataUrl.length > 700000) dataUrl = await this.resizeImage(file, 600, 0.5); // still large — compress harder
      this.formPhoto = dataUrl;
      this.renderPhotoPreview();
    } catch (err) {
      Utils.toast(err.message || 'Could not read that image', 'error');
    }
  },

  clearPhoto() {
    this.formPhoto = null;
    this.renderPhotoPreview();
  },

  renderPhotoPreview() {
    const host = document.getElementById('if-photo-preview');
    const removeBtn = document.getElementById('if-photo-remove');
    if (this.formPhoto) {
      host.innerHTML = `<img class="item-photo-thumb" src="${this.formPhoto}" alt="Item photo">`;
      removeBtn.style.display = '';
    } else {
      host.innerHTML = '';
      removeBtn.style.display = 'none';
    }
  },

  async searchCustomer(term) {
    const host = document.getElementById('if-customer-results');
    if (!term.trim()) { host.innerHTML = ''; return; }
    const results = await DB.searchMembers(term);
    if (!results.length) { host.innerHTML = `<p class="hint">No matches.</p>`; return; }
    host.innerHTML = `<div style="max-height:160px; overflow-y:auto; margin-top:6px;">${results.slice(0, 6).map(m => `
      <div class="row-link" data-id="${m.memberId}" style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line-soft);">
        <span>${Utils.escapeHtml(m.fullName)} <span class="hint">${m.memberId}</span></span>
        <span class="hint">${Utils.escapeHtml(m.phone || '')}</span>
      </div>`).join('')}</div>`;
    host.querySelectorAll('[data-id]').forEach(row => row.onclick = () => this.selectCustomer(row.dataset.id));
  },

  async selectCustomer(memberId) {
    const m = await DB.getMember(memberId);
    if (!m) return Utils.toast('Member not found', 'error');
    this.formCustomer = m;
    document.getElementById('if-memberId').value = m.memberId;
    document.getElementById('if-customer-results').innerHTML = '';
    document.getElementById('if-customer-search').value = '';
    document.getElementById('if-customer-selected').textContent = `Selected: ${m.fullName} (${m.memberId})`;
  },

  updateFormPreview() {
    const total = parseFloat(document.getElementById('if-totalPrice').value) || 0;
    const initial = parseFloat(document.getElementById('if-initialPayment').value) || 0;
    const balance = Math.max(0, total - initial);
    const pct = total ? Math.min(100, (initial / total) * 100) : 0;
    document.getElementById('if-preview').textContent = total
      ? `Outstanding balance at purchase: ${Utils.formatNaira(balance)} · ${pct.toFixed(1)}% paid` : '';
  },

  async save(e) {
    e.preventDefault();
    if (this.saving) return;
    const memberId = document.getElementById('if-memberId').value;
    if (!memberId) return Utils.toast('Search and select a customer', 'error');
    const totalPrice = parseFloat(document.getElementById('if-totalPrice').value);
    const initialPayment = parseFloat(document.getElementById('if-initialPayment').value) || 0;
    if (initialPayment > totalPrice) return Utils.toast('Initial payment cannot exceed the total price', 'error');
    const frequency = document.getElementById('if-frequency').value;
    const customDays = document.getElementById('if-customDays').value;

    const btn = document.querySelector('#installment-form button[type="submit"]');
    this.saving = true; btn.disabled = true;
    try {
      const id = await DB.Installments.createInstallment({
        memberId,
        productName: document.getElementById('if-product').value.trim(),
        productCode: document.getElementById('if-productCode').value.trim(),
        quantity: document.getElementById('if-quantity').value,
        totalPrice, initialPayment, frequency, customDays,
        expectedPaymentAmount: document.getElementById('if-expectedPaymentAmount').value,
        startDate: document.getElementById('if-startDate').value,
        expectedCompletionDate: document.getElementById('if-expectedCompletionDate').value,
        notes: document.getElementById('if-notes').value.trim(),
        itemPhoto: this.formPhoto,
        staffUid: Auth.currentUser.uid, staffName: Auth.profile.name,
      });
      Utils.toast(`Installment ${id} created`, 'success');
      document.getElementById('modal-installment-form').classList.remove('open');
      if (App.currentView === 'installments') this.renderList();
      if (App.currentView === 'installments-dashboard') this.loadDashboard();
      if (App.currentView === 'member-profile' && Members.currentProfileId === memberId) Members.selectTab('installments');
    } catch (err) {
      Utils.toast(err.message, 'error');
    } finally {
      this.saving = false; btn.disabled = false;
    }
  },

  // ---------- Dashboard ----------
  async loadDashboard() {
    const s = await DB.Installments.dashboardStats();
    document.getElementById('ins-dash-stats').innerHTML = `
      <div class="stat"><div class="stat-label">Active installments</div><div class="stat-value">${s.active.length}</div></div>
      <div class="stat"><div class="stat-label">Completed</div><div class="stat-value">${s.completed.length}</div></div>
      <div class="stat gold"><div class="stat-label">Overdue</div><div class="stat-value">${s.overdue.length}</div></div>
      <div class="stat"><div class="stat-label">Total installment sales</div><div class="stat-value" style="font-size:19px;">${Utils.formatNaira(s.totalSales)}</div></div>
      <div class="stat gold"><div class="stat-label">Total collected</div><div class="stat-value" style="font-size:19px;">${Utils.formatNaira(s.totalCollected)}</div></div>
      <div class="stat"><div class="stat-label">Outstanding balance</div><div class="stat-value" style="font-size:19px;">${Utils.formatNaira(s.totalOutstanding)}</div></div>
      <div class="stat"><div class="stat-label">Payments this month</div><div class="stat-value">${s.paymentsThisMonth}</div></div>`;

    document.getElementById('ins-dash-recent').innerHTML = s.recentPayments.length ? s.recentPayments.map(p => `
      <div style="padding:8px 0; border-bottom:1px solid var(--line-soft); font-size:13.5px;">
        <div style="display:flex; justify-content:space-between;"><span>${Utils.escapeHtml(p.memberName)} — ${Utils.escapeHtml(p.productName || '')}</span><span class="num">${Utils.formatNaira(p.amount)}</span></div>
        <div class="hint">${Utils.escapeHtml(p.paymentMethod)} · collected by ${Utils.escapeHtml(p.collectedBy || '')} · ${Utils.formatDate(p.createdAt)}</div>
      </div>`).join('') : `<div class="empty-state">No payments yet.</div>`;

    document.getElementById('ins-dash-upcoming').innerHTML = s.upcoming.length ? `<table class="ledger"><thead><tr><th>Customer</th><th>Item</th><th class="num">Expected</th><th>Due date</th><th class="num">Balance</th></tr></thead><tbody>${
      s.upcoming.map(i => `<tr class="row-link" data-open="${i.installmentId}"><td>${Utils.escapeHtml(i.memberName)}</td><td>${Utils.escapeHtml(i.productName)}</td><td class="num">${Utils.formatNaira(i.expectedPaymentAmount || i.outstandingBalance)}</td><td>${i.nextPaymentDate}</td><td class="num">${Utils.formatNaira(i.outstandingBalance)}</td></tr>`).join('')
    }</tbody></table>` : `<div class="empty-state">Nothing due soon.</div>`;

    document.getElementById('ins-dash-overdue').innerHTML = s.overdueList.length ? `<table class="ledger"><thead><tr><th>Customer</th><th>Item</th><th class="num">Expected</th><th>Due date</th><th class="num">Days overdue</th><th class="num">Balance</th></tr></thead><tbody>${
      s.overdueList.map(i => `<tr class="row-link" data-open="${i.installmentId}"><td>${Utils.escapeHtml(i.memberName)}</td><td>${Utils.escapeHtml(i.productName)}</td><td class="num">${Utils.formatNaira(i.expectedPaymentAmount || i.outstandingBalance)}</td><td>${i.nextPaymentDate}</td><td class="num">${Utils.daysOverdue(i)}</td><td class="num">${Utils.formatNaira(i.outstandingBalance)}</td></tr>`).join('')
    }</tbody></table>` : `<div class="empty-state">No overdue installments.</div>`;

    document.querySelectorAll('#ins-dash-upcoming [data-open], #ins-dash-overdue [data-open]').forEach(row => row.onclick = () => this.openProfile(row.dataset.open));
  },

  // ---------- List ----------
  async loadList() { await this.renderList(); },

  async renderList() {
    const term = document.getElementById('ins-search').value;
    const statusFilter = document.getElementById('ins-filter-status').value;
    let rows = (await DB.Installments.searchInstallments(term)).map(i => ({ ...i, displayStatus: Utils.installmentDisplayStatus(i) }));
    if (statusFilter) rows = rows.filter(i => i.displayStatus === statusFilter);
    this.shownList = rows;
    const tbody = document.getElementById('ins-tbody');
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No installments match.</div></td></tr>`; return; }
    tbody.innerHTML = rows.map(i => `
      <tr class="row-link" data-id="${i.installmentId}">
        <td class="num">${i.installmentId}</td>
        <td>${Utils.escapeHtml(i.memberName)}</td>
        <td>${Utils.escapeHtml(i.productName)}</td>
        <td class="num">${Utils.formatNaira(i.totalPrice)}</td>
        <td style="min-width:130px;">${Utils.progressBar(i.totalPaid, i.totalPrice)}<span class="hint">${(i.percentagePaid || 0).toFixed(0)}%</span></td>
        <td class="num">${Utils.formatNaira(i.outstandingBalance)}</td>
        <td>${i.nextPaymentDate || '—'}</td>
        <td>${Utils.installmentStatusPill(i.displayStatus)}</td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-id]').forEach(row => row.onclick = () => this.openProfile(row.dataset.id));
  },

  exportListCsv() {
    const rows = (this.shownList || []).map(i => [i.installmentId, i.memberName, i.memberId, i.productName, i.productCode || '', i.totalPrice, i.totalPaid, i.outstandingBalance, (i.percentagePaid || 0).toFixed(1), i.startDate, i.nextPaymentDate || '', i.expectedCompletionDate || '', i.displayStatus, i.createdBy || '']);
    Utils.downloadCSV(`installments-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Installment ID', 'Customer', 'Member ID', 'Item', 'Code', 'Total price', 'Total paid', 'Balance', '% paid', 'Start date', 'Next payment', 'Expected completion', 'Status', 'Created by'], rows);
  },

  // ---------- Profile ----------
  async openProfile(installmentId) {
    const inst = await DB.Installments.getInstallment(installmentId);
    if (!inst) return Utils.toast('Installment not found', 'error');
    this.currentInstallment = inst;
    this.currentPayments = await DB.Installments.getPayments(installmentId);
    const displayStatus = Utils.installmentDisplayStatus(inst);

    document.getElementById('ip-title').textContent = `${inst.productName} — ${inst.installmentId}`;
    document.getElementById('ip-sub').textContent = `${inst.memberName} (${inst.memberId}) · started ${inst.startDate}`;

    const actions = document.getElementById('ip-actions');
    let actionsHtml = `<input type="file" id="ip-photo-input" accept="image/*" capture="environment" style="display:none;">`;
    if (Auth.can('recordInstallments')) actionsHtml += `<button class="btn" id="ip-photo-btn">📷 ${inst.itemPhoto ? 'Change' : 'Add'} photo</button>`;
    if (Auth.can('recordInstallments') && inst.status === 'Active') actionsHtml += `<button class="btn btn-primary" id="ip-add-payment">Record payment</button>`;
    if (Auth.can('reopenInstallments') && (inst.status === 'Completed' || inst.status === 'Cancelled')) actionsHtml += `<button class="btn" id="ip-reopen">Reopen</button>`;
    if (Auth.can('recordInstallments') && inst.status === 'Active') actionsHtml += `<button class="btn btn-danger" id="ip-cancel">Cancel installment</button>`;
    actions.innerHTML = actionsHtml;

    document.getElementById('ip-body').innerHTML = `
      ${inst.itemPhoto ? `<div class="panel" style="margin-bottom:16px;"><img class="item-photo-full" src="${inst.itemPhoto}" alt="${Utils.escapeHtml(inst.productName)}"></div>` : ''}
      <div class="grid grid-3">
        <div class="stat"><div class="stat-label">Total price</div><div class="stat-value">${Utils.formatNaira(inst.totalPrice)}</div><div class="stat-sub">Qty ${inst.quantity || 1}${inst.productCode ? ' · ' + Utils.escapeHtml(inst.productCode) : ''}</div></div>
        <div class="stat gold"><div class="stat-label">Total paid</div><div class="stat-value">${Utils.formatNaira(inst.totalPaid)}</div><div class="stat-sub">${(inst.percentagePaid || 0).toFixed(1)}% paid</div></div>
        <div class="stat"><div class="stat-label">Outstanding balance</div><div class="stat-value">${Utils.formatNaira(inst.outstandingBalance)}</div><div class="stat-sub">${Utils.installmentStatusPill(displayStatus)}</div></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        ${Utils.progressBar(inst.totalPaid, inst.totalPrice)}
        <p class="hint" style="margin-top:8px;">${Utils.formatNaira(inst.totalPaid)} / ${Utils.formatNaira(inst.totalPrice)} · Next payment ${inst.nextPaymentDate || '—'} · Expected completion ${inst.expectedCompletionDate || '—'} · Frequency ${inst.frequency}${inst.frequency === 'Custom' ? ' (' + inst.customDays + ' days)' : ''} · Created by ${Utils.escapeHtml(inst.createdBy || '—')}</p>
        ${inst.notes ? `<p class="hint" style="margin-top:6px;">Notes: ${Utils.escapeHtml(inst.notes)}</p>` : ''}
      </div>
      <div class="panel" style="padding:0; overflow-x:auto; margin-top:16px;">
        <p class="panel-title" style="padding:16px 22px 0; border:0;">Payment history</p>
        <table class="ledger"><thead><tr><th>Payment</th><th class="num">Amount</th><th>Method</th><th>Reference</th><th>Collected by</th><th>Date</th><th>Status</th><th></th></tr></thead>
        <tbody id="ip-payments-tbody"></tbody></table>
      </div>`;

    this.renderPaymentsTable();
    document.getElementById('ip-add-payment')?.addEventListener('click', () => this.openPaymentForm());
    document.getElementById('ip-reopen')?.addEventListener('click', () => this.reopen());
    document.getElementById('ip-cancel')?.addEventListener('click', () => this.cancel());
    document.getElementById('ip-photo-btn')?.addEventListener('click', () => document.getElementById('ip-photo-input').click());
    document.getElementById('ip-photo-input')?.addEventListener('change', (e) => this.handleProfilePhotoSelect(e));
    App.go('installment-profile');
  },

  renderPaymentsTable() {
    const tbody = document.getElementById('ip-payments-tbody');
    if (!tbody) return;
    if (!this.currentPayments.length) { tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No payments recorded yet.</div></td></tr>`; return; }
    tbody.innerHTML = this.currentPayments.map(p => `
      <tr>
        <td class="num">${p.paymentId}</td>
        <td class="num">${Utils.formatNaira(p.amount)}</td>
        <td>${Utils.escapeHtml(p.paymentMethod)}</td>
        <td>${Utils.escapeHtml(p.transactionReference || '—')}</td>
        <td>${Utils.escapeHtml(p.collectedBy || '—')}</td>
        <td>${Utils.formatDate(p.createdAt)}</td>
        <td>${p.status === 'Voided' ? `<span class="pill negative" title="${Utils.escapeHtml(p.voidReason || '')}">Voided</span>` : '<span class="pill positive">Completed</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" data-receipt="${p.paymentId}">Receipt</button>
          ${p.status !== 'Voided' && Auth.can('correctInstallmentPayments') ? `<button class="btn btn-sm btn-danger" data-void="${p.paymentId}">Void</button>` : ''}
        </td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-receipt]').forEach(b => b.onclick = () => this.openReceipt(b.dataset.receipt));
    tbody.querySelectorAll('[data-void]').forEach(b => b.onclick = () => this.openVoidForm(b.dataset.void));
  },

  // ---------- Record payment ----------
  openPaymentForm() {
    const inst = this.currentInstallment;
    document.getElementById('installment-payment-form').reset();
    document.getElementById('ipf-context').textContent = `${inst.memberName} · ${inst.productName} · balance ${Utils.formatNaira(inst.outstandingBalance)}`;
    document.getElementById('ipf-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('ipf-amount').max = inst.outstandingBalance;
    document.getElementById('ipf-preview').textContent = '';
    document.getElementById('ipf-amount').oninput = (e) => {
      const amt = parseFloat(e.target.value) || 0;
      document.getElementById('ipf-preview').textContent = `New balance would be ${Utils.formatNaira(Math.max(0, inst.outstandingBalance - amt))}`;
    };
    document.getElementById('modal-installment-payment').classList.add('open');
  },

  async confirmPayment(e) {
    e.preventDefault();
    if (this.savingPayment) return;
    const inst = this.currentInstallment;
    const amount = parseFloat(document.getElementById('ipf-amount').value);
    if (!(amount > 0)) return Utils.toast('Enter a valid payment amount', 'error');
    if (amount > inst.outstandingBalance + 0.005) return Utils.toast('Payment cannot exceed the outstanding balance', 'error');
    const btn = document.querySelector('#installment-payment-form button[type="submit"]');
    this.savingPayment = true; btn.disabled = true;
    try {
      await DB.Installments.addPayment({
        installmentId: inst.installmentId, amount,
        paymentMethod: document.getElementById('ipf-method').value,
        transactionReference: document.getElementById('ipf-reference').value.trim(),
        collectedByUid: Auth.currentUser.uid, collectedByName: Auth.profile.name,
        paymentDate: document.getElementById('ipf-date').value,
        notes: document.getElementById('ipf-notes').value.trim(),
      });
      Utils.toast('Payment recorded', 'success');
      document.getElementById('modal-installment-payment').classList.remove('open');
      await this.openProfile(inst.installmentId);
    } catch (err) {
      Utils.toast(err.message, 'error');
    } finally { this.savingPayment = false; btn.disabled = false; }
  },

  // ---------- Void / reopen / cancel ----------
  openVoidForm(paymentId) {
    const p = this.currentPayments.find(x => x.paymentId === paymentId);
    if (!p) return;
    this.voidingPaymentId = paymentId;
    document.getElementById('void-payment-form').reset();
    document.getElementById('vpf-context').textContent = `${Utils.formatNaira(p.amount)} paid by ${p.paymentMethod} on ${Utils.formatDate(p.createdAt)}, collected by ${p.collectedBy}`;
    document.getElementById('modal-void-payment').classList.add('open');
  },

  async confirmVoid(e) {
    e.preventDefault();
    const reason = document.getElementById('vpf-reason').value.trim();
    if (!reason) return Utils.toast('A reason is required', 'error');
    if (!confirm('Void this payment? This cannot be undone, though the record stays in the audit trail.')) return;
    const btn = document.querySelector('#void-payment-form button[type="submit"]');
    btn.disabled = true;
    try {
      await DB.Installments.voidPayment({ paymentId: this.voidingPaymentId, reason, authorizedByUid: Auth.currentUser.uid, authorizedByName: Auth.profile.name });
      Utils.toast('Payment voided', 'success');
      document.getElementById('modal-void-payment').classList.remove('open');
      await this.openProfile(this.currentInstallment.installmentId);
    } catch (err) {
      Utils.toast(err.message, 'error');
    } finally { btn.disabled = false; }
  },

  async handleProfilePhotoSelect(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return Utils.toast('Please choose an image file', 'error');
    try {
      let dataUrl = await this.resizeImage(file, 900, 0.7);
      if (dataUrl.length > 700000) dataUrl = await this.resizeImage(file, 600, 0.5);
      await DB.Installments.setItemPhoto(this.currentInstallment.installmentId, dataUrl, Auth.currentUser.email);
      Utils.toast('Photo saved', 'success');
      await this.openProfile(this.currentInstallment.installmentId);
    } catch (err) {
      Utils.toast(err.message || 'Could not save that photo', 'error');
    }
  },

  async reopen() {
    const reason = prompt('Reason for reopening this installment:');
    if (reason === null) return;
    try {
      await DB.Installments.reopenInstallment({ installmentId: this.currentInstallment.installmentId, reason: (reason || '').trim(), actor: Auth.currentUser.email });
      Utils.toast('Installment reopened', 'success');
      await this.openProfile(this.currentInstallment.installmentId);
    } catch (err) { Utils.toast(err.message, 'error'); }
  },

  async cancel() {
    const reason = prompt('Reason for cancelling this installment:');
    if (reason === null) return;
    if (!reason.trim()) return Utils.toast('A reason is required', 'error');
    if (!confirm('Cancel this installment plan?')) return;
    try {
      await DB.Installments.cancelInstallment({ installmentId: this.currentInstallment.installmentId, reason: reason.trim(), actor: Auth.currentUser.email });
      Utils.toast('Installment cancelled', 'success');
      await this.openProfile(this.currentInstallment.installmentId);
    } catch (err) { Utils.toast(err.message, 'error'); }
  },

  // ---------- Receipt (reuses the existing print modal/#print-area) ----------
  openReceipt(paymentId) {
    const p = this.currentPayments.find(x => x.paymentId === paymentId);
    const inst = this.currentInstallment;
    if (!p || !inst) return;
    const previousBalance = Utils.roundMoney(inst.outstandingBalance + (p.status === 'Voided' ? 0 : p.amount));
    document.getElementById('print-area').innerHTML = `
      <div style="width:100%; max-width:380px; margin:0 auto;">
        <div style="text-align:center; margin-bottom:14px;">
          <div class="serif" style="font-size:20px; font-weight:600; color:var(--forest-dark);">DE RHYMES</div>
          <div class="hint">Installment Payment Receipt</div>
        </div>
        <div class="calc-line"><span>Receipt No.</span><span class="v">${p.paymentId}</span></div>
        <div class="calc-line"><span>Customer</span><span class="v">${Utils.escapeHtml(inst.memberName)}</span></div>
        <div class="calc-line"><span>Customer ID</span><span class="v">${inst.memberId}</span></div>
        <div class="calc-line"><span>Installment ID</span><span class="v">${inst.installmentId}</span></div>
        <div class="calc-line"><span>Item</span><span class="v">${Utils.escapeHtml(inst.productName)}</span></div>
        <div class="calc-line"><span>Total price</span><span class="v">${Utils.formatNaira(inst.totalPrice)}</span></div>
        <div class="calc-line"><span>Previous balance</span><span class="v">${Utils.formatNaira(previousBalance)}</span></div>
        <div class="calc-line total"><span>Payment made</span><span class="v">${p.status === 'Voided' ? 'VOIDED — ' : ''}${Utils.formatNaira(p.amount)}</span></div>
        <div class="calc-line total"><span>New balance</span><span class="v">${Utils.formatNaira(inst.outstandingBalance)}</span></div>
        <div class="calc-line"><span>Method</span><span class="v">${Utils.escapeHtml(p.paymentMethod)}</span></div>
        <div class="calc-line"><span>Reference</span><span class="v">${Utils.escapeHtml(p.transactionReference || '—')}</span></div>
        <div class="calc-line"><span>Collected by</span><span class="v">${Utils.escapeHtml(p.collectedBy || '—')}</span></div>
        <div class="calc-line"><span>Date &amp; time</span><span class="v">${Utils.formatDate(p.createdAt)}</span></div>
      </div>`;
    document.getElementById('modal-print-card').classList.add('open');
  },

  // ---------- Customer profile tab (called from members.js) ----------
  async renderCustomerTab(memberId) {
    const summary = await DB.Installments.customerSummary(memberId);
    const cards = summary.installments.map(i => {
      const displayStatus = Utils.installmentDisplayStatus(i);
      return `<div class="panel row-link" data-open-ins="${i.installmentId}" style="margin-top:0;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <b>${Utils.escapeHtml(i.productName)}</b>${Utils.installmentStatusPill(displayStatus)}
        </div>
        <p class="hint" style="margin:4px 0 8px;">${i.installmentId}</p>
        ${Utils.progressBar(i.totalPaid, i.totalPrice)}
        <p class="hint" style="margin-top:6px;">${Utils.formatNaira(i.totalPaid)} / ${Utils.formatNaira(i.totalPrice)} paid (${(i.percentagePaid || 0).toFixed(0)}%) · Balance ${Utils.formatNaira(i.outstandingBalance)}</p>
      </div>`;
    }).join('');
    const html = `
      <div class="grid grid-3" style="margin-bottom:16px;">
        <div class="stat"><div class="stat-label">Active installments</div><div class="stat-value">${summary.activeCount}</div></div>
        <div class="stat gold"><div class="stat-label">Completed installments</div><div class="stat-value">${summary.completedCount}</div></div>
        <div class="stat"><div class="stat-label">Total purchased</div><div class="stat-value" style="font-size:18px;">${Utils.formatNaira(summary.totalPurchased)}</div></div>
      </div>
      <div class="grid grid-2" style="margin-bottom:16px;">
        <div class="stat"><div class="stat-label">Total paid</div><div class="stat-value" style="font-size:18px;">${Utils.formatNaira(summary.totalPaid)}</div></div>
        <div class="stat"><div class="stat-label">Total outstanding</div><div class="stat-value" style="font-size:18px;">${Utils.formatNaira(summary.totalOutstanding)}</div></div>
      </div>
      ${Auth.can('recordInstallments') ? `<button class="btn btn-primary btn-sm" id="mp-add-installment" style="margin-bottom:14px;">+ Add installment purchase</button>` : ''}
      ${summary.installments.length ? `<div class="grid grid-2">${cards}</div>` : `<div class="empty-state">No installment purchases yet.</div>`}`;
    setTimeout(() => {
      document.getElementById('mp-add-installment')?.addEventListener('click', () => this.openForm(memberId));
      document.querySelectorAll('[data-open-ins]').forEach(el => el.addEventListener('click', () => this.openProfile(el.dataset.openIns)));
    }, 0);
    return html;
  },

  // ---------- Payments log ----------
  async loadPaymentsLog() {
    this.allPayments = await DB.Installments.listAllPayments({ limit: 1000 });
    const staffSet = [...new Set(this.allPayments.map(p => p.collectedBy).filter(Boolean))].sort();
    const sel = document.getElementById('insp-filter-staff');
    const current = sel.value;
    sel.innerHTML = '<option value="">All staff</option>' + staffSet.map(s => `<option value="${Utils.escapeHtml(s)}">${Utils.escapeHtml(s)}</option>`).join('');
    sel.value = staffSet.includes(current) ? current : '';
    this.renderPaymentsLog();
  },

  renderPaymentsLog() {
    const q = document.getElementById('insp-search').value.trim().toLowerCase();
    const method = document.getElementById('insp-filter-method').value;
    const staff = document.getElementById('insp-filter-staff').value;
    const from = document.getElementById('insp-filter-from').value ? new Date(document.getElementById('insp-filter-from').value + 'T00:00:00') : null;
    const to = document.getElementById('insp-filter-to').value ? new Date(document.getElementById('insp-filter-to').value + 'T23:59:59.999') : null;
    const rows = (this.allPayments || []).filter(p => {
      if (method && p.paymentMethod !== method) return false;
      if (staff && p.collectedBy !== staff) return false;
      if (q && !((p.memberName || '').toLowerCase().includes(q) || (p.installmentId || '').toLowerCase().includes(q) || (p.transactionReference || '').toLowerCase().includes(q))) return false;
      if (from || to) { const d = Utils.toDate(p.createdAt); if (!d || (from && d < from) || (to && d > to)) return false; }
      return true;
    });
    this.shownPayments = rows;
    const tbody = document.getElementById('insp-tbody');
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">No payments match.</div></td></tr>`; return; }
    tbody.innerHTML = rows.map(p => `
      <tr class="row-link" data-open="${p.installmentId}">
        <td class="num">${p.paymentId}</td>
        <td>${Utils.escapeHtml(p.memberName)}</td>
        <td class="num">${p.installmentId}</td>
        <td class="num">${Utils.formatNaira(p.amount)}</td>
        <td>${Utils.escapeHtml(p.paymentMethod)}</td>
        <td>${Utils.escapeHtml(p.collectedBy || '—')}</td>
        <td>${Utils.formatDate(p.createdAt)}</td>
        <td>${p.status === 'Voided' ? '<span class="pill negative">Voided</span>' : '<span class="pill positive">Completed</span>'}</td>
        <td></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-open]').forEach(row => row.onclick = () => this.openProfile(row.dataset.open));
  },

  exportPaymentsCsv() {
    const rows = (this.shownPayments || []).map(p => {
      const d = Utils.toDate(p.createdAt);
      return [p.paymentId, p.installmentId, p.memberName, p.memberId, p.amount, p.paymentMethod, p.transactionReference || '', p.collectedBy || '', p.status, d ? d.toISOString() : ''];
    });
    Utils.downloadCSV(`installment-payments-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Payment ID', 'Installment ID', 'Customer', 'Member ID', 'Amount', 'Method', 'Reference', 'Collected by', 'Status', 'Date'], rows);
  },

  // ---------- Reports ----------
  async loadReports() {
    const rangeVal = document.getElementById('insr-range').value;
    const from = rangeVal === 'all' ? null : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - parseInt(rangeVal, 10) + 1); return d; })();
    const [installments, payments] = await Promise.all([
      DB.Installments.listInstallments({ limit: 2000 }),
      DB.Installments.listAllPayments({ limit: 2000 }),
    ]);
    const validPayments = payments.filter(p => p.status !== 'Voided' && (!from || (Utils.toDate(p.createdAt) && Utils.toDate(p.createdAt) >= from)));
    const totalSales = installments.reduce((s, i) => s + (i.totalPrice || 0), 0);
    const totalCollected = validPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const totalOutstanding = installments.reduce((s, i) => s + (i.outstandingBalance || 0), 0);
    const completed = installments.filter(i => i.status === 'Completed').length;
    const active = installments.filter(i => Utils.installmentDisplayStatus(i) === 'Active').length;
    const overdue = installments.filter(i => Utils.installmentDisplayStatus(i) === 'Overdue').length;

    let html = `<div class="grid grid-4">
      <div class="stat gold"><div class="stat-label">Total installment sales</div><div class="stat-value" style="font-size:19px;">${Utils.formatNaira(totalSales)}</div></div>
      <div class="stat"><div class="stat-label">Total collected</div><div class="stat-value" style="font-size:19px;">${Utils.formatNaira(totalCollected)}</div></div>
      <div class="stat"><div class="stat-label">Total outstanding</div><div class="stat-value" style="font-size:19px;">${Utils.formatNaira(totalOutstanding)}</div></div>
      <div class="stat"><div class="stat-label">Active / Overdue / Completed</div><div class="stat-value" style="font-size:18px;">${active} / ${overdue} / ${completed}</div></div>
    </div>`;

    const byStaff = {};
    validPayments.forEach(p => { const s = byStaff[p.collectedBy || 'Unknown'] = byStaff[p.collectedBy || 'Unknown'] || { n: 0, amt: 0 }; s.n++; s.amt += p.amount || 0; });
    html += this.reportSection('installment-staff-collections', 'Staff collections',
      [['Staff', 'text'], ['Payments', 'num'], ['Amount collected', 'naira']],
      Object.entries(byStaff).sort((a, b) => b[1].amt - a[1].amt).map(([name, s]) => [name, s.n, s.amt]));

    const byMethod = {};
    validPayments.forEach(p => { const s = byMethod[p.paymentMethod || 'Other'] = byMethod[p.paymentMethod || 'Other'] || { n: 0, amt: 0 }; s.n++; s.amt += p.amount || 0; });
    html += this.reportSection('installment-payment-methods', 'Payment method breakdown',
      [['Method', 'text'], ['Payments', 'num'], ['Amount', 'naira']],
      Object.entries(byMethod).sort((a, b) => b[1].amt - a[1].amt).map(([m, s]) => [m, s.n, s.amt]));

    const byMonth = {};
    validPayments.forEach(p => { const d = Utils.toDate(p.createdAt); if (!d) return; const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; byMonth[k] = (byMonth[k] || 0) + (p.amount || 0); });
    const monthKeys = Object.keys(byMonth).sort().slice(-24);
    html += this.reportSection('installment-monthly-collections', 'Monthly collections',
      [['Month', 'text'], ['Amount collected', 'naira']],
      monthKeys.map(k => { const [y, m] = k.split('-').map(Number); return [new Date(y, m - 1, 1).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' }), byMonth[k]]; }));

    document.getElementById('insr-body').innerHTML = html;
  },

  reportSection(key, title, cols, rows) {
    this.reportSets[key] = { headers: cols.map(c => c[0]), rows };
    const body = rows.length
      ? `<div style="overflow-x:auto;"><table class="ledger"><thead><tr>${cols.map(c => `<th class="${c[1] === 'text' ? '' : 'num'}">${Utils.escapeHtml(c[0])}</th>`).join('')}</tr></thead><tbody>${
          rows.map(r => `<tr>${r.map((v, i) => `<td class="${cols[i][1] === 'text' ? '' : 'num'}">${cols[i][1] === 'naira' ? Utils.formatNaira(v) : cols[i][1] === 'num' ? Utils.formatPoints(v) : Utils.escapeHtml(v)}</td>`).join('')}</tr>`).join('')
        }</tbody></table></div>`
      : `<div class="empty-state">No data for this period.</div>`;
    setTimeout(() => document.getElementById(`insr-export-${key}`)?.addEventListener('click', () => this.exportReportSet(key)), 0);
    return `<div class="panel" style="margin-top:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <p class="panel-title" style="margin:0; padding:0; border:0;">${Utils.escapeHtml(title)}</p>
        <button class="btn btn-sm" id="insr-export-${key}">Export CSV</button>
      </div>${body}</div>`;
  },

  exportReportSet(key) {
    const s = this.reportSets[key];
    if (!s) return;
    Utils.downloadCSV(`${key}-${new Date().toISOString().slice(0, 10)}.csv`, s.headers, s.rows);
  },
};

window.Installments = Installments;