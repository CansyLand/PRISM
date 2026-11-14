// Visitor tracking: collects events from /t.js and serves the dashboard.
//   POST /api/t          events from the browser (array, at most 30 per request)
//   GET  /analytics      dashboard (password: ANALYTICS_PASS, or the one in app/.analytics-pass)
//   GET  /api/analytics?days=1|7|30|0   numbers for the dashboard (0 = all time)
// Events are appended to app/.analytics.jsonl, one per line, and kept in memory.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(DIR, ".analytics.jsonl");
const PASSFILE = path.join(DIR, ".analytics-pass");
const PAGE = path.join(DIR, "analytics.html");
const WAITLIST = path.join(DIR, ".waitlist.txt"); // written by server.js: "email<TAB>ISO time<TAB>source" per line, line number = place in line
const readWaitlist = () => (fs.existsSync(WAITLIST) ? fs.readFileSync(WAITLIST, "utf8") : "").split("\n").filter(Boolean)
  .map((l, i) => { const [email, at, source] = l.split("\t"); return { place: i + 1, email, at: Date.parse(at) || null, source: source || "" }; });
const PASS = process.env.ANALYTICS_PASS || (fs.existsSync(PASSFILE) ? fs.readFileSync(PASSFILE, "utf8").trim() : (() => {
  const p = crypto.randomBytes(9).toString("base64url"); fs.writeFileSync(PASSFILE, p, { mode: 0o600 });
  console.log(`[analytics] no ANALYTICS_PASS set; generated one in ${PASSFILE}`); return p;
})());
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python|go-http/i;
const TYPES = new Set(["view", "ping", "click", "act", "wallet", "error"]);

const events = [];
if (fs.existsSync(LOG)) for (const line of fs.readFileSync(LOG, "utf8").split("\n")) { if (line) try { events.push(JSON.parse(line)); } catch {} }
const out = fs.createWriteStream(LOG, { flags: "a", mode: 0o600 });

