// ============================================================
// app.js — bootstraps auth, wires nav, routes between views
// ============================================================

const App = {
  currentView: 'dashboard',
  initialized: new Set(), // modules whose event handlers are already wired (never wire twice)
  healthy: new Set(),     // modules that started without error this session
  wired: false,

  // [module name, permission needed to use it]. A module is only started for
  // roles that can actually see its page, so a Staff login never touches
  // audit-log / staff / settings data it has no rights to read.
  MODULES: [
    ['Members', 'manageMembers'],
    ['Classes', 'manageClasses'],
    ['Checkout', 'recordPurchase'],
    ['Redeem', 'redeemPoints'],
    ['Adjust', 'manualAdjustment'],
    ['Settings', 'editLoyaltyRules'],
    ['Transactions', 'viewReports'],
    ['Notifications', 'viewReports'],
    ['Reports', 'viewReports'],
    ['Staff', 'manageStaff'],
    ['AuditView', 'viewAuditLog'],
    ['Dashboard', 'viewDashboard'],
  ],

  async loadAllModules() {
    await Promise.all(this.MODULES.map(async ([name, feature]) => {
      if (!Auth.can(feature)) return;
      if (this.initialized.has(name)) { this.healthy.add(name); return; }
      this.initialized.add(name);
      try {
        await window[name].init();
        this.healthy.add(name);
      } catch (err) {
        // One broken page must never stop the rest of the app from loading.
        console.error(`${name} failed to start`, err);
        Utils.toast(`${name} couldn't load: ${err.message}`, 'error');
      }
    }));
  },

  go(view, opts = {}) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    // A member's profile lives under "Members" in the nav.
    const navView = view === 'member-profile' ? 'members' : view;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === navView));
    const target = document.getElementById('view-' + view);
    if (target) target.classList.add('active');
    this.currentView = view;
    this.closeNav();
    window.scrollTo(0, 0);

    if (opts.skipRefresh) return;
    // Lazy refresh per view so data is current when you land on it.
    const refreshers = {
      dashboard: () => Dashboard.load(),
      members: () => Members.loadList(),
      classes: () => Classes.load(),
      checkout: () => Checkout.reset(opts.memberId),
      transactions: () => Transactions.load(),
      notifications: () => Notifications.load(),
      reports: () => Reports.load(),
      staff: () => Staff.load(),
      audit: () => AuditView.load(),
      settings: () => Settings.load(),
    };
    if (refreshers[view]) {
      Promise.resolve()
        .then(refreshers[view])
        .catch(err => { console.error(err); Utils.toast(err.message || 'Could not load this page', 'error'); });
    }
  },

  // ---------- idle sign-out (shared tills: don't leave a session open) ----------
  IDLE_MINUTES: 30,
  idleTimer: null,
  idleExpired: false,
  idleBound: false,

  startIdleTimer() {
    const reset = () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.idleExpired = true;
        Auth.logout();
      }, this.IDLE_MINUTES * 60 * 1000);
    };
    if (!this.idleBound) {
      this.idleBound = true;
      let last = 0;
      ['click', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach(ev =>
        document.addEventListener(ev, () => {
          if (!Auth.currentUser) return;
          const now = Date.now();
          if (now - last > 5000) { last = now; reset(); } // throttle: mousemove fires constantly
        }, { passive: true }));
    }
    reset();
  },
  stopIdleTimer() { clearTimeout(this.idleTimer); },

  // ---------- mobile drawer ----------
  openNav() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('nav-scrim').classList.add('open');
    document.getElementById('btn-nav-toggle').setAttribute('aria-expanded', 'true');
  },
  closeNav() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('nav-scrim').classList.remove('open');
    document.getElementById('btn-nav-toggle').setAttribute('aria-expanded', 'false');
  },

  closeOverlay(ov) {
    // The scanner has to release the camera, not just hide the modal.
    if (ov.id === 'modal-scanner') Scanner.close();
    else ov.classList.remove('open');
  },

  /** Attach every global handler exactly once (this file runs boot code on every sign-in). */
  wireOnce() {
    if (this.wired) return;
    this.wired = true;

    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        if (!Auth.can(item.dataset.requires)) return Utils.toast('You don\'t have access to that section', 'error');
        this.go(item.dataset.view);
      });
    });

    document.getElementById('btn-nav-toggle').addEventListener('click', () => {
      document.getElementById('sidebar').classList.contains('open') ? this.closeNav() : this.openNav();
    });
    document.getElementById('nav-scrim').addEventListener('click', () => this.closeNav());

    // Any element marked data-add-member opens the "Add member" form, from any page.
    // data-view-link="checkout" jumps to a page.
    document.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-member]');
      if (add) { this.closeNav(); Members.openForm(); return; }
      const link = e.target.closest('[data-view-link]');
      if (link) this.go(link.dataset.viewLink);
    });

    document.querySelectorAll('.overlay').forEach(ov => {
      ov.addEventListener('click', (e) => { if (e.target === ov) this.closeOverlay(ov); });
    });
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => this.closeOverlay(btn.closest('.overlay')));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.overlay.open');
      if (open.length) this.closeOverlay(open[open.length - 1]);
      else this.closeNav();
    });
  },
};

