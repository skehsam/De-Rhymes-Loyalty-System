/**
 * ============================================================
 * De Rhymes Loyalty — notification sender (optional Cloud Function)
 * ============================================================
 *
 * The browser app only WRITES a "Pending" row to /notifications when a
 * purchase, redemption, or class change happens (see DB.queueNotification
 * in js/db.js). It cannot call WhatsApp's Business API or send email
 * directly — that needs a server holding API credentials, which is what
 * this function is for.
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase functions:config:set
 *     whatsapp.token="YOUR_META_CLOUD_API_TOKEN"
 *     whatsapp.phone_id="YOUR_PHONE_NUMBER_ID"
 *     sendgrid.key="YOUR_SENDGRID_API_KEY"
 *   firebase deploy --only functions
 *
 * Swap in whichever providers you actually use — Meta's WhatsApp Cloud
 * API and SendGrid are used below only as concrete, working examples.
 * Twilio WhatsApp, Termii, or any transactional email provider all fit
 * the same shape: read the pending doc, send, write the result back.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

exports.sendNotification = functions.firestore
  .document('notifications/{id}')
  .onWrite(async (change) => {
    // onWrite (not onCreate) so the app's "Retry" button works: retrying flips an
    // existing doc back to Pending, which onCreate would never see.
    if (!change.after.exists) return null;
    const snap = change.after;
    const before = change.before.exists ? change.before.data() : null;
    if (before && before.status === 'Pending') return null; // only react when a doc *becomes* Pending
    const notif = snap.data();
    if (notif.status !== 'Pending') return null;

    try {
      if (notif.channel === 'WhatsApp') {
        await sendWhatsApp(notif);
      } else if (notif.channel === 'Email') {
        await sendEmail(notif);
      }
      await snap.ref.update({ status: 'Sent', deliveryStatus: 'Delivered' });
    } catch (err) {
      console.error('Notification failed:', err);
      await snap.ref.update({ status: 'Failed', deliveryStatus: 'Failed', error: String(err) });
    }
    return null;
  });

async function sendWhatsApp(notif) {
  const member = await db.collection('members').doc(notif.memberId).get();
  const phone = member.data()?.phone;
  if (!phone) throw new Error('Member has no phone number on file');

  const token = functions.config().whatsapp?.token;
  const phoneId = functions.config().whatsapp?.phone_id;
  if (!token || !phoneId) throw new Error('WhatsApp credentials not configured');

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone.replace(/^0/, '234'), // adjust to your member phone format
      type: 'text',
      text: { body: notif.message },
    }),
  });
  if (!res.ok) throw new Error('WhatsApp API error: ' + (await res.text()));
}

/**
 * Runs once a day and messages every active member whose date of birth
 * (stored as 'YYYY-MM-DD' from the member form's <input type="date">) falls
 * on today's month/day. `lastBirthdayYear` on the member doc stops a member
 * from getting two birthday messages in the same year even if this function
 * is deployed/redeployed or re-triggered.
 *
 * Requires the Blaze (pay-as-you-go) plan and the Cloud Scheduler API — see
 * README §5. Change the schedule/timezone below to suit your store.
 */
exports.sendBirthdayMessages = functions.pubsub
  .schedule('0 8 * * *')
  .timeZone('Africa/Lagos')
  .onRun(async () => {
    const now = new Date();
    const monthDay = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const year = now.getFullYear();

    const settingsSnap = await db.collection('settings').doc('loyalty').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    if (settings.birthdayEnabled === false) {
      console.log('Birthday messages are turned off in Loyalty Settings — skipping.');
      return null;
    }

    const templatesSnap = await db.collection('settings').doc('templates').get();
    const templates = templatesSnap.exists ? templatesSnap.data() : {};
    const template = (templates.Birthday && String(templates.Birthday).trim())
      || 'Happy birthday, {name}! 🎉 Here\'s to another great year with De Rhymes.';

    const membersSnap = await db.collection('members').where('status', '==', 'active').get();

    let queued = 0;
    for (const doc of membersSnap.docs) {
      const m = doc.data();
      if (!m.dob || String(m.dob).slice(5, 10) !== monthDay) continue;
      if (m.lastBirthdayYear === year) continue; // already messaged this year

      const prefs = m.notificationPrefs || { whatsapp: true, email: true };
      const channels = [];
      if (settings.whatsappEnabled !== false && prefs.whatsapp) channels.push('WhatsApp');
      if (settings.emailEnabled !== false && prefs.email) channels.push('Email');
      if (!channels.length) { await doc.ref.update({ lastBirthdayYear: year }); continue; }

      const message = template
        .replace(/\{name\}/g, m.fullName || 'there')
        .replace(/\{memberId\}/g, m.memberId || '');

      for (const channel of channels) {
        await db.collection('notifications').add({
          memberId: m.memberId, memberName: m.fullName, channel, type: 'Birthday',
          message, status: 'Pending', deliveryStatus: 'Pending',
          sentDate: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await doc.ref.update({ lastBirthdayYear: year });
      queued++;
    }
    console.log(`Birthday messages queued for ${queued} member(s).`);
    return null;
  });

async function sendEmail(notif) {
  const member = await db.collection('members').doc(notif.memberId).get();
  const email = member.data()?.email;
  if (!email) throw new Error('Member has no email on file');

  const key = functions.config().sendgrid?.key;
  if (!key) throw new Error('SendGrid key not configured');

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: { email: 'loyalty@derhymes.ng', name: 'De Rhymes Loyalty' },
      subject: 'Your De Rhymes Loyalty Update',
      content: [{ type: 'text/plain', value: notif.message }],
    }),
  });
  if (!res.ok) throw new Error('SendGrid error: ' + (await res.text()));
}