const ipOf = (req) => req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
const authed = (req) => {
  const h = req.headers.authorization || "";
  const given = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  const a = Buffer.from(given), b = Buffer.from(PASS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const deny = (res) => { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Uprise analytics"', "Content-Type": "text/plain" }); res.end("password needed"); };
const clip = (o) => { // keep stored values small and flat
  const d = {}; for (const [k, v] of Object.entries(o || {}).slice(0, 20)) if (["string", "number", "boolean"].includes(typeof v)) d[k.slice(0, 20)] = typeof v === "string" ? v.slice(0, 200) : v; return d;
};
const hits = new Map();

async function collect(req, res) {
  let s = ""; for await (const c of req) { s += c; if (s.length > 20_000) break; }
  res.writeHead(204, { "Cache-Control": "no-store" }); res.end();
  const ua = req.headers["user-agent"] || ""; if (BOT.test(ua)) return;
  const ip = ipOf(req), now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (h.length > 120) return; h.push(now); hits.set(ip, h);
  let list; try { list = JSON.parse(s); } catch { return; }
  if (!Array.isArray(list)) return;
  for (const e of list.slice(0, 30)) {
    if (!e || !TYPES.has(e.t) || typeof e.v !== "string" || typeof e.s !== "string") continue;
    const ev = { at: now, t: e.t, v: e.v.slice(0, 32), s: e.s.slice(0, 32), p: String(e.p || "/").slice(0, 100), d: clip(e.d) };
    if (e.t === "view") Object.assign(ev.d, { ua: ua.slice(0, 200), ip });
    if (e.t === "ping") ev.d.sec = Math.max(0, Math.min(60, Number(ev.d.sec) || 0));
    events.push(ev); out.write(JSON.stringify(ev) + "\n");
  }
}

const day = (t) => new Date(t).toISOString().slice(0, 10);
const host = (r) => { try { return r ? new URL(r).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
const device = (d) => (/iPhone|Android.*Mobile|Mobile/i.test(d.ua || "") || (d.w > 0 && d.w < 700) ? "mobile" : /iPad|Tablet/i.test(d.ua || "") ? "tablet" : "desktop");
const browser = (ua = "") => (/Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "other");
const bump = (o, k, n = 1) => { if (k) o[k] = (o[k] || 0) + n; };
const top = (o, n = 15) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

function report(days) {
  const now = Date.now(), from = days ? now - days * 86_400_000 : 0;
  const sessions = new Map(), visitors = new Map(), wallets = new Map();
  const perDay = {}, pages = {}, refs = {}, utms = {}, devices = {}, browsers = {}, zones = {}, langs = {}, tabs = {}, clicks = {}, acts = {}, errors = [];
  const online = new Set();
  for (const e of events) {
    if (now - e.at < 60_000) online.add(e.v);
    if (e.at < from) continue;
    let s = sessions.get(e.s);
    if (!s) { s = { id: e.s, v: e.v, start: e.at, end: e.at, sec: 0, views: 0, pages: new Set(), events: [], wallets: new Set() }; sessions.set(e.s, s); }
    let v = visitors.get(e.v);
    if (!v) { v = { id: e.v, first: e.at, last: e.at, sec: 0, sessions: new Set(), wallets: new Set(), steps: new Set(["visit"]) }; visitors.set(e.v, v); }
    s.end = e.at; v.last = e.at; v.sessions.add(e.s);
    const dd = (perDay[day(e.at)] ||= { visitors: new Set(), sessions: new Set(), views: 0, sec: 0, wallets: new Set() });
    dd.visitors.add(e.v); dd.sessions.add(e.s);
    const d = e.d || {};
    if (d.mode === "live") v.steps.add("live");
    if (e.t === "view") {
      s.views++; s.pages.add(e.p); dd.views++; bump(pages, e.p);
      if (!s.ref && s.views === 1) {
        s.ref = host(d.ref) || "(direct)"; s.utm = [d.source, d.medium, d.campaign, d.ref && !d.ref.includes("/") ? d.ref : ""].filter(Boolean).join(" / ");
        s.device = device(d); s.browser = browser(d.ua); s.tz = d.tz; s.lang = d.lang; s.ip = d.ip;
        if (s.ref.endsWith("uprise.wtf")) s.ref = "(internal)";
        bump(refs, s.ref); bump(utms, s.utm); bump(devices, s.device); bump(browsers, s.browser); bump(zones, d.tz); bump(langs, (d.lang || "").split("-")[0]);
        v.ref ||= s.ref; v.utm ||= s.utm; v.device ||= s.device; v.tz ||= d.tz;
      }
    } else if (e.t === "ping") { s.sec += d.sec; v.sec += d.sec; dd.sec += d.sec; bump(tabs, e.p === "/" ? d.tab || "?" : e.p, d.sec); }
    else if (e.t === "click") { bump(clicks, d.el); if (d.el === "mode:live") v.steps.add("live"); }
    else if (e.t === "error") errors.push({ at: e.at, p: e.p, msg: d.msg, src: d.src });
    if (e.t === "wallet" || e.t === "act") {
      if (d.acct) {
        s.wallets.add(d.acct); v.wallets.add(d.acct); dd.wallets.add(d.acct); v.steps.add("wallet"); v.steps.add("live");
        let w = wallets.get(d.acct);
        if (!w) { w = { id: d.acct, kind: d.kind, first: e.at, last: e.at, visitors: new Set(), acts: {}, fails: 0, volume: 0, net: d.net }; wallets.set(d.acct, w); }
        w.last = e.at; w.visitors.add(e.v); if (d.kind) w.kind = d.kind; if (d.net) w.net = d.net;
        if (e.t === "act") { bump(w.acts, d.act + (d.ok ? "" : " ✗")); if (!d.ok) w.fails++; else if (d.usd && ["buy", "vaultDeposit"].includes(d.act)) w.volume += d.usd; }
      }
      if (e.t === "act") {
        bump(acts, d.act + (d.ok ? "" : " (failed)"));
        if (d.ok && (d.act === "faucet" || d.act === "createDevice")) v.steps.add("funded"); // testnet: new device wallets get 1,000 test USDC
        if (d.ok && (d.act === "buy" || d.act === "vaultDeposit")) { v.steps.add("funded"); v.steps.add("traded"); }
      }
    }
    if (e.t !== "ping") s.events.push({ at: e.at, t: e.t, p: e.p, d: e.t === "view" ? { ref: d.ref, w: d.w, h: d.h } : d });
  }
  for (const w of wallets.values()) { const v = visitors.get([...w.visitors][0]); w.ref = v?.ref; w.utm = v?.utm; w.sec = [...w.visitors].reduce((a, id) => a + (visitors.get(id)?.sec || 0), 0); w.visitors = w.visitors.size; }
  const V = [...visitors.values()], S = [...sessions.values()];
  const secs = S.map((s) => s.sec).sort((a, b) => a - b);
  const funnel = ["visit", "live", "wallet", "funded", "traded"].map((k) => [k, V.filter((v) => v.steps.has(k)).length]);
  const dayList = []; for (let t = days ? now - (days - 1) * 86_400_000 : Math.min(...events.map((e) => e.at), now); t <= now + 1; t += 86_400_000) dayList.push(day(t));
  return {
    now, days,
    online: online.size,
    totals: { visitors: V.length, sessions: S.length, views: S.reduce((a, s) => a + s.views, 0), wallets: wallets.size, returning: V.filter((v) => v.sessions.size > 1).length,
      avgSec: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : 0, medianSec: secs.length ? secs[Math.floor(secs.length / 2)] : 0,
      bounce: S.length ? S.filter((s) => s.sec < 10 && s.events.length <= 1).length / S.length : 0 },
    perDay: [...new Set(dayList)].map((k) => { const x = perDay[k]; return { day: k, visitors: x?.visitors.size || 0, sessions: x?.sessions.size || 0, views: x?.views || 0, sec: x?.sec || 0, wallets: x?.wallets.size || 0 }; }),
    funnel, pages: top(pages), refs: top(refs), utms: top(utms).filter(([k]) => k), devices: top(devices), browsers: top(browsers), zones: top(zones), langs: top(langs),
    waitlist: readWaitlist().reverse(), // all time, newest first
    tabs: top(tabs), clicks: top(clicks, 25), acts: top(acts, 25), errors: errors.slice(-30).reverse(),
    wallets: [...wallets.values()].sort((a, b) => b.last - a.last).slice(0, 300),
    sessions: S.sort((a, b) => b.end - a.end).slice(0, 150).map((s) => ({ ...s, pages: [...s.pages], wallets: [...s.wallets], events: s.events.slice(-80), visits: visitors.get(s.v)?.sessions.size })),
  };
}

/** Handles tracking routes. Returns true when it answered the request. */
export async function track(req, res, url) {
  if (url.pathname === "/api/t" && req.method === "POST") { await collect(req, res); return true; }
  if (url.pathname === "/analytics" || url.pathname === "/analytics/") {
    if (!authed(req)) return deny(res), true;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }); fs.createReadStream(PAGE).pipe(res); return true;
  }
  if (url.pathname === "/api/analytics") {
    if (!authed(req)) return deny(res), true;
    const days = Number(url.searchParams.get("days") ?? 7);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(report([0, 1, 7, 30, 90].includes(days) ? days : 7))); return true;
  }
  return false;
}
