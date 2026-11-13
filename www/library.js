// lessbook · Copyright © 2026 wafflemoon softworks · AGPL-3.0-only (see LICENSE)
// lessbook library: nginx's JSON listing of /books/<dir>/ rendered as a terminal-style `ls -lh`. Folders open in place
// (#/dir/), .epub files open in the reader (read.html#/dir/file.epub). F (or /) finds, S sorts, U uploads, T themes.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const list = $("list");
  const total = $("total");
  const themeBtn = $("theme");
  const sortBtn = $("sort");
  const findRow = $("findRow");
  const findInput = $("find");
  const findBtn = $("findBtn");
  const THEMES = ["auto", "light", "dark", "sepia", "dracula"];
  const SORTS = ["name", "new", "read", "size"];

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // ---- theme (shared with the reader) ----
  let theme = store.get("reader.theme", "auto");
  if (!THEMES.includes(theme)) theme = "auto";
  function applyTheme() {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    themeBtn.textContent = theme;
  }
  function cycleTheme() {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set("reader.theme", theme);
    applyTheme();
  }
  themeBtn.addEventListener("click", cycleTheme);
  applyTheme();

  // ---- sort: name (A-Z), new (newest first), read (most read first), size (largest first) ----
  let sortMode = store.get("lessbook.sort", "name");
  if (sortMode === "newest") sortMode = "new"; // renamed
  if (!SORTS.includes(sortMode)) sortMode = "name";
  sortBtn.textContent = sortMode;
  function cycleSort() {
    sortMode = SORTS[(SORTS.indexOf(sortMode) + 1) % SORTS.length];
    store.set("lessbook.sort", sortMode);
    sortBtn.textContent = sortMode;
    sel = 0;
    draw();
  }
  sortBtn.addEventListener("click", cycleSort);

  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  function currentDir() {
    let d = decodeURIComponent(location.hash.replace(/^#/, "")) || "/";
    if (!d.startsWith("/")) d = "/" + d;
    if (!d.endsWith("/")) d += "/";
    return d.replace(/\/{2,}/g, "/");
  }

  // ls -h style sizes: 3.2M, 812K, 4.0K
  function human(n) {
    if (n == null) return "-";
    const u = ["", "K", "M", "G", "T"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    if (i === 0) return String(n);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + u[i];
  }

  // ls style dates: "Nov 13 17:47" within six months, otherwise "Nov 13  2025"
  function lsDate(s) {
    const d = new Date(s);
    if (isNaN(d)) return "";
    const mon = d.toLocaleString("en-US", { month: "short" });
    const day = String(d.getDate()).padStart(2, " ");
    const recent = Math.abs(Date.now() - d) < 182 * 864e5;
    const tail = recent
      ? String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
      : " " + d.getFullYear();
    return `${mon} ${day} ${tail}`;
  }

  function readFraction(path) {
    const v = store.get("reader.pct:" + path, null);
    return v == null ? null : Number(v);
  }

  function span(cls, text) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function row({ dir, href, name, size, date, read }) {
    const li = document.createElement("li");
    if (dir) li.className = "dir";
    const a = document.createElement("a");
    a.href = href;
    a.textContent = name;
    const n = span("name", "");
    n.append(a);
    li.append(span("perm", dir ? "drwxr-xr-x" : "-rw-r--r--"), span("owner", "books"),
      span("size", size), span("date", date), n, span("read", read || ""));
    return li;
  }

  function message(text) {
    const li = document.createElement("li");
    li.className = "msg";
    li.textContent = text;
    return li;
  }

  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

  // ---- listing: fetched once per folder, then sorted / filtered locally ----
  let dir = "/";
  let dirs = [];
  let books = [];
  let loaded = false;

  async function load() {
    dir = currentDir();
    const shown = "~/books" + (dir === "/" ? "" : dir.replace(/\/$/, ""));
    document.querySelectorAll("[data-cwd]").forEach((el) => { el.textContent = shown; });
    document.title = dir === "/" ? "lessbook" : "lessbook · " + dir;
    $("upload").href = "/upload.html" + (dir === "/" ? "" : "#" + encodePath(dir));
    closeFind();
    loaded = false;
    sel = 0;
    try {
      const res = await fetch("/books" + encodePath(dir), { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(res.status === 404 ? "No such file or directory" : res.status + " " + res.statusText);
      const entries = await res.json();
      dirs = entries.filter((e) => e.type === "directory" && !e.name.startsWith("."));
      books = entries.filter((e) => e.type === "file" && /\.epub$/i.test(e.name));
      loaded = true;
    } catch (e) {
      total.textContent = "";
      list.replaceChildren(message(`ls: cannot access '${shown}': ${e.message}`));
      return;
    }
    draw();
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const time = (e) => Date.parse(e.mtime) || 0;
  function sorted(items, isDir) {
    const out = [...items];
    if (sortMode === "new") return out.sort((a, b) => time(b) - time(a) || byName(a, b));
    if (isDir) return out.sort(byName);
    if (sortMode === "size") return out.sort((a, b) => (b.size || 0) - (a.size || 0) || byName(a, b));
    if (sortMode === "read") {
      const r = (e) => { const v = readFraction(dir + e.name); return v == null ? -1 : v; };
      return out.sort((a, b) => r(b) - r(a) || byName(a, b));
    }
    return out.sort(byName);
  }

  // Every word typed must appear in the name (case-insensitive)
  function matches(name, words) {
    const n = name.toLowerCase();
    return words.every((w) => n.includes(w));
  }

  function draw() {
    if (!loaded) return;
    const words = findInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const finding = !findRow.hidden && words.length > 0;
    const shownDirs = sorted(dirs, true).filter((d) => !finding || matches(d.name, words));
    const shownBooks = sorted(books, false).filter((b) => !finding || matches(b.name, words));

    const size = human(books.reduce((n, b) => n + (b.size || 0), 0));
    total.textContent = finding
      ? `${plural(shownBooks.length + shownDirs.length, "match")} of ${books.length + dirs.length}`
      : `total ${size} · ${plural(books.length, "file")}` + (dirs.length ? ", " + plural(dirs.length, "folder") : "");
    if (sortMode !== "name") total.textContent += ` · by ${sortMode}`;

    const frag = document.createDocumentFragment();
    if (dir !== "/" && !finding) {
      frag.append(row({ dir: true, href: "#" + encodePath(dir.replace(/[^/]+\/$/, "")), name: "..", size: "-", date: "" }));
    }
    for (const d of shownDirs) {
      frag.append(row({ dir: true, href: "#" + encodePath(dir + d.name + "/"), name: d.name + "/", size: "-", date: lsDate(d.mtime) }));
    }
    for (const b of shownBooks) {
      const p = dir + b.name;
      const r = readFraction(p);
      frag.append(row({ href: "/read.html#" + encodePath(p), name: b.name, size: human(b.size), date: lsDate(b.mtime),
        read: r == null ? "" : "[" + Math.round(r * 100) + "%]" }));
    }
    if (!shownDirs.length && !shownBooks.length) {
      frag.append(message(finding ? "(nothing matches)" : "(no .epub files here)"));
    }
    list.replaceChildren(frag);
    highlight();
  }

  // ---- find ----
  function openFind() {
    findRow.hidden = false;
    findBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("kbd");
    findInput.focus();
    draw();
  }
  function closeFind() {
    if (findRow.hidden && !findInput.value) return;
    findInput.value = "";
    findRow.hidden = true;
    findBtn.setAttribute("aria-expanded", "false");
    findInput.blur();
    sel = 0;
    draw();
  }
  findBtn.addEventListener("click", () => (findRow.hidden ? openFind() : closeFind()));
  findInput.addEventListener("input", () => { sel = 0; draw(); });

  // ---- keyboard ----
  // ↑↓ / j k move, enter opens, backspace / h up, f or / find, s sort, u upload, t theme.
  // The inverse-video selection only shows once the keyboard (or find) is used.
  let sel = 0;
  const rows = () => [...list.querySelectorAll("li")].filter((li) => li.querySelector("a"));
  function highlight() {
    const items = rows();
    const on = document.body.classList.contains("kbd");
    sel = Math.max(0, Math.min(sel, items.length - 1));
    items.forEach((li, i) => li.classList.toggle("sel", on && i === sel));
    if (on && items[sel]) items[sel].scrollIntoView({ block: "nearest" });
  }
  const openSelected = () => { const it = rows()[sel]; if (it) it.querySelector("a").click(); };

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const move = (d) => { document.body.classList.add("kbd"); sel += d; highlight(); e.preventDefault(); };
    if (e.target === findInput) {
      if (e.key === "Escape") { closeFind(); e.preventDefault(); }
      else if (e.key === "Enter") { openSelected(); e.preventDefault(); }
      else if (e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowUp") move(-1);
      return; // everything else is typing
    }
    if (e.target.closest && e.target.closest("button, a, input, select") && e.key === "Enter") return;
    if (e.key === "ArrowDown" || e.key === "j") move(1);
    else if (e.key === "ArrowUp" || e.key === "k") move(-1);
    else if (e.key === "Enter" && document.body.classList.contains("kbd")) openSelected();
    else if ((e.key === "Backspace" || e.key === "h") && currentDir() !== "/") {
      location.hash = encodePath(currentDir().replace(/[^/]+\/$/, ""));
    } else if (e.key === "f" || e.key === "F" || e.key === "/") { e.preventDefault(); openFind(); }
    else if (e.key === "Escape") closeFind();
    else if (e.key === "s" || e.key === "S") cycleSort();
    else if (e.key === "t" || e.key === "T") cycleTheme();
    else if (e.key === "u" || e.key === "U") location.href = $("upload").href;
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target === findInput) return;
    document.body.classList.remove("kbd");
    highlight();
  });

  window.addEventListener("hashchange", load);
  load();
})();
