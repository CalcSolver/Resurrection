const PROXY_PREFIX = "/24/54/";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(getBibleHTML(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        }
      });
    }

    if (url.pathname.startsWith(PROXY_PREFIX)) {
      return handleProxy(request, url);
    }

    return new Response("Not found", { status: 404 });
  }
};

function encodeTargetUrl(rawUrl) {
  const bytes = new TextEncoder().encode(rawUrl);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeTargetUrl(encoded) {
  if (!encoded) return null;
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function toProxyUrl(targetUrl, baseUrl) {
  try {
    const resolved = new URL(targetUrl, baseUrl).toString();
    if (!/^https?:\/\//i.test(resolved)) return targetUrl;
    return PROXY_PREFIX + encodeURIComponent(encodeTargetUrl(resolved));
  } catch {
    return targetUrl;
  }
}

function resolveUpstreamTarget(request, url) {
  const rest = url.pathname.slice(PROXY_PREFIX.length);

  // Direct encoded target: /24/54/<base64url>
  if (rest && !rest.includes("/")) {
    const decoded = decodeTargetUrl(decodeURIComponent(rest));
    if (decoded) {
      const target = new URL(decoded);
      if (url.search) target.search = url.search;
      return target.toString();
    }
  }

  // Sub-path or asset requested under /24/54/...: resolve against Referer's upstream URL
  const referer = request.headers.get("Referer") || "";
  const refUrl = new URL(referer, url.origin);
  if (refUrl.pathname.startsWith(PROXY_PREFIX)) {
    const refRest = refUrl.pathname.slice(PROXY_PREFIX.length).split("/")[0];
    const upstreamBase = decodeTargetUrl(decodeURIComponent(refRest));
    if (upstreamBase) {
      const base = new URL(upstreamBase);
      const cleanSub = rest.replace(/^\/+/, "");
      const combined = new URL(cleanSub || ".", base);
      combined.search = url.search;
      return combined.toString();
    }
  }

  return null;
}

function rewriteHtml(html, upstreamUrl) {
  const injectBar = `
<style id="resurrect-fs-style">
  #resurrect-fs-btn {
    position: fixed;
    bottom: 14px;
    right: 14px;
    z-index: 2147483647;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid #d4af37;
    background: #151820;
    color: #d4af37;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    opacity: 0.85;
  }
  #resurrect-fs-btn:hover { opacity: 1; }
</style>
<script id="resurrect-fs-script">
(function() {
  const prefix = "${PROXY_PREFIX}";
  const base = ${JSON.stringify(upstreamUrl)};

  function wrap(u) {
    try {
      if (!u || u.startsWith("javascript:") || u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("#")) {
        return u;
      }
      const abs = new URL(u, base).toString();
      if (!/^https?:\\/\\//i.test(abs)) return u;
      const bytes = new TextEncoder().encode(abs);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const enc = btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
      return prefix + encodeURIComponent(enc);
    } catch {
      return u;
    }
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (a && a.href) {
      const rawHref = a.getAttribute("href");
      if (rawHref && !rawHref.startsWith("#") && !rawHref.startsWith("javascript:")) {
        e.preventDefault();
        window.location.href = wrap(rawHref);
      }
    }
  }, true);

  const btn = document.createElement("button");
  btn.id = "resurrect-fs-btn";
  btn.type = "button";
  btn.textContent = "Fullscreen";
  btn.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {}
  });
  document.addEventListener("fullscreenchange", () => {
    btn.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
  });

  if (document.body) document.body.appendChild(btn);
  else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(btn));
})();
<\/script>`;

  html = html.replace(/(<a\b[^>]*\bhref=["'])([^"']+)(["'])/gi, (_, p1, href, p3) => {
    if (href.startsWith("#") || href.startsWith("javascript:")) return `${p1}${href}${p3}`;
    return `${p1}${toProxyUrl(href, upstreamUrl)}${p3}`;
  });

  html = html.replace(/(<(?:script|img|link|source)\b[^>]*\b(?:src|href)=["'])([^"']+)(["'])/gi, (_, p1, src, p3) => {
    if (src.startsWith("data:") || src.startsWith("blob:")) return `${p1}${src}${p3}`;
    return `${p1}${toProxyUrl(src, upstreamUrl)}${p3}`;
  });

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, injectBar + "</body>");
  }
  return html + injectBar;
}

async function handleProxy(request, url) {
  const targetUrl = resolveUpstreamTarget(request, url);
  if (!targetUrl) {
    return new Response("Invalid or missing target URL", { status: 400 });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response("Malformed target URL", { status: 400 });
  }

  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("Host", parsedTarget.host);
  reqHeaders.set("Referer", parsedTarget.origin + "/");
  reqHeaders.delete("cf-connecting-ip");
  reqHeaders.delete("cf-ray");
  reqHeaders.delete("x-forwarded-proto");
  reqHeaders.delete("x-real-ip");
  if (!reqHeaders.has("User-Agent")) {
    reqHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstreamRes;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: request.method,
      headers: reqHeaders,
      body: hasBody ? request.body : undefined,
      redirect: "follow"
    });
  } catch (err) {
    return new Response("Upstream fetch failed: " + err.message, { status: 502 });
  }

  const resHeaders = new Headers(upstreamRes.headers);
  resHeaders.delete("Content-Security-Policy");
  resHeaders.delete("Content-Security-Policy-Report-Only");
  resHeaders.delete("X-Frame-Options");
  resHeaders.delete("Frame-Options");
  resHeaders.set("Access-Control-Allow-Origin", "*");

  const contentType = upstreamRes.headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    const rawHtml = await upstreamRes.text();
    const rewritten = rewriteHtml(rawHtml, upstreamRes.url || targetUrl);
    resHeaders.delete("Content-Length");
    return new Response(rewritten, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders
    });
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders
  });
}

function getBibleHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Resurrcction — Scripture & Archive</title>
  <style>
    :root {
      --bg: #0d0f13;
      --surface: #151820;
      --text: #e8eaef;
      --muted: #8a92a6;
      --accent: #d4af37;
      --border: #252a36;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.8;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.9rem 1.75rem;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-family: system-ui, -apple-system, sans-serif;
    }
    .brand {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--accent);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    select, input, button {
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 0.45rem 0.7rem;
      border-radius: 6px;
      font-size: 0.9rem;
    }
    select:focus, input:focus {
      outline: none;
      border-color: var(--accent);
    }
    button {
      cursor: pointer;
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
      transition: background 0.15s;
    }
    button:hover {
      background: rgba(212, 175, 55, 0.14);
    }
    main {
      max-width: 760px;
      margin: 2.25rem auto;
      padding: 0 1.5rem 5rem;
    }
    .chapter-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
      margin-bottom: 1.25rem;
    }
    h1 {
      margin: 0;
      font-weight: 400;
      font-size: 1.85rem;
    }
    .nav-btns {
      display: flex;
      gap: 0.4rem;
      font-family: system-ui, sans-serif;
    }
    .verse {
      margin: 0.55rem 0;
      padding: 0.25rem 0.5rem;
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.12s;
    }
    .verse:hover {
      background: rgba(255, 255, 255, 0.035);
    }
    .verse-num {
      font-family: system-ui, sans-serif;
      font-size: 0.74rem;
      font-weight: 600;
      color: var(--accent);
      vertical-align: super;
      margin-right: 0.4rem;
      user-select: none;
    }
    #gateway {
      display: none;
      margin-top: 2.25rem;
      padding: 1.35rem;
      background: var(--surface);
      border: 1px solid var(--accent);
      border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
    }
    #gateway.active {
      display: block;
    }
    .gateway-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.4rem;
    }
    #gateway-title {
      margin: 0;
      font-size: 0.95rem;
      color: var(--accent);
      font-weight: 600;
    }
    #fullscreenBtn {
      padding: 0.3rem 0.65rem;
      font-size: 0.8rem;
    }
    #gateway-desc {
      margin: 0 0 0.9rem;
      font-size: 0.85rem;
      color: var(--muted);
    }
    .gateway-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .gateway-row input[type="text"] {
      flex: 1;
      min-width: 220px;
    }
    .options-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.65rem;
      font-size: 0.82rem;
      color: var(--muted);
    }
    #status {
      margin-top: 0.65rem;
      font-size: 0.8rem;
      color: var(--accent);
      min-height: 1.1em;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">RESURRCCTION</div>
    <div class="controls">
      <select id="bookSelect" aria-label="Book"></select>
      <select id="chapterSelect" aria-label="Chapter"></select>
      <input id="filterInput" type="search" placeholder="Filter verses..." aria-label="Filter verses" />
    </div>
  </header>

  <main>
    <div class="chapter-header">
      <h1 id="passageTitle">Genesis 1</h1>
      <div class="nav-btns">
        <button id="prevChap" type="button">&larr; Prev</button>
        <button id="nextChap" type="button">Next &rarr;</button>
      </div>
    </div>

    <div id="versesContainer">Loading scripture...</div>

    <section id="gateway" aria-label="Luke 24:54 Gateway">
      <div class="gateway-top">
        <div id="gateway-title">Luke 24:54 — Gateway Open (/24/54/)</div>
        <button id="fullscreenBtn" type="button">Fullscreen</button>
      </div>
      <p id="gateway-desc">Enter a URL to route directly, or enable archive lookup for dead domains.</p>
      <form id="uvForm" class="gateway-row">
        <input id="targetUrl" type="text" placeholder="https://example.com" required />
        <button type="submit">Resurrect</button>
      </form>
      <label class="options-row">
        <input id="useWayback" type="checkbox" />
        Check Wayback Machine snapshot first (for offline/dead sites)
      </label>
      <div id="status"></div>
    </section>
  </main>

  <script>
    const PROXY_PREFIX = "${PROXY_PREFIX}";
    const START_BOOK = "genesis";
    const START_CHAPTER = 1;

    const BOOKS = [
      { id: "genesis", name: "Genesis", chapters: 50 },
      { id: "exodus", name: "Exodus", chapters: 40 },
      { id: "leviticus", name: "Leviticus", chapters: 27 },
      { id: "numbers", name: "Numbers", chapters: 36 },
      { id: "deuteronomy", name: "Deuteronomy", chapters: 34 },
      { id: "joshua", name: "Joshua", chapters: 24 },
      { id: "judges", name: "Judges", chapters: 21 },
      { id: "ruth", name: "Ruth", chapters: 4 },
      { id: "1-samuel", name: "1 Samuel", chapters: 31 },
      { id: "2-samuel", name: "2 Samuel", chapters: 24 },
      { id: "1-kings", name: "1 Kings", chapters: 22 },
      { id: "2-kings", name: "2 Kings", chapters: 25 },
      { id: "1-chronicles", name: "1 Chronicles", chapters: 29 },
      { id: "2-chronicles", name: "2 Chronicles", chapters: 36 },
      { id: "ezra", name: "Ezra", chapters: 10 },
      { id: "nehemiah", name: "Nehemiah", chapters: 13 },
      { id: "esther", name: "Esther", chapters: 10 },
      { id: "job", name: "Job", chapters: 42 },
      { id: "psalms", name: "Psalms", chapters: 150 },
      { id: "proverbs", name: "Proverbs", chapters: 31 },
      { id: "ecclesiastes", name: "Ecclesiastes", chapters: 12 },
      { id: "song-of-solomon", name: "Song of Solomon", chapters: 8 },
      { id: "isaiah", name: "Isaiah", chapters: 66 },
      { id: "jeremiah", name: "Jeremiah", chapters: 52 },
      { id: "lamentations", name: "Lamentations", chapters: 5 },
      { id: "ezekiel", name: "Ezekiel", chapters: 48 },
      { id: "daniel", name: "Daniel", chapters: 12 },
      { id: "hosea", name: "Hosea", chapters: 14 },
      { id: "joel", name: "Joel", chapters: 3 },
      { id: "amos", name: "Amos", chapters: 9 },
      { id: "obadiah", name: "Obadiah", chapters: 1 },
      { id: "jonah", name: "Jonah", chapters: 4 },
      { id: "micah", name: "Micah", chapters: 7 },
      { id: "nahum", name: "Nahum", chapters: 3 },
      { id: "habakkuk", name: "Habakkuk", chapters: 3 },
      { id: "zephaniah", name: "Zephaniah", chapters: 3 },
      { id: "haggai", name: "Haggai", chapters: 2 },
      { id: "zechariah", name: "Zechariah", chapters: 14 },
      { id: "malachi", name: "Malachi", chapters: 4 },
      { id: "matthew", name: "Matthew", chapters: 28 },
      { id: "mark", name: "Mark", chapters: 16 },
      { id: "luke", name: "Luke", chapters: 24 },
      { id: "john", name: "John", chapters: 21 },
      { id: "acts", name: "Acts", chapters: 28 },
      { id: "romans", name: "Romans", chapters: 16 },
      { id: "1-corinthians", name: "1 Corinthians", chapters: 16 },
      { id: "2-corinthians", name: "2 Corinthians", chapters: 13 },
      { id: "galatians", name: "Galatians", chapters: 6 },
      { id: "ephesians", name: "Ephesians", chapters: 6 },
      { id: "philippians", name: "Philippians", chapters: 4 },
      { id: "colossians", name: "Colossians", chapters: 4 },
      { id: "1-thessalonians", name: "1 Thessalonians", chapters: 5 },
      { id: "2-thessalonians", name: "2 Thessalonians", chapters: 3 },
      { id: "1-timothy", name: "1 Timothy", chapters: 6 },
      { id: "2-timothy", name: "2 Timothy", chapters: 4 },
      { id: "titus", name: "Titus", chapters: 3 },
      { id: "philemon", name: "Philemon", chapters: 1 },
      { id: "hebrews", name: "Hebrews", chapters: 13 },
      { id: "james", name: "James", chapters: 5 },
      { id: "1-peter", name: "1 Peter", chapters: 5 },
      { id: "2-peter", name: "2 Peter", chapters: 3 },
      { id: "1-john", name: "1 John", chapters: 5 },
      { id: "2-john", name: "2 John", chapters: 1 },
      { id: "3-john", name: "3 John", chapters: 1 },
      { id: "jude", name: "Jude", chapters: 1 },
      { id: "revelation", name: "Revelation", chapters: 22 }
    ];

    const bookSelect = document.getElementById("bookSelect");
    const chapterSelect = document.getElementById("chapterSelect");
    const filterInput = document.getElementById("filterInput");
    const versesContainer = document.getElementById("versesContainer");
    const passageTitle = document.getElementById("passageTitle");
    const gateway = document.getElementById("gateway");
    const statusEl = document.getElementById("status");
    const fullscreenBtn = document.getElementById("fullscreenBtn");

    let step24Armed = false;

    BOOKS.forEach(book => {
      const opt = document.createElement("option");
      opt.value = book.id;
      opt.textContent = book.name;
      if (book.id === START_BOOK) opt.selected = true;
      bookSelect.appendChild(opt);
    });

    function populateChapters(bookId, selectedChap = 1) {
      const book = BOOKS.find(b => b.id === bookId) || BOOKS[0];
      chapterSelect.innerHTML = "";
      for (let i = 1; i <= book.chapters; i++) {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = \`Chapter \${i}\`;
        if (i === Number(selectedChap)) opt.selected = true;
        chapterSelect.appendChild(opt);
      }
    }

    async function loadChapter(bookId, chapterNum) {
      step24Armed = false;
      gateway.classList.remove("active");
      filterInput.value = "";

      const bookObj = BOOKS.find(b => b.id === bookId) || BOOKS[0];
      const chap = Number(chapterNum);
      passageTitle.textContent = \`\${bookObj.name} \${chap}\`;
      versesContainer.textContent = "Loading scripture...";

      try {
        const apiUrl = \`https://cdn.jsdelivr.net/gh/wldeh/bible-api/bibles/en-kjv/books/\${bookId}/chapters/\${chap}.json\`;
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error("Passage not found");
        const json = await res.json();

        versesContainer.innerHTML = "";
        const seen = new Set();

        (json.data || []).forEach(entry => {
          const num = parseInt(entry.verse, 10);
          if (isNaN(num) || seen.has(num) || num < seen.size) return;
          seen.add(num);

          const div = document.createElement("div");
          div.className = "verse";
          div.dataset.text = \`\${num} \${entry.text}\`.toLowerCase();
          div.innerHTML = \`<span class="verse-num">\${num}</span>\${entry.text}\`;

          if (bookId === "luke" && chap === 24 && num === 24) {
            div.addEventListener("click", () => {
              step24Armed = true;
            });
          }

          versesContainer.appendChild(div);
        });

        if (bookId === "luke" && chap === 24) {
          const v54Text = "And behold, twenty and four gates were opened unto the forgotten places, and fifty and four measures of light were cast upon that which was lost, that it might walk again among the living.";
          const v54 = document.createElement("div");
          v54.className = "verse";
          v54.dataset.text = \`54 \${v54Text}\`.toLowerCase();
          v54.innerHTML = \`<span class="verse-num">54</span>\${v54Text}\`;

          v54.addEventListener("click", () => {
            if (!step24Armed) return;
            gateway.classList.add("active");
            gateway.scrollIntoView({ behavior: "smooth", block: "nearest" });
            statusEl.textContent = "Gateway ready on " + PROXY_PREFIX;
          });

          versesContainer.appendChild(v54);
        }
      } catch {
        versesContainer.textContent = "Failed to load chapter. Please check your connection.";
      }
    }

    function encodeUrl(rawUrl) {
      const bytes = new TextEncoder().encode(rawUrl);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    async function resolveWaybackUrl(targetUrl) {
      statusEl.textContent = "Searching Wayback Machine archives...";
      const api = \`https://archive.org/wayback/available?url=\${encodeURIComponent(targetUrl)}\`;
      const res = await fetch(api);
      const data = await res.json();
      const closest = data?.archived_snapshots?.closest;
      if (closest && closest.available && closest.url) {
        return closest.url.replace(/^http:\/\//i, "https://");
      }
      return null;
    }

    filterInput.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      document.querySelectorAll(".verse").forEach(el => {
        el.style.display = !q || el.dataset.text.includes(q) ? "" : "none";
      });
    });

    bookSelect.addEventListener("change", () => {
      populateChapters(bookSelect.value, 1);
      loadChapter(bookSelect.value, 1);
    });

    chapterSelect.addEventListener("change", () => {
      loadChapter(bookSelect.value, chapterSelect.value);
    });

    document.getElementById("prevChap").addEventListener("click", () => {
      const idx = BOOKS.findIndex(b => b.id === bookSelect.value);
      const chap = Number(chapterSelect.value);
      if (chap > 1) {
        chapterSelect.value = chap - 1;
        loadChapter(bookSelect.value, chap - 1);
      } else if (idx > 0) {
        const prevBook = BOOKS[idx - 1];
        bookSelect.value = prevBook.id;
        populateChapters(prevBook.id, prevBook.chapters);
        loadChapter(prevBook.id, prevBook.chapters);
      }
    });

    document.getElementById("nextChap").addEventListener("click", () => {
      const idx = BOOKS.findIndex(b => b.id === bookSelect.value);
      const book = BOOKS[idx];
      const chap = Number(chapterSelect.value);
      if (chap < book.chapters) {
        chapterSelect.value = chap + 1;
        loadChapter(book.id, chap + 1);
      } else if (idx < BOOKS.length - 1) {
        const nextBook = BOOKS[idx + 1];
        bookSelect.value = nextBook.id;
        populateChapters(nextBook.id, 1);
        loadChapter(nextBook.id, 1);
      }
    });

    document.getElementById("uvForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      let destination = document.getElementById("targetUrl").value.trim();
      if (!/^https?:\/\//i.test(destination)) {
        destination = "https://" + destination;
      }

      try {
        if (document.getElementById("useWayback").checked) {
          const archived = await resolveWaybackUrl(destination);
          if (archived) {
            destination = archived;
          } else {
            statusEl.textContent = "No archive found; routing live URL...";
          }
        }

        statusEl.textContent = "Routing...";
        window.location.href = PROXY_PREFIX + encodeURIComponent(encodeUrl(destination));
      } catch (err) {
        statusEl.textContent = "Routing error: " + err.message;
      }
    });

    fullscreenBtn.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
      } catch (err) {
        statusEl.textContent = "Fullscreen error: " + err.message;
      }
    });

    document.addEventListener("fullscreenchange", () => {
      fullscreenBtn.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
    });

    populateChapters(START_BOOK, START_CHAPTER);
    loadChapter(START_BOOK, START_CHAPTER);
  </script>
</body>
</html>`;
}
