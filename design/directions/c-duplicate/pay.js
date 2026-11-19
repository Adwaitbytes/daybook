// Pay page prototype: chain choice, QR, copy, and the status sequence up to the Paid stamp.
// States: ?state=waiting | paid | wrongtoken. "Replay" walks the sequence with sample timings.
(function () {
  "use strict";
  const QR = window.DAYBOOK_QR;
  const NAMES = { base: "Base", arbitrum: "Arbitrum" };
  const doc = document;
  const qrEl = doc.getElementById("qr");
  const live = doc.getElementById("live");
  const steps = Array.from(doc.querySelectorAll("#status li[data-step]"));
  const paidEls = doc.querySelectorAll("[data-when-paid]");
  const unpaidEls = doc.querySelectorAll("[data-when-unpaid]");
  const stampHost = doc.querySelector("[data-stamp-host]");
  const MARK = { done: "✓", now: "●", todo: "○", flag: "!" };
  let chain = "base";
  let timers = [];

  function renderQR() {
    if (!qrEl || !QR) return;
    const q = QR[chain];
    qrEl.innerHTML =
      '<svg viewBox="' + q.vb + '" role="img" aria-label="QR code for a 480 USDC transfer on ' + NAMES[chain] +
      '"><path d="' + q.d + '" stroke="currentColor" fill="none" shape-rendering="crispEdges"/></svg>';
  }

  function setChain(next) {
    chain = next;
    doc.querySelectorAll("[data-chain]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.chain === chain));
    });
    doc.querySelectorAll("[data-chain-name]").forEach(function (el) { el.textContent = NAMES[chain]; });
    renderQR();
  }

  function setStep(n) {
    steps.forEach(function (li) {
      const i = Number(li.dataset.step);
      const s = li.dataset.fixed || (i < n ? "done" : i === n ? "now" : "todo");
      li.dataset.state = s;
      const m = li.querySelector(".mark");
      if (m) m.textContent = MARK[s];
      const t = li.querySelector(".t");
      if (t) t.hidden = !(s === "done" || s === "flag");
    });
    const paid = n > steps.length;
    paidEls.forEach(function (el) { el.hidden = !paid; });
    unpaidEls.forEach(function (el) { el.hidden = paid; });
    if (stampHost) stampHost.classList.toggle("play", paid);
    if (live) live.textContent = paid ? "Paid. Receipt issued and the three transactions are linked below." :
      (steps[n - 1] ? steps[n - 1].querySelector(".what").textContent : "");
  }

  function replay() {
    timers.forEach(clearTimeout);
    timers = [];
    if (stampHost) stampHost.classList.remove("play");
    setStep(1);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gap = reduce ? 300 : 1100;
    for (let i = 2; i <= steps.length + 1; i++) {
      timers.push(setTimeout(function () { setStep(i); }, gap * (i - 1)));
    }
  }

  doc.querySelectorAll("[data-chain]").forEach(function (b) {
    b.addEventListener("click", function () { setChain(b.dataset.chain); });
  });

  const copyBtn = doc.getElementById("copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      const text = doc.getElementById("addr").textContent.trim();
      const label = copyBtn.textContent;
      const done = function (msg) {
        copyBtn.textContent = msg;
        setTimeout(function () { copyBtn.textContent = label; }, 1600);
      };
      if (!navigator.clipboard) { done("Select and copy"); return; }
      navigator.clipboard.writeText(text).then(function () { done("Copied"); }, function () { done("Copy failed"); });
    });
  }

  doc.querySelectorAll("[data-replay]").forEach(function (b) { b.addEventListener("click", replay); });
  doc.querySelectorAll("[data-print]").forEach(function (b) { b.addEventListener("click", function () { window.print(); }); });

  const state = new URLSearchParams(location.search).get("state") || doc.body.dataset.initial || "waiting";
  setChain(doc.body.dataset.chain || "base");
  setStep(state === "paid" ? steps.length + 1 : 1);
})();
