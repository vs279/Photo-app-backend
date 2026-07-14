// ============================================================================
// Photo App — Stripe Connect backend
// ----------------------------------------------------------------------------
// What this does:
//   1. Lets a HOST connect their own Stripe account (Stripe Connect onboarding).
//   2. Lets a GUEST pay per photo (£7 each / £15 per 4) via Stripe Checkout.
//   3. Sends the money straight to the HOST's connected Stripe account.
//   4. Confirms completed payments via a Stripe webhook so photos unlock.
//
// This is intentionally simple and uses an in-memory store for demo clarity.
// For production, replace the `db` object with a real database (Postgres, etc.).
// ============================================================================

import express from "express";
import cors from "cors";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  FRONTEND_URL = "http://localhost:5173",
  BACKEND_URL = "http://localhost:4242",
  PLATFORM_FEE_PERCENT = "0",
  PORT = 4242,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error("Missing STRIPE_SECRET_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// CORS: allow the configured frontend(s), plus any *.netlify.app site.
// Tolerant of trailing slashes and missing config so the app isn't silently blocked.
const allowed = (FRONTEND_URL || "")
  .split(",")
  .map(s => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // non-browser or same-origin
    const clean = origin.replace(/\/+$/, "");
    if (allowed.includes(clean)) return cb(null, true);
    if (/\.netlify\.app$/i.test(clean)) return cb(null, true); // any Netlify site
    if (allowed.includes("*")) return cb(null, true);
    return cb(null, true); // be permissive: this backend has no sensitive GET data
  },
}));

// ── Simple in-memory store (swap for a real DB in production) ───────────────
// hostId -> { stripeAccountId, chargesEnabled }
const db = {
  hosts: {},
  // sessionId -> { hostId, albumId, photoIds }
  pendingPurchases: {},
  // photoId -> true  (photos the platform has confirmed as paid)
  paidPhotos: {},
  // albumCode -> { id, name, hostId, watermarkEnabled, photos: [...] }
  albums: {},
};

// Pricing (in pence). £7 single, £15 for a group of 4.
const PRICE_SINGLE = 700;
const PRICE_BUNDLE4 = 1500;
function priceForPence(n) {
  const bundles = Math.floor(n / 4);
  const singles = n % 4;
  return bundles * PRICE_BUNDLE4 + singles * PRICE_SINGLE;
}

// ============================================================================
// STRIPE WEBHOOK  (must be registered BEFORE express.json — needs raw body)
// ============================================================================
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Payment finished successfully → mark those photos as paid
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // (a) A host subscription checkout completed → activate that host.
    if (session.mode === "subscription" && session.metadata?.hostId) {
      const hostId = session.metadata.hostId;
      db.subscriptions[hostId] = {
        active: true,
        plan: session.metadata.plan || "monthly",
        customerId: session.customer,
        subscriptionId: session.subscription,
      };
      console.log(`✅ Host ${hostId} subscription active (${session.metadata.plan}).`);
    } else {
      // (b) A guest photo purchase completed → unlock those photos.
      const purchase = db.pendingPurchases[session.id];
      if (purchase) {
        purchase.photoIds.forEach((id) => { db.paidPhotos[id] = true; });
        delete db.pendingPurchases[session.id];
        console.log(`✅ Paid: ${purchase.photoIds.length} photo(s) for album ${purchase.albumId}`);
      }
    }
  }

  // A host's subscription was cancelled or expired → deactivate them.
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const entry = Object.entries(db.subscriptions).find(([, v]) => v.subscriptionId === sub.id);
    if (entry) { db.subscriptions[entry[0]].active = false; console.log(`Host ${entry[0]} subscription ended.`); }
  }

  // A connected host finished (or updated) onboarding
  if (event.type === "account.updated") {
    const acct = event.data.object;
    const host = Object.values(db.hosts).find((h) => h.stripeAccountId === acct.id);
    if (host) host.chargesEnabled = acct.charges_enabled;
  }

  res.json({ received: true });
});

// JSON parsing for all the normal routes (after the webhook)
app.use(express.json({ limit: "25mb" }));

