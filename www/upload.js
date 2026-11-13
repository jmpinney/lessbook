// lessbook · Copyright © 2026 wafflemoon softworks · AGPL-3.0-only (see LICENSE)
// lessbook upload: checks each file is an EPUB in the browser (JSZip), then PUTs it to /upload/<folder>/<name>
// (nginx WebDAV, see nginx.conf). nginx answers 201 saved, 409 name taken, 413 too large, 403 bad path.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const MAX = 200 * 1024 * 1024;
  const log = $("log");
  const dirSel = $("dir");
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  try {
    const t = localStorage.getItem("reader.theme");
    if (t && t !== "auto") document.documentElement.dataset.theme = t;
  } catch (e) { /* storage unavailable */ }

  // Folder to upload into: from the library (upload.html#/Nonfiction/), else ~/books
  const startDir = decodeURIComponent(location.hash.replace(/^#/, "")).replace(/^\/+|\/+$/g, "");
  $("back").href = "/#" + (startDir ? encodePath("/" + startDir + "/") : "");

  // Folders under ~/books, three levels deep
  async function listDirs(path, depth) {
    if (depth > 3) return [];
    let entries = [];
    try {
      const res = await fetch("/books/" + (path ? encodePath(path) + "/" : ""), { headers: { Accept: "application/json" } });
      if (res.ok) entries = await res.json();
    } catch (e) { return []; }
    const out = [];
    for (const e of entries) {
      if (e.type !== "directory" || e.name.startsWith(".")) continue;
      const p = path ? path + "/" + e.name : e.name;
      out.push(p, ...(await listDirs(p, depth + 1)));
    }
    return out;
  }
  listDirs("", 1).then((dirs) => {
    dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    for (const d of dirs) {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = "~/books/" + d;
      dirSel.append(o);
    }
    if (startDir && dirs.includes(startDir)) dirSel.value = startDir;
  });

  function human(n) {
    const u = ["B", "K", "M", "G"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? (n < 10 ? n.toFixed(1) : Math.round(n)) : n) + u[i];
  }

  function line(status, text) {
    const li = document.createElement("li");
    li.className = "logline";
    const s = document.createElement("span");
    s.className = "status";
    s.textContent = status;
    const t = document.createElement("span");
    t.className = "text";
    t.textContent = text;
    li.append(s, t);
    log.append(li);
    li.scrollIntoView({ block: "nearest" });
    return {
      li, t,
      set(st, tx, cls) { s.textContent = st; if (tx != null) t.textContent = tx; li.className = "logline " + (cls || ""); },
      // name, then the progress bar as one unbreakable piece
      progress(name, fraction) {
        s.textContent = "upload";
        const b = document.createElement("span");
        b.className = "bar";
        b.textContent = bar(fraction);
        t.replaceChildren(document.createTextNode(name + " "), b);
      },
    };
  }

  function bar(fraction) {
    const n = 20, full = Math.round(fraction * n);
    return "[" + "#".repeat(full) + ".".repeat(n - full) + "] " + String(Math.round(fraction * 100)).padStart(3) + "%";
  }

  // A plain file name: no folders, no control characters, no leading dot
  function cleanName(raw) {
    return raw.replace(/[\\/]/g, " ").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
  }

  async function isEpub(file) {
    try {
      const zip = await JSZip.loadAsync(file);
      if (!zip.file("META-INF/container.xml")) return "not an EPUB (no META-INF/container.xml)";
      const mt = zip.file("mimetype");
      if (mt && (await mt.async("string")).trim() !== "application/epub+zip") return "not an EPUB (wrong mimetype)";
      return null;
    } catch (e) {
      return "not an EPUB (not a zip file)";
    }
  }

  function put(url, file, onProgress) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", "application/epub+zip");
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => resolve(xhr.status);
      xhr.onerror = () => resolve(0);
      xhr.send(file);
    });
  }

  const REASONS = {
    0: "network error, check your connection",
    401: "not logged in, reload the page",
    403: "that file name or folder is not allowed",
    404: "folder not found",
    409: "a book with that name is already there",
    413: "larger than 200 MB",
  };

  let saved = 0, failed = 0, busy = Promise.resolve();

  async function upload(file) {
    const name = cleanName(file.name);
    const dir = dirSel.value;
    const where = "~/books/" + (dir ? dir + "/" : "") + name;
    const l = line("check", name);
    const fail = (why) => { failed++; l.set("error", name + ": " + why, "err"); };

    if (!/\.epub$/i.test(name) || name.length <= 5) return fail("only .epub files can be uploaded");
    if (file.size > MAX) return fail("larger than 200 MB");
    if (file.size === 0) return fail("file is empty");
    const bad = await isEpub(file);
    if (bad) return fail(bad);

    l.progress(name, 0);
    const status = await put("/upload/" + encodePath((dir ? dir + "/" : "") + name), file,
      (f) => l.progress(name, f));
    if (status === 201 || status === 204) {
      saved++;
      l.set("saved", "", "ok");
      l.t.textContent = "";
      const a = document.createElement("a");
      a.href = "/read.html#" + encodePath("/" + (dir ? dir + "/" : "") + name);
      a.textContent = where;
      l.t.append(a, document.createTextNode("  " + human(file.size)));
    } else {
      fail(REASONS[status] || "upload failed (HTTP " + status + ")");
    }
  }

  function take(files) {
    const list = [...files];
    if (!list.length) return;
    busy = busy.then(async () => {
      for (const f of list) await upload(f);
      line("done", `${saved} saved, ${failed} failed`, "muted");
    });
  }

  $("file").addEventListener("change", (e) => { take(e.target.files); e.target.value = ""; });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); take(e.dataTransfer.files); });
  // Dropping anywhere on the page should not open the file in the browser
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); if (!drop.contains(e.target)) take(e.dataTransfer.files); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") location.href = $("back").href; });
})();
