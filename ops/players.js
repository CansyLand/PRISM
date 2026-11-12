// Test players for the Uprise testnet stack.
//   node players.js status                 # every player's balances and positions
//   node players.js deposit h1 20000       # hunter h1 deposits $20,000 into the vault
//   node players.js withdraw h1 [shares]   # hunter h1 queues a vault withdrawal (all if no shares)
//   node players.js long r1 250            # retail r1 opens a $250 Curve Long
//   node players.js close r1               # retail r1 closes its long and withdraws to its wallet
//   node players.js run                    # random crowd: retail trades, hunters chase yield
import { account, view, call, loadDeployment, sleep, ONE_YOCTO, usd, fmtUsd } from "./lib.js";

const d = loadDeployment();
const who = (short) => (short.includes(".") ? short : `${short}.${d.master}`);
const ts = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(ts(), ...a);

export async function openLong(id, dollars) {
  await call(account(id), d.usdc, "ft_transfer_call",
    { receiver_id: d.ledger, amount: String(usd(dollars)), msg: JSON.stringify({ action: "open_long" }) },
    { deposit: ONE_YOCTO, tgas: 150 });
}
export async function closeLong(id) {
  const a = account(id);
  const out = await call(a, d.ledger, "close_long", {}, { tgas: 100 });
  const acc = await view(d.ledger, "get_account", { account_id: id });
  if (acc && BigInt(acc.free) > 0n) await call(a, d.ledger, "withdraw", { amount: acc.free }, { deposit: ONE_YOCTO, tgas: 100 });
  return out;
}
export async function vaultDeposit(id, dollars) {
  await call(account(id), d.usdc, "ft_transfer_call", { receiver_id: d.vault, amount: String(usd(dollars)), msg: "deposit" }, { deposit: ONE_YOCTO, tgas: 100 });
}
export async function vaultWithdraw(id, shares) {
  await call(account(id), d.vault, "request_withdraw", shares ? { shares: String(shares) } : {}, { tgas: 30 });
}

async function status() {
  const m = await view(d.ledger, "get_market");
  const v = await view(d.vault, "get_vault");
  console.log(`${d.assetSymbol || "BTC"} $${(Number(m.price) / 1e6).toFixed(4)} · p=${m.power} · pool ${fmtUsd(m.risk_pool)} · claims ${fmtUsd(m.long_claims)} · util ${(m.utilization_bps / 100).toFixed(1)}% · funding ${(m.funding_rate_annual_bps / 100).toFixed(1)}%/yr`);
  console.log(`vault NAV ${fmtUsd(v.snapshot.nav)} · share ${(Number(v.share_price_e6) / 1e6).toFixed(5)} · hedge ${fmtUsd(v.hedge_value)} / target ${fmtUsd(v.snapshot.hedge_target_usd)}`);
  for (const id of [...d.retail, ...d.hunters]) {
    const [bal, acc, pos] = await Promise.all([
      view(d.usdc, "ft_balance_of", { account_id: id }),
      view(d.ledger, "get_account", { account_id: id }),
      view(d.vault, "get_position", { account_id: id }),
    ]);
    const long = acc && BigInt(acc.long_units) > 0n ? ` long ${fmtUsd(acc.long_value)} (paid ${fmtUsd(acc.long_cost)})` : "";
    const vault = BigInt(pos.shares) > 0n || BigInt(pos.pending_deposit) > 0n ? ` vault ${fmtUsd(pos.value)}${BigInt(pos.pending_deposit) > 0n ? ` +${fmtUsd(pos.pending_deposit)} queued` : ""}` : "";
    console.log(`  ${id.split(".")[0].padEnd(3)} wallet ${fmtUsd(bal).padEnd(11)}${long}${vault}`);
  }
}

async function run() {
  say("crowd running: retail trades every ~20s, hunters check yield every ~2 min");
  const opened = new Map();
  for (let tick = 0; ; tick++) {
    try { await crowdTick(tick, opened); } catch (e) { say("tick failed:", String(e.message || e).slice(0, 160)); }
    await sleep(30_000 + Math.random() * 20_000);
  }
}

async function crowdTick(tick, opened) {
  {
    const id = d.retail[Math.floor(Math.random() * d.retail.length)];
    try {
      const acc = await view(d.ledger, "get_account", { account_id: id });
      const holding = acc && BigInt(acc.long_units) > 0n;
      if (holding) {
        const age = (Date.now() - (opened.get(id) || 0)) / 60_000;
        const m = Number(acc.long_value) / Number(acc.long_cost);
        if (m > 1.5 || m < 0.6 || Math.random() < age / 30) {
          await closeLong(id); opened.delete(id);
          say(`${id.split(".")[0]} closed at ${m.toFixed(2)}×`);
        }
      } else {
        const bal = Number(await view(d.usdc, "ft_balance_of", { account_id: id })) / 1e6;
        if (bal >= 20) {
          const amt = Math.max(10, Math.round(Math.min(bal, 50 + Math.random() * 400)));
          await openLong(id, amt); opened.set(id, Date.now());
          say(`${id.split(".")[0]} opened a $${amt} Curve Long`);
        }
      }
    } catch (e) { say(id.split(".")[0], "trade failed:", String(e.message || e).slice(0, 160)); }
    if (tick % 6 === 0) {
      const h = d.hunters[Math.floor(Math.random() * d.hunters.length)];
      try {
        const pos = await view(d.vault, "get_position", { account_id: h });
        const bal = Number(await view(d.usdc, "ft_balance_of", { account_id: h })) / 1e6;
        if (BigInt(pos.shares) === 0n && bal > 1000) { const amt = Math.round(bal * (0.3 + Math.random() * 0.6)); await vaultDeposit(h, amt); say(`${h.split(".")[0]} deposits $${amt} into the vault`); }
        else if (BigInt(pos.shares) > 0n && Math.random() < 0.15) { await vaultWithdraw(h, BigInt(pos.shares) / 2n); say(`${h.split(".")[0]} asks to withdraw half`); }
      } catch (e) { say(h.split(".")[0], "vault action failed:", String(e.message || e).slice(0, 160)); }
    }
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "status") await status();
else if (cmd === "deposit") { await vaultDeposit(who(a), Number(b)); console.log("queued"); }
else if (cmd === "withdraw") { await vaultWithdraw(who(a), b); console.log("queued"); }
else if (cmd === "long") { await openLong(who(a), Number(b)); console.log("opened"); }
else if (cmd === "close") { console.log("closed for", await closeLong(who(a))); }
else if (cmd === "run") await run();
else if (cmd) console.log("unknown command");
