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