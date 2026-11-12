// Demo market: pure mockup, no blockchain. Replays real price history in fast-forward.
// One position at a time. Value = stake × (price / entry)^p × melt(t), where melt is the
// funding sped up so a flat market melts 10× to 1% in 30 s and 1× in 2 minutes.
const KEY = "uprise.demo.v2";
export const CANDLE_MS = 333; // one day of history per third of a second
export const meltSeconds = (p) => 120 * Math.pow(30 / 120, (p - 1) / 9);
const FEE = 0.003, POOL_CAP = 250_000;

export class Demo {
  constructor(snippets) {
    this.snippets = snippets;
    let s = {}; try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
    this.balance = s.balance ?? 1000;
    this.trades = s.trades ?? 0;
    this.vault = s.vault?.hist ? s.vault : seedVault();
    this.cursor = s.cursor ?? 0;
    this.order = s.order ?? this.shuffled();
    this.position = null;
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify({ balance: this.balance, trades: this.trades, vault: this.vault, cursor: this.cursor, order: this.order })); } catch {} }
  reset() { this.balance = 1000; this.trades = 0; this.vault = seedVault(); this.cursor = 0; this.order = this.shuffled(); this.save(); }
  /** 7 rallies + 3 dumps in random order, but the first trade is always a rally. */
  shuffled() { const a = shuffle(this.snippets.map((_, i) => i)); const r = a.findIndex((i) => this.snippets[i].kind === "rally"); if (r > 0) [a[0], a[r]] = [a[r], a[0]]; return a; }
  /** The snippet the next trade will play. */
  snippet() { return this.snippets[this.order[this.cursor % this.order.length]]; }
  history() { const s = this.snippet(); return s.candles.slice(0, s.entry + 1); }
  future() { const s = this.snippet(); return s.candles.slice(s.entry + 1); }
  entryPrice() { const s = this.snippet(); return s.candles[s.entry][3]; }

  open(stake, p) {
    if (this.position) throw new Error("You already have a position. Close it first.");
    if (!(stake > 0) || stake > this.balance + 1e-9) throw new Error("Not enough demo balance");
    this.balance -= stake;
    this.position = { stake, p, entry: this.entryPrice(), net: stake * (1 - FEE), t: 0, value: stake * (1 - FEE), peak: stake * (1 - FEE) };
    this.save();
    return this.position;
  }
  /** Advance the open position to `price` after `dt` seconds of fast-forward. */
  update(price, dt) {
    const q = this.position; if (!q) return null;
    q.t += dt;
    const k = Math.log(100) / meltSeconds(q.p);
    q.value = Math.min(POOL_CAP, q.net * Math.pow(price / q.entry, q.p) * Math.exp(-k * q.t));
    q.peak = Math.max(q.peak, q.value);
    q.melted = q.value < 0.01 * q.stake;
    return q;
  }
  /** Per-minute melt rate shown in the UI. */
  meltPerMinute(p) { return 1 - Math.exp(-Math.log(100) / meltSeconds(p) * 60); }
  close() {
    const q = this.position; if (!q) return null;
    const out = q.melted ? 0 : q.value * (1 - FEE);
    this.balance += out; this.position = null; this.trades++; this.cursor++;
    this.save();
    return { ...q, out, pnl: out - q.stake };
  }

  // ── demo vault: earns a fixed demo yield, sped up like the market (1 day per second) ──
  vaultDeposit(x) { if (!(x > 0) || x > this.balance + 1e-9) throw new Error("Not enough demo balance"); this.balance -= x; this.vault.stake += x; this.vault.cost += x; this.vault.hist.push(this.vault.stake); this.save(); }
  vaultWithdraw(x) { x = Math.min(x, this.vault.stake); if (!(x > 0)) throw new Error("Nothing to withdraw"); const f = x / this.vault.stake; this.vault.stake -= x; this.vault.cost -= this.vault.cost * f; this.balance += x; this.vault.hist.push(this.vault.stake); this.save(); }
  vaultAccrue(days, apy = 0.18) {
    if (this.vault.stake <= 0) return;
    this.vault.stake *= Math.pow(1 + apy, days / 365) * (1 + 0.0015 * gaussish()); // mostly sideways day to day, up over time
    this.vault.days += days; this.vault.hist.push(this.vault.stake); if (this.vault.hist.length > 720) this.vault.hist.splice(0, 2);
  }
}
// The demo player already put $10,000 into the vault six months ago: a daily history with small wobbles.
function seedVault() {
  const hist = []; let v = 10_000;
  for (let d = 0; d <= 182; d++) { if (d) v *= Math.pow(1.18, 1 / 365) * (1 + 0.0015 * gaussish()); hist.push(v); }
  return { stake: v, cost: 10_000, days: 182, hist };
}
function gaussish() { return (Math.random() + Math.random() + Math.random() - 1.5) * 1.4; }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
