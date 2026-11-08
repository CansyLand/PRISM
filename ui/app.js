// PRISM web frontend — zero-dependency, zero-backend.
// All reads go straight to NEAR RPC via JSON-RPC fetch (CORS *), so there is no
// SDK version to break and no build step. Live on-chain state of the market:
// mark, parameters, system stats, and every open position with its liquidation
// health. Trading / liquidation / funding are the CLI demos (see README), which
// mutate exactly the state this dashboard shows.
(function () {
  const CFG = {
    networkId: "testnet",
    rpc: "https://test.rpc.fastnear.com",
    contract: "prism-v4-2026.testnet",
    usdc: 1e6,
  };
  document.getElementById("rpcLabel").textContent = CFG.rpc.replace("https://", "");

  const $ = (id) => document.getElementById(id);
  let params = null;

  function view(method, args) {
    return fetch(CFG.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "x", method: "query",
        params: {
          request_type: "call_function", account_id: CFG.contract, method_name: method,
          args_base64: btoa(JSON.stringify(args || {})), finality: "optimistic",
        },
      }),
    }).then((r) => r.json()).then((j) => {
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 150));
      const bytes = Array.isArray(j.result.result) ? j.result.result : null;
      const out = String.fromCharCode.apply(null, bytes || []);
      try { return JSON.parse(out); } catch { return out; }
    });
  }

  const usdc = (raw) => (Number(raw) / CFG.usdc).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const bpsPct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
  function age(ts) {
    if (!ts) return "—";
    const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m ago";
  }

  async function refresh() {
    try {
      const [mark, p, stats, positions, funding] = await Promise.all([
        view("get_mark"), view("get_params"), view("get_stats"), view("get_positions"), view("funding_rate_bps"),
      ]);
      params = p;
      const markRaw = Number(Array.isArray(mark) ? mark[0] : mark);
      const markNum = markRaw / CFG.usdc;

      $("mark").textContent = "$" + markNum.toFixed(4);
      $("markAge").textContent = age(Array.isArray(mark) ? mark[1] : null);
      $("freshGuard").textContent = "±" + bpsPct(p.max_mark_deviation_bps) + " fresh / ±" + bpsPct(p.stale_mark_deviation_bps) + " stale";
      $("liqBps").textContent = bpsPct(p.liq_bps) + " of notional";
      $("maxLev").textContent = p.max_leverage + "×";
      $("liqPen").textContent = bpsPct(p.liq_penalty_bps) + " to liquidator";
      $("minMargin").textContent = "$" + usdc(p.min_margin);
      $("fundInterval").textContent = (p.min_funding_interval_seconds / 60).toFixed(0) + " min";
      $("fundingNow").textContent = (Number(funding) >= 0 ? "+" : "") + bpsPct(funding) + "/interval";

      $("statPos").textContent = stats.open_positions;
      $("statNotional").textContent = "$" + usdc(stats.total_notional);
      $("statMargin").textContent = "$" + usdc(stats.total_margin);
      $("statFunding").textContent = age(stats.last_funding_ts);

      // v4 pusher governor (v3 contracts: views don't exist → "—")
      try {
        const [own, pusher] = await Promise.all([view("get_owner"), view("get_pusher")]);
        $("govOwner").textContent = own || "—";
        const pv = Array.isArray(pusher) ? (pusher.length ? pusher[0] : null) : pusher;
        $("govPusher").textContent = pv || "none (permissionless)";
        const st = $("govState");
        if (pv) { st.textContent = "restricted to pusher"; st.className = "ok"; }
        else { st.textContent = "OPEN — any account can push marks"; st.className = "bad"; }
      } catch { $("govOwner").textContent = $("govPusher").textContent = $("govState").textContent = "v3 (no governor)"; }

      // positions table
      const maintBps = p.liq_bps;
      const rows = (positions || []).filter((pos) => pos.is_open).map((pos) => {
        const size = Number(pos.size), margin = Number(pos.margin);
        const entryRaw = Number(pos.entry_price);
        const notionalRaw = Math.abs(size) * markRaw;
        const pnlRaw = size * (markRaw - entryRaw);
        const equityRaw = margin + pnlRaw;
        const maintRaw = notionalRaw * (maintBps / 10000);
        const health = maintRaw > 0 ? (equityRaw / maintRaw) * 100 : Infinity;
        const cls = health < 100 ? "bad" : health < 150 ? "warn" : "ok";
        return `<tr>
          <td class="m">${pos.owner}</td>
          <td class="${size > 0 ? 'ok' : 'bad'}">${size > 0 ? "LONG" : "SHORT"}</td>
          <td>${Math.abs(size)}</td>
          <td>$${(entryRaw / CFG.usdc).toFixed(4)}</td>
          <td>$${usdc(notionalRaw)}</td>
          <td>$${usdc(margin)}</td>
          <td class="${pnlRaw >= 0 ? 'ok' : 'bad'}">$${usdc(pnlRaw)}</td>
          <td>$${usdc(equityRaw)}</td>
          <td class="${cls}"><b>${isFinite(health) ? health.toFixed(0) + "%" : "—"}</b></td>
        </tr>`;
      }).join("");
      const tbody = $("posRows");
      tbody.innerHTML = rows || `<tr><td colspan="9" class="m" style="color:var(--muted)">No open positions. Run a CLI demo (e.g. <code>npm run funding</code> or <code>npm run liquidate</code>) to open some, then watch them appear here live.</td></tr>`;
      $("updated").textContent = "updated " + new Date().toLocaleTimeString();
      $("dot").classList.add("on");
      $("chain").textContent = CFG.networkId + " · live";
    } catch (e) {
      $("updated").textContent = "read error: " + (e && e.message ? e.message.slice(0, 40) : "—");
    }
  }

  $("contractInput").value = CFG.contract;
  $("contractId").textContent = CFG.contract;
  $("contractInput").onchange = () => {
    const v = $("contractInput").value.trim();
    if (v) { CFG.contract = v; $("contractId").textContent = v; refresh(); }
  };
  $("refreshBtn").onclick = refresh;

  refresh();
  setInterval(refresh, 8000);
})();
