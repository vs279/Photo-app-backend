# Photo App — Going Live with Real Payments

This backend makes the "Connect to Stripe" button and the photo purchases **real**.
Money paid by guests goes straight to each host's own Stripe account.

You do **not** need to be a developer to follow this — just go step by step.

---

## What you'll end up with
- Hosts tap **Connect to Stripe** → finish a short Stripe form → button shows **Connected ✓**.
- Guests tap **Pay** → a real Stripe checkout page → card payment.
- The money lands in **that host's** Stripe account (minus your optional platform fee).
- Paid photos unlock with the watermark removed.

---

## Step 1 — Create a Stripe account
1. Go to https://stripe.com and sign up (free).
2. You'll start in **Test mode** (fake money) — perfect for trying it out.

## Step 2 — Turn on Stripe Connect
1. In the Stripe Dashboard, search for **Connect** and click **Get started**.
2. Choose **Platform or marketplace**. This is what lets each host get paid.

## Step 3 — Get your API key
1. Go to https://dashboard.stripe.com/apikeys
2. Copy the **Secret key** (starts with `sk_test_...`).

## Step 4 — Put the code online (host the backend)
The easiest free option is **Render**:
1. Create a free account at https://render.com
2. Put this `photo-app-backend` folder in a GitHub repo.
3. In Render: **New → Web Service** → connect that repo.
4. Build command: `npm install`   Start command: `npm start`
5. After it deploys you'll get a URL like `https://photo-app-backend.onrender.com`.

(Alternatives: Railway, Fly.io, or any Node host. It just needs to run `npm start`.)

## Step 5 — Set the webhook (so payments confirm)
1. Go to https://dashboard.stripe.com/webhooks → **Add endpoint**.
2. Endpoint URL: `https://YOUR-BACKEND-URL/webhook`
3. Select events: `checkout.session.completed`, `account.updated`, and `customer.subscription.deleted`.
4. After creating it, copy the **Signing secret** (starts with `whsec_...`).

## Step 6 — Fill in your settings
1. Copy `.env.example` to `.env`.
2. Paste in:
   - `STRIPE_SECRET_KEY` = your `sk_test_...` key
   - `STRIPE_WEBHOOK_SECRET` = your `whsec_...` secret
   - `FRONTEND_URL` = where your photo app is hosted (e.g. your Vercel URL)
   - `BACKEND_URL` = the Render URL from step 4
   - `PLATFORM_FEE_PERCENT` = 0 (or e.g. 10 to keep 10% of each sale)
3. On Render, add these same values under **Environment** (don't upload `.env`).

## Step 7 — Point the app at the backend
In the photo app frontend, set the backend URL (see `FRONTEND_CHANGES.md`)
to your Render URL. That's the only change needed in the app itself.

## Step 8 — Test it
1. Host taps **Connect to Stripe**, completes the test onboarding.
2. Guest buys a photo. Use Stripe's test card: **4242 4242 4242 4242**,
   any future expiry, any CVC, any postcode.
3. The photo unlocks; the payment shows in the host's Stripe dashboard.

## Step 9 — Go live for real money
1. In Stripe, finish **activating** your account (business + bank details).
2. Switch your keys from `sk_test_...` to `sk_live_...` (and a live webhook secret).
3. Update those two values on Render. Done — real cards now work.

---

## Money flow & your rules (already built in)
- Each purchase pays out to the **host group that owns the album**.
- Staff **linked** to that host → pay into the same Stripe account.
- Staff/host **not linked** → never receive that money.
- When two hosts **link**, the **inviter's** Stripe account is used for the group.
- Optional `PLATFORM_FEE_PERCENT` lets you (the platform owner) keep a cut.

## Two kinds of payment (both handled by this ONE backend)
1. **Guests pay hosts** for photos (£7 / £15) → money goes to the **host**.
2. **Hosts pay you** to use the app (£36.99/mo or £326.99/yr) → money goes to **you**
   (your Stripe balance). Routes: `/subscribe`, `/subscription/status`,
   `/subscription/portal`. No second backend needed — it's all in here.

## Important notes
- This demo stores data in memory, so it resets on restart. For a real launch,
  swap the `db` object in `server.js` for a database (Postgres, Supabase, etc.).
- Never share your `sk_live_...` key or commit `.env` to GitHub.
