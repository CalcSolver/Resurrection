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

    // Fallback: if a proxied page's JS made a root-relative request (/api/..., /assets/...),
    // resolve it using the Referer's upstream target so large SPAs don't 404.
    const referer = request.headers.get("Referer") || "";
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.origin === url.origin && refUrl.pathname.startsWith(PROXY_PREFIX)) {
          const refToken = refUrl.pathname.slice(PROXY_PREFIX.length).split("/")[0];
          const upstreamBase = decodeTargetUrl(decodeURIComponent(refToken));
          if (upstreamBase) {
            const resolved = new URL(url.pathname + url.search, upstreamBase).toString();
            return proxyUpstream(request, resolved);
          }
        }
      } catch {}
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
  try {
    let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function toProxyUrl(targetUrl, baseUrl) {
  try {
    if (!targetUrl) return targetUrl;
    const trimmed = targetUrl.trim();
    if (
      trimmed.startsWith("#") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("mailto:") ||
      trimmed.startsWith("tel:") ||
      trimmed.startsWith(PROXY_PREFIX)
    ) {
      return targetUrl;
    }
    const resolved = new URL(trimmed, baseUrl).toString();
    if (!/^https?:\/\//i.test(resolved)) return targetUrl;
    return PROXY_PREFIX + encodeURIComponent(encodeTargetUrl(resolved));
  } catch {
    return targetUrl;
  }
}

function resolveUpstreamTarget(request, url) {
  const rest = url.pathname.slice(PROXY_PREFIX.length);
  const firstSegment = rest.split("/")[0];
  const remainder = rest.slice(firstSegment.length);

  if (firstSegment) {
    const decoded = decodeTargetUrl(decodeURIComponent(firstSegment));
    if (decoded && /^https?:\/\//i.test(decoded)) {
      if (!remainder || remainder === "/") {
        const target = new URL(decoded);
        if (url.search && !target.search) {
          target.search = url.search;
        } else if (url.search && target.search) {
          const extra = new URLSearchParams(url.search);
          extra.forEach((v, k) => {
            if (!target.searchParams.has(k)) target.searchParams.set(k, v);
          });
        }
        return target.toString();
      }
      // Subpath appended after /24/54/<token>/some/path
      const subUrl = new URL(remainder.replace(/^\/+/, ""), decoded);
      if (url.search) subUrl.search = url.search;
      return subUrl.toString();
    }
  }

  // Fallback via Referer
  const referer = request.headers.get("Referer") || "";
  if (referer) {
    try {
      const refUrl = new URL(referer, url.origin);
      if (refUrl.pathname.startsWith(PROXY_PREFIX)) {
        const refToken = refUrl.pathname.slice(PROXY_PREFIX.length).split("/")[0];
        const upstreamBase = decodeTargetUrl(decodeURIComponent(refToken));
        if (upstreamBase) {
          const combined = new URL(rest.replace(/^\/+/, "") || ".", upstreamBase);
          combined.search = url.search;
          return combined.toString();
        }
      }
    } catch {}
  }

  return null;
}

async function resolveServerWayback(targetUrl) {
  try {
    const cdxApi =
      "https://archive.org/wayback/available?url=" + encodeURIComponent(targetUrl);
    const res = await fetch(cdxApi, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const closest = data && data.archived_snapshots && data.archived_snapshots.closest;
    if (closest && closest.available && closest.url) {
      // Use id_ modifier in Wayback URL so it serves raw archived page without archive toolbar JS
      return closest.url
        .replace(/^http:\/\//i, "https://")
        .replace(/\/web\/(\d+)\//, "/web/$1id_/");
    }
  } catch {}
  return null;
}

function rewriteCss(css, upstreamUrl) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (_, quote, assetUrl) {
    const rewritten = toProxyUrl(assetUrl, upstreamUrl);
    return "url(" + quote + rewritten + quote + ")";
  });
}

function rewriteHtml(html, upstreamUrl) {
  const runtimeShim = [
    '<style id="resurrect-ui-style">',
    "#resurrect-dock{position:fixed;bottom:calc(12px + env(safe-area-inset-bottom));right:calc(12px + env(safe-area-inset-right));z-index:2147483647;display:flex;gap:8px;}",
    ".resurrect-pill{min-height:40px;padding:8px 13px;border-radius:999px;border:1px solid #d4af37;background:rgba(21,24,32,0.92);color:#d4af37;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 4px 14px rgba(0,0,0,0.45);touch-action:manipulation;}",
    ".resurrect-pill:active{transform:scale(0.97);}",
    "</style>",
    '<script id="resurrect-runtime-shim">',
    "(function(){",
    "const PREFIX = " + JSON.stringify(PROXY_PREFIX) + ";",
    "const UPSTREAM_BASE = " + JSON.stringify(upstreamUrl) + ";",
    "const WORKER_ORIGIN = window.location.origin;",
    "function encodeB64Url(str){const bytes=new TextEncoder().encode(str);let bin='';for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}",
    "function wrapUrl(u){",
    "  try{",
    "    if(!u||typeof u!=='string')return u;",
    "    const t=u.trim();",
    "    if(!t||t.startsWith('#')||t.startsWith('javascript:')||t.startsWith('data:')||t.startsWith('blob:')||t.startsWith('mailto:')||t.startsWith('tel:'))return u;",
    "    if(t.startsWith(WORKER_ORIGIN+PREFIX)||t.startsWith(PREFIX))return u;",
    "    let abs;",
    "    if(t.startsWith(WORKER_ORIGIN+'/')){abs=new URL(t.slice(WORKER_ORIGIN.length),UPSTREAM_BASE).toString();}",
    "    else{abs=new URL(t,UPSTREAM_BASE).toString();}",
    "    if(!/^https?:\\/\\//i.test(abs))return u;",
    "    return WORKER_ORIGIN+PREFIX+encodeURIComponent(encodeB64Url(abs));",
    "  }catch{return u;}",
    "}",
    // Intercept fetch()
    "const origFetch = window.fetch;",
    "window.fetch = function(input, init){",
    "  try{",
    "    if(typeof input==='string'){input=wrapUrl(input);}",
    "    else if(input instanceof Request){input=new Request(wrapUrl(input.url), input);}",
    "  }catch{}",
    "  return origFetch.call(this, input, init);",
    "};",
    // Intercept XMLHttpRequest
    "const origXhrOpen = XMLHttpRequest.prototype.open;",
    "XMLHttpRequest.prototype.open = function(method, url){",
    "  try{if(typeof url==='string')arguments[1]=wrapUrl(url);}catch{}",
    "  return origXhrOpen.apply(this, arguments);",
    "};",
    // Intercept window.open
    "const origOpen = window.open;",
    "window.open = function(url, target, features){",
    "  if(typeof url==='string'){window.location.href=wrapUrl(url);return null;}",
    "  return origOpen.call(this, url, target, features);",
    "};",
    // Intercept link clicks & form submissions
    "document.addEventListener('click',function(e){",
    "  const a=e.target.closest('a[href]');",
    "  if(!a)return;",
    "  const raw=a.getAttribute('href');",
    "  if(!raw||raw.startsWith('#')||raw.startsWith('javascript:'))return;",
    "  e.preventDefault();",
    "  window.location.href=wrapUrl(raw);",
    "},true);",
    "document.addEventListener('submit',function(e){",
    "  const form=e.target;",
    "  if(!form||form.tagName!=='FORM')return;",
    "  const action=form.getAttribute('action')||UPSTREAM_BASE;",
    "  const method=(form.method||'GET').toUpperCase();",
    "  if(method==='GET'){",
    "    e.preventDefault();",
    "    const target=new URL(action,UPSTREAM_BASE);",
    "    const fd=new FormData(form);",
    "    fd.forEach(function(v,k){if(typeof v==='string')target.searchParams.set(k,v);});",
    "    window.location.href=wrapUrl(target.toString());",
    "  }else{",
    "    form.action=wrapUrl(action);",
    "  }",
    "},true);",
    // Floating Home + Fullscreen controls
    "function mountDock(){",
    "  if(document.getElementById('resurrect-dock'))return;",
    "  const dock=document.createElement('div');dock.id='resurrect-dock';",
    "  const homeBtn=document.createElement('button');homeBtn.type='button';homeBtn.className='resurrect-pill';homeBtn.textContent='Scripture';",
    "  homeBtn.addEventListener('click',function(){window.location.href='/';});",
    "  const fsBtn=document.createElement('button');fsBtn.type='button';fsBtn.className='resurrect-pill';fsBtn.textContent='Fullscreen';",
    "  fsBtn.addEventListener('click',async function(){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{}});",
    "  document.addEventListener('fullscreenchange',function(){fsBtn.textContent=document.fullscreenElement?'Exit Fullscreen':'Fullscreen';});",
    "  dock.appendChild(homeBtn);dock.appendChild(fsBtn);",
    "  document.body.appendChild(dock);",
    "}",
    "if(document.body)mountDock();else document.addEventListener('DOMContentLoaded',mountDock);",
    "})();",
    "</" + "script>"
  ].join("");

  // Strip integrity/crossorigin attributes that block rewritten scripts/styles
  html = html.replace(/\s+(?:integrity|nonce)=["'][^"']*["']/gi, "");

  // Rewrite standard URL attributes (href, src, action, poster, data)
  html = html.replace(
    /(<[a-z0-9-]+\b[^>]*?\b(?:href|src|action|poster|data)=["'])([^"']+)(["'])/gi,
    function (_, prefixAttr, rawVal, suffixAttr) {
      return prefixAttr + toProxyUrl(rawVal, upstreamUrl) + suffixAttr;
    }
  );

  // Rewrite srcset attributes (responsive images)
  html = html.replace(/(\bsrcset=["'])([^"']+)(["'])/gi, function (_, p1, srcsetVal, p3) {
    const rewrittenSet = srcsetVal
      .split(",")
      .map(function (item) {
        const parts = item.trim().split(/\s+/);
        if (!parts[0]) return item;
        parts[0] = toProxyUrl(parts[0], upstreamUrl);
        return parts.join(" ");
      })
      .join(", ");
    return p1 + rewrittenSet + p3;
  });

  // Rewrite inline CSS url(...)
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (_, q, assetUrl) {
    return "url(" + q + toProxyUrl(assetUrl, upstreamUrl) + q + ")";
  });

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, function (match) {
      return match + runtimeShim;
    });
  } else {
    html = runtimeShim + html;
  }

  return html;
}

