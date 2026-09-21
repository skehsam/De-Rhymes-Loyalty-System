// ============================================================
// db.js — every Firestore read/write goes through here.
// Keeps collection names and transaction logic in one place.
// ============================================================

const Col = {
  staff: () => db.collection('staff'),
  members: () => db.collection('members'),
  classes: () => db.collection('classes'),
  transactions: () => db.collection('transactions'),
  classHistory: () => db.collection('classHistory'),
  notifications: () => db.collection('notifications'),
  auditLog: () => db.collection('auditLog'),
  counters: () => db.collection('counters'),
  settingsDoc: () => db.collection('settings').doc('loyalty'),
  templatesDoc: () => db.collection('settings').doc('templates'),
};

const DEFAULT_SETTINGS = {
  baseSpendAmount: 1000,
  basePointsAwarded: 10,
  pointValue: 1,
  minRedemption: 0,        // 0 = no minimum
  maxRedemption: 0,        // 0 = no maximum
  pointExpiryMonths: 0,    // 0 = points never expire
  autoClassAssignment: false,
  whatsappEnabled: true,
  emailEnabled: true,
  birthdayEnabled: true,
  businessName: 'De Rhymes Nigeria Limited',
  businessAddress: '',
  businessPhone: '',
  businessEmail: '',
};

const DEFAULT_TEMPLATES = {
  'Welcome': 'Welcome to De Rhymes, {name}! Your membership number is {memberId}. Show your card at the till to earn points.',
  'Purchase': 'Hi {name}, your purchase of {amount} earned you {points} points. New balance: {balance} points.',
  'Points Redeemed': 'Hi {name}, {points} points ({cash}) redeemed. Remaining balance: {balance} points.',
  'Class Upgrade': 'Congratulations {name}! Your De Rhymes membership is now {class}. You earn points at {multiplier}.',
  'Bonus Points': 'Great news {name}! You received {points} bonus points. New balance: {balance} points.',
  'Account Update': 'Hi {name}, your De Rhymes account was updated: {detail}',
  'Birthday': 'Happy birthday, {name}! Here is a little something from all of us at De Rhymes.',
};

const TEMPLATE_META = {
  'Welcome':         { label: 'Welcome (new member)', vars: '{name} {memberId}' },
  'Purchase':        { label: 'Purchase / points earned', vars: '{name} {amount} {points} {balance}' },
  'Points Redeemed': { label: 'Redemption', vars: '{name} {points} {cash} {balance}' },
  'Class Upgrade':   { label: 'Class upgrade', vars: '{name} {class} {multiplier}' },
  'Bonus Points':    { label: 'Bonus points', vars: '{name} {points} {balance}' },
  'Account Update':  { label: 'Account update', vars: '{name} {detail}' },
  'Birthday':        { label: 'Birthday', vars: '{name} {memberId}' },
};

// Direction of each manual adjustment type (+1 adds points, -1 removes them).
const ADJUSTMENT_TYPES = { 'Add Points': 1, 'Bonus Points': 1, 'Remove Points': -1, 'Reverse Points': -1 };

