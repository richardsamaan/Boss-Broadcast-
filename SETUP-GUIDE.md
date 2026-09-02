# BOSS Broadcast — Cloud API Setup Guide

## What's actually done vs. what needs your action

**Fully built, tested, ready to deploy:** the Cloud Functions backend (16/16 tests passing against Meta's real, verified API schema), the Firestore security rules, and the frontend's "Send Full Campaign Now" panel with live delivery tracking.

**Cannot be done by me, only by you as the verified business owner:** every step in Part A below. Meta requires these to come directly from the business — there's no way around that, for anyone.

---

## Part A — Steps only you can complete

1. **Create a Meta Business Account** at business.facebook.com, if you don't already have one for BOSS Bahrain.
2. **Add WhatsApp Business Platform** to that Business Account, and register your store's phone number (your existing number can be migrated in — you won't lose it).
3. **Verify your business** with Meta (business documents, typically a 1–3 day review).
4. **Create at least one Marketing message template:**
   - One with an **Image header** (for the poster) + a body with a `{{1}}` variable for the customer's name.
   - If you also want the PDF catalogue sent automatically, a **second template** with a **Document header** — WhatsApp templates carry exactly one media attachment each, so image + PDF together always means two separate approved templates, sent as two messages.
   - Submit both for Meta's approval (usually within a day, sometimes longer).
5. **Collect your 3 real credentials** from Meta: the permanent access token, your Phone Number ID, and your WhatsApp Business Account ID.
6. **Upgrade your Firebase project to the Blaze (pay-as-you-go) plan.** Cloud Functions do not run on the free Spark plan — this is unavoidable for real backend automation. Blaze has no monthly minimum; you only pay for what you actually use.

---

## Part B — Deploying what I built

1. Install the Firebase CLI if you haven't already (`npm install -g firebase-tools`), then `firebase login`.
2. In the `functions/` folder, run `npm install`.
3. Set your real credentials as Firebase Secrets (never paste them directly into code):
   ```
   firebase functions:secrets:set WHATSAPP_TOKEN
   firebase functions:secrets:set WHATSAPP_PHONE_NUMBER_ID
   firebase functions:secrets:set WHATSAPP_WEBHOOK_VERIFY_TOKEN
   ```
   (For the verify token, just make up any random string yourself — you'll enter that same string in Meta's webhook setup screen in Part C.)
4. Deploy: `firebase deploy --only functions,firestore:rules`.
5. Note the URL Firebase gives you for `whatsappWebhook` — you'll need it next.
6. In `index-with-api.html`, replace the placeholder `FIREBASE_CONFIG` values with your real Firebase project's config (found in Firebase Console → Project Settings).
7. Deploy `index-with-api.html` (renamed to `index.html`) the same way as your other tools.

## Part C — Connecting Meta to your backend

1. In Meta's WhatsApp Business Platform settings, find the **Webhooks** section.
2. Enter the `whatsappWebhook` URL from Part B, step 5.
3. Enter the same random verify token you set in Part B, step 3.
4. Subscribe to the **messages** field — this is what delivers sent/delivered/read/failed status updates back into your live dashboard.

## Part D — Creating an Admin login for the tool

The "Send Full Campaign" panel requires a real sign-in (not the anonymous session pattern BOSS CRM uses), because only a verified Admin should be able to trigger real spend and real customer messages.

1. In Firebase Console → Authentication → Sign-in method, enable **Email/Password**.
2. Add yourself as a user (Authentication → Users → Add user) with your email and a password.
3. Set the `admin` custom claim on your account — this requires running a one-time script (I can write this exact script for you when you're ready for this step; it's a five-line Node script using the Firebase Admin SDK).

---

## Realistic timeline and cost, honestly

- **Setup time:** likely 3–7 days total, mostly waiting on Meta's business verification and template approval — not something that can be rushed by more engineering effort.
- **Ongoing cost:** roughly $0.01–$0.05+ per marketing message depending on the recipient's country (verified current rates as of this conversation), no monthly minimum on Meta's side. A campaign to 500 customers is roughly $10–$25 in message fees alone.
- **Until Part A–D are complete,** the existing manual-send panel (still fully intact in this same file) continues to work exactly as before — you're never left without a working tool while Meta's approval is pending.
