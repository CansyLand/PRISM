// Uprise visitor tracking. Add to any page with: <script defer src="/t.js"></script>
// Sends small events to /api/t: page views, active time (every 15 s while the tab is visible),
// clicks on buttons and tabs, and, on the app page, wallet and trade steps (read from window.uprise,
// the live client). The dashboard is at /analytics.
(() => {
  if (navigator.webdriver || /bot|crawl|spider|slurp|headless|lighthouse|preview/i.test(navigator.userAgent)) return;
  const get = (s, k) => { try { return s.getItem(k); } catch { return null; } };
  const put = (s, k, v) => { try { s.setItem(k, v); } catch {} };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const vid = get(localStorage, "uprise.t.v") || rid(); put(localStorage, "uprise.t.v", vid);
  // a session ends after 30 min without activity
  let sid = get(localStorage, "uprise.t.s"), seen = Number(get(localStorage, "uprise.t.at") || 0);
  if (!sid || Date.now() - seen > 30 * 60_000) sid = rid();
  const touch = () => { put(localStorage, "uprise.t.s", sid); put(localStorage, "uprise.t.at", String(Date.now())); };
  touch();

  let q = [];
  const flush = () => {
    if (!q.length) return;
    const body = JSON.stringify(q); q = [];
    if (!(navigator.sendBeacon && navigator.sendBeacon("/api/t", new Blob([body], { type: "text/plain" })))) fetch("/api/t", { method: "POST", body, keepalive: true }).catch(() => {});
  };
  const sel = (s) => document.querySelector(s);
  const ctx = () => ({ tab: sel("nav.tabs button[aria-selected=true]")?.dataset.tab, mode: sel("[data-mode][aria-selected=true]")?.dataset.mode });
  const send = (t, d = {}, now) => { touch(); q.push({ v: vid, s: sid, t, p: location.pathname, at: Date.now(), d: { ...ctx(), ...d } }); if (now || q.length > 15) flush(); };

  const u = new URLSearchParams(location.search), utm = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "ref"]) if (u.get(k)) utm[k.replace("utm_", "")] = u.get(k).slice(0, 60);
  send("view", { ref: document.referrer.slice(0, 200), ...utm, w: innerWidth, h: innerHeight, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, title: document.title.slice(0, 60) }, true);

  // active time: counts only while the page is visible
  let since = document.hidden ? 0 : Date.now();
  const tick = (final) => { if (since) { const sec = Math.round((Date.now() - since) / 1000); if (sec > 0) send("ping", { sec }); since = document.hidden || final ? 0 : Date.now(); } flush(); };
  setInterval(() => !document.hidden && tick(), 15_000);
  document.addEventListener("visibilitychange", () => (document.hidden ? tick(true) : (since = Date.now())));
  addEventListener("pagehide", () => tick(true));

  // clicks on buttons, tabs and links
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("button, a, [role=tab]"); if (!b) return;
    if (b.dataset.tab || b.dataset.mode) tick(); // time so far goes to the tab being left
    const name = b.dataset.tab ? "tab:" + b.dataset.tab : b.dataset.mode ? "mode:" + b.dataset.mode : b.id || (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (name) send("click", { el: name, href: b.href ? b.getAttribute("href").slice(0, 120) : undefined });
  }, true);

  let errs = 0;
  addEventListener("error", (e) => errs++ < 5 && send("error", { msg: String(e.message).slice(0, 200), src: (e.filename || "").split("/").pop() + ":" + e.lineno }));
  addEventListener("unhandledrejection", (e) => errs++ < 5 && send("error", { msg: String(e.reason?.message || e.reason).slice(0, 200) }));

  // wallet + trades from the live client (app page only)
  let acct = null, hooked = null;
  const amount = (x) => (x == null ? undefined : Number(x) / 1e6);
  const steps = {
    createDevice: () => ({}), connectWallet: (silent) => (silent ? null : {}), recoverFinish: () => ({}), backup: () => ({}), disconnect: () => ({}),
    faucet: () => ({}), buy: (raw, power) => ({ usd: amount(raw), power }), close: (power) => ({ power }),
    vaultDeposit: (raw) => ({ usd: amount(raw) }), vaultWithdraw: (shares) => ({ shares: shares ? String(shares) : "all" }), send: (to, raw) => ({ usd: amount(raw), to }),
  };
  setInterval(() => {
    const L = window.uprise; if (!L) return;
    if (hooked !== L) {
      hooked = L;
      for (const [m, info] of Object.entries(steps)) {
        const fn = L[m]; if (typeof fn !== "function") continue;
        L[m] = async function (...a) {
          const d = info(...a); if (!d) return fn.apply(this, a);
          try { const r = await fn.apply(this, a); send("act", { act: m, ok: true, acct: this.accountId, ...d }, true); return r; }
          catch (err) { send("act", { act: m, ok: false, acct: this.accountId, err: String(err?.message || err).slice(0, 200), ...d }, true); throw err; }
        };
      }
    }
    if (L.accountId !== acct) { acct = L.accountId; send("wallet", { acct, kind: L.kind, net: L.cfg?.network }, true); }
  }, 1000);
})();
