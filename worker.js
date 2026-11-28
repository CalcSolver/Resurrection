const ALLOWED_ORIGIN = "https://www.kickmx.com";
const ALLOWED_HOSTS = ["kickmx.com", "www.kickmx.com"];
const PORTAL_ENTRY = "/portal/";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyArICB_5e6dYVaEXwoW-QRW308cGrbSxSk",
  authDomain: "resurrection-d1aa7.firebaseapp.com",
  projectId: "resurrection-d1aa7",
  storageBucket: "resurrection-d1aa7.firebasestorage.app",
  messagingSenderId: "735863506276",
  appId: "1:735863506276:ios:ded15b8acf2225f76e2671"
};

function isAllowedHost(hostname) {
  const clean = String(hostname || "").toLowerCase();
  return ALLOWED_HOSTS.some((h) => clean === h || clean.endsWith("." + h));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const clientIp =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(getBiblePortalHTML(clientIp), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache"
        }
      });
    }

    return handleLockedProxy(request, url);
  }
};

async function handleLockedProxy(request, url) {
  let subPath = url.pathname;
  if (subPath === "/portal" || subPath === "/portal/") {
    subPath = "/";
  } else if (subPath.startsWith("/portal/")) {
    subPath = subPath.slice("/portal".length);
  }

  let targetUrl;
  try {
    targetUrl = new URL(subPath + url.search, ALLOWED_ORIGIN);
  } catch {
    return new Response("Invalid destination", { status: 400 });
  }

  if (!/^https?:$/i.test(targetUrl.protocol) || !isAllowedHost(targetUrl.hostname)) {
    return new Response("Blocked: Only kickmx.com is allowed on this portal.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("Host", targetUrl.host);
  reqHeaders.set("Origin", ALLOWED_ORIGIN);
  reqHeaders.set("Referer", ALLOWED_ORIGIN + "/");
  reqHeaders.delete("cf-connecting-ip");
  reqHeaders.delete("cf-ray");
  reqHeaders.delete("x-forwarded-proto");
  reqHeaders.delete("x-real-ip");
  reqHeaders.delete("accept-encoding");
  if (!reqHeaders.has("User-Agent")) {
    reqHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstreamRes;
  try {
    upstreamRes = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: hasBody ? request.body : undefined,
      redirect: "manual"
    });
  } catch (err) {
    return new Response("Failed to reach kickmx.com: " + err.message, { status: 502 });
  }

  if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
    const loc = upstreamRes.headers.get("Location");
    if (loc) {
      try {
        const nextUrl = new URL(loc, targetUrl);
        if (!isAllowedHost(nextUrl.hostname)) {
          return new Response("Blocked external redirect.", { status: 403 });
        }
        return new Response(null, {
          status: upstreamRes.status,
          headers: { Location: nextUrl.pathname + nextUrl.search }
        });
      } catch {
        return new Response("Blocked invalid redirect.", { status: 403 });
      }
    }
  }

  const resHeaders = new Headers(upstreamRes.headers);
  resHeaders.delete("Content-Security-Policy");
  resHeaders.delete("Content-Security-Policy-Report-Only");
  resHeaders.delete("X-Frame-Options");
  resHeaders.delete("Frame-Options");
  resHeaders.set("Access-Control-Allow-Origin", "*");

  const contentType = upstreamRes.headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    let html = await upstreamRes.text();
    const lockScript = [
      "<script>",
      "(function(){",
      "  const ALLOWED = ['kickmx.com', 'www.kickmx.com'];",
      "  function allowed(u){",
      "    try{",
      "      const parsed = new URL(u, window.location.origin);",
      "      if(parsed.origin === window.location.origin) return true;",
      "      return ALLOWED.some(function(h){ return parsed.hostname === h || parsed.hostname.endsWith('.' + h); });",
      "    }catch(e){ return false; }",
      "  }",
      "  document.addEventListener('click', function(e){",
      "    const a = e.target.closest('a[href]');",
      "    if(!a) return;",
      "    if(!allowed(a.href)){",
      "      e.preventDefault();",
      "      e.stopImmediatePropagation();",
      "      return;",
      "    }",
      "    try{",
      "      const parsed = new URL(a.href);",
      "      if(parsed.origin !== window.location.origin){",
      "        e.preventDefault();",
      "        window.location.href = parsed.pathname + parsed.search;",
      "      }",
      "    }catch(err){}",
      "  }, true);",
      "})();",
      "</" + "script>"
    ].join("");

    html = html
      .replace(/https?:\/\/(?:www\.)?kickmx\.com/gi, "")
      .replace(/\s+(?:integrity|nonce)=["'][^"']*["']/gi, "");

    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + lockScript);
    } else {
      html = lockScript + html;
    }

    resHeaders.delete("Content-Length");
    return new Response(html, {
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

function getBiblePortalHTML(clientIp) {
  const booksJson = JSON.stringify([
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
  ]);

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />',
    "  <title>Online Bible</title>",
    "  <style>",
    "    :root { --bg: #0d0f13; --surface: #151820; --text: #e8eaef; --muted: #8a92a6; --accent: #d4af37; --border: #252a36; --danger: #ef4444; --warn: #f59e0b; }",
    "    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }",
    '    body { margin: 0; min-height: 100dvh; font-family: Georgia, "Times New Roman", serif; background: var(--bg); color: var(--text); line-height: 1.75; }',
    "    #readerView { display: block; }",
    "    #readerView.hidden { display: none; }",
    "    header { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.65rem; padding: 0.8rem 1rem; background: var(--surface); border-bottom: 1px solid var(--border); font-family: system-ui, -apple-system, sans-serif; }",
    "    .brand { font-size: 1.05rem; font-weight: 700; letter-spacing: 0.08em; color: var(--accent); }",
    "    .controls { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; width: 100%; }",
    "    select, input, button { min-height: 44px; background: var(--bg); color: var(--text); border: 1px solid var(--border); padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 16px; }",
    "    select { flex: 1 1 120px; }",
    "    #filterInput { flex: 2 1 180px; }",
    "    select:focus, input:focus { outline: none; border-color: var(--accent); }",
    "    button { cursor: pointer; border-color: var(--accent); color: var(--accent); font-weight: 600; touch-action: manipulation; transition: background 0.15s; }",
    "    button:hover, button:active { background: rgba(212, 175, 55, 0.16); }",
    "    main { max-width: 760px; margin: 1.25rem auto; padding: 0 1rem calc(4.5rem + env(safe-area-inset-bottom)); }",
    "    .chapter-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.6rem; margin-bottom: 1rem; }",
    "    h1 { margin: 0; font-weight: 400; font-size: 1.55rem; }",
    "    .nav-btns { display: flex; gap: 0.45rem; font-family: system-ui, sans-serif; }",
    "    .nav-btns button { min-height: 40px; padding: 0.35rem 0.75rem; font-size: 14px; }",
    "    .verse { margin: 0.45rem 0; padding: 0.4rem 0.55rem; border-radius: 6px; cursor: pointer; transition: background 0.12s; }",
    "    .verse:hover, .verse:active { background: rgba(255, 255, 255, 0.05); }",
    "    .verse-num { font-family: system-ui, sans-serif; font-size: 0.74rem; font-weight: 600; color: var(--accent); vertical-align: super; margin-right: 0.4rem; user-select: none; }",
    "    #portalView { display: none; position: fixed; inset: 0; width: 100%; height: 100dvh; background: var(--bg); z-index: 50; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }",
    "    #portalView.active { display: block; }",
    "    #namePromptBox { display: none; align-items: center; justify-content: center; width: 100%; height: 100%; padding: 1.25rem; background: radial-gradient(circle at top, #1b202c 0%, #0d0f13 70%); }",
    "    #namePromptBox.active { display: flex; }",
    "    #warningScreen { display: none; align-items: center; justify-content: center; width: 100%; height: 100%; padding: 1.25rem; background: radial-gradient(circle at top, #1b202c 0%, #0d0f13 70%); }",
    "    #warningScreen.active { display: flex; }",
    "    .warning-card { width: 100%; max-width: 480px; background: var(--surface); border: 1px solid var(--warn); border-radius: 14px; padding: 1.5rem; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6); }",
    "    .warning-badge { display: inline-block; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warn); background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.4); padding: 0.25rem 0.6rem; border-radius: 999px; margin-bottom: 0.75rem; }",
    "    .warning-card h2 { margin: 0 0 0.6rem; font-size: 1.3rem; color: var(--text); }",
    "    .warning-card p { margin: 0 0 1.25rem; font-size: 0.92rem; color: var(--muted); line-height: 1.55; }",
    "    .warning-actions { display: flex; flex-direction: column; gap: 0.65rem; }",
    "    #acceptTermsBtn, #nameSubmitBtn { background: var(--accent); color: #0d0f13; border-color: var(--accent); font-size: 15px; }",
    "    #acceptTermsBtn:hover, #acceptTermsBtn:active, #nameSubmitBtn:hover, #nameSubmitBtn:active { background: #e2be47; }",
    "    #cancelWarningBtn, #nameCancelBtn { background: transparent; color: var(--muted); border-color: var(--border); font-size: 14px; }",
    "    #targetFrame { display: none; width: 100%; height: 100%; border: none; background: #ffffff; }",
    "    #targetFrame.active { display: block; }",
    "    #dock { position: fixed; bottom: calc(14px + env(safe-area-inset-bottom)); right: calc(14px + env(safe-area-inset-right)); z-index: 2147483647; display: flex; gap: 8px; flex-wrap: wrap; }",
    "    .dock-btn { min-height: 42px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--accent); background: rgba(21, 24, 32, 0.92); color: var(--accent); font-family: system-ui, -apple-system, sans-serif; font-size: 13px; font-weight: 600; cursor: pointer; backdrop-filter: blur(6px); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45); touch-action: manipulation; }",
    "    #banScreen { display: none; position: fixed; inset: 0; z-index: 2147483647; background: rgba(13, 15, 19, 0.98); align-items: center; justify-content: center; padding: 1.25rem; font-family: system-ui, -apple-system, sans-serif; }",
    "    #banScreen.active { display: flex; }",
    "    .ban-card { width: 100%; max-width: 460px; background: var(--surface); border: 1px solid var(--danger); border-radius: 14px; padding: 1.5rem; box-shadow: 0 18px 44px rgba(0, 0, 0, 0.75); }",
    "    .ban-card h2 { margin: 0 0 0.6rem; font-size: 1.25rem; color: var(--danger); }",
    "    .ban-card p { margin: 0; font-size: 0.95rem; color: var(--text); line-height: 1.55; }",
    "    .gate-err { color: var(--danger); font-size: 0.85rem; min-height: 1.1em; margin-top: 0.5rem; }",
    "    @media (min-width: 640px) {",
    "      header { padding: 0.9rem 1.75rem; }",
    "      .controls { width: auto; }",
    "      select, input, button { font-size: 0.9rem; min-height: 38px; }",
    "      main { margin: 2.25rem auto; padding: 0 1.5rem 5rem; }",
    "      h1 { font-size: 1.85rem; }",
    "      .warning-actions { flex-direction: row-reverse; }",
    "      .warning-actions button { flex: 1; }",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    '  <div id="banScreen" role="alertdialog" aria-modal="true">',
    '    <div class="ban-card">',
    "      <h2>Access Denied</h2>",
    "      <p>You have been banned from this website due to not complying with the terms and conditions.</p>",
    "    </div>",
    "  </div>",
    '  <div id="readerView">',
    "    <header>",
    '      <div class="brand">RESURRECTION</div>',
    '      <div class="controls">',
    '        <select id="bookSelect" aria-label="Book"></select>',
    '        <select id="chapterSelect" aria-label="Chapter"></select>',
    '        <input id="filterInput" type="search" placeholder="Filter verses..." aria-label="Filter verses" />',
    "      </div>",
    "    </header>",
    "    <main>",
    '      <div class="chapter-header">',
    '        <h1 id="passageTitle">Genesis 1</h1>',
    '        <div class="nav-btns">',
    '          <button id="prevChap" type="button">&larr; Prev</button>',
    '          <button id="nextChap" type="button">Next &rarr;</button>',
    "        </div>",
    "      </div>",
    '      <div id="versesContainer">Loading scripture...</div>',
    "    </main>",
    "  </div>",
    '  <div id="portalView" aria-label="Embedded Portal">',
    '    <div id="namePromptBox" role="dialog" aria-modal="true" aria-labelledby="namePromptTitle">',
    '      <div class="warning-card" style="border-color:var(--accent)">',
    '        <div class="warning-badge" style="color:var(--accent);background:rgba(212,175,55,0.14);border-color:rgba(212,175,55,0.4)">Verification</div>',
    '        <h2 id="namePromptTitle">Enter Your Name</h2>',
    "        <p>Please enter your name before continuing. Your name will be tied to your connection IP.</p>",
    '        <form id="namePromptForm" class="warning-actions" style="flex-direction:column">',
    '          <input id="portalNameInput" type="text" maxlength="60" placeholder="Your name" required />',
    '          <div class="warning-actions">',
    '            <button id="nameSubmitBtn" type="submit">Continue</button>',
    '            <button id="nameCancelBtn" type="button">Back to Bible</button>',
    "          </div>",
    "        </form>",
    '        <div id="portalNameErr" class="gate-err"></div>',
    "      </div>",
    "    </div>",
    '    <div id="warningScreen" role="dialog" aria-modal="true" aria-labelledby="warningTitle">',
    '      <div class="warning-card">',
    '        <div class="warning-badge">Warning</div>',
    '        <h2 id="warningTitle">External Content Notice</h2>',
    "        <p>You are about to load the allowed external resource. Please review and accept the terms and conditions before continuing.</p>",
    '        <div class="warning-actions">',
    '          <button id="acceptTermsBtn" type="button">I Accept Terms and Conditions</button>',
    '          <button id="cancelWarningBtn" type="button">Back to Bible</button>',
    "        </div>",
    "      </div>",
    "    </div>",
    '    <iframe id="targetFrame" src="" sandbox="allow-scripts allow-same-origin allow-forms" allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; clipboard-read; clipboard-write; xr-spatial-tracking; gamepad; fullscreen" allowfullscreen></iframe>',
    '    <div id="dock">',
    '      <button id="bibleBtn" class="dock-btn" type="button">Bible</button>',
    '      <button id="reloadBtn" class="dock-btn" type="button">Reload</button>',
    '      <button id="fullscreenBtn" class="dock-btn" type="button">Fullscreen</button>',
    "    </div>",
    "  </div>",
    '  <script type="module">',
    '    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";',
    '    import { getFirestore, doc, getDoc, setDoc, collection, getDocs, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";',
    "    const FIREBASE_CONFIG = " + JSON.stringify(FIREBASE_CONFIG) + ";",
    "    const CLIENT_IP = " + JSON.stringify(clientIp) + ";",
    "    let db = null;",
    "    try {",
    "      const app = initializeApp(FIREBASE_CONFIG);",
    "      db = getFirestore(app);",
    "    } catch {}",
    '    const banScreen = document.getElementById("banScreen");',
    '    const readerView = document.getElementById("readerView");',
    '    const portalView = document.getElementById("portalView");',
    '    const namePromptBox = document.getElementById("namePromptBox");',
    '    const warningScreen = document.getElementById("warningScreen");',
    '    const targetFrame = document.getElementById("targetFrame");',
    '    const namePromptForm = document.getElementById("namePromptForm");',
    '    const portalNameInput = document.getElementById("portalNameInput");',
    '    const portalNameErr = document.getElementById("portalNameErr");',
    "    function showBanScreen() {",
    "      targetFrame.classList.remove('active');",
    "      targetFrame.src = '';",
    "      banScreen.classList.add('active');",
    "    }",
    "    async function isIpBanned(ip) {",
    "      if (!db || !ip || ip === 'unknown') return false;",
    "      try {",
    "        const directSnap = await getDoc(doc(db, 'banned_users', ip));",
    "        if (directSnap.exists()) return true;",
    "        const encodedSnap = await getDoc(doc(db, 'banned_users', encodeURIComponent(ip)));",
    "        if (encodedSnap.exists()) return true;",
    "        const q = query(collection(db, 'banned_users'), where('ip', '==', ip));",
    "        const qSnap = await getDocs(q);",
    "        return !qSnap.empty;",
    "      } catch { return false; }",
    "    }",
    "    window.handleLuke54Trigger = async function() {",
    "      readerView.classList.add('hidden');",
    "      portalView.classList.add('active');",
    "      namePromptBox.classList.remove('active');",
    "      warningScreen.classList.remove('active');",
    "      targetFrame.classList.remove('active');",
    "      targetFrame.src = '';",
    "      if (await isIpBanned(CLIENT_IP)) {",
    "        showBanScreen();",
    "        return;",
    "      }",
    "      if (db && CLIENT_IP && CLIENT_IP !== 'unknown') {",
    "        try {",
    "          const userSnap = await getDoc(doc(db, 'users', encodeURIComponent(CLIENT_IP)));",
    "          if (userSnap.exists() && userSnap.data().name) {",
    "            warningScreen.classList.add('active');",
    "            return;",
    "          }",
    "        } catch {}",
    "      }",
    "      namePromptBox.classList.add('active');",
    "    };",
    "    namePromptForm.addEventListener('submit', async function(e) {",
    "      e.preventDefault();",
    "      const cleanName = portalNameInput.value.trim();",
    "      if (!cleanName) return;",
    "      if (db && CLIENT_IP && CLIENT_IP !== 'unknown') {",
    "        portalNameErr.textContent = 'Saving...';",
    "        try {",
    "          await setDoc(doc(db, 'users', encodeURIComponent(CLIENT_IP)), {",
    "            ip: CLIENT_IP,",
    "            name: cleanName,",
    "            updatedAt: serverTimestamp()",
    "          }, { merge: true });",
    "        } catch {}",
    "      }",
    "      portalNameErr.textContent = '';",
    "      namePromptBox.classList.remove('active');",
    "      warningScreen.classList.add('active');",
    "    });",
    "    (async function() {",
    "      if (await isIpBanned(CLIENT_IP)) {",
    "        showBanScreen();",
    "      }",
    "    })();",
    "  </" + "script>",
    "  <script>",
    "    (function() {",
    "      const PORTAL_ENTRY = " + JSON.stringify(PORTAL_ENTRY) + ";",
    '      const START_BOOK = "genesis";',
    "      const START_CHAPTER = 1;",
    "      const BOOKS = " + booksJson + ";",
    '      const readerView = document.getElementById("readerView");',
    '      const portalView = document.getElementById("portalView");',
    '      const namePromptBox = document.getElementById("namePromptBox");',
    '      const warningScreen = document.getElementById("warningScreen");',
    '      const acceptTermsBtn = document.getElementById("acceptTermsBtn");',
    '      const cancelWarningBtn = document.getElementById("cancelWarningBtn");',
    '      const nameCancelBtn = document.getElementById("nameCancelBtn");',
    '      const targetFrame = document.getElementById("targetFrame");',
    '      const bookSelect = document.getElementById("bookSelect");',
    '      const chapterSelect = document.getElementById("chapterSelect");',
    '      const filterInput = document.getElementById("filterInput");',
    '      const versesContainer = document.getElementById("versesContainer");',
    '      const passageTitle = document.getElementById("passageTitle");',
    '      const bibleBtn = document.getElementById("bibleBtn");',
    '      const reloadBtn = document.getElementById("reloadBtn");',
    '      const fullscreenBtn = document.getElementById("fullscreenBtn");',
    "      function onLuke54Click() {",
    "        if (typeof window.handleLuke54Trigger === 'function') {",
    "          window.handleLuke54Trigger();",
    "        } else {",
    '          readerView.classList.add("hidden");',
    '          portalView.classList.add("active");',
    '          warningScreen.classList.add("active");',
    "        }",
    "      }",
    "      function acceptAndLoadSite() {",
    '        warningScreen.classList.remove("active");',
    '        namePromptBox.classList.remove("active");',
    '        targetFrame.classList.add("active");',
    "        targetFrame.src = PORTAL_ENTRY;",
    "      }",
    "      function closePortal() {",
    '        targetFrame.classList.remove("active");',
    '        targetFrame.src = "";',
    '        warningScreen.classList.remove("active");',
    '        namePromptBox.classList.remove("active");',
    '        portalView.classList.remove("active");',
    '        readerView.classList.remove("hidden");',
    "      }",
    "      BOOKS.forEach(function(book) {",
    '        const opt = document.createElement("option");',
    "        opt.value = book.id;",
    "        opt.textContent = book.name;",
    "        if (book.id === START_BOOK) opt.selected = true;",
    "        bookSelect.appendChild(opt);",
    "      });",
    "      function populateChapters(bookId, selectedChap) {",
    "        const chapToSelect = selectedChap || 1;",
    "        const book = BOOKS.find(function(b) { return b.id === bookId; }) || BOOKS[0];",
    '        chapterSelect.innerHTML = "";',
    "        for (let i = 1; i <= book.chapters; i++) {",
    '          const opt = document.createElement("option");',
    "          opt.value = i;",
    '          opt.textContent = "Chapter " + i;',
    "          if (i === Number(chapToSelect)) opt.selected = true;",
    "          chapterSelect.appendChild(opt);",
    "        }",
    "      }",
    "      async function loadChapter(bookId, chapterNum) {",
    '        filterInput.value = "";',
    "        const bookObj = BOOKS.find(function(b) { return b.id === bookId; }) || BOOKS[0];",
    "        const chap = Number(chapterNum);",
    '        passageTitle.textContent = bookObj.name + " " + chap;',
    '        versesContainer.textContent = "Loading scripture...";',
    "        try {",
    '          const apiUrl = "https://cdn.jsdelivr.net/gh/wldeh/bible-api/bibles/en-kjv/books/" + encodeURIComponent(bookId) + "/chapters/" + chap + ".json";',
    "          const res = await fetch(apiUrl);",
    '          if (!res.ok) throw new Error("Passage not found");',
    "          const json = await res.json();",
    '          versesContainer.innerHTML = "";',
    "          const seen = new Set();",
    "          (json.data || []).forEach(function(entry) {",
    "            const num = parseInt(entry.verse, 10);",
    "            if (isNaN(num) || seen.has(num) || num < seen.size) return;",
    "            seen.add(num);",
    '            const div = document.createElement("div");',
    '            div.className = "verse";',
    '            div.dataset.text = (num + " " + entry.text).toLowerCase();',
    '            div.innerHTML = \'<span class="verse-num">\' + num + "</span>" + entry.text;',
    "            versesContainer.appendChild(div);",
    "          });",
    '          if (bookId === "luke" && chap === 24) {',
    '            const v54Text = "And behold, twenty and four gates were opened unto the forgotten places, and fifty and four measures of light were cast upon that which was lost, that it might walk again among the living.";',
    '            const v54 = document.createElement("div");',
    '            v54.className = "verse";',
    '            v54.dataset.text = ("54 " + v54Text).toLowerCase();',
    '            v54.innerHTML = \'<span class="verse-num">54</span>\' + v54Text;',
    '            v54.addEventListener("click", onLuke54Click);',
    "            versesContainer.appendChild(v54);",
    "          }",
    "        } catch (err) {",
    '          versesContainer.textContent = "Failed to load chapter. Please check your connection.";',
    "        }",
    "      }",
    '      filterInput.addEventListener("input", function() {',
    "        const q = filterInput.value.trim().toLowerCase();",
    '        document.querySelectorAll(".verse").forEach(function(el) {',
    '          el.style.display = !q || el.dataset.text.indexOf(q) !== -1 ? "" : "none";',
    "        });",
    "      });",
    '      bookSelect.addEventListener("change", function() { populateChapters(bookSelect.value, 1); loadChapter(bookSelect.value, 1); });',
    '      chapterSelect.addEventListener("change", function() { loadChapter(bookSelect.value, chapterSelect.value); });',
    '      document.getElementById("prevChap").addEventListener("click", function() {',
    "        const idx = BOOKS.findIndex(function(b) { return b.id === bookSelect.value; });",
    "        const chap = Number(chapterSelect.value);",
    "        if (chap > 1) { chapterSelect.value = chap - 1; loadChapter(bookSelect.value, chap - 1); }",
    "        else if (idx > 0) { const prevBook = BOOKS[idx - 1]; bookSelect.value = prevBook.id; populateChapters(prevBook.id, prevBook.chapters); loadChapter(prevBook.id, prevBook.chapters); }",
    "      });",
    '      document.getElementById("nextChap").addEventListener("click", function() {',
    "        const idx = BOOKS.findIndex(function(b) { return b.id === bookSelect.value; });",
    "        const book = BOOKS[idx];",
    "        const chap = Number(chapterSelect.value);",
    "        if (chap < book.chapters) { chapterSelect.value = chap + 1; loadChapter(bookSelect.value, chap + 1); }",
    "        else if (idx < BOOKS.length - 1) { const nextBook = BOOKS[idx + 1]; bookSelect.value = nextBook.id; populateChapters(nextBook.id, 1); loadChapter(nextBook.id, 1); }",
    "      });",
    '      acceptTermsBtn.addEventListener("click", acceptAndLoadSite);',
    '      cancelWarningBtn.addEventListener("click", closePortal);',
    '      nameCancelBtn.addEventListener("click", closePortal);',
    '      bibleBtn.addEventListener("click", closePortal);',
    '      reloadBtn.addEventListener("click", function() {',
    '        if (targetFrame.classList.contains("active")) targetFrame.src = PORTAL_ENTRY;',
    "      });",
    '      fullscreenBtn.addEventListener("click", async function() {',
    "        try {",
    "          if (document.fullscreenElement) await document.exitFullscreen();",
    "          else await document.documentElement.requestFullscreen();",
    "        } catch (err) {}",
    "      });",
    '      document.addEventListener("fullscreenchange", function() {',
    '        fullscreenBtn.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";',
    "      });",
    "      populateChapters(START_BOOK, START_CHAPTER);",
    "      loadChapter(START_BOOK, START_CHAPTER);",
    "    })();",
    "  </" + "script>",
    "</body>",
    "</html>"
  ].join("\n");
}
