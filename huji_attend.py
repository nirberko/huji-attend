#!/usr/bin/env python3
"""
huji_attend.py — scan Moodle QR codes: log in once, then mark attendance headlessly.

Setup:
    pip install requests opencv-python

Use:
    python3 huji_attend.py                        # point webcam at a Moodle QR
    python3 huji_attend.py --image qr.png         # decode QR from a screenshot/photo
    python3 huji_attend.py --text 'moodlemobile://https://...'  # paste decoded content

Base URL override (HUJI vs. local instance):
    Set MOODLE_BASE_URL to force which Moodle the script talks to:

        MOODLE_BASE_URL=http://localhost:8080 python3 huji_attend.py
        MOODLE_BASE_URL=https://moodle.huji.ac.il/2026-27 python3 huji_attend.py

    It defaults to https://192.168.1.154:8088 and replaces the site URL embedded
    in scanned QR codes (useful for local test instances, or Docker setups where
    the QR contains an internal hostname). Set MOODLE_BASE_URL= (empty) to use
    the URL from the QR itself instead. Tokens are cached
    per site in ~/.moodle_qr_token.json, so logins for different sites coexist.

Two QR types are auto-detected:

  * Profile QR (Moodle profile page -> "QR code for mobile app access"):
    exchanged for a long-lived API token. The QR expires ~10 min after the page
    loads and is bound to the IP of the browser that generated it, so scan it
    fresh, from the same network. Only needed once per site.

  * Class QR (mod_attendance): marks you present immediately.
    No browser, no SSO login — fully headless.

Requirements on the Moodle server:
  * web services + the mobile service enabled, QR login turned on
    (Site admin -> Mobile app -> qrcodetype = "automatic login")
  * HTTPS — Moodle refuses autologin/QR-login keys over plain HTTP
    (for a local instance use mkcert/Caddy, and a NON-admin test account)
"""

import argparse
import json
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse

import requests

APP_UA = "Mozilla/5.0 MoodleMobile"          # passes core_useragent::is_moodle_app()
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
CACHE = Path.home() / ".moodle_qr_token.json"
DEFAULT_BASE = "https://192.168.1.154:8088"
ENV_BASE = os.environ.get("MOODLE_BASE_URL", DEFAULT_BASE).rstrip("/")


# ---------- QR input ----------

def read_qr(args):
    if args.text:
        return args.text.strip()
    import cv2
    if args.image:
        img = cv2.imread(args.image)
        if img is None:
            sys.exit(f"Could not read image: {args.image}")
        # tightly cropped screenshots lack the white quiet zone the detector needs
        img = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT,
                                 value=(255, 255, 255))
        data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
        if not data:
            sys.exit("No QR code found in that image.")
        return data
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        sys.exit("No webcam available — use --image or --text instead.")
    det = cv2.QRCodeDetector()
    print("Point the camera at a QR code (Ctrl+C to quit)...")
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                continue
            data, _, _ = det.detectAndDecode(frame)
            cv2.imshow("QR scan", frame)
            cv2.waitKey(1)
            if data:
                return data
    finally:
        cap.release()
        cv2.destroyAllWindows()


# ---------- site resolution ----------

def qr_site(payload):
    """Site base URL as embedded in a QR payload."""
    url = payload.split("://", 1)[1]  # strip leading 'moodlemobile://' if present
    p = urlparse(url if "://" in url else "https://" + url)
    return f"{p.scheme or 'https'}://{p.netloc}{p.path}".rstrip("/")


def effective_site(payload):
    """MOODLE_BASE_URL wins over the URL embedded in the QR."""
    return ENV_BASE or qr_site(payload)


def retarget(qr_url, site):
    """Rewrite an absolute QR URL onto `site`, keeping its path and query."""
    if not ENV_BASE:
        return qr_url
    p, b = urlparse(qr_url), urlparse(site)
    path = p.path
    if b.path and not path.startswith(b.path + "/"):
        path = b.path + path
    out = f"{b.scheme}://{b.netloc}{path}"
    if p.query:
        out += "?" + p.query
    return out


