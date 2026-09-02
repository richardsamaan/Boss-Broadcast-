/**
 * BOSS Broadcast — Cloud Functions backend
 * ============================================================
 * This is the piece that makes true one-action bulk sending possible.
 * It calls the OFFICIAL WhatsApp Cloud API (Meta) — never an unofficial
 * or reverse-engineered method — so your store's WhatsApp number is
 * never at risk of being banned for automation.
 *
 * WHAT YOU MUST DO BEFORE THIS CODE CAN SEND A SINGLE MESSAGE
 * (none of these are things I can do on your behalf — Meta only
 * accepts them from the verified business owner):
 *   1. Create a Meta Business Account + WhatsApp Business Platform
 *      connection (business.facebook.com).
 *   2. Verify your business and register your store's phone number
 *      (it CAN be your existing number — Meta walks you through
 *      migrating it).
 *   3. Create and submit at least one Marketing message template
 *      with an Image header (for the poster) and, if you also want
 *      to send the PDF catalogue, a second template with a Document
 *      header — WhatsApp templates carry exactly one media header
 *      each, so image+PDF together requires two approved templates,
 *      sent as two messages. Meta must APPROVE each template before
 *      it can be used (usually within a day, sometimes longer).
 *   4. Get your three real credentials from Meta and set them below:
 *      WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID.
 *   5. Deploy this to Firebase (requires the Blaze pay-as-you-go
 *      plan — Cloud Functions do not run on the free Spark plan).
 *
 * Until all five are done, sendCampaign will fail with a clear error
 * explaining which credential is missing — it will never silently
 * pretend to have sent something it didn't.
 * ============================================================
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// Store these as Firebase Secrets (never hardcode real credentials in source):
//   firebase functions:secrets:set WHATSAPP_TOKEN
//   firebase functions:secrets:set WHATSAPP_PHONE_NUMBER_ID
//   firebase functions:secrets:set WHATSAPP_WEBHOOK_VERIFY_TOKEN
const WHATSAPP_TOKEN = defineSecret('WHATSAPP_TOKEN');
const WHATSAPP_PHONE_NUMBER_ID = defineSecret('WHATSAPP_PHONE_NUMBER_ID');
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = defineSecret('WHATSAPP_WEBHOOK_VERIFY_TOKEN');

const GRAPH_API_VERSION = 'v22.0'; // update if Meta deprecates this version

/* ---------------------------------------------------------------
   Sends ONE WhatsApp template message to ONE recipient.
   Exported separately from sendCampaign so it can be unit-tested
   in isolation with a mocked fetch, without needing real credentials.
--------------------------------------------------------------- */
async function sendOneTemplateMessage({ phoneNumberId, token, to, templateName, languageCode, headerType, headerLink, headerFilename, bodyParams }, fetchImpl = fetch){
  const components = [];

  if(headerType && headerLink){
    const mediaParam = headerType === 'document'
      ? { type: 'document', document: { link: headerLink, filename: headerFilename || 'catalogue.pdf' } }
      : { type: 'image', image: { link: headerLink } };
    components.push({ type: 'header', parameters: [mediaParam] });
  }

  if(bodyParams && bodyParams.length > 0){
    components.push({
      type: 'body',
      parameters: bodyParams.map(text => ({ type: 'text', text }))
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'en_US' },
      components
    }
  };

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if(!res.ok){
    const err = new Error((data.error && data.error.message) || `WhatsApp API error (HTTP ${res.status})`);
    err.metaCode = data.error && data.error.code;
    err.metaSubcode = data.error && data.error.error_subcode;
    err.status = res.status;
    throw err;
  }
  // Successful response includes messages[0].id — Meta's own message ID,
  // which is what the delivery-status webhook will later reference.
  return data.messages && data.messages[0] && data.messages[0].id;
}

