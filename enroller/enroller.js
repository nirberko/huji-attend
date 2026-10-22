#!/usr/bin/env node
/*
 * HUJI Attend — Enroller (desktop)
 *
 * Adds Moodle users to the cloud app from your own network. HUJI binds a profile QR
 * to the IP of the browser that showed it and only accepts the token exchange from
 * that same IP, so the exchange cannot run on Cloudflare — it must run here, on your
 * LAN. This program:
 *   1. serves a small HTTPS page your phone opens (same Wi-Fi),
 *   2. you scan the Moodle profile QR with the phone camera,
 *   3. it exchanges the QR for a token *from this machine* (passing the IP check),
 *   4. it hands the token to your Cloudflare worker to store in D1.
 * After that the deployed app sees the user and marks attendance from anywhere.
 */
"use strict";

const https = require("node:https");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const dgram = require("node:dgram");
const selfsigned = require("selfsigned");
const qrcode = require("qrcode");

const APP_UA = "Mozilla/5.0 MoodleMobile"; // passes core_useragent::is_moodle_app()

const DEFAULTS = {
  workerUrl: "https://huji-attend.nirberko.workers.dev",
  appPassword: "KW4jG16wvDc1hF0GiLjl",
  // "" = use the site embedded in each scanned QR instead of forcing one.
  moodleBaseUrl: "https://moodle.huji.ac.il/2026-27",
  port: 8787,
};

/** Where the exe lives (pkg) or the script dir (node), for config.json next to it. */
function baseDir() {
  return process.pkg ? path.dirname(process.execPath) : __dirname;
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const file = path.join(baseDir(), "config.json");
    if (fs.existsSync(file)) Object.assign(cfg, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    console.warn("Could not read config.json, using defaults:", e.message);
  }
  // Env overrides win, for quick testing.
  if (process.env.WORKER_URL) cfg.workerUrl = process.env.WORKER_URL;
  if (process.env.APP_PASSWORD) cfg.appPassword = process.env.APP_PASSWORD;
  if (process.env.MOODLE_BASE_URL !== undefined) cfg.moodleBaseUrl = process.env.MOODLE_BASE_URL;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  cfg.workerUrl = String(cfg.workerUrl).replace(/\/+$/, "");
  cfg.moodleBaseUrl = String(cfg.moodleBaseUrl || "").replace(/\/+$/, "");
  return cfg;
}

const CONFIG = loadConfig();

// ---------- asset loading (bundled by pkg) ----------

function asset(name) {
  return fs.readFileSync(path.join(__dirname, "assets", name));
}

// ---------- Moodle QR → token exchange (ported from lib/moodle.ts) ----------

function qrUrl(payload) {
  const rest = payload.slice(payload.indexOf("://") + 3);
  return new URL(rest.includes("://") ? rest : "https://" + rest);
}

function effectiveSite(payload) {
  if (CONFIG.moodleBaseUrl) return CONFIG.moodleBaseUrl;
  const u = qrUrl(payload);
  return (u.protocol + "//" + u.host + u.pathname).replace(/\/+$/, "");
}

async function exchange(payload) {
  if (!payload || !payload.includes("qrlogin=")) {
    throw new Error("Not a profile QR. Open Moodle profile -> 'QR code for mobile app access'.");
  }
  const site = effectiveSite(payload);
  const q = qrUrl(payload).searchParams;
  const userid = Number(q.get("userid"));
  const qrloginkey = q.get("qrlogin");
  if (!userid || !qrloginkey) throw new Error("Profile QR is missing userid/qrlogin.");

  const r = await fetch(site + "/lib/ajax/service.php", {
    method: "POST",
    headers: { "User-Agent": APP_UA, "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        index: 0,
        methodname: "tool_mobile_get_tokens_for_qr_login",
        args: { qrloginkey, userid },
      },
    ]),
  }).catch((e) => {
    throw new Error("Could not reach Moodle at " + site + " (" + (e.cause?.code || e.message) + ")");
  });
  const [result] = await r.json();
  if (result && result.error) {
    throw new Error(
      "Login QR exchange failed: " +
        (result.exception?.message || "unknown") +
        " (QR keys expire ~10 min after the profile page loads and are bound to the IP of " +
        "that browser — reload the page and scan fresh, from the same network as this program.)",
    );
  }
  return { site, userid, token: result.data.token, privatetoken: result.data.privatetoken };
}

