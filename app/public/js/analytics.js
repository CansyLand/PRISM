// Analytics arena: traders on the left, the vault in the middle, liquidity providers on the right,
// coins flying between them. Demo: a small simulated crowd. Live: real ledger accounts, with
// coins animated from the changes between polls (an approximation of on-chain flows).
import { css, fit, pw } from "./theme.js";
const rand = (a, b) => a + Math.random() * (b - a);
const big = (v) => (Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e4 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + Math.round(v).toLocaleString("en-US"));

export class Arena {
  constructor(canvas) {
    this.cv = canvas; this.coins = []; this.retail = []; this.hunters = []; this.vault = { x: 0, y: 0, r: 60, nav: 0, usdc: 0, asset: 0, owed: 0, label: "" };
    this.exch = { x: 0, y: 0, r: 22, total: 0 }; this.running = false; this.mode = "demo"; this.prev = new Map();
  }
  start(mode, live) {
    this.mode = mode; this.live = live; this.coins = []; this.prev = new Map(); this.W = 0; // force a fresh layout: new people have no positions yet
    if (mode === "demo") this.seedDemo();
    if (!this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame((t) => this.frame(t)); }
    clearInterval(this.poll);
    if (mode === "live") { this.pollLive(); this.poll = setInterval(() => this.pollLive(), 8000); }
  }
  stop() { this.running = false; clearInterval(this.poll); }

  // ── demo crowd ──
  seedDemo() {
    this.retail = Array.from({ length: 18 }, (_, i) => ({ id: "r" + i, bank: Math.round(rand(50, 500)), value: 0, open: false, p: 0, wait: rand(0, 3) }));
    this.hunters = Array.from({ length: 5 }, (_, i) => ({ id: "h" + i, value: Math.round(rand(20, 100)) * 100 }));
    const tvl = this.hunters.reduce((a, h) => a + h.value, 0);
    Object.assign(this.vault, { nav: tvl, usdc: tvl, asset: 0, owed: 0, label: "Crab vault" });
    this.price = 1; this.exch.total = 0; Object.assign(this.vault, { apy: 0, earned: 0, perDay: 0, rate: undefined });
  }
  stepDemo(dt) {
    this.price *= Math.exp(0.9 * Math.sqrt(dt) * 0.1 * gauss());
    let owed = 0, funding = 0;
    for (const r of this.retail) {
      if (r.open) {
        r.value = r.stake * Math.pow(this.price / r.entry, r.p) * Math.exp(-0.05 * r.p * (r.age += dt));
        // funding = only the melt part (not price moves): the value it loses to time in this step
        const drip = r.value * (Math.exp(0.05 * r.p * dt) - 1); funding += drip;
        r.dripAcc = (r.dripAcc || 0) + drip; while (r.dripAcc >= 10) { r.dripAcc -= 10; this.emit(r, this.vault, "fund", 1); }
        owed += r.value;
        if (r.age > r.hold || r.value < r.stake * 0.2 || r.value > r.stake * 2.5) {
          const out = r.value; r.bank += out; r.open = false; r.wait = rand(1, 4); this.vault.usdc -= out;
          this.emit(this.vault, r, out > r.stake ? "win" : "coin", Math.min(30, Math.round(out / 10)));
        }
      } else if ((r.wait -= dt) <= 0 && r.bank >= 10) {
        const stake = Math.round(r.bank * rand(0.3, 1)); r.bank -= stake; this.vault.usdc += stake; this.exch.total += stake * 0.003;
        Object.assign(r, { open: true, stake, p: 1 + Math.floor(rand(0, 10)), entry: this.price, age: 0, hold: rand(4, 14), value: stake, lastV: stake });
        this.emit(r, this.vault, "coin", Math.min(30, Math.round(stake / 10)));
      } else if (r.bank < 10) { r.bank = Math.round(rand(50, 500)); }
    }
    this.vault.owed = owed;
    const delta = owed * 3; // vault keeps p × claims in the asset; show it as the NEAR share
    this.vault.asset += (delta - this.vault.asset) * Math.min(1, dt);
    this.vault.nav = this.hunters.reduce((a, h) => a + h.value, 0);
    // Yield is exactly the funding open positions paid (90% to providers, 10% exchange fee), split by
    // deposit. Few open positions → little yield; nobody holding → no yield coins at all.
    const toLPs = funding * 0.9, nav = this.vault.nav || 1; this.exch.total += funding * 0.1;
    for (const h of this.hunters) {
      const add = toLPs * (h.value / nav); this.vault.earned += add; h.value += add;
      h.yAcc = (h.yAcc || 0) + add; while (h.yAcc >= 10) { h.yAcc -= 10; this.emit(this.yieldC, h, "yield", 1); }
    }
    // shown APY: recent yield per second (EMA), one demo second ≈ one month, so a year ≈ 12.2 s
    this.vault.rate = (this.vault.rate ?? toLPs / Math.max(dt, 1e-3)) * 0.98 + (toLPs / Math.max(dt, 1e-3)) * 0.02;
    this.vault.apy = (this.vault.rate * 12.17) / nav; this.vault.perDay = this.vault.rate * 12.17 / 365;
    if (Math.random() < dt * 0.08) { const h = this.hunters[Math.floor(Math.random() * this.hunters.length)]; const x = Math.round(rand(5, 20)) * 100; h.value += x; this.emit(h, this.vault, "bar", Math.max(1, Math.round(x / 1000))); }
  }

