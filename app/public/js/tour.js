// First-visit tutorial, mobile-game style: a spotlight, a hand and a bubble on one thing at a time.
// Each step waits for you to do it (or a few seconds for the "watch" steps). Doing a later step early skips ahead.
// app.js tells the tour what happened with tour.emit("closed" | "resultClosed" | "mode" | "tab").
const $ = (id) => document.getElementById(id);
const STEPS = [
  { el: () => $("p"), hand: "swipe", text: "<b>Drag to pick your curve.</b> Higher grows faster when the price rises.", wait: "slid" },
  { el: () => $("buy"), hand: "tap", text: "<b>Buy with $100</b> of play money.", wait: "bought", skipTo: true },
  { el: () => document.querySelector(".chart-card"), text: "⏱️ Time runs <b>100× faster</b> here. Watch the price move.", ms: 3500 },
  { el: () => $("flip"), text: "<b>Your position</b> rises faster than the price. It also melts a little with time ⏳", ms: 4500 },
  { el: () => $("close"), hand: "tap", text: "<b>Take your profit</b> whenever you like. Or let it ride.", wait: "closed", skipTo: true },
  { wait: "resultClosed", skipTo: true }, // the result card speaks for itself
  { el: () => document.querySelector('[data-mode="live"]'), hand: "tap", text: "<b>Ready for real?</b> Try it live on testnet with free test USDC.", ms: 6000, wait: "mode", endOnWait: true },
  { el: () => document.querySelector('[data-tab="crab"]'), hand: "tap", text: "🦀 <b>Or be the house.</b> Earn what bulls pay to hold their curves.", ms: 6000, wait: "tab" },
];

export function createTour({ onDone }) {
  let cur = -1, timer = 0, raf = 0;
  const spot = document.createElement("div"), bub = document.createElement("div"), hand = document.createElement("div");
  spot.className = "coach-spot"; bub.className = "coach-bub"; hand.className = "coach-hand"; hand.textContent = "👆";
  for (const n of [spot, bub, hand]) { n.hidden = true; document.body.append(n); }

  const tour = {
    get active() { return cur >= 0; },
    start() { if (cur < 0) { listen(); go(0); } },
    emit(ev) {
      if (cur < 0) return;
      const s = STEPS[cur];
      if (s.wait === ev) return s.endOnWait ? end() : go(cur + 1);
      const k = STEPS.findIndex((x, i) => i > cur && x.skipTo && x.wait === ev);
      if (k > 0) return go(k + 1);
      if (ev === "mode" || ev === "tab") end(); // wandered off: let them explore
    },
  };

  function listen() {
    $("p").addEventListener("change", () => tour.emit("slid"));
    $("buy").addEventListener("click", () => tour.emit("bought"));
  }
  function go(i) {
    clearTimeout(timer); cancelAnimationFrame(raf);
    if (i >= STEPS.length) return end();
    cur = i; const s = STEPS[i], el = s.el?.();
    hand.className = "coach-hand " + (s.hand || ""); hand.hidden = !s.hand;
    spot.hidden = bub.hidden = !el;
    if (s.ms) timer = setTimeout(() => go(cur + 1), s.ms);
    if (!el) return;
    bub.innerHTML = `<p>${s.text}</p><button type="button" class="coach-skip">Skip tutorial</button><span class="coach-n">${i + 1 > 5 ? "" : `${i + 1}/5`}</span>`;
    bub.querySelector(".coach-skip").onclick = end;
    const r = el.getBoundingClientRect(), navH = document.querySelector("nav.tabs")?.getBoundingClientRect().height || 0;
    if (r.top < 60 || r.bottom > innerHeight - navH - 140) el.scrollIntoView({ block: "center", behavior: "smooth" });
    spot.classList.remove("in"); void spot.offsetWidth; spot.classList.add("in");
    const place = () => { if (cur === i) { position(el, s); raf = requestAnimationFrame(place); } };
    place();
  }
  function position(el, s) {
    const r = el.getBoundingClientRect(), pad = s.hand === "swipe" ? 14 : 6;
    Object.assign(spot.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
    // bubble under the target if it fits, else above; kept inside the screen
    const bw = Math.min(300, innerWidth - 24), bh = bub.offsetHeight, below = r.bottom + pad + 54 + bh < innerHeight;
    const left = Math.max(12, Math.min(innerWidth - bw - 12, r.left + r.width / 2 - bw / 2));
    Object.assign(bub.style, { width: bw + "px", left: left + "px", top: Math.max(8, below ? r.bottom + pad + 48 : r.top - pad - bh - 12) + "px" });
    bub.classList.toggle("up", below); bub.style.setProperty("--ax", Math.max(18, Math.min(bw - 18, r.left + r.width / 2 - left)) + "px");
    if (s.hand === "swipe") { // start at the slider's thumb
      const el2 = el, v = (el2.value - el2.min) / (el2.max - el2.min);
      Object.assign(hand.style, { left: r.left + 8 + v * (r.width - 16) - 12 + "px", top: r.top + r.height / 2 + 2 + "px" });
    } else if (s.hand) Object.assign(hand.style, { left: r.left + r.width / 2 - 12 + "px", top: (r.height < 44 ? r.bottom - 8 : r.top + r.height / 2 + 4) + "px" }); // small targets: fingertip on the edge, word stays readable
  }
  function end() {
    clearTimeout(timer); cancelAnimationFrame(raf); cur = -1;
    spot.hidden = bub.hidden = hand.hidden = true; onDone?.();
  }
  return tour;
}