# ---------- Moodle API helpers ----------

def api(site, function, token=None, ua="moodle-qr-attend/1.0", **params):
    body = {"moodlewsrestformat": "json", "wsfunction": function, **params}
    if token:
        body["wstoken"] = token
    r = requests.post(f"{site}/webservice/rest/server.php", data=body,
                      headers={"User-Agent": ua}, timeout=25)
    r.raise_for_status()
    return r.json()


def _load_cache():
    if not CACHE.exists():
        return {}
    data = json.loads(CACHE.read_text())
    if "token" in data:  # legacy single-site format -> migrate
        entry = {k: data[k] for k in ("site", "userid", "token", "privatetoken")}
        data = {"last": data["site"], "sites": {data["site"]: entry}}
    return data


def _save_cache(data):
    CACHE.write_text(json.dumps(data, indent=2) + "\n")


def login(payload):
    """Exchange a profile QR (moodlemobile://SITE?qrlogin=KEY&userid=ID) for a token."""
    site = effective_site(payload)
    q = parse_qs(urlparse(payload.split("://", 1)[1]).query)
    userid, qrkey = int(q["userid"][0]), q["qrlogin"][0]
    r = requests.post(f"{site}/lib/ajax/service.php",
                      headers={"User-Agent": APP_UA, "Content-Type": "application/json"},
                      json=[{"index": 0,
                             "methodname": "tool_mobile_get_tokens_for_qr_login",
                             "args": {"qrloginkey": qrkey, "userid": userid}}],
                      timeout=25)
    result = r.json()[0]
    if result.get("error"):
        msg = result["exception"].get("message", str(result))
        sys.exit(f"Login QR exchange failed: {msg}\n"
                 "(QR keys expire ~10 min after the profile page loads and are bound "
                 "to the IP of that browser — reload the page, scan fresh, same network.)")
    entry = {"site": site, "userid": userid,
             "token": result["data"]["token"],
             "privatetoken": result["data"]["privatetoken"]}
    cache = _load_cache()
    cache.setdefault("sites", {})[site] = entry
    cache["last"] = site
    _save_cache(cache)
    print(f"Logged in as userid {userid} on {site}\nToken cached to {CACHE}")


def get_cached():
    data = _load_cache()
    site = ENV_BASE or data.get("last")
    entry = data.get("sites", {}).get(site) if site else None
    if not entry:
        return None
    r = api(entry["site"], "core_webservice_get_site_info", token=entry["token"])
    if "exception" in r:
        print(f"Cached token for {entry['site']} no longer valid — scan that site's "
              "profile QR again.")
        return None
    return entry


# ---------- Attendance marking ----------

class Forms(HTMLParser):
    """Collect forms (action/hidden inputs/'status' radios) and label texts."""
    def __init__(self):
        super().__init__()
        self.forms, self.labels = [], {}
        self._cur, self._label = None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self._cur = {"action": a.get("action", ""), "hidden": {}, "radios": []}
            self.forms.append(self._cur)
        elif tag == "input" and self._cur is not None:
            if a.get("type") == "hidden" and "name" in a:
                self._cur["hidden"][a["name"]] = a.get("value", "")
            elif a.get("type") == "radio" and a.get("name") == "status":
                self._cur["radios"].append({"id": a.get("id", ""), "value": a.get("value", "")})
        elif tag == "label" and a.get("for"):
            self._label = a["for"]

    def handle_data(self, data):
        if self._label:
            self.labels[self._label] = self.labels.get(self._label, "") + data

    def handle_endtag(self, tag):
        if tag == "form":
            self._cur = None
        elif tag == "label":
            self._label = None


def alerts(html):
    msgs = re.findall(r'<div[^>]+class="[^"]*alert[^"]*"[^>]*>(.*?)</div>', html, re.S)
    clean = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", m)).strip() for m in msgs]
    return "\n".join(m for m in clean if m) or html[:300]