  // ── live: real accounts ──
  async pollLive() {
    const L = this.live; if (!L?.cfg) return;
    try {
      const [accts, market, vault] = await Promise.all([L.view(L.cfg.ledger, "get_accounts", { from_index: 0, limit: 60 }), L.view(L.cfg.ledger, "get_market"), L.view(L.cfg.vault, "get_vault")]);
      const e6 = (x) => Number(x) / 1e6, s = vault.snapshot;
      const traders = accts.filter((a) => a.account_id !== L.cfg.vault);
      this.retail = traders.slice(0, 40).map((a) => ({ id: a.account_id, bank: e6(a.free), value: e6(a.long_value), open: BigInt(a.long_units) > 0n, p: market.power, stake: e6(a.long_cost) }));
      Object.assign(this.vault, { nav: e6(s.nav), usdc: e6(s.usdc) + e6(s.short_value) + e6(s.ledger_free), asset: e6(vault.hedge_value), owed: e6(market.long_claims), label: "Crab vault" });
      // the vault's depositors: you (always shown and marked) and everyone else as one circle
      const mine = L.accountId ? e6(L.state?.pos?.value || 0) + e6(L.state?.pos?.pending_deposit || 0) : 0; // includes a deposit still waiting for the next vault update
      this.hunters = mine > 0 ? [{ id: "you", value: mine, me: true }, { id: "others", value: Math.max(0, e6(s.nav) - mine) }] : [{ id: "depositors", value: e6(s.nav) }];
      // your own trader circle is always in the list, marked
      if (L.accountId) { const me = this.retail.find((r) => r.id === L.accountId); if (me) me.me = true; else { const a = accts.find((x) => x.account_id === L.accountId); if (a) this.retail.unshift({ id: a.account_id, bank: e6(a.free), value: e6(a.long_value), open: BigInt(a.long_units) > 0n, p: market.power, stake: e6(a.long_cost), me: true }); } }
      const share = Number(market.short_shares) > 0 ? Number(s.short_shares) / Number(market.short_shares) : 0, perYear = market.funding_rate_annual_bps / 1e4 * e6(market.long_claims) * share * 0.9;
      Object.assign(this.vault, { apy: e6(s.nav) > 0 ? perYear / e6(s.nav) : 0, perDay: perYear / 365, earned: null });
      this.layout();
      if (perYear > 0) this.emit(this.yieldC, this.hunters[0], "yield", Math.min(6, Math.max(1, Math.round(perYear / 365 / 10))));
      this.exch.total = e6(market.fees);
      for (const r of this.retail) {
        const p = this.prev.get(r.id);
        if (p) {
          const paidIn = r.stake - p.stake, fund = p.value - r.value;
          if (paidIn > 1) this.emit(r, this.vault, "coin", Math.min(30, Math.round(paidIn / 10)));
          if (p.open && !r.open) this.emit(this.vault, r, p.value > p.stake ? "win" : "coin", Math.min(30, Math.round(p.value / 10)));
          if (r.open && fund > 0) this.emit(r, this.vault, "fund", Math.min(10, Math.max(1, Math.round(fund))));
        }
        this.prev.set(r.id, { ...r });
      }
      const pv = this.prev.get("__vault");
      if (pv && Math.abs(this.vault.asset - pv.asset) > 5) this.emit(this.vault, this.market, "asset", Math.min(10, Math.ceil(Math.abs(this.vault.asset - pv.asset) / 200)));
      this.prev.set("__vault", { ...this.vault });
    } catch (e) { console.warn("arena poll", e); }
  }

