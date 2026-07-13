# Connecting the Photo App frontend to the real backend

Only a few small changes turn the simulated Stripe/payments into real ones.
Open `photo-app.jsx` and make these edits.

---

## 1) Add your backend URL (top of the file, near the other constants)

```js
const BACKEND_URL = "https://YOUR-BACKEND-URL"; // e.g. https://photo-app-backend.onrender.com
```

---

## 2) Real "Connect to Stripe" (in `StripeModal`)

Replace the simulated `connect()` with a call that starts real Stripe onboarding:

```js
async function connect() {
  try {
    const res = await fetch(`${BACKEND_URL}/connect/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: ownerIdOf(user), email: user.email }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url; // go to Stripe onboarding
    else setErr(data.error || "Could not start Stripe connection.");
  } catch (e) {
    setErr("Network error connecting to Stripe.");
  }
}
```

To show **Connected ✓** reliably, check status when the modal opens:

```js
useEffect(() => {
  fetch(`${BACKEND_URL}/connect/status?hostId=${ownerIdOf(user)}`)
    .then(r => r.json())
    .then(d => {
      if (d.connected && d.chargesEnabled) {
        const s = ensureStripe();
        if (!s.accounts.length) {
          s.accounts.push({ id: d.accountId, name: d.name, acctId: d.accountId, received: 0 });
          s.activeId = d.accountId;
          re();
        }
      }
    }).catch(() => {});
}, []);
```

The existing **Open Stripe →** button already links to `https://stripe.com/login` — keep it.

---

## 3) Real guest checkout (in `GuestGallery`, `completePurchase`)

Replace the simulated unlock with a real Stripe Checkout redirect:

```js
async function completePurchase() {
  try {
    const res = await fetch(`${BACKEND_URL}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostId: album.hostId,          // the group root host that owns this album
        albumId: album.id,
        albumName: album.name,
        photoIds: selected,
      }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url; // go to Stripe payment page
    else alert(data.error || "Could not start checkout.");
  } catch (e) {
    alert("Network error starting checkout.");
  }
}
```

After paying, Stripe sends the guest back to `...?album=CODE&paid=1`. The app already
opens that album on load. To unlock the purchased photos, fetch their paid status:

```js
useEffect(() => {
  const ids = album.photos.map(p => p.id).join(",");
  if (!ids) return;
  fetch(`${BACKEND_URL}/paid?photoIds=${ids}`)
    .then(r => r.json())
    .then(d => {
      // mark these photo ids as unlocked for the viewer
      const u = DB.users[user?.id];
      if (u) {
        u.unlockedPhotos = Array.from(new Set([...(u.unlockedPhotos || []), ...d.paid]));
      }
    }).catch(() => {});
}, []);
```

---

## That's it
- Hosts get real Stripe onboarding and a true "Connected ✓".
- Guests pay with real cards; money goes to the correct host (your linking/staff
  rules are enforced because `album.hostId` is always the group root).
- Test with card `4242 4242 4242 4242` before switching to live keys.

If you'd like, I can also fold these edits directly into `photo-app.jsx` for you —
just say the word and tell me your backend URL.