// ---------------- Login ----------------
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    await Auth.login(email, password);
  } catch (err) {
    console.error('Sign-in failed:', err.code, err.message);
    const msgs = {
      'auth/invalid-email': 'That email address isn\'t valid.',
      'auth/user-not-found': 'No account exists for that email. Ask a Super Admin to create one under Authentication → Users, or Staff & Roles.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/invalid-login-credentials': 'Incorrect email or password.',
      'auth/user-disabled': 'This account has been disabled.',
      'auth/too-many-requests': 'Too many failed attempts. Wait a few minutes and try again.',
      'auth/network-request-failed': 'Network problem. Check your connection.',
      'auth/api-key-not-valid': 'invalid API key .',
      'auth/invalid-api-key': 'Firebase isn\'t configured correctly (invalid API key in js/firebase-config.js).',
      'auth/configuration-not-found': 'Email/Password sign-in isn\'t enabled for this Firebase project (Authentication → Sign-in method).',
    };
    errEl.textContent = msgs[err.code] ||
      (err.code ? `Could not sign in (${err.code}).` : 'Could not sign in — is js/firebase-config.js set up? Check the browser console for details.');
  }
});

document.getElementById('btn-logout').addEventListener('click', () => Auth.logout());

document.getElementById('btn-forgot').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const errEl = document.getElementById('login-error');
  const noteEl = document.getElementById('login-note');
  errEl.textContent = ''; noteEl.textContent = '';
  if (!email) { errEl.textContent = 'Type your email above first, then press "Forgot password?".'; return; }
  try {
    await Auth.resetPassword(email);
    noteEl.textContent = 'If an account exists for that email, a reset link has been sent.';
  } catch (err) {
    console.error('Password reset failed:', err.code, err.message);
    const msgs = {
      'auth/invalid-email': 'That email address isn\'t valid.',
      'auth/network-request-failed': 'Network problem reaching Firebase.',
      'auth/too-many-requests': 'Too many attempts. Wait a few minutes.',
    };
    errEl.textContent = msgs[err.code] || ('Could not send reset email (' + (err.code || err.message) + ')');
  }
});

// ---------------- Boot ----------------
Auth.init(async (user, err) => {
  if (user) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.add('ready');
    document.getElementById('who-name').textContent = Auth.profile.name || Auth.currentUser.email;
    document.getElementById('who-role').textContent = ROLE_LABEL[Auth.profile.role] || Auth.profile.role;
    App.wireOnce();
    App.startIdleTimer();
    await App.loadAllModules();
    // Dashboard.init() already loaded its data, so don't fetch it twice.
    App.go('dashboard', { skipRefresh: App.healthy.has('Dashboard') });
  } else {
    App.healthy.clear(); // next sign-in must refresh, not show the last user's data
    App.stopIdleTimer();
    document.getElementById('login-note').textContent = App.idleExpired
      ? 'You were signed out after ' + App.IDLE_MINUTES + ' minutes of inactivity.' : '';
    App.idleExpired = false;
    document.querySelectorAll('.overlay.open').forEach(ov => ov.classList.remove('open'));
    document.getElementById('login-screen').style.display = 'grid';
    document.getElementById('app').classList.remove('ready');
    if (err) {
      const deactivated = err.code === 'staff/deactivated';
      document.getElementById('login-error').textContent = deactivated
        ? 'This account has been deactivated. Please contact a Super Admin.' :
        'Signed in, but the staff profile could not be loaded (' + (err.code || err.message) +
        '). If this is a new project, deploy the Firestore rules: firebase deploy --only firestore:rules';
      auth.signOut();
    }
  }
});

window.App = App;