def mark(cache, qr, want=None):
    site = cache["site"]
    qr = retarget(qr, site)

    # 1. one-time autologin key (~60 s TTL, single use)
    key = api(site, "tool_mobile_get_autologin_key", cache["token"], ua=APP_UA,
              privatetoken=cache["privatetoken"])
    if "exception" in key:
        sys.exit("Could not get autologin key: " + key.get("message", str(key)))

    # 2. autologin -> real Moodle session cookie, redirected onto the attendance page
    s = requests.Session()
    s.headers["User-Agent"] = BROWSER_UA
    url = (f"{key['autologinurl']}?userid={cache['userid']}&key={key['key']}"
           f"&urltogo={quote(qr, safe='')}")
    page = s.get(url, timeout=25)
    text = page.text
    for marker, msg in [
        ("qr_pass_wrong", "QR password wrong/expired — it rotates; scan the current code."),
        ("already_submitted", "attendance already submitted for this session."),
        ("invalidkey", "autologin key rejected."),
        ("httpsrequired", "server requires HTTPS for autologin."),
    ]:
        if marker in text:
            sys.exit(f"Server says: {msg}")
    if "attendance.php" not in page.url:
        hint = ""
        if urlparse(qr).netloc != urlparse(site).netloc:
            # autologin only redirects within its own wwwroot
            hint = (f"\nQR points to {urlparse(qr).netloc} but your token is for {site}. "
                    f"If they are the same Moodle, rerun with MOODLE_BASE_URL={site}")
        sys.exit("Did not reach the marking page (session closed or already marked?)"
                 + hint + "\n" + alerts(text))

    # 3. parse the self-marking form and pick a status
    f = Forms()
    f.feed(text)
    form = next((x for x in f.forms if x["radios"]), None)
    sesskey = re.search(r'"sesskey"\s*:\s*"(\w+)"', text)
    if not form or not sesskey:
        sys.exit("No self-marking form found (session not open to students?)\n" + alerts(text))

    order = ([want] if want else []) + ["present", "נוכח"]
    chosen, label = None, ""
    for w in order:
        for r in form["radios"]:
            if w.lower() in f.labels.get(r["id"], "").lower():
                chosen, label = r["value"], f.labels[r["id"]].strip()
                break
        if chosen:
            break
    if not chosen:  # fallback: first option (Moodle orders Present first)
        chosen = form["radios"][0]["value"]
        label = f.labels.get(form["radios"][0]["id"], "").strip() or "first option"

    data = dict(form["hidden"])
    data.update({"sesskey": sesskey.group(1), "status": chosen, "submitbutton": "Save"})
    q = parse_qs(urlparse(qr).query)
    if "qrpass" in q:
        data.setdefault("studentpassword", q["qrpass"][0])

    post = urljoin(page.url, form["action"] or "/mod/attendance/attendance.php")
    if "sessid" not in post and "sessid" in q:
        post += ("&" if "?" in post else "?") + urlparse(qr).query
    resp = s.post(post, data=data, timeout=25)

    if "view.php" in resp.url:
        print(f"Marked '{label}' — attendance recorded on {site}.")
    else:
        print("Submission sent but result is unclear. Page says:")
        print(alerts(resp.text))


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", help="decode QR from an image file instead of the webcam")
    ap.add_argument("--text", help="use an already-decoded QR string")
    ap.add_argument("--status", help="status label to match (default: Present/נוכח)")
    args = ap.parse_args()

    payload = read_qr(args)
    print("QR:", payload[:90] + ("..." if len(payload) > 90 else ""))

    if "qrlogin=" in payload:
        login(payload)
    elif "mod/attendance" in payload:
        cache = get_cached()
        if not cache:
            which = ENV_BASE or "any site"
            sys.exit(f"No valid token for {which} — first scan that site's profile QR "
                     "(profile page -> 'QR code for mobile app access').")
        mark(cache, payload, args.status)
    else:
        sys.exit("Unrecognized QR — expected a Moodle profile QR or an attendance QR.")


if __name__ == "__main__":
    main()