const DB = {

  // ---------- Settings ----------
  async getSettings() {
    const snap = await Col.settingsDoc().get();
    if (!snap.exists) {
      await Col.settingsDoc().set(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
    // Older settings docs won't have the newer fields; fill them from defaults.
    return { ...DEFAULT_SETTINGS, ...snap.data() };
  },

  async updateSettings(patch, actor) {
    const before = await this.getSettings();
    await Col.settingsDoc().set(patch, { merge: true });
    await this.logAudit({
      action: 'Updated loyalty settings',
      previousValue: before,
      newValue: { ...before, ...patch },
      actor,
    });
  },

  // ---------- Notification templates ----------
  async getTemplates() {
    // Staff may not be allowed to read this doc; fall back to defaults rather than fail a purchase.
    const snap = await Col.templatesDoc().get().catch(() => null);
    const stored = snap && snap.exists ? snap.data() : {};
    const out = {};
    Object.keys(DEFAULT_TEMPLATES).forEach(k => {
      out[k] = stored[k] && String(stored[k]).trim() ? stored[k] : DEFAULT_TEMPLATES[k];
    });
    return out;
  },

  async saveTemplates(templates, actor) {
    const before = await this.getTemplates();
    await Col.templatesDoc().set(templates);
    await this.logAudit({ action: 'Updated notification templates', previousValue: before, newValue: templates, actor });
  },

  // ---------- Staff / roles ----------
  async getStaffProfile(uid) {
    const snap = await Col.staff().doc(uid).get();
    return snap.exists ? { uid, ...snap.data() } : null;
  },

  async listStaff() {
    const snap = await Col.staff().get();
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  },

  async upsertStaff(uid, data, actor) {
    await Col.staff().doc(uid).set(data, { merge: true });
    await this.logAudit({ action: `Updated staff record (${data.role || ''})`, newValue: data, actor });
  },

  /**
   * Creates a Firebase Auth login for a new staff member WITHOUT signing the
   * current admin out (a second Firebase app instance is used for the sign-up),
   * writes their /staff record, and emails them a link to choose a password.
   */
  async createStaffAccount({ name, email, role }, actor) {
    let secondary;
    try { secondary = firebase.app('secondary'); }
    catch (e) { secondary = firebase.initializeApp(firebaseConfig, 'secondary'); }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const tempPassword = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') + 'Aa1!';
    const cred = await secondary.auth().createUserWithEmailAndPassword(email, tempPassword);
    const uid = cred.user.uid;
    try {
      await secondary.auth().sendPasswordResetEmail(email);
    } catch (e) { console.error('Reset email not sent', e); }
    await secondary.auth().signOut();
    await this.upsertStaff(uid, { name, email, role, active: true, deactivated: false }, actor);
    return uid;
  },

  async setStaffActive(uid, active, actor) {
    await Col.staff().doc(uid).set({ active, deactivated: !active }, { merge: true });
    await this.logAudit({
      action: active ? 'Reactivated staff account' : 'Deactivated staff account',
      previousValue: { active: !active }, newValue: { active, uid }, actor,
    });
  },

  /** Recent transactions and admin actions performed by one staff member. */
  async staffActivity(uid, email) {
    const [txSnap, auditSnap] = await Promise.all([
      Col.transactions().where('staffUid', '==', uid).limit(300).get(),
      email ? Col.auditLog().where('actor', '==', email).limit(100).get().catch(() => ({ docs: [] })) : Promise.resolve({ docs: [] }),
    ]);
    const byDate = (a, b) => Utils.tsMillis(b.date) - Utils.tsMillis(a.date);
    return {
      transactions: txSnap.docs.map(d => d.data()).sort(byDate),
      audit: auditSnap.docs.map(d => d.data()).sort(byDate),
    };
  },

  // ---------- Classes ----------
  async listClasses() {
    const snap = await Col.classes().orderBy('minSpend', 'asc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async getClass(id) {
    const snap = await Col.classes().doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  },

  async saveClass(id, data, actor) {
    const ref = id ? Col.classes().doc(id) : Col.classes().doc();
    const before = id ? (await ref.get()).data() : null;
    await ref.set({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (!id) await ref.set({ createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await this.logAudit({
      action: id ? `Edited class "${data.name}"` : `Created class "${data.name}"`,
      previousValue: before, newValue: data, actor,
    });
    return ref.id;
  },

  async setClassStatus(id, status, actor) {
    await Col.classes().doc(id).update({ status });
    await this.logAudit({ action: `Set class status → ${status}`, newValue: { id, status }, actor });
  },

  async deleteClass(id, name, actor) {
    await Col.classes().doc(id).delete();
    await this.logAudit({ action: `Deleted class "${name}"`, actor });
  },

  // ---------- Member ID sequence ----------
  async nextMemberId() {
    const ref = Col.counters().doc('memberId');
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const last = snap.exists ? (snap.data().lastNumber || 0) : 0;
      const next = last + 1;
      tx.set(ref, { lastNumber: next }, { merge: true });
      return Utils.formatMemberId(next);
    });
  },

  // ---------- Members ----------
  async createMember(data, actor) {
    if (data.phone) {
      const dupe = await Col.members().where('phone', '==', data.phone).limit(1).get();
      if (!dupe.empty) {
        const d = dupe.docs[0].data();
        throw new Error(`${d.fullName} (${d.memberId}) is already registered with this phone number`);
      }
    }
    const memberId = await this.nextMemberId();
    const doc = {
      ...data,
      memberId,
      points: 0,
      totalSpent: 0,
      status: data.status || 'active',
      registrationDate: firebase.firestore.FieldValue.serverTimestamp(),
      lastActivityDate: firebase.firestore.FieldValue.serverTimestamp(),
      qrValue: memberId,        // first-issue card: the code IS the member ID
      barcodeValue: memberId,
      cardVersion: 1,
      notificationPrefs: data.notificationPrefs || { whatsapp: true, email: true },
    };
    await Col.members().doc(memberId).set(doc);
    await this.logAudit({ action: `Registered member ${memberId} (${data.fullName})`, actor });
    try {
      await this.queueNotification({ memberId, type: 'Welcome' });
    } catch (err) { console.error('Welcome message not queued', err); }
    return memberId;
  },

  async getMember(memberId) {
    const snap = await Col.members().doc(memberId).get();
    return snap.exists ? snap.data() : null;
  },

  /**
   * Resolves whatever a scanner read off a card. Only the code currently printed
   * on the member's card matches, so a reissued (replaced) card's old code stops working.
   */
  async findMemberByCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return null;
    const snap = await Col.members().where('qrValue', '==', c).limit(1).get();
    if (!snap.empty) return snap.docs[0].data();
    // Members created before card codes were stored: the code is the member ID.
    const legacy = await Col.members().doc(c).get();
    if (legacy.exists && !legacy.data().qrValue) return legacy.data();
    return null;
  },

  async updateMember(memberId, patch, actor) {
    await Col.members().doc(memberId).update(patch);
    await this.logAudit({ action: `Edited member ${memberId}`, newValue: patch, actor });
  },

  async setMemberStatus(memberId, status, reason, actor) {
    const before = await this.getMember(memberId);
    if (!before) throw new Error('Member not found');
    await Col.members().doc(memberId).update({ status });
    await this.logAudit({
      action: status === 'inactive' ? `Deactivated member ${memberId}` : `Reactivated member ${memberId}`,
      previousValue: { status: before.status || 'active' }, newValue: { status }, reason, actor,
    });
    try {
      await this.queueNotification({
        memberId, type: 'Account Update',
        vars: { detail: status === 'inactive' ? 'your membership is now inactive.' : 'your membership is active again.' },
      });
    } catch (err) { console.error(err); }
  },

  /** Lost/damaged card: issue a new code and void the old one. */
  async reissueCard(memberId, reason, actor) {
    const member = await this.getMember(memberId);
    if (!member) throw new Error('Member not found');
    let token = null;
    for (let i = 0; i < 5 && !token; i++) {
      const candidate = Utils.generateCardToken(memberId);
      const clash = await Col.members().where('qrValue', '==', candidate).limit(1).get();
      if (clash.empty) token = candidate;
    }
    if (!token) throw new Error('Could not generate a unique card code — try again');
    await Col.members().doc(memberId).update({
      qrValue: token, barcodeValue: token,
      cardVersion: (member.cardVersion || 1) + 1,
      cardReissuedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await this.logAudit({
      action: `Reissued membership card for ${memberId}`,
      previousValue: { code: member.qrValue || memberId, cardVersion: member.cardVersion || 1 },
      newValue: { code: token, cardVersion: (member.cardVersion || 1) + 1 },
      reason, actor,
    });
    try {
      await this.queueNotification({
        memberId, type: 'Account Update',
        vars: { detail: 'your membership card was replaced. Please use your new card; the old one no longer works.' },
      });
    } catch (err) { console.error(err); }
    return token;
  },

  async listMembers({ limit = 50 } = {}) {
    const snap = await Col.members().orderBy('registrationDate', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  },

  /** Client-side search across the small/medium member list. For large datasets, swap in Algolia/Typesense. */
  async searchMembers(term) {
    const t = term.trim().toLowerCase();
    if (!t) return [];
    const results = new Map();
    if (/^drl-/i.test(t)) {
      const snap = await Col.members().doc(t.toUpperCase()).get();
      if (snap.exists) results.set(snap.id, snap.data());
    }
    const phoneSnap = await Col.members().where('phone', '==', term.trim()).limit(5).get();
    phoneSnap.forEach(d => results.set(d.id, d.data()));

    const all = await Col.members().limit(500).get();
    all.forEach(d => {
      const m = d.data();
      if (
        m.fullName?.toLowerCase().includes(t) ||
        m.email?.toLowerCase().includes(t) ||
        m.memberId?.toLowerCase().includes(t) ||
        m.phone?.includes(t)
      ) results.set(d.id, m);
    });
    return Array.from(results.values());
  },

  // ---------- Class history ----------
  async logClassChange({ memberId, previousClass, newClass, reason }) {
    await Col.classHistory().add({
      memberId, previousClass, newClass, reason,
      date: firebase.firestore.FieldValue.serverTimestamp(),
    });
  },

  async getClassHistory(memberId) {
    const snap = await Col.classHistory().where('memberId', '==', memberId).orderBy('date', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  // ---------- Transactions (purchase / redeem / adjust / refund / class change / expiry) ----------
  async recordTransaction(tx) {
    const id = Utils.generateTxnId();
    await Col.transactions().doc(id).set({
      ...tx,
      transactionId: id,
      date: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return id;
  },

  async listTransactions({ memberId, type, limit = 100 } = {}) {
    let q = Col.transactions().orderBy('date', 'desc').limit(limit);
    if (memberId) q = Col.transactions().where('memberId', '==', memberId).orderBy('date', 'desc').limit(limit);
    const snap = await q.get();
    let rows = snap.docs.map(d => d.data());
    if (type) rows = rows.filter(r => r.type === type);
    return rows;
  },

  async getTransaction(txId) {
    const snap = await Col.transactions().doc(txId).get();
    return snap.exists ? snap.data() : null;
  },

  // ---------- Purchase: the core engine ----------
  /**
   * Runs the whole purchase as one Firestore transaction so the member's
   * balance can never be corrupted by a concurrent scan at another till.
   * Stores a full rule-snapshot on the transaction doc (spec §26): later
   * changes to multipliers/point value must NOT retroactively change history.
   */
  async recordPurchase({ memberId, purchaseAmount, staffUid, staffName }) {
    const settings = await this.getSettings();
    const classes = await this.listClasses();

    return db.runTransaction(async (t) => {
      const memberRef = Col.members().doc(memberId);
      const memberSnap = await t.get(memberRef);
      if (!memberSnap.exists) throw new Error('Member not found');
      const member = memberSnap.data();

      const cls = classes.find(c => c.id === member.classId) || { name: 'Standard', multiplier: 1 };
      const { basePoints, finalPoints } = Utils.calculatePoints({
        purchaseAmount,
        baseSpendAmount: settings.baseSpendAmount,
        basePointsAwarded: settings.basePointsAwarded,
        multiplier: cls.multiplier,
      });

      const previousBalance = member.points || 0;
      const newBalance = previousBalance + finalPoints;
      const newTotalSpent = (member.totalSpent || 0) + purchaseAmount;

      t.update(memberRef, {
        points: newBalance, totalSpent: newTotalSpent,
        lastActivityDate: firebase.firestore.FieldValue.serverTimestamp(),
      });

      const txId = Utils.generateTxnId();
      const txRef = Col.transactions().doc(txId);
      t.set(txRef, {
        transactionId: txId,
        type: 'Purchase',
        memberId, memberName: member.fullName,
        purchaseAmount,
        baseSpendAmount: settings.baseSpendAmount,
        basePointsRule: settings.basePointsAwarded,
        basePoints,
        classId: cls.id || null, className: cls.name,
        multiplier: cls.multiplier,
        finalPoints,
        pointValueAtTime: settings.pointValue,
        previousBalance, newBalance,
        staffUid, staffName,
        status: 'Completed',
        date: firebase.firestore.FieldValue.serverTimestamp(),
      });

      return {
        txId, basePoints, finalPoints, previousBalance, newBalance,
        className: cls.name, multiplier: cls.multiplier, newTotalSpent,
      };
    }).then(async (result) => {
      // Everything below runs AFTER the purchase is safely committed, so a failure here
      // must never surface as "purchase failed" (the cashier would ring it up twice).
      try {
        if (settings.autoClassAssignment) {
          await this.maybeReclassify(memberId, result.newTotalSpent, classes, 'Spending threshold');
        }
        await this.queueNotification({
          memberId, type: 'Purchase',
          vars: {
            amount: Utils.formatNaira(purchaseAmount),
            points: Utils.formatPoints(result.finalPoints),
            balance: Utils.formatPoints(result.newBalance),
          },
        });
      } catch (err) { console.error('Post-purchase steps failed', err); }
      return result;
    });
  },

  async maybeReclassify(memberId, totalSpent, classes, reason) {
    const member = await this.getMember(memberId);
    if (!member) return null;
    const target = Utils.classForSpend(totalSpent, classes);
    if (!target || target.id === member.classId) return null;

    const previous = classes.find(c => c.id === member.classId);
    await Col.members().doc(memberId).update({ classId: target.id, className: target.name });
    await this.logClassChange({
      memberId, previousClass: previous?.name || 'Standard', newClass: target.name, reason,
    });
    await this.recordTransaction({
      type: 'Class Upgrade', memberId, memberName: member.fullName,
      classId: target.id, className: target.name,
      note: `${previous?.name || 'Standard'} → ${target.name}`,
      status: 'Completed', staffName: 'System (auto)',
    });
    await this.queueNotification({
      memberId, type: 'Class Upgrade',
      vars: { class: target.name, multiplier: Utils.formatMultiplier(target.multiplier) },
    });
    return target;
  },

  // ---------- Redeem ----------
  async redeemPoints({ memberId, pointsToRedeem, reason, staffUid, staffName }) {
    const settings = await this.getSettings();
    if (settings.minRedemption && pointsToRedeem < settings.minRedemption) {
      throw new Error(`Minimum redemption is ${Utils.formatPoints(settings.minRedemption)} points`);
    }
    if (settings.maxRedemption && pointsToRedeem > settings.maxRedemption) {
      throw new Error(`Maximum redemption is ${Utils.formatPoints(settings.maxRedemption)} points per transaction`);
    }
    return db.runTransaction(async (t) => {
      const memberRef = Col.members().doc(memberId);
      const snap = await t.get(memberRef);
      if (!snap.exists) throw new Error('Member not found');
      const member = snap.data();
      if ((member.points || 0) < pointsToRedeem) throw new Error('Insufficient points balance');

      const previousBalance = member.points;
      const newBalance = previousBalance - pointsToRedeem;
      const cashValue = Utils.pointsToCash(pointsToRedeem, settings.pointValue);

      t.update(memberRef, { points: newBalance, lastActivityDate: firebase.firestore.FieldValue.serverTimestamp() });

      const txId = Utils.generateTxnId();
      t.set(Col.transactions().doc(txId), {
        transactionId: txId, type: 'Points Redeemed',
        memberId, memberName: member.fullName,
        classId: member.classId || null, className: member.className || 'Standard',
        finalPoints: -pointsToRedeem,
        pointValueAtTime: settings.pointValue,
        cashValue, reason,
        previousBalance, newBalance,
        staffUid, staffName, status: 'Completed',
        date: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return { txId, cashValue, previousBalance, newBalance };
    }).then(async (result) => {
      try {
        await this.logAudit({
          action: `Redeemed ${Utils.formatPoints(pointsToRedeem)} points (${memberId})`,
          previousValue: { points: result.previousBalance }, newValue: { points: result.newBalance },
          reason: reason || null, actor: staffName,
        });
        await this.queueNotification({
          memberId, type: 'Points Redeemed',
          vars: {
            points: Utils.formatPoints(pointsToRedeem),
            cash: Utils.formatNaira(result.cashValue),
            balance: Utils.formatPoints(result.newBalance),
          },
        });
      } catch (err) { console.error('Post-redemption steps failed', err); }
      return result;
    });
  },

  // ---------- Manual adjustment ----------
  /**
   * adjustmentType: 'Add Points' | 'Bonus Points' | 'Remove Points' | 'Reverse Points'
   * `points` is always a positive number; the type decides the direction.
   * The balance never goes below zero, and the transaction records the change
   * that was ACTUALLY applied (not the amount requested).
   */
  async adjustPoints({ memberId, points, adjustmentType, reason, notes, relatedTxId, staffUid, staffName }) {
    const sign = ADJUSTMENT_TYPES[adjustmentType];
    if (!sign) throw new Error('Unknown adjustment type');
    if (!(points > 0)) throw new Error('Enter a valid number of points');
    if (!reason) throw new Error('A reason is required for manual adjustments');
    const delta = sign * points;

    return db.runTransaction(async (t) => {
      const memberRef = Col.members().doc(memberId);
      const snap = await t.get(memberRef);
      if (!snap.exists) throw new Error('Member not found');
      const member = snap.data();
      const previousBalance = member.points || 0;
      const newBalance = Math.max(0, previousBalance + delta);
      const applied = newBalance - previousBalance;

      t.update(memberRef, { points: newBalance, lastActivityDate: firebase.firestore.FieldValue.serverTimestamp() });

      const txId = Utils.generateTxnId();
      t.set(Col.transactions().doc(txId), {
        transactionId: txId, type: 'Manual Adjustment', adjustmentType,
        memberId, memberName: member.fullName,
        classId: member.classId || null, className: member.className || 'Standard',
        finalPoints: applied, requestedPoints: delta,
        reason, notes: notes || '', relatedTxId: relatedTxId || null,
        previousBalance, newBalance,
        staffUid, staffName, status: 'Completed',
        date: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return { txId, previousBalance, newBalance, applied };
    }).then(async (result) => {
      try {
        await this.logAudit({
          action: `${adjustmentType}: ${result.applied > 0 ? '+' : ''}${Utils.formatPoints(result.applied)} (${memberId})`,
          previousValue: { points: result.previousBalance }, newValue: { points: result.newBalance },
          reason, actor: staffName,
        });
        if (adjustmentType === 'Bonus Points') {
          await this.queueNotification({
            memberId, type: 'Bonus Points',
            vars: { points: Utils.formatPoints(result.applied), balance: Utils.formatPoints(result.newBalance) },
          });
        } else {
          await this.queueNotification({
            memberId, type: 'Account Update',
            vars: { detail: `${result.applied > 0 ? '+' : ''}${Utils.formatPoints(result.applied)} points (${reason}). New balance: ${Utils.formatPoints(result.newBalance)} points.` },
          });
        }
      } catch (err) { console.error('Post-adjustment steps failed', err); }
      return result;
    });
  },

  // ---------- Refund ----------
  /**
   * A purchase can be refunded exactly once. The refund gets a deterministic
   * ID (RFD-<purchase id>) and is checked inside the same Firestore transaction,
   * so two clicks / two tills can't reverse the same points twice.
   */
  async refundPurchase({ originalTxId, reason, staffUid, staffName }) {
    const original = await this.getTransaction(originalTxId);
    if (!original || original.type !== 'Purchase') throw new Error('Original purchase not found');

    const legacy = await Col.transactions().where('relatedTxId', '==', originalTxId).limit(1).get();
    if (!legacy.empty) throw new Error('This purchase has already been refunded');

    const refundId = 'RFD-' + originalTxId.replace(/^TXN-/, '');

    return db.runTransaction(async (t) => {
      const memberRef = Col.members().doc(original.memberId);
      const refundRef = Col.transactions().doc(refundId);
      const [snap, refundSnap] = await Promise.all([t.get(memberRef), t.get(refundRef)]);
      if (refundSnap.exists) throw new Error('This purchase has already been refunded');
      if (!snap.exists) throw new Error('Member not found');
      const member = snap.data();
      const previousBalance = member.points || 0;
      const reversal = -original.finalPoints;
      const newBalance = Math.max(0, previousBalance + reversal);
      const newTotalSpent = Math.max(0, (member.totalSpent || 0) - (original.purchaseAmount || 0));

      t.update(memberRef, { points: newBalance, totalSpent: newTotalSpent });

      t.set(refundRef, {
        transactionId: refundId, type: 'Refund',
        memberId: original.memberId, memberName: original.memberName,
        classId: original.classId || null, className: original.className || 'Standard',
        purchaseAmount: -original.purchaseAmount,
        finalPoints: reversal,
        relatedTxId: originalTxId, reason: reason || '',
        previousBalance, newBalance,
        staffUid, staffName, status: 'Completed',
        date: firebase.firestore.FieldValue.serverTimestamp(),
      });
      return { txId: refundId, previousBalance, newBalance };
    }).then(async (result) => {
      await this.logAudit({
        action: `Refunded purchase ${originalTxId} (${original.memberId})`,
        previousValue: { points: result.previousBalance }, newValue: { points: result.newBalance },
        reason: reason || null, actor: staffName,
      }).catch(err => console.error(err));
      return result;
    });
  },

  // ---------- Point expiration ----------
  /**
   * Expires the whole balance of members with no earn/redeem/adjust activity for
   * `pointExpiryMonths`. Members with no recorded activity date yet are SKIPPED
   * (never guessed), so nobody loses points because of missing history.
   */
  async expireInactivePoints(actor) {
    const settings = await this.getSettings();
    const months = Number(settings.pointExpiryMonths) || 0;
    if (!months) throw new Error('Point expiration is off — set the number of months first and save');
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    const snap = await Col.members().where('points', '>', 0).get();
    let members = 0, points = 0, skipped = 0;
    for (const d of snap.docs) {
      const last = Utils.toDate(d.data().lastActivityDate);
      if (!last) { skipped++; continue; }
      if (last >= cutoff) continue;
      const expired = await db.runTransaction(async (t) => {
        const cur = (await t.get(d.ref)).data();
        const curLast = Utils.toDate(cur.lastActivityDate);
        if (!(cur.points > 0) || !curLast || curLast >= cutoff) return 0; // changed since we looked
        const txId = Utils.generateTxnId();
        t.update(d.ref, { points: 0 });
        t.set(Col.transactions().doc(txId), {
          transactionId: txId, type: 'Points Expired',
          memberId: cur.memberId, memberName: cur.fullName,
          classId: cur.classId || null, className: cur.className || 'Standard',
          finalPoints: -cur.points, reason: `No activity for ${months} months`,
          previousBalance: cur.points, newBalance: 0,
          staffName: actor, status: 'Completed',
          date: firebase.firestore.FieldValue.serverTimestamp(),
        });
        return cur.points;
      });
      if (expired) { members++; points += expired; }
    }
    await this.logAudit({
      action: `Ran point expiry: ${Utils.formatPoints(points)} points from ${members} members`,
      newValue: { months, members, points, skippedNoActivityDate: skipped }, actor,
    });
    return { members, points, skipped };
  },

  // ---------- Notifications ----------
  /**
   * Writes a pending notification record. Actual delivery (WhatsApp Business
   * API / email provider) happens server-side — see functions/index.js.
   * The wording comes from the editable templates (Settings → Notification templates);
   * pass `message` to bypass the template.
   */
  async queueNotification({ memberId, type, vars = {}, message }) {
    const settings = await this.getSettings();
    const member = await this.getMember(memberId);
    if (!member) return;
    const prefs = member.notificationPrefs || { whatsapp: true, email: true };
    const channels = [];
    if (settings.whatsappEnabled && prefs.whatsapp) channels.push('WhatsApp');
    if (settings.emailEnabled && prefs.email) channels.push('Email');
    if (!channels.length) return;
    let text = message;
    if (!text) {
      const templates = await this.getTemplates();
      text = Utils.renderTemplate(templates[type] || '', { name: member.fullName, memberId, ...vars });
    }
    for (const channel of channels) {
      await Col.notifications().add({
        memberId, memberName: member.fullName, channel, type, message: text,
        status: 'Pending', deliveryStatus: 'Pending',
        sentDate: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  },

  /**
   * Manual "send now" for a member's profile — independent of whether today
   * is actually their birthday. Also stamps lastBirthdayYear so the daily
   * automatic check (functions/index.js) doesn't message them again the
   * same year. Throws if the member has no channel enabled to tell the
   * staff why nothing was sent, rather than silently doing nothing.
   */
  async sendBirthdayNow(memberId, actor) {
    const member = await this.getMember(memberId);
    if (!member) throw new Error('Member not found');
    const prefs = member.notificationPrefs || { whatsapp: true, email: true };
    const settings = await this.getSettings();
    const hasChannel = (settings.whatsappEnabled && prefs.whatsapp) || (settings.emailEnabled && prefs.email);
    if (!hasChannel) throw new Error(`${member.fullName} has no notification channel enabled (check their profile and Loyalty Settings)`);
    await this.queueNotification({ memberId, type: 'Birthday' });
    await Col.members().doc(memberId).update({ lastBirthdayYear: new Date().getFullYear() });
    await this.logAudit({ action: `Sent birthday message (${memberId})`, actor });
  },

  async listNotifications({ limit = 100 } = {}) {
    const snap = await Col.notifications().orderBy('sentDate', 'desc').limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async retryNotification(id) {
    await Col.notifications().doc(id).update({ status: 'Pending', deliveryStatus: 'Pending' });
  },

  async retryNotifications(ids) {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = db.batch();
      ids.slice(i, i + 400).forEach(id => batch.update(Col.notifications().doc(id), { status: 'Pending', deliveryStatus: 'Pending' }));
      await batch.commit();
    }
  },

  // ---------- Audit log ----------
  async logAudit({ action, previousValue, newValue, reason, actor }) {
    await Col.auditLog().add({
      action,
      previousValue: previousValue ?? null,
      newValue: newValue ?? null,
      reason: reason ?? null,
      actor: actor || 'Unknown',
      date: firebase.firestore.FieldValue.serverTimestamp(),
    });
  },

  async listAuditLog({ limit = 100 } = {}) {
    const snap = await Col.auditLog().orderBy('date', 'desc').limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  // ---------- Reports ----------
  async reportData() {
    const [membersSnap, txSnap, settings] = await Promise.all([
      Col.members().get(),
      Col.transactions().orderBy('date', 'desc').limit(2000).get(),
      this.getSettings(),
    ]);
    return {
      members: membersSnap.docs.map(d => d.data()),
      txs: txSnap.docs.map(d => d.data()),
      truncated: txSnap.size >= 2000,
      pointValue: settings.pointValue || 1,
    };
  },

  // ---------- Dashboard aggregates ----------
  async dashboardStats() {
    const [membersSnap, txSnap, notifSnap] = await Promise.all([
      Col.members().get(),
      Col.transactions().orderBy('date', 'desc').limit(500).get(),
      Col.notifications().limit(500).get().catch(() => ({ docs: [] })),
    ]);
    const members = membersSnap.docs.map(d => d.data());
    const txs = txSnap.docs.map(d => d.data());
    const notifs = notifSnap.docs.map(d => d.data());

    const totalMembers = members.length;
    const activeMembers = members.filter(m => m.status === 'active').length;
    const purchases = txs.filter(t => t.type === 'Purchase');
    const totalPurchases = purchases.reduce((s, t) => s + (t.purchaseAmount || 0), 0);
    const totalPointsIssued = txs.filter(t => t.finalPoints > 0).reduce((s, t) => s + t.finalPoints, 0);
    const totalPointsRedeemed = txs.filter(t => t.type === 'Points Redeemed').reduce((s, t) => s + Math.abs(t.finalPoints || 0), 0);
    const outstandingPoints = members.reduce((s, m) => s + (m.points || 0), 0);
    const settings = await this.getSettings();
    const totalLoyaltyValue = outstandingPoints * (settings.pointValue || 1);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todaysTransactions = txs.filter(t => t.date && t.date.toDate && t.date.toDate() >= startOfDay).length;
    const whatsappSent = notifs.filter(n => n.channel === 'WhatsApp' && n.status !== 'Failed').length;
    const emailSent = notifs.filter(n => n.channel === 'Email' && n.status !== 'Failed').length;

    return {
      totalMembers, activeMembers, totalPurchases, totalPointsIssued,
      totalPointsRedeemed, outstandingPoints, totalLoyaltyValue,
      todaysTransactions, whatsappSent, emailSent,
      recentTx: txs.slice(0, 8), members, purchases, txs,
    };
  },
};

DB.DEFAULT_TEMPLATES = DEFAULT_TEMPLATES;
DB.TEMPLATE_META = TEMPLATE_META;
DB.ADJUSTMENT_TYPES = ADJUSTMENT_TYPES;

window.DB = DB;