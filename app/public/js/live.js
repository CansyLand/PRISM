// Live network client. Two kinds of users:
//  - device wallet: a key created in this browser (NEAR implicit account). Every call is a
//    meta-transaction (NEP-366) that our relayer submits, so the user never needs NEAR for gas.
//  - NEAR wallet (Meteor, MyNearWallet, Intear) through Wallet Selector: each transaction opens
//    the wallet for approval. No standing permission is granted.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, keyToImplicitAddress, actions, encodeSignedDelegate } from "https://esm.sh/near-api-js@7.5.3";

const KEY = "uprise.v1.key", KIND = "uprise.v1.signer";
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => { const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || r.statusText); return j; });
const WS = "10.1.4";

export class Live {
  async init() {
    this.cfg = await fetch("/api/config").then((r) => r.json());
    this.provider = new JsonRpcProvider({ url: location.origin + "/api/rpc" }, { retries: 4, wait: 500 });
    this.kind = ls.get(KIND); this.accountId = null; this.state = {};
    if (this.kind === "device" && ls.get(KEY)) this.useKey(ls.get(KEY));
    if (this.kind === "wallet") this.connectWallet(true).catch(() => {});
    return this;
  }
  get connected() { return !!this.accountId; }
  view(contractId, method, args = {}) { return this.provider.callFunction({ contractId, method, args }); }

  // ── device wallet ──
  useKey(secret) {
    const kp = KeyPair.fromString(secret);
    this.accountId = keyToImplicitAddress(kp.getPublicKey());
    this.acct = new Account(this.accountId, this.provider, new KeyPairSigner(kp));
    this.kind = "device"; ls.set(KIND, "device"); ls.set(KEY, secret);
  }
  secret() { return ls.get(KEY); }
  async createDevice() {
    const secret = ls.get(KEY) || KeyPair.fromRandom("ed25519").toString();
    this.useKey(secret);
    await post("/api/onboard", { account_id: this.accountId });
    for (let i = 0; i < 20; i++) { if (await this.exists()) break; await new Promise((r) => setTimeout(r, 800)); }
  }
  async exists() { try { await this.provider.viewAccount({ accountId: this.accountId }); return true; } catch { return false; } }
  backup(email) { return post("/api/backup", { account_id: this.accountId, email, secret: this.secret() }); }
  recoverStart(email) { return post("/api/recover/start", { email }); }
  async recoverFinish(email, code) {
    const r = await post("/api/recover/finish", { email, code });
    if (!r.wallets?.length) throw new Error("no wallet stored for this email");
    this.useKey(r.wallets[r.wallets.length - 1].secret);
    return r.wallets;
  }