// ============================================================================
// 1) HOST: connect a Stripe account (Stripe Connect onboarding)
// ============================================================================
// Frontend calls this when the host taps "Connect to Stripe".
// Returns a URL to redirect the host to; they finish onboarding on Stripe.
app.post("/connect/start", async (req, res) => {
  try {
    const { hostId, email } = req.body;
    if (!hostId) return res.status(400).json({ error: "hostId required" });

    let host = db.hosts[hostId];

    // Create the connected account once, reuse it after.
    if (!host?.stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      host = db.hosts[hostId] = { stripeAccountId: account.id, chargesEnabled: false };
    }

    // One-time onboarding link
    const safeFront = (FRONTEND_URL && FRONTEND_URL.startsWith("http")) ? FRONTEND_URL : BACKEND_URL;
    const link = await stripe.accountLinks.create({
      account: host.stripeAccountId,
      refresh_url: `${BACKEND_URL}/connect/refresh?hostId=${encodeURIComponent(hostId)}`,
      return_url: `${safeFront}?stripe=connected`,
      type: "account_onboarding",
    });

    res.json({ url: link.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// If the onboarding link expires, mint a fresh one.
app.get("/connect/refresh", async (req, res) => {
  try {
    const host = db.hosts[req.query.hostId];
    if (!host) return res.redirect(FRONTEND_URL);
    const link = await stripe.accountLinks.create({
      account: host.stripeAccountId,
      refresh_url: `${BACKEND_URL}/connect/refresh?hostId=${encodeURIComponent(req.query.hostId)}`,
      return_url: `${FRONTEND_URL}?stripe=connected`,
      type: "account_onboarding",
    });
    res.redirect(link.url);
  } catch (err) {
    res.redirect(FRONTEND_URL);
  }
});

// Frontend can poll this to show "Connected ✓" and the account status.
app.get("/connect/status", async (req, res) => {
  const host = db.hosts[req.query.hostId];
  if (!host) return res.json({ connected: false });
  try {
    const acct = await stripe.accounts.retrieve(host.stripeAccountId);
    host.chargesEnabled = acct.charges_enabled;
    res.json({
      connected: true,
      chargesEnabled: acct.charges_enabled,
      accountId: host.stripeAccountId,
      name: acct.business_profile?.name || acct.email || host.stripeAccountId,
    });
  } catch (err) {
    res.json({ connected: false });
  }
});

// ============================================================================
// 2) GUEST: pay for photos → money goes to the host's connected account
// ============================================================================
app.post("/checkout", async (req, res) => {
  try {
    const { hostId, albumId, albumName, photoIds } = req.body;
    if (!hostId || !Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: "hostId and photoIds required" });
    }

    const host = db.hosts[hostId];
    if (!host?.stripeAccountId || !host.chargesEnabled) {
      return res.status(400).json({ error: "This host hasn't finished connecting Stripe yet." });
    }

    const amount = priceForPence(photoIds.length);
    const feePercent = Number(PLATFORM_FEE_PERCENT) || 0;
    const applicationFee = Math.round(amount * (feePercent / 100));

    // Destination charge: customer pays the platform, money is transferred to the host.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `${photoIds.length} photo${photoIds.length > 1 ? "s" : ""} — ${albumName || "Album"}`,
              description: "Watermark removed + full-resolution download",
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),
        transfer_data: { destination: host.stripeAccountId },
      },
      success_url: `${FRONTEND_URL}?album=${encodeURIComponent(albumId)}&paid=1`,
      cancel_url: `${FRONTEND_URL}?album=${encodeURIComponent(albumId)}&paid=0`,
    });

    db.pendingPurchases[session.id] = { hostId, albumId, photoIds };
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Frontend checks which photos in an album are paid (so they unlock + can download).
app.get("/paid", (req, res) => {
  const ids = (req.query.photoIds || "").split(",").filter(Boolean);
  const paid = ids.filter((id) => db.paidPhotos[id]);
  res.json({ paid });
});

// ============================================================================
// 3) HOST SUBSCRIPTION — the host pays YOU to use the app.
//    Monthly £36.99 or yearly £326.99. This money lands in YOUR Stripe balance
//    (not a connected account), because you are selling the subscription.
// ============================================================================
// hostId -> { active, plan, customerId, subscriptionId }
db.subscriptions = db.subscriptions || {};

app.post("/subscribe", async (req, res) => {
  try {
    const { hostId, email, plan } = req.body; // plan = "monthly" | "yearly"
    if (!hostId || !plan) return res.status(400).json({ error: "hostId and plan required" });

    const amount = plan === "yearly" ? 32699 : 3699; // pence
    const interval = plan === "yearly" ? "year" : "month";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email || undefined,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `Photo App Host — ${plan === "yearly" ? "Yearly" : "Monthly"}`,
            },
            unit_amount: amount,
            recurring: { interval },
          },
          quantity: 1,
        },
      ],
      // Note: no transfer_data here → the money stays with YOU (the platform).
      success_url: `${FRONTEND_URL}?host=active`,
      cancel_url: `${FRONTEND_URL}?host=cancelled`,
      metadata: { hostId, plan },
    });

    db.subscriptions[hostId] = { active: false, plan, pendingSession: session.id };
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Frontend polls this to know if a host's subscription is active.
app.get("/subscription/status", (req, res) => {
  const sub = db.subscriptions[req.query.hostId];
  res.json({ active: !!(sub && sub.active), plan: sub?.plan || null });
});

// Let a host manage/cancel their subscription in Stripe's billing portal.
app.post("/subscription/portal", async (req, res) => {
  try {
    const sub = db.subscriptions[req.body.hostId];
    if (!sub?.customerId) return res.status(400).json({ error: "No active subscription." });
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.customerId,
      return_url: FRONTEND_URL,
    });
    res.json({ url: portal.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ALBUMS — so a guest on ANY device can open an album by its code / QR.
// The host's app pushes album data here; guests fetch it by code.
// ============================================================================
// Host saves/updates an album (called whenever photos are added).
app.post("/album/save", (req, res) => {
  const { album } = req.body;
  if (!album || !album.id) return res.status(400).json({ error: "album with id required" });
  db.albums[album.id] = {
    id: album.id,
    name: album.name || "Album",
    hostId: album.hostId || null,
    watermarkEnabled: album.watermarkEnabled !== false,
    photos: Array.isArray(album.photos) ? album.photos : [],
    updatedAt: Date.now(),
  };
  res.json({ ok: true });
});

// Guest fetches an album by its code (works on any device, anywhere).
app.get("/album/:code", (req, res) => {
  const album = db.albums[(req.params.code || "").toUpperCase()];
  if (!album) return res.status(404).json({ error: "not found" });
  res.json({ album });
});

// ============================================================================
app.get("/", (_req, res) => res.send("Photo App backend is running ✓"));

app.listen(PORT, () => {
  console.log(`Photo App backend listening on port ${PORT}`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  if (Number(PLATFORM_FEE_PERCENT) > 0) console.log(`Platform fee: ${PLATFORM_FEE_PERCENT}%`);
});