/** Hand the exchanged token to the Cloudflare worker, which validates and stores it. */
async function storeOnWorker(account) {
  const auth = "Basic " + Buffer.from("enroller:" + CONFIG.appPassword).toString("base64");
  const resp = await fetch(CONFIG.workerUrl + "/api/users/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(account),
  }).catch((e) => {
    throw new Error("Could not reach the cloud app (" + (e.cause?.code || e.message) + ")");
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || "Cloud app returned HTTP " + resp.status);
  return data;
}

// ---------- networking ----------

/** The LAN IP the OS actually routes outbound traffic through (the real Wi-Fi/Ethernet
 *  one), which is the address the phone on the same network should use. */
function primaryIP() {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    try {
      s.connect(80, "8.8.8.8", () => {
        let addr = null;
        try { addr = s.address().address; } catch {}
        s.close();
        resolve(addr);
      });
    } catch {
      resolve(null);
    }
  });
}

function lanIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function makeCert(ips) {
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: "commonName", value: "huji-attend-enroller" }], {
    days: 825,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames }],
  });
  return { key: pems.private, cert: pems.cert };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) reject(new Error("Body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function handle(req, res) {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
      return send(res, 200, "text/html; charset=utf-8", PAGE);
    }
    if (req.method === "GET" && req.url === "/jsQR.js") {
      return send(res, 200, "application/javascript; charset=utf-8", asset("jsQR.js"));
    }
    if (req.method === "POST" && req.url === "/enroll") {
      const { payload } = JSON.parse((await readBody(req)) || "{}");
      const account = await exchange(payload);
      const saved = await storeOnWorker(account);
      console.log("  + added: " + (saved.fullname || "user") + " (" + (saved.username || "?") + ")");
      return send(res, 200, "application/json", JSON.stringify(saved));
    }
    send(res, 404, "text/plain", "Not found");
  } catch (e) {
    console.log("  ! " + e.message);
    send(res, 400, "application/json", JSON.stringify({ error: e.message }));
  }
}

