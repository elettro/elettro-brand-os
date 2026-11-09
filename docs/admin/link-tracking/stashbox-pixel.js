// Elettro OS tracked links: Shopify custom pixel for stashbox.ai.
// Paste the whole file into Shopify admin > Settings > Customer events > Add custom pixel ("Elettro OS links").
// It only reports visits that came from an Elettro OS post: the post's code arrives as ?eo=<code> (from
// go.stashbox.com/<code>, or straight on Pinterest / Google Business links) and is remembered for 7 days.
// It sends counts (event type, product name, order total) with that code. No name, email, address or IP.
// Runbook: docs/admin/link-tracking.md in the elettro-brand-os repo.

const ENDPOINT = "https://go.stashbox.com/api/link-events";
const STORE_KEY = "elettro_eo";
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CODE = /^[2-9a-km-zA-HJ-NP-Z]{7}$/;

async function currentCode(event) {
  let fromUrl = null;
  try { fromUrl = new URL(event.context.document.location.href).searchParams.get("eo"); } catch (e) {}
  if (fromUrl && CODE.test(fromUrl)) {
    await browser.localStorage.setItem(STORE_KEY, JSON.stringify({ code: fromUrl, at: Date.now() }));
    return { code: fromUrl, landing: true };
  }
  try {
    const saved = JSON.parse((await browser.localStorage.getItem(STORE_KEY)) || "null");
    if (saved && CODE.test(saved.code) && Date.now() - saved.at < WINDOW_MS) return { code: saved.code, landing: false };
  } catch (e) {}
  return null;
}

function send(payload) {
  fetch(ENDPOINT, { method: "POST", body: JSON.stringify(payload), keepalive: true }).catch(() => {});
}

// A store visit = the page a tracked link landed on (not every page after it).
analytics.subscribe("page_viewed", async (event) => {
  const c = await currentCode(event);
  if (c && c.landing) send({ code: c.code, kind: "page_view", eventId: event.id });
});

analytics.subscribe("product_viewed", async (event) => {
  const c = await currentCode(event);
  const v = event.data && event.data.productVariant;
  if (c) send({ code: c.code, kind: "product_view", eventId: event.id, product: v && v.product && v.product.title,
    value: v && v.price && v.price.amount, currency: v && v.price && v.price.currencyCode });
});

analytics.subscribe("product_added_to_cart", async (event) => {
  const c = await currentCode(event);
  const line = event.data && event.data.cartLine;
  if (c) send({ code: c.code, kind: "add_to_cart", eventId: event.id,
    product: line && line.merchandise && line.merchandise.product && line.merchandise.product.title,
    value: line && line.cost && line.cost.totalAmount && line.cost.totalAmount.amount,
    currency: line && line.cost && line.cost.totalAmount && line.cost.totalAmount.currencyCode });
});

analytics.subscribe("checkout_started", async (event) => {
  const c = await currentCode(event);
  const total = event.data && event.data.checkout && event.data.checkout.totalPrice;
  if (c) send({ code: c.code, kind: "checkout_started", eventId: event.id, value: total && total.amount, currency: total && total.currencyCode });
});

analytics.subscribe("checkout_completed", async (event) => {
  const c = await currentCode(event);
  const checkout = event.data && event.data.checkout;
  const total = checkout && checkout.totalPrice;
  // The order id keeps a reloaded thank-you page from counting the sale twice.
  const orderId = checkout && checkout.order && checkout.order.id;
  if (c) send({ code: c.code, kind: "purchase", eventId: orderId ? "order-" + orderId : event.id, value: total && total.amount, currency: total && total.currencyCode });
});
