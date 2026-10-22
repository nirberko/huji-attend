# HUJI Attend — Enroller (Windows)

A small desktop program that adds Moodle users to the cloud app by scanning the
**profile QR** with your phone. It exists because HUJI binds each profile QR to the
IP of the browser that showed it and only accepts the token exchange from that same
IP — so the exchange can't run on Cloudflare, it has to run on your own network.

Everything else (scanning class QRs, marking attendance, seeing who's connected) stays
on the deployed app: https://huji-attend.nirberko.workers.dev

## Use it

1. Copy **`dist/HUJI-Attend-Enroller.exe`** to your Windows PC and double-click it.
   - SmartScreen may warn (the exe isn't code-signed): **More info → Run anyway**.
   - Windows Firewall will ask once: **allow on Private networks**.
2. The window prints one or more `https://<ip>:8787` addresses.
3. On your **phone, same Wi-Fi**, open one of them. The browser warns about the
   certificate (it's self-signed) — **Advanced → proceed**.
4. On a computer, open your Moodle profile → **"QR code for mobile app access"**.
5. Point the phone camera at that QR. On success the page says *Added <name>*, and the
   user now appears in the cloud app.

Leave the window open while enrolling. Close it when done.

## Configure (optional)

The exe ships with working defaults. To change them, put a `config.json` next to the
exe (see `config.sample.json`):

```json
{
  "workerUrl": "https://huji-attend.nirberko.workers.dev",
  "appPassword": "…",
  "moodleBaseUrl": "https://moodle.huji.ac.il/2026-27",
  "port": 8787
}
```

- `moodleBaseUrl`: force which Moodle to talk to. Leave `""` to use the site inside each QR.
- `appPassword`: must match the cloud app's `APP_PASSWORD` (it's how the exe is allowed to store users).

## Build it again

Needs Node + npm (no Windows machine required — it cross-compiles):

```bash
cd enroller
npm install
npm run build:win     # -> dist/HUJI-Attend-Enroller.exe
```

## Notes

- A self-signed certificate warning on the phone is expected and safe here; the page is
  only served on your LAN. The warning can't be avoided without a real domain + cert.
- If the camera still won't start after accepting the warning, use **Upload a
  screenshot / photo** or paste the decoded QR text — both are on the page.
- Phone and PC must be on the **same network**, and that network's public IP must match
  the one your Moodle profile page was loaded from (no VPN in the way).
