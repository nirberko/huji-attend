/**
 * Moodle client — a port of huji_attend.py.
 *
 * Two QR types:
 *  - Profile QR (moodlemobile://SITE?qrlogin=KEY&userid=ID): exchanged for a long-lived
 *    API token. Expires ~10 min after the profile page loads and is bound to the IP of
 *    the browser that showed it, so the server doing the exchange must share that IP.
 *  - Class QR (mod_attendance): marks the user present via autologin + the self-marking form.
 */
import { parse } from "node-html-parser";

const APP_UA = "Mozilla/5.0 MoodleMobile"; // passes core_useragent::is_moodle_app()
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

export class MoodleError extends Error {}

/** Error text for the UI; fetch() hides the real reason (TLS, DNS, refused) in `cause`. */
export function errorMessage(e: unknown) {
  const err = e as Error & { cause?: { message?: string; code?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  return cause ? `${err.message}: ${cause}` : err.message;
}

export type MoodleAccount = {
  site: string;
  userid: number;
  token: string;
  privatetoken: string;
  /** Saved browser session (Browser.save()) from an earlier autologin, if any. */
  session?: string;
};

export type SiteInfo = {
  sitename: string;
  username: string;
  firstname: string;
  lastname: string;
  fullname: string;
  userid: number;
  userpictureurl: string;
};

export const isLoginQr = (payload: string) => payload.includes("qrlogin=");
export const isAttendanceQr = (payload: string) => payload.includes("mod/attendance");

// ---------- site resolution ----------

/** MOODLE_BASE_URL (if set) replaces the site URL embedded in scanned QR codes. */
function baseOverride() {
  return (process.env.MOODLE_BASE_URL ?? "").replace(/\/+$/, "");
}

/** Strip a leading 'moodlemobile://' and parse what remains. */
function qrUrl(payload: string) {
  const rest = payload.slice(payload.indexOf("://") + 3);
  return new URL(rest.includes("://") ? rest : `https://${rest}`);
}

function effectiveSite(payload: string) {
  if (baseOverride()) return baseOverride();
  const u = qrUrl(payload);
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
}

/** Rewrite an absolute QR URL onto `site`, keeping its path and query. */
function retarget(qr: string, site: string) {
  if (!baseOverride()) return qr;
  const p = new URL(qr);
  const b = new URL(site);
  const basePath = b.pathname.replace(/\/+$/, "");
  let path = p.pathname;
  if (basePath && !path.startsWith(basePath + "/")) path = basePath + path;
  return `${b.protocol}//${b.host}${path}${p.search}`;
}

// ---------- web service API ----------

async function api<T>(
  site: string,
  wsfunction: string,
  token: string,
  params: Record<string, string> = {},
  ua = "moodle-qr-attend/1.0",
): Promise<T> {
  const body = new URLSearchParams({
    moodlewsrestformat: "json",
    wsfunction,
    wstoken: token,
    ...params,
  });
  const r = await fetch(`${site}/webservice/rest/server.php`, {
    method: "POST",
    body,
    headers: { "User-Agent": ua },
  });
  if (!r.ok) throw new MoodleError(`${wsfunction}: HTTP ${r.status}`);
  const data = (await r.json()) as { exception?: string; message?: string; errorcode?: string };
  if (data && typeof data === "object" && "exception" in data) {
    throw new MoodleError(data.message ?? data.errorcode ?? JSON.stringify(data));
  }
  return data as T;
}

/** Exchange a profile QR for an API token + private token. */
export async function loginWithQr(payload: string): Promise<MoodleAccount> {
  const site = effectiveSite(payload);
  const q = qrUrl(payload).searchParams;
  const userid = Number(q.get("userid"));
  const qrloginkey = q.get("qrlogin");
  if (!userid || !qrloginkey) throw new MoodleError("Profile QR is missing userid/qrlogin.");

  const r = await fetch(`${site}/lib/ajax/service.php`, {
    method: "POST",
    headers: { "User-Agent": APP_UA, "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        index: 0,
        methodname: "tool_mobile_get_tokens_for_qr_login",
        args: { qrloginkey, userid },
      },
    ]),
  });
  const [result] = (await r.json()) as {
    error?: boolean;
    exception?: { message?: string };
    data: { token: string; privatetoken: string };
  }[];
  if (result?.error) {
    throw new MoodleError(
      `Login QR exchange failed: ${result.exception?.message ?? JSON.stringify(result)} ` +
        "(QR keys expire ~10 min after the profile page loads and are bound to the IP " +
        "of that browser — reload the page and scan fresh, from the same network.)",
    );
  }
  return { site, userid, token: result.data.token, privatetoken: result.data.privatetoken };
}

/** Who the token belongs to. Throws if the token is no longer valid. */
export function getSiteInfo(site: string, token: string) {
  return api<SiteInfo>(site, "core_webservice_get_site_info", token);
}

// ---------- attendance marking ----------

/** Minimal cookie-keeping browser: fetch() drops cookies across redirects, Moodle needs them. */
class Browser {
  private cookies: Map<string, string>;

  /** `saved` is a previous save(), so a Moodle session can be reused across requests. */
  constructor(saved?: string) {
    this.cookies = new Map(saved ? (JSON.parse(saved) as [string, string][]) : []);
  }

  save() {
    return JSON.stringify([...this.cookies]);
  }

