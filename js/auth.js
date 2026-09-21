// ============================================================
// auth.js — Firebase Auth + role lookup from /staff/{uid}
// Roles: superadmin | manager | staff  (see spec §24)
// ============================================================

const ROLE_LABEL = { superadmin: 'Super Admin', manager: 'Manager', staff: 'Staff' };

const PERMISSIONS = {
  // feature -> roles allowed
  viewDashboard: ['superadmin', 'manager', 'staff'],
  manageMembers: ['superadmin', 'manager', 'staff'],
  recordPurchase: ['superadmin', 'manager', 'staff'],
  redeemPoints: ['superadmin', 'manager', 'staff'],
  manualAdjustment: ['superadmin', 'manager'],
  refund: ['superadmin', 'manager'],
  manageClasses: ['superadmin'],
  editLoyaltyRules: ['superadmin'],
  manageStaff: ['superadmin'],
  viewAuditLog: ['superadmin'],
  viewReports: ['superadmin', 'manager'],
};

const Auth = {
  currentUser: null,
  profile: null,

  can(feature) {
    if (!this.profile) return false;
    return (PERMISSIONS[feature] || []).includes(this.profile.role);
  },

  async login(email, password) {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    return cred.user;
  },

  async resetPassword(email) {
    await auth.sendPasswordResetEmail(email);
  },

  async logout() {
    await auth.signOut();
  },

  async loadProfile(user) {
    let profile = await DB.getStaffProfile(user.uid);
    if (!profile) {
      // First person to sign in becomes Super Admin (bootstrap path).
      const anyStaff = await DB.listStaff();
      const role = anyStaff.length === 0 ? 'superadmin' : 'staff';
      const data = { name: user.email.split('@')[0], email: user.email, role, active: role !== 'staff' ? true : false };
      await DB.upsertStaff(user.uid, data, user.email);
      profile = { uid: user.uid, ...data };
    }
    if (profile.deactivated === true) {
      const e = new Error('This account has been deactivated.');
      e.code = 'staff/deactivated';
      throw e;
    }
    this.profile = profile;
    return profile;
  },

  applyRoleVisibility() {
    document.querySelectorAll('[data-requires]').forEach(el => {
      const feature = el.getAttribute('data-requires');
      el.style.display = this.can(feature) ? '' : 'none';
    });
    // Hide a nav section's heading when none of its links are allowed
    // (otherwise Staff see empty "RECORDS" and "ADMIN" labels).
    document.querySelectorAll('.nav-group').forEach(group => {
      const anyVisible = [...group.querySelectorAll('.nav-item')].some(i => i.style.display !== 'none');
      group.style.display = anyVisible ? '' : 'none';
    });
  },

  init(onReady) {
    auth.onAuthStateChanged(async (user) => {
      this.currentUser = user;
      if (!user) {
        this.profile = null;
        return onReady(null);
      }
      try {
        await this.loadProfile(user);
        this.applyRoleVisibility();
        onReady(user);
      } catch (err) {
        // Signed in to Firebase but couldn't read/create the staff record
        // (usually Firestore rules not deployed yet). Don't leave a blank screen.
        console.error('Could not load staff profile', err);
        this.profile = null;
        onReady(null, err);
      }
    });
  },
};

window.Auth = Auth;