/* ---------------------------------------------------------------
   Retry wrapper — handles transient failures (network blips, Meta's
   own rate limiting on HTTP 429) without giving up immediately.
   Does NOT retry on errors a retry can never fix (bad phone number,
   template not approved, etc.) — those fail fast with a clear reason.
--------------------------------------------------------------- */
async function withRetry(fn, { attempts = 3, baseDelayMs = 800 } = {}){
  let lastErr;
  for(let i = 0; i < attempts; i++){
    try{
      return await fn();
    }catch(e){
      lastErr = e;
      const retryable = e.status === 429 || e.status >= 500 || !e.status;
      if(!retryable || i === attempts - 1) throw e;
      await new Promise(res => setTimeout(res, baseDelayMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------
   sendCampaign — the actual "one action sends to everyone" endpoint.
   Called by the BOSS Broadcast frontend once an admin taps "Send Campaign".
--------------------------------------------------------------- */
exports.sendCampaign = onCall(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID] },
  async (request) => {
    if(!request.auth){
      throw new HttpsError('unauthenticated', 'You must be signed in to send a campaign.');
    }
    // Admin-only — mirrors the role check already used in BOSS CRM.
    const isAdmin = request.auth.token && request.auth.token.role === 'admin';
    if(!isAdmin){
      throw new HttpsError('permission-denied', 'Only an Admin can send a campaign to customers.');
    }

    const { campaignId } = request.data || {};
    if(!campaignId){
      throw new HttpsError('invalid-argument', 'campaignId is required.');
    }

    const campaignRef = db.collection('campaigns').doc(campaignId);
    const campaignSnap = await campaignRef.get();
    if(!campaignSnap.exists){
      throw new HttpsError('not-found', 'Campaign not found.');
    }
    const campaign = campaignSnap.data();

    const token = WHATSAPP_TOKEN.value();
    const phoneNumberId = WHATSAPP_PHONE_NUMBER_ID.value();
    if(!token || !phoneNumberId){
      throw new HttpsError('failed-precondition',
        'WhatsApp API credentials are not configured yet. Complete Meta Business setup and set WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID before sending a real campaign.');
    }

    const recipients = campaign.recipients || []; // [{ id, name, phone }]
    if(recipients.length === 0){
      throw new HttpsError('invalid-argument', 'This campaign has no recipients.');
    }

    await campaignRef.update({ status: 'sending', startedAt: admin.firestore.FieldValue.serverTimestamp() });

    let sentCount = 0, failedCount = 0;

    // Sequential, not parallel — Meta's default throughput is generous, but
    // going one-at-a-time keeps this safely under any tier limit on a new
    // WhatsApp Business number (new numbers start on the lowest tier).
    for(const recipient of recipients){
      const recipientRef = campaignRef.collection('recipients').doc(recipient.id);
      try{
        const messageId = await withRetry(() => sendOneTemplateMessage({
          phoneNumberId, token,
          to: recipient.phone,
          templateName: campaign.templateName,
          languageCode: campaign.languageCode,
          headerType: campaign.headerType,   // 'image' or 'document'
          headerLink: campaign.posterUrl,    // public HTTPS URL (e.g. Firebase Storage)
          headerFilename: campaign.pdfFilename,
          bodyParams: campaign.bodyParams ? campaign.bodyParams.map(p => p === '{{name}}' ? recipient.name : p) : []
        }));
        await recipientRef.set({
          name: recipient.name, phone: recipient.phone,
          status: 'sent', whatsappMessageId: messageId,
          sentAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        sentCount++;
      }catch(e){
        await recipientRef.set({
          name: recipient.name, phone: recipient.phone,
          status: 'failed', errorMessage: e.message,
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        failedCount++;
      }
      // Keep the live progress counters on the campaign doc itself updating
      // as we go, so the frontend's real-time dashboard moves in step with
      // actual sends rather than jumping to a final number at the end.
      await campaignRef.update({ sentCount, failedCount });
    }

    await campaignRef.update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      sentCount, failedCount
    });

    return { sentCount, failedCount, total: recipients.length };
  }
);

/* ---------------------------------------------------------------
   Webhook — Meta calls this to report delivery status (sent →
   delivered → read, or failed) for every message this app sends.
   This is real delivery tracking; nothing client-side could ever
   provide this, since only Meta's servers know if a message actually
   reached the recipient's phone.
--------------------------------------------------------------- */
exports.whatsappWebhook = onRequest(
  { secrets: [WHATSAPP_WEBHOOK_VERIFY_TOKEN] },
  async (req, res) => {
    // Step 1 of Meta's webhook setup: the verification handshake.
    if(req.method === 'GET'){
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if(mode === 'subscribe' && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN.value()){
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
      return;
    }

    // Step 2: actual delivery status events, as they happen.
    if(req.method === 'POST'){
      try{
        const entry = req.body.entry && req.body.entry[0];
        const change = entry && entry.changes && entry.changes[0];
        const statuses = change && change.value && change.value.statuses;
        if(statuses){
          for(const s of statuses){
            // s.status is one of: sent, delivered, read, failed
            // s.id is the WhatsApp message ID we stored as whatsappMessageId
            const matches = await db.collectionGroup('recipients')
              .where('whatsappMessageId', '==', s.id).limit(1).get();
            if(!matches.empty){
              await matches.docs[0].ref.set({
                status: s.status,
                [`${s.status}At`]: admin.firestore.FieldValue.serverTimestamp()
              }, { merge: true });
            }
          }
        }
      }catch(e){
        console.error('Webhook processing error:', e);
        // Still return 200 — Meta will keep retrying otherwise, and a
        // transient logging error shouldn't cause a webhook retry storm.
      }
      res.sendStatus(200);
      return;
    }

    res.sendStatus(405);
  }
);

// Exported for the test suite — not part of the public Cloud Functions API.
exports._internal = { sendOneTemplateMessage, withRetry };