async function handleProxy(request, url) {
  let targetUrl = resolveUpstreamTarget(request, url);
  if (!targetUrl) {
    return new Response("Invalid or missing target URL", { status: 400 });
  }

  // Server-side Wayback lookup when requested via ?wayback=1
  if (url.searchParams.get("wayback") === "1") {
    const cleanTarget = new URL(targetUrl);
    cleanTarget.searchParams.delete("wayback");
    const archivedUrl = await resolveServerWayback(cleanTarget.toString());
    if (archivedUrl) {
      return Response.redirect(
        url.origin + PROXY_PREFIX + encodeURIComponent(encodeTargetUrl(archivedUrl)),
        302
      );
    }
    targetUrl = cleanTarget.toString();
  }

  return proxyUpstream(request, targetUrl);
}

async function proxyUpstream(request, targetUrl) {
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response("Malformed target URL", { status: 400 });
  }

  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("Host", parsedTarget.host);
  reqHeaders.set("Origin", parsedTarget.origin);
  reqHeaders.set("Referer", parsedTarget.origin + "/");
  reqHeaders.delete("cf-connecting-ip");
  reqHeaders.delete("cf-ray");
  reqHeaders.delete("x-forwarded-proto");
  reqHeaders.delete("x-real-ip");
  reqHeaders.delete("accept-encoding"); // Avoid compressed stream issues during HTML/CSS rewrite

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
      redirect: "manual"
    });
  } catch (err) {
    return new Response("Upstream fetch failed: " + err.message, { status: 502 });
  }

  // Rewrite HTTP redirects (301, 302, 303, 307, 308) so they stay inside /24/54/
  if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
    const location = upstreamRes.headers.get("Location");
    if (location) {
      const nextProxied = toProxyUrl(location, targetUrl);
      const redirHeaders = new Headers(upstreamRes.headers);
      redirHeaders.set("Location", nextProxied);
      redirHeaders.delete("Content-Security-Policy");
      return new Response(null, {
        status: upstreamRes.status,
        headers: redirHeaders
      });
    }
  }

  const resHeaders = new Headers(upstreamRes.headers);
  resHeaders.delete("Content-Security-Policy");
  resHeaders.delete("Content-Security-Policy-Report-Only");
  resHeaders.delete("X-Frame-Options");
  resHeaders.delete("Frame-Options");
  resHeaders.delete("Cross-Origin-Opener-Policy");
  resHeaders.delete("Cross-Origin-Embedder-Policy");
  resHeaders.delete("Cross-Origin-Resource-Policy");
  resHeaders.delete("Strict-Transport-Security");
  resHeaders.set("Access-Control-Allow-Origin", "*");
  resHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  resHeaders.set("Access-Control-Allow-Headers", "*");

  const contentType = upstreamRes.headers.get("Content-Type") || "";
  const finalUpstreamUrl = upstreamRes.url || targetUrl;

  if (contentType.includes("text/html")) {
    const rawHtml = await upstreamRes.text();
    const rewritten = rewriteHtml(rawHtml, finalUpstreamUrl);
    resHeaders.delete("Content-Length");
    return new Response(rewritten, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders
    });
  }

  if (contentType.includes("text/css")) {
    const rawCss = await upstreamRes.text();
    const rewrittenCss = rewriteCss(rawCss, finalUpstreamUrl);
    resHeaders.delete("Content-Length");
    return new Response(rewrittenCss, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders
    });
  }

  // Stream binary/media/JS responses directly without buffering large files in memory
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders
  });
}

