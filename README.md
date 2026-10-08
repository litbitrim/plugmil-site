# plugmil.dev

Static German service website for Jamil Dentel / plugmil, with a Node.js contact endpoint prepared for Vercel. The main website is `index.html`; the old acquisition-page URL redirects to `/`.

## Local use

Node.js 24 is sufficient. There are no runtime npm dependencies.

```bash
npm ci
npm test
npm run build
npm run dev
```

The local preview listens on `http://127.0.0.1:4173`. Without mail and Redis credentials, the contact endpoint intentionally responds with `503`; the UI retains the enquiry and provides the direct email link. It never claims a successful email send when only a `mailto:` window opened.

## Contact delivery

`POST /api/contact` validates the JSON payload, requires an allowed origin, applies a honeypot and distributed quotas, then sends through the Resend REST API. The only recipient is **litbitrim@gmail.com**. A browser-supplied recipient is never used. The visitor's validated address becomes `reply_to`; the sender comes from server configuration.

The prepared provider choices are **Resend for email** and **Upstash Redis for shared abuse counters**. This repository does not provision either service. Their availability in the production account has not been verified.

Configure these server-only environment variables in the verified Vercel project:

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Key authorized to send from the chosen verified domain |
| `CONTACT_FROM` | Sender address on that verified domain, optionally with display name |
| `UPSTASH_REDIS_REST_URL` | HTTPS REST endpoint of the owner's Upstash Redis database |
| `UPSTASH_REDIS_REST_TOKEN` | Write-capable token for that database |

The destination Gmail address does not need to be the sender domain. Verify the sender domain and its DNS records in Resend. Do not put these values in HTML or commit `.env` files.

`CONTACT_LOCAL_DEV=1` permits the two documented localhost origins only when the process is not running on Vercel. It is not needed in production. Vercel supplies `VERCEL`, `VERCEL_ENV` and the exact deployment's `VERCEL_URL`.

### Request and response behavior

- Fields: `name` (2–120 characters), `email` (valid address, at most 254), `service` (one of the five UI choices), `message` (10–5000), `website` (empty honeypot), `privacy` (`true`), `requestId` (UUID v4).
- Maximum JSON payload: 32 KiB. Only `POST` and `application/json` are accepted.
- Shared limits: 5 requests per IP or IPv6 /64 in 15 minutes, 3 per normalized sender address in one hour, 30 total in one hour. Limits are checked and incremented atomically with Redis Lua. Rejections do not prolong the expiry window. Preview and production use separate namespaces.
- Redis keys contain keyed hashes of IP/email, not the raw values or enquiry text. The Redis token acts as the private HMAC key. Keys expire with their quota window.
- The same submission UUID is reused after an uncertain client failure. Resend's idempotency key suppresses duplicate sends during its documented retention period.
- `202 {"status":"accepted","requestId":"…"}` means the email provider accepted the message. **It is not evidence of Gmail inbox delivery.**
- `400`, `403`, `413`, `415`, `429`, `502` and `503` preserve the form contents and produce an actionable message. Quota rejection includes `Retry-After`.
- Logs contain an enquiry UUID, accepted provider ID or error category, but not message contents, email address, IP address or credentials.

### Behind Cloudflare

The API trusts `x-vercel-forwarded-for` only on Vercel. If Cloudflare proxies traffic, verify which address Vercel actually observes before release. Do not start trusting an arbitrary client-supplied `CF-Connecting-IP` or `X-Forwarded-For` header. Where a trusted proxy arrangement is unavailable, use DNS-only routing for the website or a separately verified edge implementation for client-IP limits; document the selected topology.

## Release status — 2026-10-08

This change is prepared for review. It has **not** been deployed to production or proven to deliver mail to the Gmail inbox.

The source revision inspected was `fd93fcf616efb05cd46b5b486e1bdeefaa3c2068`. At that revision, `index.html` was a placeholder and `plugmil-akquise.html` opened `mailto:hello@plugmil.dev`; it had no backend.

The website and `/imprint/` returned a Cloudflare `403` to the audit requests. That result establishes what the audit client received, not what every visitor receives. The authorized Vercel team lookup returned a scope-access `403`; the domain-to-project binding, environment variables, and current deployment therefore remain unverified.

Before production release, complete these concrete acceptance steps:

1. Confirm the actual `plugmil.dev` DNS target, Vercel team, project, linked repository, production branch and current deployment. Use the existing authorized account context.
2. Verify the owner's current business imprint and full privacy notice. The existing `/imprint/` URL remains in navigation; this repository currently has no imprint route. The contact-data summary is not a replacement for the complete website privacy notice. No unverified address or tax details were added to public source.
3. Verify existing mail infrastructure. If using the prepared Resend/Upstash adapters, configure the variables above and the verified sender's DNS records. The code fails closed while they are missing.
4. Run `npm ci`, `npm test`, `npm run build`; create a preview from the reviewed commit and test the browser flow against its real `/api/contact` endpoint.
5. Stage production without assigning domains, then verify one clearly marked test enquiry from the real form. Match the UUID in the API response, provider record and the received email in **litbitrim@gmail.com**. Verify that Reply responds to the test sender. A provider ID alone does not complete this step.
6. Verify provider rejection, duplicate retry, and quota behavior without sending repeated real email. Check the site's responsive navigation, demo switches and scope-to-enquiry action.
7. Promote the verified deployment, then repeat one production enquiry and confirm receipt. Record the deployment URL, commit, message ID, receipt time and outcome outside the public repository.

Do not publish personal operations notes or access credentials as part of the website.

## Verified documentation

- [Vercel Node.js functions](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel request headers](https://vercel.com/docs/headers/request-headers)
- [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email)
- [Resend verified domains](https://resend.com/docs/dashboard/domains/introduction)
- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi)