  emit(from, to, kind, n) {
    for (let k = 0; k < n && this.coins.length < 900; k++) this.coins.push({ from, to, kind, t: -k * 0.03, dur: rand(0.7, 1.1), jx: rand(-1, 1), jy: rand(-1, 1), arc: rand(-0.3, 0.3) });
  }
  // Circular layout: the vault in the middle, yield above and fees below (mirrored), traders on three
  // arcs to the left, liquidity providers on two arcs to the right.
  layout() {
    const r = this.cv.getBoundingClientRect(); this.W = r.width; this.H = r.height;
    const W = this.W, H = this.H, cx = W / 2, cy = H * 0.5, vr = Math.min(W * 0.14, H * 0.15);
    Object.assign(this.vault, { x: cx, y: cy, r: vr });
    const D = vr + Math.min(80, H * 0.19), sr = Math.min(28, vr * 0.58);
    this.yieldC = { x: cx, y: cy - D, r: sr }; Object.assign(this.exch, { x: cx, y: cy + D, r: sr });
    this.market = { x: cx, y: 18, r: 6 };
    const maxR = Math.min(W / 2 - 28, H / 2 - 24), minR = vr + 34;
    this.rings = [];
    const arcs = (list, side, fr, spread, maxDot) => {
      const radii = fr.map((f) => minR + (maxR - minR) * f), n = list.length; if (!n) return;
      const tot = radii.reduce((a, b) => a + b, 0), counts = radii.map((R) => Math.floor((n * R) / tot));
      for (let left = n - counts.reduce((a, b) => a + b, 0), k = radii.length - 1; left > 0; left--, k = (k + radii.length - 1) % radii.length) counts[k]++;
      const sep = radii.length > 1 ? (radii[1] - radii[0]) * 0.46 : maxDot, base = side < 0 ? Math.PI : 0;
      let i = 0;
      radii.forEach((R, k) => {
        const c = counts[k]; if (!c) return; const slot = (2 * spread) / c, dot = Math.min(maxDot, R * slot * 0.42, sep);
        this.rings.push({ R, a0: base - spread, a1: base + spread });
        for (let j = 0; j < c; j++) { const a = base - spread + (j + 0.5) * slot, o = list[i++]; o.x = cx + Math.cos(a) * R; o.y = cy + Math.sin(a) * R; o.r = dot; }
      });
    };
    arcs(this.retail, -1, [0, 0.5, 1], 0.95, 15);
    arcs(this.hunters, 1, [0.3, 1], 0.75, 26);
  }
  frame(now) {
    if (!this.running) return;
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000)); this.last = now;
    if (this.mode === "demo") this.stepDemo(dt);
    this.draw(dt);
    requestAnimationFrame((t) => this.frame(t));
  }
  draw(dt) {
    const cv = this.cv, r = cv.getBoundingClientRect(); if (!r.width) return;
    if (r.width !== this.W || r.height !== this.H || !this.vault.x) this.layout();
    const fitted = fit(cv); if (!fitted) return; const { ctx } = fitted;
    const C = (n) => css(n), F = (s, w = 600, mono) => `${w} ${s}px ${mono ? css("--mono") : css("--font")}`;
    ctx.lineWidth = 1; ctx.strokeStyle = C("--line");
    for (const g of this.rings || []) { ctx.beginPath(); ctx.arc(this.vault.x, this.vault.y, g.R, g.a0 - 0.12, g.a1 + 0.12); ctx.stroke(); }
    ctx.font = F(14, 800); ctx.fillStyle = C("--up"); ctx.textAlign = "left"; ctx.fillText("🐮 TRADERS", 8, 22);
    ctx.fillStyle = C("--usdc"); ctx.textAlign = "right"; ctx.fillText("LIQUIDITY PROVIDERS 🦀", this.W - 8, 22);
    // coins first, so the vault, yield and people stay readable on top
    const col = { coin: C("--gold"), win: C("--gold"), fund: C("--accent"), bar: C("--crab"), asset: C("--near"), yield: C("--up") };
    this.coins = this.coins.filter((c) => (c.t += dt / c.dur) < 1);
    for (const c of this.coins) {
      if (c.t < 0) continue;
      const e = c.t < 0.5 ? 2 * c.t * c.t : 1 - (-2 * c.t + 2) ** 2 / 2;
      const fx = c.from.x + c.jx * (c.from.r || 6) * 0.4, fy = c.from.y + c.jy * (c.from.r || 6) * 0.4, tx = c.to.x + c.jx * (c.to.r || 6) * 0.5, ty = c.to.y + c.jy * (c.to.r || 6) * 0.5;
      const mx = (fx + tx) / 2 - (ty - fy) * c.arc, my = (fy + ty) / 2 + (tx - fx) * c.arc;
      const x = (1 - e) ** 2 * fx + 2 * (1 - e) * e * mx + e * e * tx, y = (1 - e) ** 2 * fy + 2 * (1 - e) * e * my + e * e * ty;
      ctx.fillStyle = col[c.kind];
      if (c.kind === "bar") ctx.fillRect(x - 5, y - 3, 10, 6); else { ctx.beginPath(); ctx.arc(x, y, c.kind === "fund" || c.kind === "yield" ? 2.4 : 3.4, 0, 7); ctx.fill(); }
    }
    // vault: ring = USDC vs NEAR, inside = total
    const v = this.vault, tot = Math.max(1e-9, v.usdc + v.asset), a0 = -Math.PI / 2, aN = v.asset / tot * Math.PI * 2;
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(v.x, v.y, v.r + 7, a0, a0 + aN); ctx.strokeStyle = C("--near"); ctx.stroke();
    ctx.beginPath(); ctx.arc(v.x, v.y, v.r + 7, a0 + aN, a0 + Math.PI * 2); ctx.strokeStyle = C("--usdc"); ctx.stroke();
    ctx.beginPath(); ctx.arc(v.x, v.y, v.r, 0, 7); ctx.fillStyle = C("--panel"); ctx.fill();
    ctx.textAlign = "center"; ctx.fillStyle = C("--muted"); ctx.font = F(10, 700); ctx.fillText("CRAB VAULT", v.x, v.y - v.r * 0.3);
    ctx.fillStyle = C("--ink"); ctx.font = F(Math.max(13, v.r * 0.26), 700, true); ctx.fillText(big(v.nav), v.x, v.y + 4);
    ctx.fillStyle = C("--muted"); ctx.font = F(10, 500); ctx.fillText(`owed to traders ${big(v.owed)}`, v.x, v.y + v.r * 0.38);
    ctx.fillText(`NEAR ${Math.round(v.asset / tot * 100)}% · USDC ${Math.round(v.usdc / tot * 100)}%`, v.x, v.y + v.r + 26);
    // yield: what the vault earns for liquidity providers
    const yc = this.yieldC;
    ctx.beginPath(); ctx.moveTo(yc.x, yc.y + yc.r); ctx.lineTo(v.x, v.y - v.r - 12); ctx.strokeStyle = C("--line"); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(yc.x, yc.y, yc.r, 0, 7); ctx.fillStyle = color(C("--up"), 0.14); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C("--up"); ctx.stroke();
    ctx.fillStyle = C("--muted"); ctx.font = F(8.5, 700); ctx.fillText("YIELD", yc.x, yc.y - yc.r * 0.38);
    ctx.fillStyle = C("--up"); ctx.font = F(Math.max(11, yc.r * 0.42), 700, true); ctx.fillText(`${(v.apy * 100).toFixed(1)}%`, yc.x, yc.y + yc.r * 0.12);
    ctx.fillStyle = C("--muted"); ctx.font = F(9, 500); ctx.fillText(v.earned != null ? `+${big(v.earned)} paid` : `${v.perDay < 1 ? "$" + v.perDay.toFixed(3) : big(v.perDay)}/day`, yc.x, yc.y + yc.r * 0.55);
    // exchange
    ctx.beginPath(); ctx.arc(this.exch.x, this.exch.y, this.exch.r, 0, 7); ctx.fillStyle = C("--panel"); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C("--ex"); ctx.stroke();
    ctx.fillStyle = C("--ex"); ctx.font = F(8.5, 700); ctx.fillText("FEES", this.exch.x, this.exch.y - 2); ctx.fillStyle = C("--ink"); ctx.font = F(10, 600, true); ctx.fillText(big(this.exch.total), this.exch.x, this.exch.y + 10);
    // people
    for (const p of this.retail) {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fillStyle = C("--panel"); ctx.fill();
      if (p.open) { const m = p.value / Math.max(1e-9, p.stake); ctx.lineWidth = Math.max(2, p.r * 0.22); ctx.beginPath(); ctx.arc(p.x, p.y, p.r - 1, a0, a0 + Math.min(1, m) * Math.PI * 2); ctx.strokeStyle = m >= 1 ? C("--up") : C("--down"); ctx.stroke(); if (p.r > 10) { ctx.fillStyle = C("--up"); ctx.font = F(Math.max(8, p.r * 0.6), 800); ctx.fillText(pw(p.p), p.x, p.y + p.r * 0.2); } }
      else { ctx.lineWidth = 1; ctx.strokeStyle = C("--line"); ctx.stroke(); }
      if (p.me) { ctx.lineWidth = 2.5; ctx.strokeStyle = C("--ink"); ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 4, 0, 7); ctx.stroke(); ctx.fillStyle = C("--ink"); ctx.font = F(9, 800); ctx.fillText("YOU", p.x, p.y - p.r - 7); }
    }
    for (const h of this.hunters) {
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 7); ctx.fillStyle = h.me ? C("--usdc") : color(C("--usdc"), 0.2); ctx.fill(); ctx.lineWidth = h.me ? 3 : 2; ctx.strokeStyle = h.me ? C("--ink") : C("--usdc"); ctx.stroke();
      ctx.fillStyle = h.me ? "#fff" : C("--ink"); ctx.font = F(Math.max(9, Math.min(12, h.r * 0.34)), 700, true); ctx.fillText(big(h.value), h.x, h.y + (h.me ? 8 : 4));
      if (h.me) { ctx.font = F(9, 800); ctx.fillText("YOU", h.x, h.y - 6); } else if (h.id === "others") { ctx.fillStyle = C("--muted"); ctx.font = F(8.5, 700); ctx.fillText("OTHERS", h.x, h.y - h.r - 6); }
    }
  }
}
function gauss() { return Math.sqrt(-2 * Math.log(Math.max(Math.random(), 1e-12))) * Math.cos(2 * Math.PI * Math.random()); }
function color(c, a) { return `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`; }