// ---------- the phone page ----------

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Add Moodle user</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background: #0b0b0c; color: #f4f4f5; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 20px; margin: 8px 0 4px; }
  p.sub { color: #a1a1aa; font-size: 14px; margin: 0 0 16px; }
  video { width: 100%; aspect-ratio: 1; object-fit: cover; background: #000; border-radius: 16px; }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  label.file, button { border: 0; border-radius: 10px; padding: 12px 14px; font-size: 15px;
         font-weight: 600; cursor: pointer; }
  label.file { background: #27272a; color: #f4f4f5; display: block; text-align: center; flex: 1; }
  button { background: #f4f4f5; color: #09090b; }
  input[type=text] { flex: 1; min-width: 0; border-radius: 10px; border: 1px solid #3f3f46;
         background: transparent; color: inherit; padding: 12px; font-size: 15px; }
  .msg { margin-top: 16px; padding: 12px 14px; border-radius: 10px; font-size: 14px; display: none; }
  .ok { background: #052e1a; color: #86efac; display: block; }
  .err { background: #3f1212; color: #fca5a5; display: block; }
  .hint { background: #1f2937; color: #cbd5e1; display: block; }
  ul { padding-left: 18px; margin: 10px 0 0; } li { margin: 4px 0; color: #d4d4d8; font-size: 14px; }
</style></head>
<body><div class="wrap">
  <h1>Add Moodle user</h1>
  <p class="sub">Open Moodle &rarr; your profile &rarr; "QR code for mobile app access", then scan it below.</p>
  <video id="v" muted playsinline></video>
  <div class="row">
    <label class="file">Upload a screenshot / photo
      <input id="file" type="file" accept="image/*" hidden />
    </label>
  </div>
  <form id="pasteForm" class="row">
    <input id="text" type="text" placeholder="…or paste the decoded QR text" />
    <button type="submit">Use</button>
  </form>
  <div id="msg" class="msg"></div>
  <ul id="log"></ul>
</div>
<script src="/jsQR.js"></script>
<script>
  const msg = document.getElementById("msg");
  const log = document.getElementById("log");
  let busy = false, done = new Set();

  function show(text, cls) { msg.textContent = text; msg.className = "msg " + cls; }

  async function enroll(payload) {
    if (busy) return;
    if (done.has(payload)) return;
    busy = true; show("Adding…", "hint");
    try {
      const r = await fetch("/enroll", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed");
      done.add(payload);
      show("Added " + (data.fullname || "user") + (data.username ? " (" + data.username + ")" : "") + ".", "ok");
      const li = document.createElement("li");
      li.textContent = (data.fullname || "user") + " — added";
      log.prepend(li);
    } catch (e) { show(e.message, "err"); }
    finally { busy = false; }
  }

  // paste
  document.getElementById("pasteForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = document.getElementById("text").value.trim();
    if (t) enroll(t);
  });

  // image upload
  document.getElementById("file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const pad = 40;
    const c = document.createElement("canvas");
    c.width = bmp.width + pad * 2; c.height = bmp.height + pad * 2;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, pad, pad);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const code = window.jsQR(img.data, img.width, img.height);
    if (code && code.data) enroll(code.data);
    else show("No QR code found in that image.", "err");
  });

  // live camera
  (async () => {
    const v = document.getElementById("v");
    const c = document.createElement("canvas");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      v.srcObject = stream; await v.play();
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const tick = () => {
        if (v.readyState === v.HAVE_ENOUGH_DATA) {
          c.width = v.videoWidth; c.height = v.videoHeight;
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const code = window.jsQR(img.data, img.width, img.height);
          if (code && code.data) enroll(code.data);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      show("Camera unavailable (" + e.message + "). Accept the certificate warning, or use upload / paste.", "hint");
    }
  })();
</script>
</body></html>`;

// ---------- boot ----------

async function main() {
  const ips = lanIPv4s();
  const { key, cert } = makeCert(ips);
  const server = https.createServer({ key, cert }, handle);
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error("\nPort " + CONFIG.port + " is already in use. Close the other program or set a different");
      console.error('"port" in config.json, then run this again.');
    } else {
      console.error("Server error:", e.message);
    }
    waitForKey();
  });
  server.listen(CONFIG.port, "0.0.0.0", async () => {
    // Pick the address the phone should use: the real outbound LAN IP if we can find it.
    const primary = (await primaryIP()) || ips[0] || null;
    const primaryUrl = primary ? "https://" + primary + ":" + CONFIG.port : null;

    console.log("\n======================================================");
    console.log("  HUJI Attend — Enroller is running");
    console.log("======================================================\n");

    if (primaryUrl) {
      console.log("On your PHONE (same Wi-Fi), scan this to open the page:\n");
      try {
        const qr = await qrcode.toString(primaryUrl, { type: "terminal", small: true });
        console.log(qr);
      } catch {
        /* fall back to the text URL below */
      }
      console.log("  " + primaryUrl + "\n");
      console.log("Accept the certificate warning (Advanced -> proceed). No login.");
    } else {
      console.log("No network address found — connect to Wi-Fi and restart.");
    }

    const others = ips.filter((ip) => ip !== primary);
    if (others.length) {
      console.log("\nIf that address doesn't work, try one of these instead:");
      for (const ip of others) console.log("    https://" + ip + ":" + CONFIG.port);
    }

    console.log("\nThen: Moodle profile -> 'QR code for mobile app access' -> scan it.");
    console.log("Target Moodle : " + (CONFIG.moodleBaseUrl || "(from each QR)"));
    console.log("Cloud app     : " + CONFIG.workerUrl);
    console.log("\nIf Windows asks, allow access on Private networks.");
    console.log("Leave this window open. Press Ctrl+C to stop.\n");
  });
}

function waitForKey() {
  try {
    console.log("\nPress Enter to close…");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(1));
  } catch { process.exit(1); }
}

main();
