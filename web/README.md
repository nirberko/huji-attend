# HUJI Attend (web)

Next.js version of `../huji_attend.py`, for several Moodle accounts at once:

1. **Add user**: scan a Moodle profile QR ("QR code for mobile app access"). The server
   exchanges it for an API token (`tool_mobile_get_tokens_for_qr_login`) and saves it in D1.
2. **Scan class QR**: marks every saved user present (autologin key → session → self-marking form).
3. **Users list**: each token is checked live with `core_webservice_get_site_info`, which
   returns the name, username, user id and site name.

## Local development

```bash
pnpm install
npx wrangler login         # dev uses the real Cloudflare D1 (`"remote": true` in wrangler.jsonc)
pnpm db:migrate:remote     # apply any new migrations to it
pnpm dev                   # http://localhost:3030
pnpm dev:local-moodle      # same, but trusts ../local-moodle.pem for the local HTTPS Moodle
```

Local dev and the deployed worker share one database, so users added locally (where the
profile-QR IP check passes) are available to the deployed app.

`.env.development.local` sets `MOODLE_BASE_URL` (same meaning as in the Python script) for
`next dev` only. Set it to empty to use the site URL inside the QR, for example the real HUJI
Moodle. Don't put it in `.env.local`: OpenNext bundles that file into the deployed worker.

The camera needs HTTPS or `localhost`. To scan with a phone on the LAN:

```bash
pnpm dev:cert    # once (and again if your LAN IP changes): self-signed cert for localhost + LAN IP
pnpm dev:https   # https://<LAN IP>:3030, accept the certificate warning on the phone
```

## Deploy to Cloudflare

```bash
npx wrangler d1 create huji-attend   # put the printed database_id in wrangler.jsonc
pnpm db:migrate:remote
npx wrangler secret put APP_PASSWORD # basic auth: the DB holds other people's tokens
pnpm deploy
```

Caveats:
- Moodle ties profile-QR keys to the IP of the browser that shows the QR (`qrsameipcheck`,
  on by default). On Workers the exchange comes from a Cloudflare IP, so **adding users only
  works from a local server on the same network**. Marking attendance works from anywhere.
- Autologin keys can be requested at most once every ~6 minutes per user. The Moodle session
  from each autologin is saved and reused, so a key is only needed when that session expires.
- Each user costs ~6–8 subrequests per scan; the Workers free plan allows 50 per request.
