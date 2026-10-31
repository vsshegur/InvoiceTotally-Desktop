/* Shared controls: a modern calendar / month picker and a type-to-search dropdown.
   They upgrade the page's own <input type="date|month"> and <select class="in"> in place: the original element stays
   (hidden) and keeps its value, so the rest of the app reads and sets .value and listens for change exactly as before. */
"use strict";
/** "2026-09" for this month + offset, in this PC's own calendar (toISOString() is UTC: before 5:30 am in India it is
 * still yesterday, and setMonth on the 31st overflows into the next month). */
function localMonth(offset = 0) { const d = new Date(); const t = new Date(d.getFullYear(), d.getMonth() + offset, 1); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"); }
function localDate() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
(() => {
  if (typeof HTMLInputElement === "undefined" || typeof MutationObserver === "undefined" || typeof requestAnimationFrame === "undefined") return;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONF = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  const ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 3v4M16 3v4M4 11h16"/></svg>';
  const CHEV = '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function place(pop, anchor, minW) {
    const r = anchor.getBoundingClientRect();
    pop.style.minWidth = Math.max(minW || 0, r.width) + "px";
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + "px";
    const h = pop.offsetHeight, below = innerHeight - r.bottom - 8, above = r.top - 8;
    const top = below >= h || below >= above ? r.bottom + 4 : r.top - h - 4;
    pop.style.top = Math.max(8, top) + "px";
    pop.style.maxHeight = Math.max(160, below >= h || below >= above ? below : above) + "px";
  }

  // ------------------------------------------------------------------ calendar
  let cal = null;
  function closeCal() { if (cal) { cal.pop.remove(); document.removeEventListener("mousedown", cal.out, true); window.removeEventListener("resize", closeCal); cal.btn.focus?.(); cal = null; } }
  function parseTyped(s, month) {
    s = String(s).trim();
    if (month) {
      let m = /^(\d{4})[-/](\d{1,2})$/.exec(s) || /^(\d{1,2})[-/ .](\d{4})$/.exec(s);
      if (m) { const [a, b] = m.slice(1).map(Number); const y = a > 31 ? a : b, mo = a > 31 ? b : a; if (mo >= 1 && mo <= 12) return `${y}-${pad(mo)}`; }
      m = /^([A-Za-z]{3})[a-z]*[ -]+(\d{2,4})$/.exec(s);
      if (m) { const i = MON.findIndex((x) => x.toLowerCase() === m[1].toLowerCase()); if (i >= 0) return `${m[2].length === 2 ? 2000 + +m[2] : m[2]}-${pad(i + 1)}`; }
      return "";
    }
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s), y, mo, d;
    if (m) [y, mo, d] = m.slice(1).map(Number);
    else if ((m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(s))) { d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; }
    else if ((m = /^(\d{1,2})[-/. ]?([A-Za-z]{3})[a-z]*[-/. ]?(\d{2}|\d{4})$/.exec(s))) { d = +m[1]; mo = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) + 1; y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; }
    else return "";
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? isoOf(y, mo - 1, d) : "";
  }
  function openCal(inp, btn, month) {
    if (cal && cal.inp === inp) return closeCal();
    closeCal();
    const today = new Date(), ty = today.getFullYear(), tm = today.getMonth(), td = today.getDate();
    const cur = inputValue.get.call(inp);
    const parts = (month ? cur + "-01" : cur).split("-").map(Number);
    let y = parts[0] || ty, m = parts[0] ? parts[1] - 1 : tm, focusD = parts[2] || (m === tm && y === ty ? td : 1);
    let view = month ? "months" : "days", decade = Math.floor(y / 12) * 12;
    const min = inp.min || "", max = inp.max || "";
    const ok = (iso) => (!min || iso >= min.slice(0, iso.length)) && (!max || iso <= max.slice(0, iso.length));
    const pop = document.createElement("div");
    pop.className = "dp-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", month ? "Choose a month" : "Choose a date"); pop.tabIndex = -1;
    document.body.appendChild(pop);
    const pick = (v) => {
      inputValue.set.call(inp, v);
      inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true }));
      closeCal();
    };
    const render = () => {
      let head = "", body = "";
      if (view === "days") {
        head = `<button type="button" class="dp-nav" data-a="pm" aria-label="Previous month">‹</button><button type="button" class="dp-title" data-a="months">${MONF[m]} ${y} ▾</button><button type="button" class="dp-nav" data-a="nm" aria-label="Next month">›</button>`;
        const offset = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7, dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), prev = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const cells = [];
        for (let i = 0; i < 42; i++) {
          const dn = i - offset + 1; let cy = y, cm = m, cd = dn, other = false;
          if (dn < 1) { cm = m - 1; if (cm < 0) { cm = 11; cy--; } cd = prev + dn; other = true; }
          else if (dn > dim) { cm = m + 1; if (cm > 11) { cm = 0; cy++; } cd = dn - dim; other = true; }
          const iso = isoOf(cy, cm, cd);
          cells.push(`<button type="button" class="dp-d${other ? " o" : ""}${iso === cur ? " sel" : ""}${cy === ty && cm === tm && cd === td ? " today" : ""}${!other && cd === focusD ? " f" : ""}" data-d="${iso}" ${ok(iso) ? "" : "disabled"} tabindex="-1">${cd}</button>`);
        }
        body = `<div class="dp-dow">${DOW.map((x) => `<span>${x}</span>`).join("")}</div><div class="dp-days">${cells.join("")}</div>`;
      } else if (view === "months") {
        head = `<button type="button" class="dp-nav" data-a="py" aria-label="Previous year">‹</button><button type="button" class="dp-title" data-a="years">${y} ▾</button><button type="button" class="dp-nav" data-a="ny" aria-label="Next year">›</button>`;
        body = `<div class="dp-grid">${MON.map((x, i) => `<button type="button" class="dp-c${month && cur === `${y}-${pad(i + 1)}` ? " sel" : ""}${y === ty && i === tm ? " today" : ""}" data-m="${i}" ${ok(`${y}-${pad(i + 1)}`) ? "" : "disabled"}>${x}</button>`).join("")}</div>`;
      } else {
        head = `<button type="button" class="dp-nav" data-a="pd" aria-label="Earlier years">‹</button><span class="dp-title static">${decade} – ${decade + 11}</span><button type="button" class="dp-nav" data-a="nd" aria-label="Later years">›</button>`;
        body = `<div class="dp-grid">${Array.from({ length: 12 }, (_, i) => decade + i).map((yy) => `<button type="button" class="dp-c${yy === y ? " sel" : ""}${yy === ty ? " today" : ""}" data-y="${yy}">${yy}</button>`).join("")}</div>`;
      }
      pop.innerHTML = `<input class="dp-type" placeholder="${month ? "Type e.g. Oct 2026" : "Type e.g. 25/10/2026"}" aria-label="Type a ${month ? "month" : "date"}" autocomplete="off">
        <div class="dp-head">${head}</div>${body}
        <div class="dp-foot"><button type="button" class="dp-link" data-a="today">${month ? "This month" : "Today"}</button>${inp.required ? "" : '<button type="button" class="dp-link" data-a="clear">Clear</button>'}</div>`;
      place(pop, btn, 268);
    };
    render();
    pop.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.d) return pick(b.dataset.d);
      if (b.dataset.m != null) { m = +b.dataset.m; if (month) return pick(`${y}-${pad(m + 1)}`); view = "days"; focusD = 1; return render(); }
      if (b.dataset.y) { y = +b.dataset.y; view = "months"; return render(); }
      const a = b.dataset.a;
      if (a === "pm") { if (--m < 0) { m = 11; y--; } }
      else if (a === "nm") { if (++m > 11) { m = 0; y++; } }
      else if (a === "py") y--; else if (a === "ny") y++;
      else if (a === "pd") decade -= 12; else if (a === "nd") decade += 12;
      else if (a === "months") view = "months"; else if (a === "years") { view = "years"; decade = Math.floor(y / 12) * 12; }
      else if (a === "today") return pick(month ? `${ty}-${pad(tm + 1)}` : isoOf(ty, tm, td));
      else if (a === "clear") return pick("");
      render();
    };
    pop.onkeydown = (e) => {
      if (e.target.classList.contains("dp-type")) {
        if (e.key === "Enter") { e.preventDefault(); const v = parseTyped(e.target.value, month); if (v && ok(v)) pick(v); else e.target.classList.add("bad"); }
        else if (e.key === "Escape") closeCal();
        else e.target.classList.remove("bad");
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); closeCal(); return; }
      if (view !== "days") return;
      const mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (mv) {
        e.preventDefault();
        const dt = new Date(Date.UTC(y, m, focusD + mv)); y = dt.getUTCFullYear(); m = dt.getUTCMonth(); focusD = dt.getUTCDate(); render();
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault(); m += e.key === "PageUp" ? -1 : 1; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
        focusD = Math.min(focusD, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()); render();
      } else if (e.key === "Enter") { e.preventDefault(); const v = isoOf(y, m, focusD); if (ok(v)) pick(v); }
    };
    const out = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) closeCal(); };
    document.addEventListener("mousedown", out, true); window.addEventListener("resize", closeCal);
    cal = { pop, inp, btn, out };
    pop.focus();
  }

  function enhanceDate(inp) {
    if (inp.dataset.dp) return; inp.dataset.dp = "1";
    const month = inp.type === "month";
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "in dp-btn"; btn.style.cssText = inp.style.cssText;
    btn.innerHTML = `<span class="dp-txt"></span>${ICON}`;
    const txt = btn.firstChild;
    const fmt = (v) => {
      const p = String(v || "").split("-").map(Number);
      if (!p[0]) return "";
      return month ? `${MON[p[1] - 1] || ""} ${p[0]}` : `${p[2]} ${MON[p[1] - 1] || ""} ${p[0]}`;
    };
    const refresh = () => {
      const v = inputValue.get.call(inp);
      txt.textContent = fmt(v) || (month ? "Select month" : "Select date");
      btn.classList.toggle("empty", !v); btn.disabled = inp.disabled;
      const lbl = inp.id && document.querySelector(`label[for="${inp.id}"]`); if (lbl) btn.setAttribute("aria-label", lbl.textContent.trim() + ": " + (fmt(v) || "none"));
    };
    Object.defineProperty(inp, "value", { get() { return inputValue.get.call(this); }, set(v) { inputValue.set.call(this, v); refresh(); }, configurable: true });
    new MutationObserver(refresh).observe(inp, { attributes: true, attributeFilter: ["disabled", "min", "max"] });
    inp.addEventListener("change", refresh);
    inp.hidden = true; inp.after(btn);
    btn.addEventListener("click", () => openCal(inp, btn, month));
    btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); openCal(inp, btn, month); } });
    refresh();
  }

  // ------------------------------------------------------------------ searchable dropdown
  let open = null;
  function closeList(restore = true) {
    if (!open) return;
    const o = open; open = null;
    o.list.remove(); document.removeEventListener("mousedown", o.out, true); window.removeEventListener("resize", o.closer); window.removeEventListener("scroll", o.closer, true);
    o.wrap.classList.remove("open");
    if (restore) o.refresh();
  }
  function rank(label, tokens) {
    const l = label.toLowerCase(); let score = 0;
    for (const t of tokens) {
      const i = l.indexOf(t); if (i < 0) return -1;
      score += i === 0 ? 0 : /[\s\-/(&.,]/.test(l[i - 1]) ? 2 : 5;
    }
    return score + l.length / 1000;
  }
  function enhanceSelect(sel, openNow) {
    if (sel.dataset.cb) return;
    sel.dataset.cb = "1";
    const wrap = document.createElement("div");
    wrap.className = "cb"; wrap.style.cssText = sel.style.cssText;
    if (sel.classList.contains("sm")) wrap.classList.add("sm");
    const input = document.createElement("input");
    input.className = "in cb-input"; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "false"); input.setAttribute("aria-autocomplete", "list");
    const aria = sel.getAttribute("aria-label"); if (aria) input.setAttribute("aria-label", aria);
    else if (sel.id) { const l = document.querySelector(`label[for="${sel.id}"]`); if (l) input.setAttribute("aria-label", l.textContent.trim()); }
    wrap.append(input);
    wrap.insertAdjacentHTML("beforeend", `<span class="cb-chev">${CHEV}</span>`);
    sel.hidden = true; sel.required = false; sel.after(wrap);
    const opts = () => [...sel.options];
    const labelOf = () => { const o = sel.options[sel.selectedIndex]; return o && o.value !== "" ? o.text : ""; };
    const refresh = () => {
      input.value = labelOf();
      const first = sel.options[0];
      input.placeholder = first && first.value === "" ? first.text : "Search…";
      input.disabled = sel.disabled; wrap.classList.toggle("disabled", sel.disabled);
    };
    Object.defineProperty(sel, "value", { get() { return selectValue.get.call(this); }, set(v) { selectValue.set.call(this, v); refresh(); }, configurable: true });
    new MutationObserver(refresh).observe(sel, { attributes: true, attributeFilter: ["disabled"] });
    sel.addEventListener("change", refresh);
    refresh();

    let items = [], hi = 0, typed = false;
    const list = document.createElement("div"); list.className = "cb-list"; list.setAttribute("role", "listbox");
    const build = () => {
      const q = typed ? input.value.trim().toLowerCase() : "", tokens = q.split(/\s+/).filter(Boolean);
      let all = opts().map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled && (tokens.length ? o.value !== "" : true));
      if (tokens.length) all = all.map((x) => ({ ...x, s: rank(x.o.text, tokens) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s);
      items = all.slice(0, 120);
      const cur = sel.selectedIndex;
      hi = Math.max(0, items.findIndex((x) => x.i === cur));
      if (tokens.length) hi = 0;
      list.innerHTML = items.length ? items.map((x, k) => `<div class="cb-opt${x.i === cur ? " sel" : ""}${k === hi ? " hi" : ""}${x.o.value === "" ? " ph" : ""}" role="option" data-k="${k}">${esc(x.o.text)}</div>`).join("") +
        (all.length > items.length ? `<div class="cb-more">${all.length - items.length} more — keep typing to narrow</div>` : "") : `<div class="cb-more">No match for “${esc(input.value)}”</div>`;
      list.querySelector(".hi")?.scrollIntoView({ block: "nearest" });
    };
    const choose = (k) => {
      const x = items[k]; if (!x) return;
      selectValue.set.call(sel, sel.options[x.i].value); sel.selectedIndex = x.i;
      closeList(false); refresh();
      sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const show = () => {
      if (sel.disabled) return;
      if (open && open.wrap === wrap) return;
      closeList(); closeCal();
      typed = false; document.body.appendChild(list); wrap.classList.add("open"); input.setAttribute("aria-expanded", "true");
      build(); place(list, wrap, 220);
      const out = (e) => { if (!list.contains(e.target) && !wrap.contains(e.target)) closeList(); };
      const closer = (e) => { if (e && e.target && list.contains(e.target)) return; closeList(); };
      document.addEventListener("mousedown", out, true); window.addEventListener("resize", closer); window.addEventListener("scroll", closer, true);
      open = { wrap, list, out, closer, refresh: () => { refresh(); input.setAttribute("aria-expanded", "false"); } };
    };
    const move = (d) => {
      if (!items.length) return;
      list.querySelector(".hi")?.classList.remove("hi");
      hi = (hi + d + items.length) % items.length;
      const el = list.querySelector(`[data-k="${hi}"]`); el?.classList.add("hi"); el?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("focus", () => { input.select(); show(); });
    input.addEventListener("click", () => { show(); });
    wrap.querySelector(".cb-chev").addEventListener("mousedown", (e) => { e.preventDefault(); open && open.wrap === wrap ? closeList() : (input.focus(), show()); });
    input.addEventListener("input", () => { typed = true; show(); build(); place(list, wrap, 220); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); show(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); show(); move(-1); }
      else if (e.key === "Enter") { if (open && open.wrap === wrap) { e.preventDefault(); e.stopPropagation(); choose(hi); } }
      else if (e.key === "Escape") { if (open && open.wrap === wrap) { e.preventDefault(); e.stopPropagation(); closeList(); } }
      else if (e.key === "Tab") { if (open && open.wrap === wrap && typed && items.length) choose(hi); else closeList(); }
    });
    input.addEventListener("blur", () => { setTimeout(() => { if (open && open.wrap === wrap && document.activeElement !== input) closeList(); }, 120); });
    list.addEventListener("mousedown", (e) => { e.preventDefault(); const o = e.target.closest(".cb-opt"); if (o) choose(+o.dataset.k); });
    list.addEventListener("mousemove", (e) => { const o = e.target.closest(".cb-opt"); if (o && +o.dataset.k !== hi) { list.querySelector(".hi")?.classList.remove("hi"); o.classList.add("hi"); hi = +o.dataset.k; } });
    if (openNow) { input.focus(); }
  }

  const SEARCH_MIN = 10;
  function scan(root) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll('input[type="date"]:not([data-dp]), input[type="month"]:not([data-dp])').forEach(enhanceDate);
    root.querySelectorAll("select.in:not([data-cb]):not([multiple])").forEach((s) => { if (s.dataset.search !== undefined || s.options.length >= SEARCH_MIN) enhanceSelect(s); });
  }
  // A select that got its options after it appeared: upgrade it the moment someone reaches for it.
  document.addEventListener("mousedown", (e) => {
    const s = e.target.closest && e.target.closest("select.in:not([data-cb]):not([multiple])");
    if (s && s.options.length >= SEARCH_MIN) { e.preventDefault(); enhanceSelect(s, true); }
  }, true);
  let queued = false;
  const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; scan(document); }); };
  new MutationObserver(queue).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cal) { closeCal(); e.stopPropagation(); } }, true);
  scan(document);
  window.UI = { scan, enhanceSelect, enhanceDate };
})();
