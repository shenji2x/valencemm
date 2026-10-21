# Biolink profiles and one-time Premium

The existing Google Cloud Node backend owns authentication, profile data, uploads
and Premium entitlements. No Cloudflare Worker or paid Workers plan is used.

## Included

- Dashboard → Biolink: live preview; editable name, bio and ordered HTTPS links;
  five themes; centered/left layouts; two existing local fonts; QR sharing;
  explicit publish/unpublish; aggregate profile views and link clicks.
- Public profiles at `/u/<existing username or agent handle>`. Drafts and media
  belonging to drafts are unavailable publicly. Public output contains no email,
  account ID, authentication data, payment IDs or private analytics.
- “Start a deal with me” opens New deal with the profile owner as the intended
  seller. Server checks restrict joining to that owner; the buyer shares the
  regular invite code with them. No funding or seller acceptance is automatic.
- Premium: US$20 once, 30 links (free: 10), glass layout, avatar glow, entrance
  effect, and one background MP4 capped at 300 seconds AND 100,000,000 bytes.
- Avatar and background: one each, PNG/JPEG/WebP up to 5,000,000 bytes. Static
  images only. At most 10 upload authorizations per account per day.

This is the first profile release, not the complete Noiz/Feds feature catalogue.

## R2 connection

Use a **private R2 Standard bucket**, without public bucket access. Set these in
the existing Cloud Run service; never commit values to source control:

| Variable | Meaning |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET` | Private bucket name |
| `R2_ACCESS_KEY_ID` | S3 API access key scoped to this bucket |
| `R2_SECRET_ACCESS_KEY` | Corresponding secret, preferably a Secret Manager reference |
| `FFPROBE_PATH` | Optional override; default `ffprobe`, installed in the Docker image |

Bucket CORS:

```json
[
  {
    "AllowedOrigins": ["https://valencemm.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length", "Range"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range"],
    "MaxAgeSeconds": 3600
  }
]
```

Add an R2 object lifecycle rule: delete `staging/` objects after **one day**.
Incomplete uploads, abandoned uploads, or replays of a still-valid upload URL
then expire automatically. Never apply that rule to `profiles/`.

Upload bytes go directly from the browser to R2 to avoid Cloud Run's request-size
limit. Upload grants bind a random key, content type and exact length, expiring in
10 minutes. Finalization checks stored length/type, inspects actual bytes with
ffprobe and enforces dimensions/duration. At most one verification runs at once.
The validated bytes are copied to a fresh random key to prevent reuse of the
original upload grant from modifying a published asset. Replacements remove the
previous object after the new metadata is saved. Media URLs are short-lived R2
GET grants issued only for published profiles or authenticated owner previews.
Already-issued GET grants can remain usable up to one hour after unpublishing;
unpublishing immediately prevents issuing new ones.

R2 credentials and bucket must be configured before uploads work. The Dockerfile
installs ffprobe through Debian's ffmpeg package; use the Dockerfile build path.
No paid video processing service is introduced. There is no automatic content
moderation/transcoding pipeline in this release; suspicious content can be
reported through Support.

## Premium payment connection

Premium uses **platform Stripe Checkout**, a fixed USD 2000-cent one-time payment.
It is separate from Stripe Connect deal charges. The browser cannot choose the
price, account, entitlement, recipient or payment state. Session IDs are saved
against the authenticated account before checkout is returned to the browser.
Fulfillment retrieves the current session and expanded payment/charge directly
from Stripe, checking identity, price, payment status, refunds and disputes.
Repeated confirmation is idempotent. Refund/chargeback notifications revoke the
entitlement. Historical uploads are retained, but video stops being served and
premium appearance/extra links stop appearing publicly after revocation.

Ensure the platform restricted Stripe key permits creating/retrieving Checkout
Sessions and reading the expanded PaymentIntent and Charge. Use a **platform
account** webhook destination at `/v1/webhooks/stripe`, with its matching
`STRIPE_WEBHOOK_SECRET`, subscribing to `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `charge.refunded` and
`charge.dispute.created`. Existing seller Connect webhooks remain required for
deals. The webhook route rejects Connect events as Premium grants. Distinct
platform and Connect webhook destinations may require a separate signing secret;
configure `STRIPE_PREMIUM_WEBHOOK_SECRET` for the platform destination when its
secret differs from the existing Connect destination.

Only after R2, verification and platform notifications are configured and tested,
set `PREMIUM_CHECKOUT_ENABLED=1`. Until then the public profile editor works,
uploads require R2, and purchasing Premium is disabled. Existing free accounts
are not upgraded automatically. Never test by making real customer charges.

## Operation and checks

Keep Cloud Run at **one maximum instance** because the existing durable backend
is a single JSON snapshot with in-process auth/rate limits. Generation checks
prevent conflicting Cloud Storage writes; horizontal scaling requires a database
and distributed limits rather than raising the instance count. Account capacity
is increased to 15,000 so a 10,000-profile launch isn't blocked by the old cap.
This is not a claim that the current storage model is load-tested for that scale.

`npm test` covers profile isolation, malformed links/appearance, fixed-price
checkout, identity and refund checks, authenticated notifications, failed-save
retry behavior, media gates/cleanup and seller-bound deal creation. To include
real MP4/image fixture validation, provide `FFMPEG_TEST_PATH` and `FFPROBE_PATH`.
The fixture test checks a valid MP4 and rejects a 301-second video.