function getBibleHTML() {
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
    "  <title>Resurrcction — Scripture & Archive</title>",
    "  <style>",
    "    :root { --bg: #0d0f13; --surface: #151820; --text: #e8eaef; --muted: #8a92a6; --accent: #d4af37; --border: #252a36; }",
    "    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }",
    '    body { margin: 0; min-height: 100dvh; font-family: Georgia, "Times New Roman", serif; background: var(--bg); color: var(--text); line-height: 1.75; }',
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
    "    #gateway { display: none; margin-top: 1.75rem; padding: 1.15rem; background: var(--surface); border: 1px solid var(--accent); border-radius: 10px; font-family: system-ui, -apple-system, sans-serif; }",
    "    #gateway.active { display: block; }",
    "    .gateway-top { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.45rem; }",
    "    #gateway-title { margin: 0; font-size: 0.95rem; color: var(--accent); font-weight: 600; }",
    "    #fullscreenBtn { min-height: 38px; padding: 0.3rem 0.75rem; font-size: 13px; }",
    "    #gateway-desc { margin: 0 0 0.85rem; font-size: 0.85rem; color: var(--muted); }",
    "    .gateway-row { display: flex; flex-direction: column; gap: 0.55rem; }",
    "    .gateway-row input[type='text'] { width: 100%; }",
    "    .gateway-row button { width: 100%; }",
    "    .options-row { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.75rem; font-size: 0.85rem; color: var(--muted); min-height: 36px; cursor: pointer; }",
    "    .options-row input[type='checkbox'] { width: 20px; height: 20px; min-height: 20px; accent-color: var(--accent); }",
    "    #status { margin-top: 0.65rem; font-size: 0.82rem; color: var(--accent); min-height: 1.1em; }",
    "    @media (min-width: 640px) {",
    "      header { padding: 0.9rem 1.75rem; }",
    "      .controls { width: auto; }",
    "      select, input, button { font-size: 0.9rem; min-height: 38px; }",
    "      main { margin: 2.25rem auto; padding: 0 1.5rem 5rem; }",
    "      h1 { font-size: 1.85rem; }",
    "      .gateway-row { flex-direction: row; }",
    "      .gateway-row input[type='text'] { flex: 1; }",
    "      .gateway-row button { width: auto; padding: 0.45rem 1.1rem; }",
    "    }",
    "  </style>",
    "</head>",
    "<body>",
    "  <header>",
    '    <div class="brand">RESURRCCTION</div>',
    '    <div class="controls">',
    '      <select id="bookSelect" aria-label="Book"></select>',
    '      <select id="chapterSelect" aria-label="Chapter"></select>',
    '      <input id="filterInput" type="search" placeholder="Filter verses..." aria-label="Filter verses" />',
    "    </div>",
    "  </header>",
    "  <main>",
    '    <div class="chapter-header">',
    '      <h1 id="passageTitle">Genesis 1</h1>',
    '      <div class="nav-btns">',
    '        <button id="prevChap" type="button">&larr; Prev</button>',
    '        <button id="nextChap" type="button">Next &rarr;</button>',
    "      </div>",
    "    </div>",
    '    <div id="versesContainer">Loading scripture...</div>',
    '    <section id="gateway" aria-label="Luke 24:54 Gateway">',
    '      <div class="gateway-top">',
    '        <div id="gateway-title">Luke 24:54 — Gateway Open (' + PROXY_PREFIX + ")</div>",
    '        <button id="fullscreenBtn" type="button">Fullscreen</button>',
    "      </div>",
    '      <p id="gateway-desc">Enter a URL or search query to route, or enable server-side Wayback archive lookup.</p>',
    '      <form id="uvForm" class="gateway-row">',
    '        <input id="targetUrl" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="https://example.com or search..." required />',
    '        <button type="submit">Resurrect</button>',
    "      </form>",
    '      <label class="options-row"><input id="useWayback" type="checkbox" /> Server-side Wayback Machine snapshot (for dead/offline sites)</label>',
    '      <div id="status"></div>',
    "    </section>",
    "  </main>",
    "  <script>",
    "    (function() {",
    "      const PROXY_PREFIX = " + JSON.stringify(PROXY_PREFIX) + ";",
    '      const START_BOOK = "genesis";',
    "      const START_CHAPTER = 1;",
    "      const BOOKS = " + booksJson + ";",
    '      const bookSelect = document.getElementById("bookSelect");',
    '      const chapterSelect = document.getElementById("chapterSelect");',
    '      const filterInput = document.getElementById("filterInput");',
    '      const versesContainer = document.getElementById("versesContainer");',
    '      const passageTitle = document.getElementById("passageTitle");',
    '      const gateway = document.getElementById("gateway");',
    '      const statusEl = document.getElementById("status");',
    '      const fullscreenBtn = document.getElementById("fullscreenBtn");',
    "      let step24Armed = false;",
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
    "        step24Armed = false;",
    '        gateway.classList.remove("active");',
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
    '            if (bookId === "luke" && chap === 24 && num === 24) {',
    '              div.addEventListener("click", function() { step24Armed = true; });',
    "            }",
    "            versesContainer.appendChild(div);",
    "          });",
    '          if (bookId === "luke" && chap === 24) {',
    '            const v54Text = "And behold, twenty and four gates were opened unto the forgotten places, and fifty and four measures of light were cast upon that which was lost, that it might walk again among the living.";',
    '            const v54 = document.createElement("div");',
    '            v54.className = "verse";',
    '            v54.dataset.text = ("54 " + v54Text).toLowerCase();',
    '            v54.innerHTML = \'<span class="verse-num">54</span>\' + v54Text;',
    '            v54.addEventListener("click", function() {',
    "              if (!step24Armed) return;",
    '              gateway.classList.add("active");',
    '              gateway.scrollIntoView({ behavior: "smooth", block: "nearest" });',
    '              statusEl.textContent = "Gateway ready on " + PROXY_PREFIX;',
    "            });",
    "            versesContainer.appendChild(v54);",
    "          }",
    "        } catch (err) {",
    '          versesContainer.textContent = "Failed to load chapter. Please check your connection.";',
    "        }",
    "      }",
    "      function encodeUrl(rawUrl) {",
    "        const bytes = new TextEncoder().encode(rawUrl);",
    '        let bin = "";',
    "        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);",
    '        return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");',
    "      }",
    "      function normalizeInput(raw) {",
    "        const val = raw.trim();",
    '        if (/^https?:\\/\\//i.test(val)) return val;',
    '        if (/^[a-z0-9-]+(\\.[a-z0-9-]+)+([\\/?#].*)?$/i.test(val)) return "https://" + val;',
    '        return "https://duckduckgo.com/?q=" + encodeURIComponent(val);',
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
    '      document.getElementById("uvForm").addEventListener("submit", function(e) {',
    "        e.preventDefault();",
    '        const raw = document.getElementById("targetUrl").value;',
    "        const destination = normalizeInput(raw);",
    '        const wayback = document.getElementById("useWayback").checked ? "?wayback=1" : "";',
    '        statusEl.textContent = wayback ? "Resolving archive on server..." : "Routing...";',
    "        window.location.href = PROXY_PREFIX + encodeURIComponent(encodeUrl(destination)) + wayback;",
    "      });",
    '      fullscreenBtn.addEventListener("click", async function() {',
    "        try {",
    "          if (document.fullscreenElement) await document.exitFullscreen();",
    "          else await document.documentElement.requestFullscreen();",
    "        } catch (err) {",
    '          statusEl.textContent = "Fullscreen error: " + err.message;',
    "        }",
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
