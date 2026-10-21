const crypto = require('crypto');
const { ApiError } = require('./errors');
const { limiter } = require('./http');
const { SLOTS } = require('./profiles');
const { VIDEO_BYTES, IMAGE_BYTES } = require('./profile-media');

function installBiolink(add, store, opts) {
  const { stripe, persistence, profileMedia: media, mediaVerifier } = opts;
  const clock = opts.now || Date.now;
  const siteUrl = (opts.siteUrl || 'https://valencemm.com').replace(/\/$/, '');
  const checkoutEnabled = Boolean((opts.premiumCheckoutEnabled ?? process.env.PREMIUM_CHECKOUT_ENABLED === '1') && stripe?.configured && stripe.acceptsPremiumWebhooks && media.configured);
  const uploads = limiter({ windowMs: 86400000, max: 10, code: 'upload_limit' });
  const metrics = limiter({ windowMs: 3600000, max: 100, code: 'metric_limit' });
  const checks = new Set();
  let activeChecks = 0;
  const publicOwner = (handle) => {
    const a = store.profileOwner(handle);
    if (!a?.profile?.published) throw new ApiError(404, 'profile_not_found', 'This profile is not published');
    return a;
  };
  function ready() {
    if (!checkoutEnabled) throw new ApiError(503, 'premium_unavailable', 'Premium checkout will open after media storage and payment notifications are connected');
  }
  function fulfill(session, account) {
    if (!session || session.mode !== 'payment' || session.payment_status !== 'paid' || session.status !== 'complete' || session.currency !== 'usd' || session.amount_total !== 2000 || session.metadata?.product !== 'valence_premium_v1' || session.metadata?.account_id !== account.id || session.client_reference_id !== account.id || !session.payment_intent) throw new ApiError(409, 'payment_not_confirmed', 'Stripe has not confirmed a US$20 Premium payment for this account');
    const intent = session.payment_intent;
    if (typeof intent !== 'object' || intent.status !== 'succeeded' || intent.amount !== 2000 || intent.currency !== 'usd' || !intent.latest_charge || intent.latest_charge.refunded || intent.latest_charge.amount_refunded > 0 || intent.latest_charge.disputed) throw new ApiError(409, 'payment_not_confirmed', 'This payment is unpaid, refunded or disputed');
    store.grantPremium(account, { ...session, payment_intent: intent.id });
  }
  async function confirm(id, account) {
    if (typeof id !== 'string' || !/^cs_[A-Za-z0-9_]{1,250}$/.test(id) || !account.premiumPurchases?.includes(id)) throw new ApiError(404, 'unknown_purchase', 'Purchase not found');
    const session = await stripe.request('GET', '/v1/checkout/sessions/' + encodeURIComponent(id), { expand: ['payment_intent.latest_charge'] });
    fulfill(session, account);
  }
  add('GET', '/biolink', { auth: true }, ({ account }) => ({ body: { profile: store.profileView(account), mediaEnabled: media.configured, checkoutEnabled, price: { amount: 2000, currency: 'usd', recurring: false } } }));
  add('POST', '/biolink', { auth: true, mutate: true, bodyLimit: 24 * 1024 }, ({ account, body }) => ({ body: { profile: store.saveProfile(account, body) } }));
  add('GET', '/profiles/:handle', {}, ({ params }) => ({ body: { profile: store.profileView(publicOwner(params.handle), { publicView: true }) } }));
  add('POST', '/profiles/:handle/view', { limit: metrics }, ({ params, ip }) => {
    // One count per profile/IP/hour. Aggregate totals only; visitor addresses aren't persisted.
    const a = publicOwner(params.handle), hour = Math.floor(clock() / 3600000);
    const key = crypto.createHash('sha256').update(a.id + ip + hour).digest('hex');
    if (!seen.has(key)) { seen.set(key, hour); store.profileMetric(a, 'views'); }
    if (seen.size > 20000) for (const [k, h] of seen) if (h < hour || seen.size > 30000) seen.delete(k);
    return { body: { ok: true } };
  });
  const seen = new Map();
  add('POST', '/profiles/:handle/click/:index', { limit: metrics }, ({ params }) => {
    const a = publicOwner(params.handle), i = Number(params.index);
    if (!Number.isInteger(i) || i < 0 || i >= a.profile.links.length) throw new ApiError(404, 'not_found', 'Link not found');
    store.profileMetric(a, 'clicks'); return { body: { ok: true } };
  });
  add('POST', '/premium/checkout', { auth: true, mutate: true }, async ({ account }) => {
    ready();
    if (account.premium?.active) return { body: { premium: true } };
    if ((account.premiumPurchases || []).length >= 100) throw new ApiError(429, 'checkout_limit', 'Too many checkout attempts. Contact support for help.');
    // Fixed server price, charged to Valence's platform account, separate from deal escrow.
    const session = await stripe.request('POST', '/v1/checkout/sessions', {
      mode: 'payment', payment_method_types: ['card'], client_reference_id: account.id,
      success_url: siteUrl + '/dashboard?premium_session={CHECKOUT_SESSION_ID}#biolink', cancel_url: siteUrl + '/dashboard#biolink',
      line_items: [{ price_data: { currency: 'usd', unit_amount: 2000, product_data: { name: 'Valence Premium — one-time purchase' } }, quantity: 1 }],
      metadata: { product: 'valence_premium_v1', account_id: account.id },
      payment_intent_data: { metadata: { product: 'valence_premium_v1', account_id: account.id } },
    }, { idempotencyKey: `premium_${account.id}_${account.premium?.sessionId || 'first'}_${Math.floor(clock() / 1800000)}` });
    if (!session.id || !/^https:\/\/checkout\.stripe\.com\//.test(session.url || '')) throw new Error('Invalid Checkout response');
    store.premiumCheckout(account, session.id);
    return { body: { url: session.url } };
  });
  add('POST', '/premium/confirm', { auth: true, mutate: true }, async ({ account, body }) => {
    ready(); await confirm(body.sessionId, account); return { body: { premium: account.premium?.active === true } };
  });
  add('POST', '/biolink/media/upload', { auth: true, mutate: true }, async ({ account, body }) => {
    if (!media.configured) throw new ApiError(503, 'media_unavailable', 'Media storage is not connected yet');
    uploads(account.id);
    const { slot, size, type } = body;
    if (!SLOTS.includes(slot)) throw new ApiError(400, 'invalid_slot', 'Unknown media slot');
    if (slot === 'video' && !account.premium?.active) throw new ApiError(403, 'premium_required', 'Video uploads require Premium');
    const limit = slot === 'video' ? VIDEO_BYTES : IMAGE_BYTES;
    const types = slot === 'video' ? ['video/mp4'] : ['image/png', 'image/jpeg', 'image/webp'];
    if (!Number.isInteger(size) || size < 12 || size > limit || !types.includes(type)) throw new ApiError(400, 'invalid_upload', `Use ${slot === 'video' ? 'MP4 up to 100 MB' : 'PNG, JPEG or WebP up to 5 MB'}`);
    const old = account.pendingProfileUpload;
    if (old && checks.has(old.id)) throw new ApiError(409, 'verification_pending', 'Your previous file is still being checked');
    if (old) await media.remove(old.key);
    const id = crypto.randomBytes(20).toString('hex');
    const key = `staging/${account.id}/${id}`;
    account.pendingProfileUpload = { id, key, slot, size, type, expiresAt: clock() + 900000 };
    return { body: { uploadId: id, url: media.signed('PUT', key, { type, size }), headers: { 'Content-Type': type } } };
  });
  add('POST', '/biolink/media/confirm', { auth: true, mutate: true }, async ({ account, body }) => {
    const u = account.pendingProfileUpload;
    if (!u || u.id !== body.uploadId || u.expiresAt < clock()) throw new ApiError(404, 'upload_expired', 'Upload expired. Choose your file again.');
    if (checks.has(u.id) || activeChecks >= 1) throw new ApiError(429, 'verification_busy', 'Media verification is busy. Please retry shortly.');
    checks.add(u.id); activeChecks++;
    try {
      const head = await media.head(u.key);
      if (head.size !== u.size || head.type !== u.type) throw new ApiError(400, 'upload_mismatch', 'Uploaded file does not match the approved size and type');
      const bytes = await media.bytes(u.key, u.size);
      if (bytes.length !== u.size) throw new ApiError(400, 'upload_mismatch', 'Upload size changed during verification');
      const info = await mediaVerifier(bytes, u.slot, u.type);
      if (u.slot === 'video' && !account.premium?.active) throw new ApiError(403, 'premium_required', 'Premium is required');
      const old = account.profileMedia?.[u.slot];
      // Never publish a key for which a browser still has a reusable signed PUT.
      const finalKey = `profiles/${account.id}/${crypto.randomBytes(20).toString('hex')}`;
      await media.put(finalKey, bytes, u.type);
      account.profileMedia ||= {};
      account.profileMedia[u.slot] = { ...u, key: finalKey, ...info };
      delete account.pendingProfileUpload;
      await persistence.commit();
      await media.remove(u.key).catch(err => console.error('Staging cleanup failed:', err.message));
      if (old) await media.remove(old.key).catch(err => console.error('Old profile media cleanup failed:', err.message));
      return { body: { profile: store.profileView(account) } };
    } catch (err) {
      if (account.pendingProfileUpload?.id === u.id) {
        delete account.pendingProfileUpload;
        await media.remove(u.key).catch(() => {});
        await persistence.commit();
      }
      throw err;
    } finally { checks.delete(u.id); activeChecks--; }
  });
  add('POST', '/biolink/media/remove', { auth: true, mutate: true }, async ({ account, body }) => {
    if (!SLOTS.includes(body.slot)) throw new ApiError(400, 'invalid_slot', 'Unknown slot');
    const old = account.profileMedia?.[body.slot];
    if (old) { delete account.profileMedia[body.slot]; await persistence.commit(); await media.remove(old.key); }
    return { body: { profile: store.profileView(account) } };
  });
  add('GET', '/profiles/:handle/media/:slot', { send: true }, ({ params, res }) => {
    const a = publicOwner(params.handle), item = a.profileMedia?.[params.slot];
    if (!item || (params.slot === 'video' && !a.premium?.active)) throw new ApiError(404, 'not_found', 'Media not found');
    res.writeHead(302, { Location: media.signed('GET', item.key, { expires: 3600 }), 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
  });
  // Draft media preview is private; bearer credentials never appear in media URLs.
  add('POST', '/biolink/media/preview', { auth: true }, ({ account }) => {
    const urls = {};
    for (const [slot, item] of Object.entries(account.profileMedia || {})) if (slot !== 'video' || account.premium?.active) urls[slot] = media.signed('GET', item.key, { expires: 600 });
    return { body: { urls } };
  });
  return {
    async webhook(event) {
      if (event.account) return false; // Connect seller events cannot grant Premium.
      const obj = event.data?.object;
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && obj?.metadata?.product === 'valence_premium_v1') {
        const a = store.profileOwnerById(obj.metadata.account_id);
        if (a && obj.payment_status === 'paid') {
          try { await confirm(obj.id, a); } catch (err) {
            if (!['payment_not_confirmed', 'purchase_revoked'].includes(err.code)) throw err;
          }
          await persistence.commit();
        }
        return true;
      }
      if ((event.type === 'charge.refunded' && obj?.refunded) || event.type === 'charge.dispute.created') {
        if (obj?.payment_intent) { store.revokePremium(obj.payment_intent); await persistence.commit(); }
      }
      return false;
    },
  };
}
module.exports = { installBiolink };