  // ── NEAR wallet via Wallet Selector (loaded only when needed) ──
  async connectWallet(silent) {
    const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupMyNearWallet }, { setupIntearWallet }] = await Promise.all([
      import(`https://esm.sh/@near-wallet-selector/core@${WS}`), import(`https://esm.sh/@near-wallet-selector/modal-ui@${WS}`),
      import(`https://esm.sh/@near-wallet-selector/meteor-wallet@${WS}`), import(`https://esm.sh/@near-wallet-selector/my-near-wallet@${WS}`),
      import(`https://esm.sh/@near-wallet-selector/intear-wallet@${WS}`),
    ]);
    if (!document.getElementById("ws-css")) { const l = document.createElement("link"); l.id = "ws-css"; l.rel = "stylesheet"; l.href = `https://cdn.jsdelivr.net/npm/@near-wallet-selector/modal-ui@${WS}/styles.css`; document.head.appendChild(l); }
    this.selector ||= await setupWalletSelector({ network: this.cfg.network, modules: [setupMeteorWallet(), setupMyNearWallet(), setupIntearWallet()] });
    const pick = (st) => { const a = st.accounts?.find((x) => x.active) || st.accounts?.[0]; if (a) { this.accountId = a.accountId; this.kind = "wallet"; ls.set(KIND, "wallet"); this.onChange?.(); } };
    this.selector.store.observable.subscribe(pick);
    pick(this.selector.store.getState());
    if (!this.accountId && !silent) setupModal(this.selector, { contractId: this.cfg.ledger }).show();
  }
  async disconnect() {
    if (this.kind === "wallet" && this.selector) { try { await (await this.selector.wallet()).signOut(); } catch {} }
    this.accountId = null; this.kind = null; ls.set(KIND, null); this.onChange?.();
  }

  /** Call a contract method as the user. Device wallets: gas-free via our relayer. */
  async call(receiverId, methodName, args = {}, { deposit = 0n, tgas = 100 } = {}) {
    const gas = BigInt(tgas) * 10n ** 12n;
    if (this.kind === "device") {
      const { signedDelegate } = await this.acct.createSignedMetaTransaction({ receiverId, actions: [actions.functionCall(methodName, args, gas, BigInt(deposit))] });
      const b64 = btoa(String.fromCharCode(...encodeSignedDelegate(signedDelegate)));
      const r = await post("/api/relay", { signed_delegate: b64 });
      const failed = r.receipts?.find((s) => s && s.Failure);
      if (failed) throw new Error(explain(failed.Failure));
      return r;
    }
    if (this.kind === "wallet") {
      const wallet = await this.selector.wallet();
      return wallet.signAndSendTransaction({ receiverId, actions: [actions.functionCall(methodName, args, gas, BigInt(deposit))] });
    }
    throw new Error("Connect a wallet first");
  }

  async refresh() {
    const c = this.cfg, me = this.accountId;
    const [market, vault, ledgerAcc, usdc, pos] = await Promise.all([
      this.view(c.ledger, "get_market"), this.view(c.vault, "get_vault"),
      me ? this.view(c.ledger, "get_account", { account_id: me }) : null,
      me ? this.view(c.usdc, "ft_balance_of", { account_id: me }).catch(() => "0") : "0",
      me ? this.view(c.vault, "get_position", { account_id: me }) : null,
    ]);
    this.state = { market, vault, ledgerAcc, usdc: BigInt(usdc || 0), pos };
    return this.state;
  }
  cash() { return this.state.usdc + BigInt(this.state.ledgerAcc?.free || 0); }

  // ── trades ──
  /** Buy `raw` USDC of Curve Long at strength `power` (1..10): free ledger balance first, the rest from the wallet. */
  async buy(raw, power) {
    const free = BigInt(this.state.ledgerAcc?.free || 0), c = this.cfg;
    if (free >= raw) return this.call(c.ledger, "open_long", { power, amount: String(raw) });
    if (free > 0n) await this.call(c.ledger, "open_long", { power, amount: String(free) });
    return this.call(c.usdc, "ft_transfer_call", { receiver_id: c.ledger, amount: String(raw - free), msg: JSON.stringify({ action: "open_long", power }) }, { deposit: 1n, tgas: 120 });
  }
  /** Close the `power` position (every position if omitted) and cash out to the wallet. */
  async close(power) {
    const c = this.cfg;
    const held = (this.state.ledgerAcc?.longs || []).map((l) => l.power);
    for (const p of power ? [power] : held) await this.call(c.ledger, "close_long", { power: p });
    const a = await this.view(c.ledger, "get_account", { account_id: this.accountId });
    if (a && BigInt(a.free) > 0n) await this.call(c.ledger, "withdraw", { amount: a.free }, { deposit: 1n });
  }
  closeAll() { return this.close(); }
  vaultDeposit(raw) { return this.call(this.cfg.usdc, "ft_transfer_call", { receiver_id: this.cfg.vault, amount: String(raw), msg: "deposit" }, { deposit: 1n }); }
  vaultWithdraw(shares) { return this.call(this.cfg.vault, "request_withdraw", shares ? { shares: String(shares) } : {}, { tgas: 30 }); }
  faucet() { return post("/api/faucet", { account_id: this.accountId }); }
  depositAddress(asset, amount) { return post("/api/deposit-address", { account_id: this.accountId, asset, amount }); }
  async send(to, raw) {
    const c = this.cfg;
    if (raw > this.state.usdc) { const need = raw - this.state.usdc; await this.call(c.ledger, "withdraw", { amount: String(need) }, { deposit: 1n }); }
    return this.call(c.usdc, "ft_transfer", { receiver_id: to, amount: String(raw) }, { deposit: 1n, tgas: 30 });
  }
}
function explain(f) { const s = JSON.stringify(f); const m = s.match(/Smart contract panicked: ([^"\\]+)/) || s.match(/"ExecutionError":"([^"]+)"/); return (m ? m[1] : s).slice(0, 180); }