  async go(url: string, init: { method?: string; body?: URLSearchParams } = {}) {
    let current = url;
    let { method = "GET", body } = init;
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(current, {
        method,
        body,
        redirect: "manual",
        headers: {
          "User-Agent": BROWSER_UA,
          Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!value || value === "deleted") this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        current = new URL(location, current).toString();
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return { url: current, text: await res.text() };
    }
    throw new MoodleError("Too many redirects.");
  }
}

function alerts(html: string) {
  const msgs = [...html.matchAll(/<div[^>]+class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  const clean = msgs
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return clean.join("\n") || html.slice(0, 300);
}

const SERVER_MARKERS: [string, string][] = [
  ["qr_pass_wrong", "QR password wrong/expired — it rotates; scan the current code."],
  ["already_submitted", "Attendance already submitted for this session."],
  ["invalidkey", "Autologin key rejected."],
  ["httpsrequired", "Server requires HTTPS for autologin."],
];

/**
 * Open `qr` in a logged-in Moodle session. Reuses `account.session` while Moodle still
 * accepts it; otherwise spends an autologin key and reports the new session through
 * `onSession` (null when the saved one expired and no new one could be made).
 */
async function openLoggedIn(
  account: MoodleAccount,
  qr: string,
  onSession: (session: string | null) => Promise<void>,
) {
  if (account.session) {
    const browser = new Browser(account.session);
    const page = await browser.go(qr);
    // an expired session lands on the login page
    if (!new URL(page.url).pathname.includes("/login/")) {
      if (browser.save() !== account.session) await onSession(browser.save());
      return { browser, page };
    }
  }

  // one-time autologin key (~60 s TTL, single use, at most one per user every ~6 min)
  const key = await api<{ key: string; autologinurl: string }>(
    account.site,
    "tool_mobile_get_autologin_key",
    account.token,
    { privatetoken: account.privatetoken },
    APP_UA,
  ).catch(async (e) => {
    if (account.session) await onSession(null);
    throw new MoodleError(`Could not get autologin key: ${e.message}`);
  });

  // autologin -> real Moodle session cookie, redirected onto the attendance page
  const browser = new Browser();
  const page = await browser.go(
    `${key.autologinurl}?userid=${account.userid}&key=${key.key}` +
      `&urltogo=${encodeURIComponent(qr)}`,
  );
  // saved even if marking fails below: the key is spent, so retries need this session
  if (!new URL(page.url).pathname.includes("/login/")) await onSession(browser.save());
  return { browser, page };
}

/** Mark one account present for the class in `qr`. Returns the status label used. */
export async function markAttendance(
  account: MoodleAccount,
  qr: string,
  want?: string,
  onSession: (session: string | null) => Promise<void> = async () => {},
) {
  const { site } = account;
  qr = retarget(qr, site);

  const { browser, page } = await openLoggedIn(account, qr, onSession);
  for (const [marker, msg] of SERVER_MARKERS) {
    if (page.text.includes(marker)) throw new MoodleError(msg);
  }
  if (!page.url.includes("attendance.php")) {
    let hint = "";
    if (new URL(qr).host !== new URL(site).host) {
      // autologin only redirects within its own wwwroot
      hint = ` QR points to ${new URL(qr).host} but this token is for ${site}.`;
    }
    throw new MoodleError(
      `Did not reach the marking page (session closed or already marked?).${hint} ${alerts(page.text)}`,
    );
  }

  // 3. parse the self-marking form and pick a status
  const root = parse(page.text);
  const labels = new Map(
    root.querySelectorAll("label[for]").map((l) => [l.getAttribute("for")!, l.text]),
  );
  const form = root
    .querySelectorAll("form")
    .find((f) => f.querySelector('input[type="radio"][name="status"]'));
  const sesskey = page.text.match(/"sesskey"\s*:\s*"(\w+)"/);
  if (!form || !sesskey) {
    throw new MoodleError(
      `No self-marking form found (session not open to students?). ${alerts(page.text)}`,
    );
  }

  const radios = form.querySelectorAll('input[type="radio"][name="status"]').map((r) => ({
    value: r.getAttribute("value") ?? "",
    label: (labels.get(r.getAttribute("id") ?? "") ?? "").trim(),
  }));
  const order = [...(want ? [want] : []), "present", "נוכח"];
  const chosen =
    order
      .map((w) => radios.find((r) => r.label.toLowerCase().includes(w.toLowerCase())))
      .find(Boolean) ?? radios[0]; // fallback: first option (Moodle orders Present first)

  const data = new URLSearchParams();
  for (const input of form.querySelectorAll('input[type="hidden"][name]')) {
    data.set(input.getAttribute("name")!, input.getAttribute("value") ?? "");
  }
  data.set("sesskey", sesskey[1]);
  data.set("status", chosen.value);
  data.set("submitbutton", "Save");
  const q = new URL(qr).searchParams;
  if (q.get("qrpass") && !data.has("studentpassword")) {
    data.set("studentpassword", q.get("qrpass")!);
  }

  let post = new URL(form.getAttribute("action") || "/mod/attendance/attendance.php", page.url)
    .toString();
  if (!post.includes("sessid") && q.has("sessid")) {
    post += (post.includes("?") ? "&" : "?") + new URL(qr).search.slice(1);
  }
  const resp = await browser.go(post, { method: "POST", body: data });

  if (!resp.url.includes("view.php")) {
    throw new MoodleError(`Submission sent but result is unclear. Page says: ${alerts(resp.text)}`);
  }
  return chosen.label || "first option";
}
