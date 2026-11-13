// lessbook · Copyright © 2026 wafflemoon softworks · AGPL-3.0-only (see LICENSE)
// lessbook reader: epub.ts (vendor/epub-ts.umd.js, the maintained TypeScript fork of epub.js) in paginated mode. Book path comes from the hash: read.html#/dir/file.epub.
// State in localStorage: reader.pos:<path> (CFI), reader.pct:<path> (0-1, shown in the library),
// reader.locs:<path> (cached page locations), reader.size / reader.font / reader.theme.
// Position and percentage are also synced to /progress.json so they follow you across browsers.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* full or blocked */ } },
  };

  const path = decodeURIComponent(location.hash.replace(/^#/, ""));
  const dir = path.replace(/[^/]*$/, "");
  $("back").href = "/#" + encodePath(dir);
  const fileName = path.split("/").pop().replace(/\.epub$/i, "");
  $("title").textContent = fileName;
  document.title = fileName + " · lessbook";

  if (!/\.epub$/i.test(path)) {
    status.textContent = "not an .epub file: " + path;
    return;
  }

  // ---- settings ----
  const FONTS = {
    serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, serif',
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    vt323: '"VT323", ui-monospace, monospace',
    book: null,
  };
  // VT323 is small for its size, so it gets a boost on top of the chosen text size
  const FONT_SCALE = { vt323: 1.3 };
  const settings = {
    size: Number(store.get("reader.size", "100")) || 100,
    font: store.get("reader.font", "serif"),
    theme: store.get("reader.theme", "auto"),
  };
  if (!(settings.font in FONTS)) settings.font = "serif";

  function applyPageTheme() {
    if (settings.theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.theme;
  }
  applyPageTheme();

  function bookCSS() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    let css = `html, body { background: ${v("--bg")} !important; color: ${v("--fg")} !important; }
      a, a:visited { color: ${v("--link")} !important; }
      body { -webkit-text-size-adjust: 100%; }
      img, svg, video { max-width: 100%; height: auto; }`;
    if (settings.font === "vt323") {
      // The book frame doesn't see the page's @font-face, so declare it here (absolute URL: the frame has its own base)
      css = `@font-face { font-family: "VT323"; font-display: swap;
        src: url("${location.origin}/vendor/fonts/vt323-latin.woff2") format("woff2"); }\n` + css;
    }
    if (FONTS[settings.font]) {
      css += `body, body *:not(pre):not(code):not(kbd):not(samp) { font-family: ${FONTS[settings.font]} !important; }`;
    }
    return css;
  }

  // ---- book ----
  const book = ePub("/books" + encodePath(path), { openAs: "epub" });
  const rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    flow: "paginated",
    spread: "none",
    allowScriptedContent: false,
  });

  function styleContents(contents) {
    const doc = contents.document;
    let el = doc.getElementById("reader-style");
    if (!el) {
      el = doc.createElement("style");
      el.id = "reader-style";
      (doc.head || doc.documentElement).appendChild(el);
    }
    el.textContent = bookCSS();
  }
  function restyle() {
    rendition.getContents().forEach(styleContents);
  }

  // Re-paginate at the current position after a change that alters layout (font)
  function relayout() {
    const cur = rendition.currentLocation();
    const cfi = cur && cur.start ? cur.start.cfi : undefined;
    restyle();
    rendition.display(cfi);
  }

  window.lessbook = { book, rendition }; // for debugging from the browser console

  const next = () => rendition.next();
  const prev = () => rendition.prev();

  // ---- input inside the book frame: tap zones, swipe, keys ----
  let lastSwipe = 0;
  rendition.hooks.content.register((contents) => {
    styleContents(contents);
    const doc = contents.document;
    const win = contents.window;

    doc.addEventListener("keydown", onKey);

    let sx = 0, sy = 0, st = 0;
    doc.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
    }, { passive: true });
    doc.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 800) {
        lastSwipe = Date.now();
        dx < 0 ? next() : prev();
      }
    }, { passive: true });

    doc.addEventListener("click", (e) => {
      if (Date.now() - lastSwipe < 500) return;
      if (e.target.closest && e.target.closest("a")) return;
      const sel = win.getSelection && win.getSelection();
      if (sel && sel.toString()) return;
      if (closePanels()) return;
      // The frame can be wider than the screen in paginated mode: work in page coordinates
      const frame = win.frameElement;
      const x = (frame ? frame.getBoundingClientRect().left : 0) + e.clientX;
      const v = $("viewer").getBoundingClientRect();
      const rel = (x - v.left) / v.width;
      if (rel < 0.3) prev();
      else if (rel > 0.7) next();
    });
  });

  // ---- position + progress ----
  // Kept in localStorage and, so every browser picks up where you left off, in /progress.json on the server
  // ({"<path>": {cfi, href, page, total, pct, t}}). When a book opens, whichever copy is newer wins.
  const POS = "reader.pos:" + path, PCT = "reader.pct:" + path, LOCS = "reader.locs:" + path;

  let remote = null;   // last copy of progress.json read from the server
  let pending = null;  // newest position not yet sent
  let timer = 0;
  let locsReady = false; // percentages are only right once the book's page locations are complete
  let lastCfi = null;

  // {} when there is no file yet; null when the server can't be read (then never write, or we'd wipe other books)
  async function fetchProgress() {
    try {
      const r = await fetch("/progress.json", { cache: "no-store" });
      if (r.status === 404) return {};
      if (!r.ok) return null;
      const j = await r.json();
      return j && typeof j === "object" ? j : null;
    } catch (e) { return null; }
  }

  function putProgress(doc, keepalive) {
    return fetch("/progress.json", {
      method: "PUT", keepalive, headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc),
    }).catch(() => { /* offline: localStorage still has it, next save retries */ });
  }

  function saveRemote(entry) {
    pending = entry;
    clearTimeout(timer);
    timer = setTimeout(pushRemote, 2000);
  }

  async function pushRemote() {
    if (!pending) return;
    const entry = pending;
    pending = null;
    const doc = await fetchProgress();
    if (!doc) { pending = pending || entry; return; }
    remote = doc;
    if (doc[path] && (doc[path].t || 0) > entry.t) return; // read further along on another device since
    doc[path] = entry;
    await putProgress(doc);
  }

  // Leaving the page: send the last position at once, without waiting to re-read the file
  function flush() {
    if (!pending || !remote) return;
    clearTimeout(timer);
    remote[path] = pending;
    pending = null;
    putProgress(remote, true);
  }
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  function showLocation(loc) {
    if (!loc || !loc.start) return null;
    const parts = [];
    let pct = null;
    if (locsReady) pct = book.locations.percentageFromCfi(loc.start.cfi);
    if (loc.atEnd) pct = 1;
    if (pct != null) {
      parts.push(Math.round(pct * 100) + "%");
      store.set(PCT, String(pct));
    }
    const d = loc.start.displayed;
    if (d && d.total) parts.push(d.page + "/" + d.total);
    $("loc").textContent = parts.join("  ·  ");
    markCurrentToc(loc.start.href);
    return pct;
  }

  // Saved as {cfi, href, page, total}. The CFI marks where the first visible text starts; when that text began on
  // the previous page, epub.js reopens one page early, so after display we step forward to the saved page
  // (only when the chapter still has the same page count, i.e. same screen size).
  let restoring = false;
  rendition.on("relocated", (loc) => {
    const pct = showLocation(loc);
    // epub.js also reports the same spot again after layout changes; only a real move is saved
    if (!restoring && loc.start.cfi !== lastCfi) {
      lastCfi = loc.start.cfi;
      const d = loc.start.displayed || {};
      const pos = { cfi: loc.start.cfi, href: loc.start.href, page: d.page, total: d.total, t: Date.now() };
      store.set(POS, JSON.stringify(pos));
      const known = store.get(PCT, null);
      saveRemote({ ...pos, pct: pct != null ? pct : known != null ? Number(known) : null });
    }
  });

  function savedPos() {
    const raw = store.get(POS, "");
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return { cfi: raw }; } // older plain-CFI format
  }

  async function restore() {
    remote = await fetchProgress();
    const local = savedPos();
    const server = remote && remote[path];
    let saved = local;
    if (server && server.cfi && (!local || (server.t || 0) > (local.t || 0))) {
      saved = server;
      store.set(POS, JSON.stringify(server));
      if (server.pct != null) store.set(PCT, String(server.pct));
    }
    if (!saved || !saved.cfi) return rendition.display();
    restoring = true;
    try {
      await rendition.display(saved.cfi);
      for (let i = 0; i < 30; i++) {
        const cur = rendition.currentLocation();
        const d = cur && cur.start && cur.start.displayed;
        if (!d || cur.start.href !== saved.href || d.total !== saved.total || d.page >= saved.page) break;
        await rendition.next();
      }
    } finally {
      restoring = false;
    }
    const cur = rendition.currentLocation();
    if (cur && cur.start) lastCfi = cur.start.cfi;
    if (cur && cur.start) showLocation(cur);
  }

  book.opened.then(() => {
    status.remove();
    return restore();
  }).catch((err) => {
    // A stale saved position can fail to resolve; fall back to the start
    if (store.get(POS, null)) {
      store.set(POS, "");
      return rendition.display();
    }
    throw err;
  }).catch((err) => {
    status.textContent = "could not open this book (" + (err && err.message ? err.message : err) + ")";
  });

  function applySize() {
    rendition.themes.fontSize(Math.round(settings.size * (FONT_SCALE[settings.font] || 1)) + "%");
  }
  applySize();

  book.loaded.metadata.then((m) => {
    if (m && m.title) {
      $("title").textContent = m.title + (m.creator ? " — " + m.creator : "");
      document.title = m.title + " · lessbook";
    }
  });

  // Page locations for a whole-book percentage: generated once per book, then cached
  book.ready.then(async () => {
    const cached = store.get(LOCS, null);
    if (cached) {
      try { book.locations.load(cached); } catch (e) { /* regenerate below */ }
    }
    if (!book.locations.length()) {
      await book.locations.generate(1600);
      store.set(LOCS, book.locations.save());
    }
    locsReady = true;
    const pct = showLocation(rendition.currentLocation());
    if (pending && pct != null) pending.pct = pct;
  }).catch(() => { /* percentage is optional */ });

  // ---- table of contents ----
  // TOC links are relative to the nav document ("ch01.xhtml"), but epub.js looks sections up by their path in the
  // package ("e9781982179403/xhtml/ch01.xhtml"); unresolved links fail with "No Section Found". Resolve them against
  // the nav file's folder, falling back to the spine item with the same file name.
  function resolveHref(href) {
    if (!href) return href;
    const [file, frag] = href.split("#");
    const hash = frag ? "#" + frag : "";
    if (!file || book.spine.get(file)) return href;
    const pkg = book.packaging || {};
    const navPath = pkg.navPath || pkg.ncxPath || "";
    const base = navPath.includes("/") ? navPath.replace(/[^/]*$/, "") : "";
    const joined = decodeURIComponent(new URL(base + file, "http://x/").pathname.slice(1));
    if (book.spine.get(joined)) return joined + hash;
    const name = file.split("/").pop();
    const item = book.spine.spineItems.find((s) => s.href === name || s.href.endsWith("/" + name));
    return item ? item.href + hash : href;
  }

  const toc = $("toc");
  book.loaded.navigation.then((nav) => {
    const build = (items) => {
      const ul = document.createElement("ul");
      for (const it of items) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = (it.label || "").trim() || "(untitled)";
        const target = resolveHref(it.href);
        a.dataset.href = target;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          closePanels();
          rendition.display(target).catch((err) => console.error("toc jump failed", target, err));
        });
        li.append(a);
        if (it.subitems && it.subitems.length) li.append(build(it.subitems));
        ul.append(li);
      }
      return ul;
    };
    if (nav.toc && nav.toc.length) toc.append(build(nav.toc));
    else toc.textContent = "this book has no table of contents";
  });

  function markCurrentToc(href) {
    if (!href) return;
    const base = href.split("#")[0];
    toc.querySelectorAll("a").forEach((a) => {
      a.classList.toggle("current", (a.dataset.href || "").split("#")[0] === base);
    });
  }

  // ---- panels + settings UI ----
  const panels = [[$("tocBtn"), toc], [$("setBtn"), $("settings")]];
  function closePanels() {
    let closed = false;
    for (const [btn, el] of panels) {
      if (!el.hidden) { el.hidden = true; btn.setAttribute("aria-expanded", "false"); closed = true; }
    }
    return closed;
  }
  for (const [btn, el] of panels) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = el.hidden;
      closePanels();
      if (open) {
        el.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        const cur = el.querySelector("a.current");
        if (cur) cur.scrollIntoView({ block: "center" });
      }
    });
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".panel") && !e.target.closest("header")) closePanels();
  });

  function syncButtons() {
    $("sizeVal").textContent = settings.size + "%";
    document.querySelectorAll("[data-font]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.font === settings.font)));
    document.querySelectorAll("[data-theme]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === settings.theme)));
  }
  syncButtons();

  document.querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => {
    settings.size = Math.max(70, Math.min(200, settings.size + 10 * Number(b.dataset.size)));
    store.set("reader.size", String(settings.size));
    applySize();
    syncButtons();
  }));
  document.querySelectorAll("[data-font]").forEach((b) => b.addEventListener("click", () => {
    settings.font = b.dataset.font;
    store.set("reader.font", settings.font);
    syncButtons();
    applySize();
    relayout();
  }));
  document.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => {
    settings.theme = b.dataset.theme;
    store.set("reader.theme", settings.theme);
    applyPageTheme();
    syncButtons();
    restyle();
  }));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (settings.theme === "auto") restyle();
  });

  // ---- buttons + keys ----
  $("next").addEventListener("click", next);
  $("prev").addEventListener("click", prev);

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowRight": case "PageDown": case " ": case "l": next(); break;
      case "ArrowLeft": case "PageUp": case "h": prev(); break;
      case "t": $("tocBtn").click(); break;
      case "Escape": closePanels(); break;
      case "b": location.href = $("back").href; break;
      default: return;
    }
    e.preventDefault();
  }
  document.addEventListener("keydown", onKey);
})();
