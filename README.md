# moodleplus

Mark Moodle (HUJI) attendance for several accounts from one QR scan.

- **`web/`** — the Next.js app, deployed to Cloudflare Workers (OpenNext) with a D1
  database. Scan a class QR once and every connected user is marked present. See
  [`web/README.md`](web/README.md).
- **`enroller/`** — a small Windows program that adds users by scanning their Moodle
  profile QR from your own network (HUJI binds that QR to the browser's IP, so it can't
  run in the cloud). See [`enroller/README.md`](enroller/README.md).
- **`huji_attend.py`** — the original command-line script this is based on.

## Why two pieces

Adding a user exchanges a profile QR for a long-lived API token. HUJI accepts that
exchange only from the same IP that loaded the profile page, so it runs locally (the
enroller). Everything else — marking attendance, listing who's connected — runs on the
deployed worker, which shares the same Cloudflare D1 database.
