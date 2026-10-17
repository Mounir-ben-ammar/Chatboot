/* Rules of Golf Assistant — client */
(() => {
  "use strict";

  document.documentElement.classList.add("js");

  const MAX_CHARS = 2000;
  const HISTORY_TURNS = 6;
  const HEALTH_INTERVAL_MS = 30000;
  // Backend origin; empty means same origin (local run). Set in config.js.
  const API_BASE = (window.CHATBOT_CONFIG?.apiBase ?? "").replace(/\/+$/, "");

  const $ = (sel) => document.querySelector(sel);
  const els = {
    status: $("#status"),
    statusLabel: $("#status .status__label"),
    newChat: $("#newChat"),
    scroller: $("#scroller"),
    empty: $("#empty"),
    suggestions: $("#suggestions"),
    messages: $("#messages"),
    announcer: $("#announcer"),
    form: $("#composer"),
    input: $("#input"),
    send: $("#send"),
    counter: $("#counter"),
    tplUser: $("#tpl-user"),
    tplBot: $("#tpl-bot"),
    tplError: $("#tpl-error"),
  };

  const state = {
    history: [],        // completed turns: {role, content}
    busy: false,
    controller: null,
    stickToBottom: true,
  };

  /* ---------------- Markdown ---------------- */

  let purifyHooked = false;
  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      if (!purifyHooked) {
        window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
          if (node.tagName === "A") {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer");
          }
        });
        purifyHooked = true;
      }
      const html = window.marked.parse(text, { gfm: true, breaks: true });
      return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    // Fallback when the CDN libraries are unavailable: plain escaped text.
    const div = document.createElement("div");
    div.textContent = text;
    return `<p style="white-space:pre-wrap">${div.innerHTML}</p>`;
  }

  /* ---------------- Health ---------------- */

  function setStatus(kind, label) {
    els.status.dataset.state = kind;
    els.statusLabel.textContent = label;
  }

  async function checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.llm_configured) {
        setStatus("warn", "API key not configured");
      } else {
        const n = Number(data.pages) || 0;
        setStatus("ok", `Ready · ${n} ${n === 1 ? "page" : "pages"}`);
      }
    } catch {
      setStatus("offline", "Offline");
    }
  }

  /* ---------------- Scrolling ---------------- */

  function isNearBottom() {
    const s = els.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  }

  function scrollToBottom(force = false) {
    if (!force && !state.stickToBottom) return;
    els.scroller.scrollTop = els.scroller.scrollHeight;
  }

  els.scroller.addEventListener("scroll", () => {
    state.stickToBottom = isNearBottom();
  }, { passive: true });

  /* ---------------- Composer ---------------- */

  function autoGrow() {
    const el = els.input;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function updateComposer() {
    const len = els.input.value.length;
    els.counter.textContent = `${len} / ${MAX_CHARS}`;
    els.counter.classList.toggle("is-near", len >= MAX_CHARS * 0.9 && len < MAX_CHARS);
    els.counter.classList.toggle("is-max", len >= MAX_CHARS);
    els.send.disabled = state.busy || els.input.value.trim().length === 0;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.form.classList.toggle("is-busy", busy);
    els.input.disabled = busy;
    els.send.setAttribute("aria-label", busy ? "Waiting for answer" : "Send message");
    els.suggestions.querySelectorAll("button").forEach((b) => { b.disabled = busy; });
    els.messages.querySelectorAll(".btn--retry").forEach((b) => { b.disabled = busy; });
    updateComposer();
    if (!busy) els.input.focus({ preventScroll: true });
  }

  els.input.addEventListener("input", () => { autoGrow(); updateComposer(); });

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.input.value.trim();
    if (!text || state.busy) return;
    els.input.value = "";
    autoGrow();
    updateComposer();
    ask(text.slice(0, MAX_CHARS));
  });

  els.suggestions.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-q]");
    if (btn && !state.busy) ask(btn.dataset.q);
  });

  els.newChat.addEventListener("click", () => {
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.history = [];
    els.messages.replaceChildren();
    els.empty.hidden = false;
    els.input.value = "";
    autoGrow();
    setBusy(false);
    els.announcer.textContent = "Started a new chat.";
  });

  /* ---------------- Message rendering ---------------- */

  function addUserMessage(text) {
    const node = els.tplUser.content.firstElementChild.cloneNode(true);
    node.querySelector(".msg__bubble").textContent = text;
    els.messages.append(node);
    return node;
  }

  function addBotMessage() {
    const node = els.tplBot.content.firstElementChild.cloneNode(true);
    node.classList.add("msg--streaming");
    node.setAttribute("aria-busy", "true");
    els.messages.append(node);
    return {
      node,
      typing: node.querySelector(".typing"),
      md: node.querySelector(".md"),
      sources: node.querySelector(".sources"),
    };
  }

  function renderSources(view, sources) {
    if (!Array.isArray(sources) || sources.length === 0) return;
    const pagesEl = view.sources.querySelector(".sources__pages");
    const listEl = view.sources.querySelector(".sources__list");
    const pages = [...new Set(sources.map((s) => s.page))].sort((a, b) => a - b);
    pagesEl.replaceChildren(...pages.map((p) => {
      const chip = document.createElement("span");
      chip.className = "page-chip";
      chip.textContent = `p. ${p}`;
      return chip;
    }));
    listEl.replaceChildren(...sources.map((s) => {
      const li = document.createElement("li");
      li.className = "source";
      const page = document.createElement("span");
      page.className = "source__page";
      page.textContent = `Page ${s.page}`;
      const snip = document.createElement("p");
      snip.className = "source__snippet";
      snip.textContent = s.snippet || "";
      li.append(page, snip);
      return li;
    }));
    view.sources.querySelector(".sources__label").textContent =
      sources.length === 1 ? "1 source" : `${sources.length} sources`;
    view.sources.hidden = false;
  }

  function addError(message, onRetry) {
    const node = els.tplError.content.firstElementChild.cloneNode(true);
    node.querySelector(".error__text").textContent = message;
    const btn = node.querySelector(".btn--retry");
    btn.addEventListener("click", () => {
      if (state.busy) return;
      node.remove();
      onRetry();
    });
    els.messages.append(node);
    scrollToBottom(true);
    return node;
  }

  /* ---------------- Server responses ---------------- */

  async function readErrorDetail(res) {
    try {
      const { detail } = await res.json();
      if (detail) {
        if (typeof detail === "string") return detail;
        if (Array.isArray(detail)) return detail.map((d) => d.msg || String(d)).join(" ");
        return JSON.stringify(detail);
      }
    } catch { /* body was not JSON */ }
    return `The server responded with ${res.status}.`;
  }

  function parseEventBlock(block) {
    const data = block.split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; } // ignore malformed event
  }

  // Yields each parsed Server-Sent Event; stops reading when the consumer breaks.
  async function* readEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        // Normalise CRLF/CR line endings, but keep a trailing "\r" until the next chunk shows
        // whether it is half of a "\r\n" split across chunks (else it would read as "\n\n").
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n|\r(?!$)/g, "\n");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const evt = parseEventBlock(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (evt) yield evt;
        }
      }
      for (const block of buffer.replace(/\r\n?/g, "\n").split("\n\n")) {
        const evt = parseEventBlock(block);
        if (evt) yield evt;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /* ---------------- Chat flow ---------------- */

  function ask(question) {
    els.empty.hidden = true;
    addUserMessage(question);
    state.stickToBottom = true;
    scrollToBottom(true);
    run(question);
  }

  async function run(question) {
    const history = state.history.slice(-HISTORY_TURNS * 2);
    const view = addBotMessage();
    scrollToBottom(true);
    setBusy(true);

    const controller = new AbortController();
    state.controller = controller;

    let answer = "";
    let renderQueued = false;
    const flush = () => {
      renderQueued = false;
      view.md.innerHTML = renderMarkdown(answer);
      scrollToBottom();
    };
    const queueRender = () => {
      if (!renderQueued) { renderQueued = true; requestAnimationFrame(flush); }
    };

    const fail = (msg) => {
      if (controller.signal.aborted) return; // New chat cleared the view
      view.node.remove();
      addError(msg, () => run(question));
      notifyIfClosed();
    };

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: question, history }),
        signal: controller.signal,
      });

      if (!res.ok) {
        fail(await readErrorDetail(res));
        return;
      }
      if (!res.body) throw new Error("Streaming is not supported by this browser.");

      let finished = false;
      let errored = null;

      for await (const evt of readEvents(res.body)) {
        try {
          switch (evt.type) {
            case "sources":
              renderSources(view, evt.sources);
              scrollToBottom();
              break;
            case "token":
              if (typeof evt.text !== "string") break;
              if (!answer) { view.typing.hidden = true; view.md.hidden = false; }
              answer += evt.text;
              queueRender();
              break;
            case "done":
              finished = true;
              break;
            case "error":
              errored = evt.message || "The assistant could not answer.";
              break;
          }
        } catch (err) {
          // A malformed event (e.g. a bad sources entry) is skipped, not reported as a network failure.
          console.error("Ignoring malformed event", evt, err);
        }
        if (finished || errored) break;
      }

      if (errored) { fail(errored); return; }
      if (!finished && !answer) { fail("The connection closed before an answer arrived."); return; }

      if (!answer) answer = "_No answer was returned._";
      flush();
      view.typing.hidden = true;
      view.md.hidden = false;
      view.node.classList.remove("msg--streaming");
      view.node.removeAttribute("aria-busy");
      els.announcer.textContent = `Assistant: ${view.md.textContent}`;
      notifyIfClosed();

      state.history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    } catch (err) {
      if (err && err.name === "AbortError") return; // New chat cleared the view
      fail("Couldn't reach the server. Check your connection and try again.");
      checkHealth();
    } finally {
      if (state.controller === controller) {
        state.controller = null;
        setBusy(false);
      }
    }
  }

  /* ---------------- Widget shell ---------------- */

  const shell = {
    root: document.documentElement,
    site: $("#site"),
    widget: $("#widget"),
    panel: $("#chatPanel"),
    launcher: $("#launcher"),
    close: $("#panelClose"),
    unread: $("#unread"),
    nudge: $("#nudge"),
    nudgeClose: $("#nudgeClose"),
  };
  const phoneQuery = window.matchMedia("(max-width: 480px)");
  const NUDGE_KEY = "golf-chat-nudge-dismissed";
  const FOCUSABLE = "button, textarea, summary, a[href], [tabindex]:not([tabindex='-1'])";

  const isOpen = () => shell.panel.classList.contains("is-open");

  function updateLauncherLabel() {
    const unread = !shell.unread.hidden;
    shell.launcher.setAttribute("aria-label", isOpen()
      ? "Close Rules of Golf chat"
      : `Open Rules of Golf chat${unread ? " (new answer)" : ""}`);
  }

  // Phones get a full-screen modal sheet: lock page scroll and make the page inert.
  function applyModal() {
    const modal = isOpen() && phoneQuery.matches;
    shell.root.classList.toggle("chat-locked", modal);
    shell.site.inert = modal;
    if (modal) shell.panel.setAttribute("aria-modal", "true");
    else shell.panel.removeAttribute("aria-modal");
  }

  function openPanel() {
    if (isOpen()) return;
    shell.panel.inert = false;
    shell.panel.classList.add("is-open");
    shell.widget.classList.add("is-open");
    shell.launcher.setAttribute("aria-expanded", "true");
    shell.unread.hidden = true;
    dismissNudge();
    updateLauncherLabel();
    applyModal();
    syncViewport();
    state.stickToBottom = true;
    scrollToBottom(true);
    requestAnimationFrame(() => {
      (els.input.disabled ? shell.close : els.input).focus({ preventScroll: true });
    });
  }

  function closePanel() {
    if (!isOpen()) return;
    shell.panel.classList.remove("is-open");
    shell.widget.classList.remove("is-open");
    shell.panel.inert = true;
    shell.launcher.setAttribute("aria-expanded", "false");
    updateLauncherLabel();
    applyModal();
    shell.launcher.focus({ preventScroll: true });
  }

  function notifyIfClosed() {
    if (isOpen()) return;
    shell.unread.hidden = false;
    updateLauncherLabel();
  }

  function dismissNudge() {
    try { localStorage.setItem(NUDGE_KEY, "1"); } catch { /* storage unavailable */ }
    if (shell.nudge.hidden || shell.nudge.classList.contains("is-leaving")) return;
    shell.nudge.classList.add("is-leaving");
    const hide = () => { shell.nudge.hidden = true; shell.nudge.classList.remove("is-leaving"); };
    shell.nudge.addEventListener("animationend", hide, { once: true });
    setTimeout(hide, 400); // in case animations are disabled
  }

  function maybeShowNudge() {
    let dismissed = false;
    try { dismissed = localStorage.getItem(NUDGE_KEY) === "1"; } catch { /* storage unavailable */ }
    if (!dismissed && !isOpen()) shell.nudge.hidden = false;
  }

  // Keep the phone sheet sized to the visible area when the on-screen keyboard opens.
  function syncViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    shell.root.style.setProperty("--vv-height", `${vv.height}px`);
    shell.root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
  }

  shell.launcher.addEventListener("click", () => (isOpen() ? closePanel() : openPanel()));
  shell.close.addEventListener("click", closePanel);
  shell.nudgeClose.addEventListener("click", dismissNudge);
  document.querySelectorAll("[data-open-chat]").forEach((b) => b.addEventListener("click", openPanel));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isOpen()) { e.preventDefault(); closePanel(); }
    else if (!shell.nudge.hidden) dismissNudge();
  });

  // Trap focus inside the full-screen sheet on phones.
  shell.panel.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || !phoneQuery.matches) return;
    const items = [...shell.panel.querySelectorAll(FOCUSABLE)]
      .filter((el) => !el.disabled && el.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  phoneQuery.addEventListener("change", applyModal);
  if (window.visualViewport) {
    const onViewport = () => { syncViewport(); if (isOpen()) scrollToBottom(); };
    window.visualViewport.addEventListener("resize", onViewport);
    window.visualViewport.addEventListener("scroll", onViewport);
  }

  /* ---------------- Host page reveals ---------------- */

  function setupReveals() {
    const items = document.querySelectorAll(".reveal");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add("is-visible"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -80px 0px", threshold: 0.1 });
    items.forEach((el) => io.observe(el));
  }

  /* ---------------- Init ---------------- */

  setupReveals();
  syncViewport();
  updateLauncherLabel();
  setTimeout(maybeShowNudge, 1200);
  updateComposer();
  checkHealth();
  setInterval(checkHealth, HEALTH_INTERVAL_MS);
  window.addEventListener("online", checkHealth);
  window.addEventListener("offline", () => setStatus("offline", "Offline"));
})();
