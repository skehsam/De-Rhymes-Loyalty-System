# De Rhymes Loyalty Console

A customer loyalty management platform for De Rhymes Nigeria Limited — members,
purchases, points, customer classes, QR/barcode identification, redemptions,
and notifications. Plain HTML/CSS/JS on the frontend, Firebase (Auth +
Firestore) as the backend. No build step — open it, or host it as static files.

## 1. Set up Firebase

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Build → Authentication → Sign-in method** → enable **Email/Password**.
3. **Build → Firestore Database** → Create database (start in production mode).
4. **Project settings → Your apps → Web app** → copy the config object into
   `js/firebase-config.js` (replace the `YOUR_...` placeholders).
5. Install the Firebase CLI (`npm install -g firebase-tools`), then from this
   folder:
   ```
   firebase login
   firebase init firestore   # point it at this same project, keep the default rules file
   firebase deploy --only firestore:rules
   ```
   This deploys `firestore.rules`, which enforces the same role permissions
   the UI does (staff/manager/superadmin) — see §6 below.

## 2. Run it

Any static file server works, e.g.:
```
npx serve .
```
or just open `index.html` directly in a browser (camera scanning requires
`https://` or `localhost`, so use a local server rather than a bare `file://`
URL if you want to test QR/barcode scanning).

## 3. First sign-in

There's no seed data. Create a user under **Authentication → Users → Add
user** in the Firebase console (or sign up via a temporary form — the app
itself only exposes sign-in). **The very first person to sign in becomes
Super Admin automatically.** Every sign-in after that defaults to the Staff
role until a Super Admin promotes them from the **Staff & Roles** page.

Then, as Super Admin:
1. **Loyalty Settings** — set the base earning rule (₦ per point) and point value.
2. **Customer Classes** — create your tiers (Standard, Silver, Gold, VIP, or
   your own) with multipliers and spend thresholds.
3. Start adding members from the **Members** page.

## 4. What's implemented

- Email/password auth with three roles (Super Admin / Manager / Staff) and
  role-gated navigation + Firestore rules
- Member registration with auto-generated Member ID (`DRL-000001`), QR code
  and barcode, digital membership card (viewable + printable)
- Universal search by name, phone, email, Member ID, or scan
- Fast 4-step checkout flow: identify → profile → amount → confirm, with the
  exact `basePoints = floor(amount / baseAmount) * basePoints` then
  `finalPoints = basePoints * classMultiplier` formula from the spec
- Every purchase transaction stores a **rule snapshot** (base rule,
  multiplier, point value at that moment) so editing rules later never
  rewrites history
- Redemption, manual adjustment (with mandatory reason), and refund
  (reverses points, keeps both transactions) flows
- Optional automatic class upgrade/downgrade by total spend, with class
  history kept per member
- Append-only transaction ledger, notification log, and audit log
  (Firestore rules make transactions/classHistory/auditLog un-editable
  after creation)
- Dashboard with the stat cards from the spec and a 7-day purchase chart
- Camera-based QR/barcode scanning (`html5-qrcode`) for the till and for
  member lookup

## 5. What needs one more step: sending WhatsApp/email

A browser can't call the WhatsApp Business Cloud API or an email provider
directly — those need a secret API key, which must live on a server, not in
client-side JS. So the app **queues** a notification (writes a `Pending` row
to `/notifications` after every purchase, redemption, and class upgrade) and
that's as far as pure client-side code can safely go.

`functions/index.js` is a ready-to-deploy Cloud Function that watches that
collection and actually sends the message, using Meta's WhatsApp Cloud API
and SendGrid as concrete examples (swap for Twilio, Termii, or your own
provider — the shape stays the same). To turn it on:

```
cd functions
npm install
firebase functions:config:set \
  whatsapp.token="..." whatsapp.phone_id="..." \
  sendgrid.key="..."
firebase deploy --only functions
```

Until you deploy this, notifications will sit in the **Notification Log**
page as "Pending" — which is honest, not broken: the UI, data model, and
per-member/global on-off toggles are all fully wired, only the last-mile
delivery needs your provider credentials.

### Birthday messages

`functions/index.js` also includes `sendBirthdayMessages`, a scheduled
function that runs once a day (default 8am `Africa/Lagos`, edit the
`.schedule(...)`/`.timeZone(...)` calls to change it). It messages every
active member whose date of birth matches today, using the editable
**Birthday** template under Loyalty Settings → Notification templates, and
stamps `lastBirthdayYear` on the member so nobody gets it twice in one year.
Turn it off any time with the **Birthday messages enabled** checkbox in
Loyalty Settings.

Scheduled functions need the **Blaze (pay-as-you-go)** plan and the Cloud
Scheduler API enabled — `firebase deploy --only functions` will prompt you
to enable it the first time. A staff member can also send one member a
birthday message immediately from their profile page ("🎂 Send birthday
message"), independent of the daily schedule.

## 6. Roles

| Action | Staff | Manager | Super Admin |
|---|---|---|---|
| Search, scan, record purchases | ✅ | ✅ | ✅ |
| Redeem points | ✅ | ✅ | ✅ |
| Manual point adjustment / refunds | – | ✅ | ✅ |
| Manage customer classes, loyalty rules | – | – | ✅ |
| Manage staff roles | – | – | ✅ |
| View audit log | – | – | ✅ |

Enforced both in the UI (`js/auth.js` → `PERMISSIONS`) and in
`firestore.rules`, so a Staff account can't bypass this by calling Firestore
directly from the browser console.

## 7. Data model (Firestore collections)

- `staff/{uid}` — name, email, role
- `members/{memberId}` — profile fields, `points`, `totalSpent`, `classId`,
  `qrValue`/`barcodeValue` (both equal the Member ID), notification prefs
- `classes/{id}` — name, multiplier, min/max spend, benefits, status
- `settings/loyalty` — `baseSpendAmount`, `basePointsAwarded`, `pointValue`,
  `autoClassAssignment`, `whatsappEnabled`, `emailEnabled`
- `transactions/{id}` — every Purchase / Points Redeemed / Manual Adjustment
  / Refund / Class Upgrade, append-only, with the rule snapshot on purchases
- `classHistory/{id}` — previous → new class, reason, date
- `notifications/{id}` — channel, message, status, deliveryStatus
- `auditLog/{id}` — every settings/class/staff change, append-only
- `counters/memberId` — the running sequence used to mint `DRL-000001` etc.

## 8. Designed to grow into

The data model already carries a `memberId`-keyed structure that a `branchId`
field can be added to without restructuring anything, and the class/settings
model is fully dynamic (no hard-coded tiers) — so birthday rewards, referral
points, promotional multipliers, points expiration, and multi-branch support
(spec §31) are additive, not rewrites.