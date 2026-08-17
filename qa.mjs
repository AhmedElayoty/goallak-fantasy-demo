/* qa.mjs — the LIVE check. check.mjs asks "does the file parse"; this asks "does the built
 * page still work when a thumb lands on it".
 *
 * Every assertion in here exists because a specific bug shipped past every check we had.
 * The through-line of those bugs was that the checks measured the things already known to
 * break, in one language, at one width. So: two languages, five viewports, and the
 * assertions are about REACHABILITY and AGREEMENT, not about geometry and contrast.
 *
 *   node qa.mjs            run everything, exit 1 on any failure
 *   node qa.mjs --verbose  also print every PASS line
 *   node qa.mjs --keep     leave Chrome running (debugging)
 *
 * NO DEPENDENCIES. There is no playwright and no puppeteer installed here, and adding one
 * to gate a commit is a 300MB download nobody will keep. Chrome IS installed, and Node 22+
 * ships a WebSocket client, so this drives Chrome over the DevTools Protocol directly:
 * a ~200-line CDP client, a static file server (the app fetches clubs.json, so file:// is
 * out), and a PNG reader built on node:zlib for the one assertion that has to look at
 * actual pixels. That is the whole toolchain.
 *
 * This file NEVER writes to the app. It only reads the page and pokes it through its own
 * public functions.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
const KEEP = process.argv.includes("--keep");
const DUMP = process.argv.includes("--dump-kits");

/* ============================================================================
   0. RESULTS
   ========================================================================== */
const results = [];
let ctx = "";
const setCtx = s => { ctx = s; };
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || "", ctx });
  if (!pass) console.log("  FAIL  [" + ctx + "] " + name + (detail ? "\n          " + String(detail).split("\n").join("\n          ") : ""));
  else if (VERBOSE) console.log("  pass  [" + ctx + "] " + name + (detail ? "  — " + detail : ""));
}
const notes = [];
function note(s) { notes.push(s); console.log("  note  " + s); }

/* ============================================================================
   1. STATIC SERVER — the app fetches clubs.json/prices.json/calendar.json.
   ========================================================================== */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function startServer(root) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/") p = "/index.html";
      const file = path.join(root, path.normalize(p).replace(/^[\\/]+/, ""));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { "content-type": "text/plain" }); return res.end("404");
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store" });
      res.end(fs.readFileSync(file));
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

/* ============================================================================
   2. CHROME + CDP
   ========================================================================== */
function findChrome() {
  if (process.env.GOALAK_CHROME && fs.existsSync(process.env.GOALAK_CHROME)) return process.env.GOALAK_CHROME;
  const c = [
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
    (process.env.LOCALAPPDATA || "") + String.raw`\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  return null;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Map();
    ws.addEventListener("message", e => {
      const m = JSON.parse(e.data);
      if (m.id != null) {
        const w = this.waiting.get(m.id); if (!w) return; this.waiting.delete(m.id);
        m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
      } else {
        const hs = this.handlers.get(m.method); if (hs) for (const h of hs) h(m.params);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error("CDP timeout: " + method)); }, 40000);
    });
  }
  on(ev, fn) { if (!this.handlers.has(ev)) this.handlers.set(ev, []); this.handlers.get(ev).push(fn); }
}

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
      const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
        return new CDP(ws);
      }
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("could not attach to Chrome on port " + port);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================================
   3. PAGE DRIVER
   ========================================================================== */
let cdp, BASE;
/* console errors, tagged with whatever context was current when they fired */
const consoleErrors = [];
const IGNORE_ERR = [/favicon\.ico/i];
function wireConsole(client) {
  const rec = (level, text) => {
    if (!/error|severe/i.test(level)) return;
    if (IGNORE_ERR.some(r => r.test(text))) return;
    consoleErrors.push({ ctx, text: String(text).slice(0, 220) });
  };
  client.on("Runtime.consoleAPICalled", p => { if (p.type === "error" || p.type === "assert")
    rec("error", (p.args || []).map(a => a.value ?? a.description ?? a.type).join(" ")); });
  client.on("Runtime.exceptionThrown", p => rec("error",
    (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text));
  /* the URL matters: a network error's text is just "Failed to load resource", and whether
     that is a real fault or a missing favicon is only visible in the url field */
  client.on("Log.entryAdded", p => rec(p.entry.level,
    p.entry.text + (p.entry.url ? "  <" + p.entry.url + ">" : "")));
}

async function evaluate(expression, opts) {
  const r = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true, ...(opts || {})
  });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error("in-page error: " + (e.exception && e.exception.description || e.text));
  }
  return r.result.value;
}
async function waitFor(expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 12000)) {
    try { if (await evaluate(expr)) return true; } catch (_) { }
    await sleep(60);
  }
  throw new Error("timed out waiting for " + (label || expr));
}
async function setViewport(w, h) {
  /* The OS window behind the tab has to be at least as big as the emulated viewport, or
     Chrome rasterises at the window size and Page.captureScreenshot returns an upscale of
     it. Emulation alone does not resize the window. */
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds",
      { windowId, bounds: { width: Math.max(w, 400) + 40, height: Math.max(h, 400) + 120, windowState: "normal" } });
  } catch (_) { /* older Chrome, or no window — the calibration guard will catch the fallout */ }
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: 1, mobile: false });
}
/* one-shot event wait. It has to be armed BEFORE the command that triggers it. The first
   version of loadApp polled for `CLUBS` straight after asking for a navigation, saw the OLD
   document's CLUBS still sitting there, and ran the whole matrix against a page that had
   never reloaded — every run silently in Arabic with the wizard still covering the pitch.
   The suite was reporting its own race. */
function once(event, ms) {
  return new Promise(res => {
    let done = false;
    const h = p => { if (!done) { done = true; res(p); } };
    cdp.on(event, h);
    setTimeout(() => h(null), ms || 20000);
  });
}
async function navigate(url) {
  const done = once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await done;
}

/* Boot the app in a known state. `fresh` leaves onboarding armed (for the tutorial suite);
   otherwise onboarding is marked done and a full legal squad is installed, because an empty
   pitch has no cards to hit-test. The squad is built with the app's OWN blockReason(), so it
   is a squad the app itself would accept — not a fixture we invented. */
async function loadApp({ lang, fresh }) {
  await navigate(BASE + "/index.html");
  try {
    await waitFor(`typeof CLUBS !== "undefined" && CLUBS && CLUBS.length > 0`, 15000, "club data");
  } catch (_) {
    /* This is what a page that stopped parsing looks like from outside: the HTML arrives,
       nothing runs, and there is no error on screen — just an empty shell. */
    const why = await evaluate(`JSON.stringify({
      html: document.documentElement.outerHTML.length,
      hasApp: typeof CLUBS !== "undefined",
      nav: document.getElementById("bnav") ? document.getElementById("bnav").children.length : -1,
      body: document.body.innerText.trim().slice(0,120) })`).then(JSON.parse).catch(() => ({}));
    const errs = consoleErrors.slice(-4).map(e => e.text).join(" | ");
    throw new Error("the page served " + (why.html || 0) + " bytes of HTML but its script never "
      + "produced any club data — the app did not start. "
      + (why.hasApp === false ? "CLUBS is not even declared, which is what a syntax error looks like. " : "")
      + (errs ? "Console said: " + errs : "The console said nothing."));
  }
  await waitFor(`document.getElementById("bnav").children.length > 0`, 8000, "chrome painted");
  /* THE DEMO WIPES localStorage ON EVERY OPEN — fx_lang and fx_onboarded included. That is
     deliberate (it is a review build and the owner opens the link to judge the first run),
     so state cannot be seeded from outside. Every run therefore starts in Arabic with the
     wizard up, and the suite gets to its state the way a user does: through the app's own
     skip and language controls. */
  await waitFor(`!document.getElementById("wiz").classList.contains("hide")`, 8000, "onboarding wizard");
  if (!fresh) await evaluate(`closeWizard()`);
  if (await evaluate(`LANG`) !== lang) await evaluate(`toggleLang()`);
  const got = await evaluate(`LANG`);
  if (got !== lang) throw new Error("could not switch language: LANG is " + got + ", wanted " + lang);
  if (!fresh) {
    const n = await evaluate(`(()=>{
      if(squad.length < SQUAD_SIZE){
        const pool = CLUBS.slice().sort((a,b)=>priceOf(b.id)-priceOf(a.id));
        while(squad.length < SQUAD_SIZE){ let added=false;
          for(const c of pool){ if(squad.includes(c.id))continue; if(blockReason(c))continue;
            squad.push(c.id); added=true; break; }
          if(!added) break; }
      }
      if(!captain && squad.length) captain = squad[0];
      save(); paintChrome(); render(); return squad.length;
    })()`);
    if (n !== 15) throw new Error("could not build a legal squad: got " + n + " clubs");
    if (await evaluate(`!document.getElementById("wiz").classList.contains("hide")`))
      throw new Error("the onboarding wizard is still covering the page");
  }
  await installProbes();
}

/* ---- the in-page probe kit. Installed fresh after every load. ---------------------- */
async function installProbes() {
  await evaluate(String.raw`
window.__QA = (function(){
  const R = el => el.getBoundingClientRect();
  const vis = el => { const r = R(el); return r.width > 0 && r.height > 0; };

  /* THE assertion. A control that does not answer elementFromPoint at its own centre does
     not exist, however perfect it looks. Returns one row per card. */
  function hitTest(sel){
    const out = [];
    const cards = [...document.querySelectorAll(sel)];
    for(let i = 0; i < cards.length; i++){
      const el = cards[i];
      el.scrollIntoView({block:"center", inline:"center", behavior:"instant"});
      const r = R(el);
      const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
      const hit = document.elementFromPoint(cx, cy);
      /* also probe the four quarter points — a card can answer at the centre and be dead
         over most of its face (a badge or a plate can be the only live region) */
      const quads = [[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([fx,fy]) => {
        const h = document.elementFromPoint(Math.round(r.left+r.width*fx), Math.round(r.top+r.height*fy));
        return h && el.contains(h) ? 1 : 0;
      });
      out.push({
        i, w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        label: (el.getAttribute("aria-label")||el.textContent||"").trim().slice(0,44),
        selfHit: !!(hit && (hit === el || el.contains(hit))),
        hitTag: hit ? (hit.tagName.toLowerCase() + "." + (hit.className||"").toString().split(" ")[0]) : "NOTHING",
        quadsLive: quads.reduce((a,b)=>a+b,0)
      });
    }
    window.scrollTo(0, 0);
    return out;
  }

  /* NEVER AGAIN #1: a 3D transform anywhere above a tap target removes its hit region.
     Walk from every button to the root and report any ancestor that opens a 3D context. */
  const BAD3D = /translateZ|translate3d|rotateX|rotateY|rotate3d|matrix3d/i;
  function transforms3d(){
    const bad = [];
    for(const btn of document.querySelectorAll("button, [role=button], a[href]")){
      if(!vis(btn)) continue;
      let n = btn, hops = 0;
      while(n && n !== document.documentElement && hops++ < 40){
        const cs = getComputedStyle(n);
        const why = [];
        if(cs.transform && cs.transform !== "none" && BAD3D.test(cs.transform)) why.push("transform:"+cs.transform);
        /* a computed matrix3d() is the resolved form of translateZ/rotateX */
        if(/^matrix3d\(/.test(cs.transform||"")) why.push("transform:"+cs.transform);
        if(cs.transformStyle === "preserve-3d") why.push("transform-style:preserve-3d");
        if(cs.perspective && cs.perspective !== "none") why.push("perspective:"+cs.perspective);
        if(why.length) bad.push({ btn: (btn.className||"")+"", anc: (n.className||n.tagName)+"", why: why.join(", ") });
        n = n.parentElement;
      }
    }
    return bad;
  }

  /* text that is cut off. Two ways it happens: the element scrolls its own overflow, or an
     ancestor with overflow:hidden (every .cc is one) crops it. Both are invisible. */
  function textFit(root){
    const bad = [];
    const scope = root ? document.querySelectorAll(root) : [document.body];
    for(const s of scope){
      for(const el of s.querySelectorAll("*")){
        const txt = (el.textContent||"").trim();
        if(!txt) continue;
        const hasOwnText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        if(!hasOwnText) continue;
        if(!vis(el)) continue;
        if(el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible")
          bad.push({ txt: txt.slice(0,30), why: "scrollWidth " + el.scrollWidth + " > clientWidth " + el.clientWidth });
        /* clipped by an ancestor that hides its overflow */
        let a = el.parentElement, hops = 0;
        while(a && hops++ < 6){
          const cs = getComputedStyle(a);
          if(cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden"){
            const er = R(el), ar = R(a);
            if(er.width > 0 && (er.left < ar.left - 1.5 || er.right > ar.right + 1.5))
              bad.push({ txt: txt.slice(0,30), why: "cropped by ." + ((a.className||"")+"").split(" ")[0]
                + " (text " + er.left.toFixed(0) + "–" + er.right.toFixed(0)
                + " vs box " + ar.left.toFixed(0) + "–" + ar.right.toFixed(0) + ")" });
            break;
          }
          a = a.parentElement;
        }
      }
    }
    return bad;
  }

  /* cards must not overlap each other or spill out of the pitch — the desktop failure mode */
  function rowGeometry(root){
    const bad = [];
    const cards = document.querySelector((root||"") + " .st__cards");
    if(!cards) return bad;
    const cr = R(cards);
    for(const row of cards.querySelectorAll(".st__row")){
      const kids = [...row.children].filter(vis);
      const n = +row.dataset.n;
      /* the 5-across row deliberately tucks cards by 9px; nothing else may overlap at all */
      const allow = n === 5 ? 14 : 1;
      for(let i = 1; i < kids.length; i++){
        const a = R(kids[i-1]), b = R(kids[i]);
        const lo = Math.min(a.right, b.right), hi = Math.max(a.left, b.left);
        const ov = lo - hi;
        if(ov > allow) bad.push({ why: "row n=" + n + ": cards " + (i-1) + "/" + i + " overlap by " + ov.toFixed(1) + "px" });
      }
      const r = R(row);
      if(r.left < cr.left - 2 || r.right > cr.right + 2)
        bad.push({ why: "row n=" + n + " spills out of .st__cards (" + r.left.toFixed(0) + "–" + r.right.toFixed(0)
          + " vs " + cr.left.toFixed(0) + "–" + cr.right.toFixed(0) + ")" });
    }
    return bad;
  }

  /* what the fixed bottom nav is sitting on top of, once the page is scrolled as far as it
     will go — i.e. content the user can never bring out from under it */
  function underNav(sel){
    window.scrollTo(0, document.documentElement.scrollHeight);
    const nav = document.getElementById("bnav");
    const out = [];
    if(!nav) return out;
    for(const el of document.querySelectorAll(sel)){
      if(!vis(el)) continue;
      const r = R(el);
      if(r.bottom < 0 || r.top > innerHeight) continue;
      const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
      const hit = document.elementFromPoint(cx, cy);
      if(hit && (hit === nav || nav.contains(hit)))
        out.push({ what: ((el.className||"")+"").split(" ")[0] || el.tagName,
                   label: (el.getAttribute("aria-label")||el.textContent||"").trim().slice(0,40) });
    }
    window.scrollTo(0, 0);
    return out;
  }

  /* every score the UI shows for the same thing, read off the DOM rather than the model */
  function scoreboard(){
    const table = [...document.querySelectorAll("#viewBoard .lbrow")].map(r => ({
      name: (r.querySelector(".lbname")||{textContent:""}).textContent.trim(),
      pts: parseInt(((r.querySelector(".lbpts")||{textContent:""}).textContent||"").replace(/[^\d]/g,""), 10),
      me: r.classList.contains("me")
    }));
    /* the head-to-head band, if this build still has one */
    const band = document.querySelector(".gapb");
    const bandData = band ? {
      them: (band.querySelector(".gapb__them")||{textContent:""}).textContent.trim(),
      themPts: parseInt(((band.querySelector(".gapb__n.them")||{textContent:""}).textContent||"").replace(/[^\d]/g,""),10),
      mePts: parseInt(((band.querySelector(".gapb__n.me")||{textContent:""}).textContent||"").replace(/[^\d]/g,""),10)
    } : null;
    return { table, band: bandData };
  }
  function pointsSeasonTotal(){
    const rows = [...document.querySelectorAll("#viewPoints .ptsrow")];
    for(const r of rows){
      const v = r.querySelector(".v");
      if(v) return parseInt((v.textContent||"").replace(/[^\d]/g,""), 10);
    }
    return null;
  }

  /* ---- kit fidelity harness. Renders every club's declared kit AND a striped twin in the
     same two colours, at the real on-pitch size, so a screenshot can be asked the only
     question that matters: does this plain shirt have a full-height band of its trim
     colour running down it? ------------------------------------------------------------ */
  /* The sheet is plain in-flow content on a stripped body, NOT a fixed full-screen overlay.
     A position:fixed + overflow:hidden host gets promoted to its own composited layer, and
     Chrome hands back a stale, washed-out raster of that layer — magenta came out white.
     This runs in a throwaway tab, so hiding the app's own nodes costs nothing. */
  function mountKits(from, to){
    const old = document.getElementById("__qaKits"); if(old) old.remove();
    document.body.classList.remove("gk-lock");
    for(const el of [...document.body.children]) if(el.id !== "__qaKits") el.style.display = "none";
    document.documentElement.style.background = "#101010";
    document.body.style.cssText = "background:#101010;margin:0;padding:6px";
    const host = document.createElement("div");
    host.id = "__qaKits";
    host.style.cssText = "display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px";
    const mk = (c, pat) => {
      const s = document.createElement("span");
      s.className = "cc__kit fxkit";
      s.setAttribute("data-pat", pat);
      if(c.iso) s.setAttribute("data-iso", "1");
      /* 76x66 is exactly .cc__kit at a 360px viewport: --cw 76, --ch 100.3, kit = --ch - 34.
         border-radius goes to 0 because rounded corners would put the page background inside
         the sample box; nothing about a corner is what this assertion is measuring. */
      s.style.cssText = "position:static;inline-size:76px;block-size:66px;flex:0 0 auto;"
        + "border-radius:0;--c1:" + c.c1 + ";--c2:" + c.c2;
      s.dataset.qaId = c.id; s.dataset.qaPat = pat;
      return s;
    };
    /* CALIBRATION TILES. A screenshot that is quietly stale, or upscaled from a smaller
       raster, reports colours that are all subtly wrong — and a colour assertion reading
       those pixels will invent failures, or worse, miss real ones. So the sheet is seeded
       with pure-magenta tiles all through it: unless every one of them reads back exactly
       255,0,255, nothing else measured from this image is allowed to count. */
    const cal = () => { const s = document.createElement("span");
      s.style.cssText = "inline-size:76px;block-size:66px;flex:0 0 auto;background:#FF00FF";
      s.dataset.qaCal = "1"; return s; };
    const meta = [];
    const slice = CLUBS.slice(from, to);
    for(let i = 0; i < 6; i++) host.appendChild(cal());
    let k = 0;
    for(const c of slice){
      host.appendChild(mk(c, c.pat)); host.appendChild(mk(c, "stripes"));
      if(++k % 5 === 0) host.appendChild(cal());
      meta.push({ id: c.id, code: c.code, pat: c.pat, c1: c.c1, c2: c.c2 });
    }
    for(let i = 0; i < 6; i++) host.appendChild(cal());
    document.body.appendChild(host);
    const all = [...host.children].map(el => { const r = R(el);
      return { cal: el.dataset.qaCal === "1", id: el.dataset.qaId, pat: el.dataset.qaPat,
               x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
               bg: el.dataset.qaCal ? "" : getComputedStyle(el).backgroundImage.slice(0, 200) }; });
    return { meta, rects: all.filter(r => !r.cal), cals: all.filter(r => r.cal),
             hostH: Math.round(R(host).height), gridH: host.scrollHeight };
  }
  function unmountKits(){
    const o = document.getElementById("__qaKits"); if(o) o.remove();
    for(const el of [...document.body.children]) el.style.display = "";
    document.body.style.cssText = ""; document.documentElement.style.background = "";
  }

  /* THE KIT ASSERTION THAT DOES NOT NEED A CAMERA.
     Every club's declared kit is rendered beside a striped twin in the same two colours, and
     the resolved background layers of both are handed back for analysis. Reading the
     computed value (not the stylesheet text) means --c1/--c2 are substituted, the cascade
     has been applied, and per-layer background-size is resolved — i.e. it is what the
     browser is actually about to paint. */
  function kitCss(){
    const host = document.createElement("div");
    host.id = "__qaKitCss";
    host.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden";
    const mk = (c, pat) => { const s = document.createElement("span");
      s.className = "cc__kit fxkit"; s.setAttribute("data-pat", pat);
      if(c.iso) s.setAttribute("data-iso", "1");
      s.style.cssText = "position:static;inline-size:76px;block-size:66px;--c1:" + c.c1 + ";--c2:" + c.c2;
      return s; };
    const read = el => { const cs = getComputedStyle(el);
      return { img: cs.backgroundImage, size: cs.backgroundSize, repeat: cs.backgroundRepeat,
               color: cs.backgroundColor }; };
    const out = [];
    for(const c of CLUBS){
      const a = mk(c, c.pat), b = mk(c, "stripes");
      host.appendChild(a); host.appendChild(b);
      out.push({ id: c.id, code: c.code, pat: c.pat, c1: c.c1, c2: c.c2, iso: !!c.iso, a: null, b: null, _i: out.length });
    }
    document.body.appendChild(host);
    const kids = host.children;
    for(let i = 0; i < out.length; i++){ out[i].a = read(kids[i * 2]); out[i].b = read(kids[i * 2 + 1]); }
    host.remove();
    return out;
  }

  return { hitTest, transforms3d, textFit, rowGeometry, underNav, scoreboard,
           pointsSeasonTotal, mountKits, unmountKits, kitCss };
})(); "installed"`);
}

/* ============================================================================
   4. PNG (node:zlib only) — for the one assertion that must see pixels
   ========================================================================== */
function decodePng(buf) {
  let off = 8; const idat = []; let W = 0, H = 0, bd = 0, ct = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error("unsupported PNG (bitDepth " + bd + ", colorType " + ct + ")");
  const ch = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const px = Buffer.alloc(H * stride);
  let p = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[p++]; const line = raw.subarray(p, p + stride); p += stride;
    const cur = px.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
  }
  return { W, H, ch, px };
}
const hex2rgb = h => { const s = String(h).replace("#", ""); return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)]; };
const d2 = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;

/* ============================================================================
   5. THE SUITES
   ========================================================================== */
const VIEWPORTS = [
  { w: 360, h: 800, n: "360x800" },      /* the floor — cheapest Android still in the market */
  { w: 412, h: 915, n: "412x915" },      /* the modal Android */
  { w: 915, h: 412, n: "915x412" },      /* the same phone turned sideways */
  { w: 768, h: 1024, n: "768x1024" },    /* tablet */
  { w: 1256, h: 1000, n: "1256x1000" }   /* a desktop window — where the 300px card happened */
];
const LANGS = ["ar", "en"];

/* render() only toggles .hide on the views it is leaving — the old markup stays in the DOM.
   So every probe is scoped to the view that is actually on screen, or the suite measures
   display:none cards, calls them 0x0 and fails for a reason that has nothing to do with the
   product. */
async function suiteScreen(screen, root) {
  const CARD_SEL = root + " .st__cards .cc, " + root + " .dug .cc";
  /* --- HIT TESTING. Bug: 9 of 11 cards untappable, every other check green. --- */
  const hits = await evaluate(`JSON.stringify(__QA.hitTest(${JSON.stringify(CARD_SEL)}))`).then(JSON.parse);
  ok(screen + ": cards exist to test", hits.length > 0, hits.length + " cards");
  const dead = hits.filter(h => !h.selfHit);
  ok(screen + ": every card answers elementFromPoint at its centre", dead.length === 0,
    dead.length ? dead.length + "/" + hits.length + " dead: " +
      dead.slice(0, 6).map(d => "#" + d.i + " \"" + d.label + "\" -> " + d.hitTag).join("; ") : hits.length + " cards live");
  const patchy = hits.filter(h => h.selfHit && h.quadsLive < 4);
  ok(screen + ": every card is live across its whole face", patchy.length === 0,
    patchy.length ? patchy.slice(0, 6).map(d => "#" + d.i + " \"" + d.label + "\" only " + d.quadsLive + "/4 quadrants").join("; ") : "");
  const small = hits.filter(h => h.w < 44 || h.h < 44);
  ok(screen + ": every card is at least 44x44", small.length === 0,
    small.length ? small.slice(0, 6).map(d => "\"" + d.label + "\" " + d.w + "x" + d.h).join("; ") : "");

  /* --- CARD SIZE CAP. Bug: 300px cards on a desktop window. --- */
  const wide = hits.filter(h => h.w > 100);
  ok(screen + ": no card grows past its cap", wide.length === 0,
    wide.length ? "widest " + Math.max(...hits.map(h => h.w)) + "px (cap is 84 + border)" : "widest " + Math.max(...hits.map(h => h.w)) + "px");

  const geom = await evaluate(`JSON.stringify(__QA.rowGeometry(${JSON.stringify(root)}))`).then(JSON.parse);
  ok(screen + ": rows do not overlap or spill out of the pitch", geom.length === 0,
    geom.slice(0, 5).map(g => g.why).join("; "));

  /* --- 3D TRANSFORMS ABOVE A TAP TARGET. --- */
  const t3 = await evaluate(`JSON.stringify(__QA.transforms3d())`).then(JSON.parse);
  ok(screen + ": no 3D transform on any ancestor of a tap target", t3.length === 0,
    t3.slice(0, 5).map(b => "." + b.btn.split(" ")[0] + " under ." + String(b.anc).split(" ")[0] + " — " + b.why).join("; "));

  /* --- TEXT FIT on the cards. --- */
  const tf = await evaluate(`JSON.stringify(__QA.textFit(${JSON.stringify(root + " .st__cards, " + root + " .dug")}))`).then(JSON.parse);
  ok(screen + ": no clipped text on any card", tf.length === 0,
    tf.slice(0, 6).map(b => "\"" + b.txt + "\" — " + b.why).join("; ") + (tf.length > 6 ? " (+" + (tf.length - 6) + " more)" : ""));

  /* --- BOTTOM NAV OCCLUSION. --- */
  const sel = [".cc", ".btn", ".lbrow", ".rndb", ".gwbar", ".card h3"].map(s => root + " " + s).join(", ");
  const un = await evaluate(`JSON.stringify(__QA.underNav(${JSON.stringify(sel)}))`).then(JSON.parse);
  ok(screen + ": nothing important is stranded under the bottom nav", un.length === 0,
    un.slice(0, 5).map(u => "." + u.what + " \"" + u.label + "\"").join("; "));
}

/* text fit across every round — the fixture line and the score change 36 times */
async function suiteAllRounds() {
  const res = await evaluate(String.raw`(function(){
    const start = CURRENT_GW; const bad = [];
    for(let g = 1; g <= 36; g++){
      CURRENT_GW = g; render();
      for(const b of __QA.textFit("#viewPoints .st__cards, #viewPoints .dug")) bad.push({ gw: g, txt: b.txt, why: b.why });
      if(bad.length > 40) break;
    }
    CURRENT_GW = start; render();
    return JSON.stringify(bad);
  })()`).then(JSON.parse);
  const rounds = [...new Set(res.map(r => r.gw))];
  ok("points: no clipped card text in any of the 36 rounds", res.length === 0,
    res.length ? res.length + " clips across rounds " + rounds.slice(0, 8).join(",") + " — e.g. "
      + res.slice(0, 5).map(r => "GW" + r.gw + " \"" + r.txt + "\": " + r.why).join("; ") : "36 rounds clean");
}

/* ============================================================================
   6. MAIN
   ========================================================================== */
let chromeProc, serverHandle, profileDir;
async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log("  FAIL  no Chrome/Edge found. Set GOALAK_CHROME to a browser executable.");
    process.exit(1);
  }
  const { srv, port } = await startServer(HERE);
  serverHandle = srv;
  BASE = "http://127.0.0.1:" + port;

  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "goalak-qa-"));
  const dbg = 9222 + (process.pid % 900);
  chromeProc = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=" + dbg, "--user-data-dir=" + profileDir,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    /* The window surface must be at least as big as the largest emulated viewport we ever
       screenshot. Left at the headless default of 800x600, Page.captureScreenshot returns a
       blurry UPSCALE of a 800x600 raster — every colour in it is wrong, and the kit
       assertion happily "found" 33 bugs that did not exist. */
    "--window-size=1400,1700",
    "--force-device-scale-factor=1", "--disable-extensions", "--disable-background-networking",
    "--disable-features=Translate,BackForwardCache", "about:blank"
  ], { stdio: "ignore" });

  cdp = await connect(dbg);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  wireConsole(cdp);

  console.log("goalak live QA — Chrome " + path.basename(chromePath) + ", serving " + HERE + " on " + BASE + "\n");

  /* ---- boot sanity. A page that stopped parsing shipped once; this is what that looks
         like from outside. --------------------------------------------------------- */
  setCtx("boot");
  await setViewport(360, 800);
  await loadApp({ lang: "ar", fresh: false });
  const boot = await evaluate(`JSON.stringify({
    clubs: (typeof CLUBS!=="undefined"&&CLUBS)?CLUBS.length:0,
    prices: Object.keys(typeof PRICES!=="undefined"?PRICES:{}).length,
    squad: squad.length, nav: document.getElementById("bnav").children.length,
    team: document.getElementById("viewTeam").children.length,
    tut: typeof tutInit === "function",
    /* boot()'s catch replaces .wrap wholesale, so the tell is that the three view sections
       are gone — NOT the presence of the failure string, which also lives in the inline
       <script> and therefore in document.body.textContent on a perfectly healthy page */
    failCard: !document.getElementById("viewTeam") || !document.getElementById("viewPoints")
  })`).then(JSON.parse);
  ok("the page boots and paints", boot.clubs > 0 && boot.nav > 0 && boot.team > 0 && !boot.failCard,
    boot.clubs + " clubs, " + boot.prices + " prices, squad " + boot.squad + ", nav " + boot.nav
    + " items, #viewTeam children " + boot.team + (boot.failCard ? ", SHOWING THE LOAD-FAILURE CARD" : ""));
  ok("the app builds a full legal squad", boot.squad === 15, "squad = " + boot.squad);
  ok("the tutorial module is present", boot.tut, boot.tut ? "tutInit() bound" : "tutInit missing — the wizard falls back to a version with no highlighted control");

  /* ---- KIT FIDELITY. Bug: 60 solid-kit clubs rendered striped.
     THIS RUNS FIRST, ON PURPOSE. It is the only assertion that reads pixels, and Chrome's
     headless compositor stops refreshing this tab's surface after it has been resized a
     number of times — every later Page.captureScreenshot then returns a byte-identical
     frozen frame. Taken first, the capture is honest. The magenta calibration tiles are
     what proves that on every run rather than assuming it. ------------------------- */
  setCtx("kits");
  /* deliberately modest: the swatch sheet is captured in pages of KIT_PAGE clubs, because a
     big sheet of gradient-painted tiles is rasterised at reduced resolution */
  await setViewport(1000, 760);
  await loadApp({ lang: "en", fresh: false });
  await kitSuite();

  /* ---- the matrix: 5 viewports x 2 languages ------------------------------------- */
  const boardByLang = {};
  for (const vp of VIEWPORTS) {
    for (const lang of LANGS) {
      setCtx(vp.n + " " + lang);
      await setViewport(vp.w, vp.h);
      await loadApp({ lang, fresh: false });

      await evaluate(`setView("team")`);
      await suiteScreen("team", "#viewTeam");

      await evaluate(`setView("points")`);
      await waitFor(`document.querySelectorAll("#viewPoints .cc").length > 0`, 6000, "points pitch");
      await suiteScreen("points", "#viewPoints");
      await suiteAllRounds();

      await evaluate(`setView("board")`);
      const sb = await evaluate(`JSON.stringify(__QA.scoreboard())`).then(JSON.parse);
      const model = await evaluate(`JSON.stringify(boardRows().map(r=>({seed:r.seed,name:r.name,s:r.s,me:r.me})))`).then(JSON.parse);
      const season = await evaluate(`seasonTotal()`);

      /* the standings table must be a view of the model, not its own copy of it */
      const domVsModel = sb.table.map((r, i) => model[i] && r.pts === Math.max(0, model[i].s) ? null
        : "row " + (i + 1) + " shows " + r.pts + ", model says " + (model[i] ? model[i].s : "—")).filter(Boolean);
      ok("board: the table shows the same numbers the model holds", domVsModel.length === 0, domVsModel.join("; "));

      /* the same season total on the standings table and the points screen */
      await evaluate(`setView("points")`);
      const ptsTotal = await evaluate(`__QA.pointsSeasonTotal()`);
      const meRow = sb.table.find(r => r.me);
      ok("cross-screen: the season total agrees on the points screen and the standings table",
        meRow && ptsTotal === meRow.pts && ptsTotal === season,
        "points screen " + ptsTotal + ", standings " + (meRow ? meRow.pts : "—") + ", model " + season);

      if (sb.band) {
        const themRow = sb.table.find(r => r.name === sb.band.them);
        ok("cross-screen: the head-to-head band and the standings table agree about the rival",
          themRow && themRow.pts === sb.band.themPts && sb.band.mePts === (meRow ? meRow.pts : NaN),
          "band says " + sb.band.them + " " + sb.band.themPts + " / me " + sb.band.mePts
          + "; table says " + (themRow ? themRow.pts : "rival not in table") + " / me " + (meRow ? meRow.pts : "—"));
      }

      boardByLang[vp.n + "|" + lang] = { model, season, table: sb.table, hasBand: !!sb.band };
    }

    /* THE ARABIC-ONLY BUG. Rivals are seeded by a stable key, so every rival's score must be
       byte-identical between the two languages. When the seed was a display name, English
       agreed with itself and Arabic did not, and no single-language test could see it. */
    setCtx(vp.n + " ar-vs-en");
    const a = boardByLang[vp.n + "|ar"], e = boardByLang[vp.n + "|en"];
    const byS = m => Object.fromEntries(m.model.filter(r => !r.me).map(r => [r.seed, r.s]));
    const sa = byS(a), se = byS(e);
    const diff = Object.keys(sa).filter(k => sa[k] !== se[k]).map(k => k + ": ar " + sa[k] + " vs en " + se[k]);
    ok("ar/en: every rival scores the same in both languages", diff.length === 0, diff.join("; "));
    ok("ar/en: the season total is the same in both languages", a.season === e.season,
      "ar " + a.season + " vs en " + e.season);
    const orderA = a.model.map(r => r.me ? "ME" : r.seed).join(">");
    const orderE = e.model.map(r => r.me ? "ME" : r.seed).join(">");
    ok("ar/en: the standings are in the same order in both languages", orderA === orderE,
      "ar " + orderA + "\n  en " + orderE);
  }

  /* ---- KIT FIDELITY. Bug: 60 solid-kit clubs rendered striped. ------------------- */
  /* ---- THE TUTORIAL. Mandatory onboarding; it has trapped users before. ---------- */
  for (const lang of LANGS) {
    for (const vp of [VIEWPORTS[0], VIEWPORTS[4]]) {
      setCtx("tutorial " + vp.n + " " + lang);
      await setViewport(vp.w, vp.h);
      await loadApp({ lang, fresh: true });
      await tutorialSuite();
    }
  }

  /* ---- CONSOLE ---------------------------------------------------------------- */
  setCtx("console");
  ok("no console errors anywhere in the run", consoleErrors.length === 0,
    consoleErrors.slice(0, 8).map(e => "[" + e.ctx + "] " + e.text).join("\n"));

  report();
}

/* --- kit fidelity ------------------------------------------------------------------ */
const KIT_PAGE = 24;          /* clubs per screenshot */

/* Mount a page of swatches and capture it, refusing to return until the magenta calibration
   tiles come back EXACTLY 255,0,255. A whole 126-club sheet in one shot does not: Chrome
   rasterises ~290 gradient-painted tiles at reduced resolution and hands back a washed-out
   upscale in which every colour is wrong — which is how the first version of this assertion
   "found" 33 kit bugs that did not exist. Small pages raster cleanly. */
async function captureKitPage(from, to) {
  let img = null, badCal = [], shotData = null, tries = 0;
  let mounted = null;
  for (; tries < 6; tries++) {
    mounted = await evaluate(`JSON.stringify(__QA.mountKits(${from},${to}))`).then(JSON.parse);
    try { await cdp.send("Page.bringToFront"); } catch (_) { }
    await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await sleep(80 + tries * 120);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    shotData = shot.data;
    img = decodePng(Buffer.from(shot.data, "base64"));
    badCal = [];
    for (const c of mounted.cals) {
      const x = c.x + (c.w >> 1), y = c.y + (c.h >> 1);
      if (x < 0 || y < 0 || x >= img.W || y >= img.H) { badCal.push("(" + x + "," + y + ") off-image"); continue; }
      const o = (y * img.W + x) * img.ch;
      const p = [img.px[o], img.px[o + 1], img.px[o + 2]];
      if (p[0] !== 255 || p[1] !== 0 || p[2] !== 255) badCal.push("(" + x + "," + y + ")=" + p.join(","));
    }
    if (!badCal.length) break;
  }
  return { mounted, img, badCal, shotData, tries };
}

/* ---- reading a shirt out of its computed background layers -------------------------
   A kit is painted as a stack of CSS gradient layers. What made 60 plain clubs look striped
   was a layer running along the HORIZONTAL axis (a 90deg gradient — a placket down the
   chest, sleeve bars) in the trim colour, which by construction spans the whole height of
   the shirt. Collars and hems run along the vertical axis (180deg/0deg) and can never do
   that, however wide they are. So the rule is exact and needs no camera:

     a `solid` kit may not contain a horizontal-axis gradient layer in --c2.

   The same function run over a striped twin in the same two colours MUST report a band —
   that is the proof the reader works, per club, rather than a check that cannot fail. */
function splitLayers(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const hexRgb = h => { const [r, g, b] = hex2rgb(h); return "rgb(" + r + ", " + g + ", " + b + ")"; };
function verticalBands(css, c2hex) {
  const layers = splitLayers(css.img).filter(l => l && l !== "none");
  const sizes = splitLayers(css.size);
  const want = hexRgb(c2hex);
  const bands = [];
  layers.forEach((layer, i) => {
    if (!/^(repeating-)?linear-gradient\(/.test(layer)) return;
    const m = layer.match(/^(?:repeating-)?linear-gradient\(\s*(-?[\d.]+)deg/);
    /* no explicit angle means `to bottom`, i.e. 180deg — bands run across, not down */
    const angle = ((m ? parseFloat(m[1]) : 180) % 360 + 360) % 360;
    if (angle % 180 !== 90) return;                       /* not a vertical band */
    if (layer.indexOf(want) < 0) return;                  /* not in the trim colour */
    const size = (sizes[i] || sizes[sizes.length - 1] || "auto").trim();
    const h = size.split(/\s+/)[1] || "auto";
    if (!(h === "auto" || h === "100%")) return;          /* does not reach full height */
    bands.push(angle + "deg layer #" + (i + 1) + " in " + c2hex);
  });
  return bands;
}

async function kitSuite() {
  /* ---- the deterministic pass: every club, from computed style ---- */
  const css = await evaluate(`JSON.stringify(__QA.kitCss())`).then(JSON.parse);
  const striped = [], detectorDeadCss = [], noGradient = [];
  for (const c of css) {
    if (!/gradient/.test(c.a.img)) { noGradient.push(c.code + " (" + c.pat + "): " + c.a.img); continue; }
    /* the striped twin is the per-club proof that the reader can see this club's colours */
    if (!verticalBands(c.b, c.c2).length) { detectorDeadCss.push(c.code + " (" + c.c1 + "/" + c.c2 + ")"); continue; }
    if (c.pat !== "solid") continue;
    const bands = verticalBands(c.a, c.c2);
    if (bands.length) striped.push(c.code + " " + c.c1 + "/" + c.c2 + " — " + bands.join(", "));
  }
  const solidCount = css.filter(c => c.pat === "solid").length;
  ok("kits: a `solid` club never paints a full-height band of its second colour",
    striped.length === 0 && solidCount > 0,
    striped.length ? striped.slice(0, 8).join("; ") + (striped.length > 8 ? " (+" + (striped.length - 8) + " more)" : "")
      : solidCount + " solid clubs of " + css.length + " checked against their own striped twin");
  ok("kits: every club's declared pattern actually resolves to a gradient", noGradient.length === 0,
    noGradient.slice(0, 6).join("; "));
  ok("kits: the band reader is not vacuous", detectorDeadCss.length === 0,
    detectorDeadCss.length ? detectorDeadCss.length + " clubs whose striped twin showed no band either — "
      + "for these the assertion above proves nothing: " + detectorDeadCss.slice(0, 8).join(", ") : "");

  /* ---- the pixel pass: advisory. See kitPixelSuite for why. ---- */
  await kitPixelSuite();
}

/* The pixel pass renders the same swatch sheet and looks at it.
   IT IS ADVISORY, and only because this machine cannot deliver a trustworthy screenshot of
   THIS page: headless Chrome here returns a smooth, dithered, washed-out raster in which a
   pure-magenta 76x66 tile reads back as 255,252,255. A trivial page screenshots perfectly
   from the same browser and flags, so it is the goalak page's layer tree that defeats it.
   The calibration tiles detect that, and when they fail this pass reports and stands down
   rather than inventing failures — an earlier version of it "found" 33 kit bugs that were
   entirely an artefact of the capture. The CSS pass above is the one that gates the commit. */
async function kitPixelSuite() {
  const total = await evaluate(`CLUBS.length`);
  const pages = [];
  let calTiles = 0, calBad = [], worstShot = null;
  for (let from = 0; from < total; from += KIT_PAGE) {
    const pg = await captureKitPage(from, Math.min(from + KIT_PAGE, total));
    calTiles += pg.mounted.cals.length;
    if (pg.badCal.length) { calBad.push("clubs " + from + "-" + Math.min(from + KIT_PAGE, total) + ": "
      + pg.badCal.length + "/" + pg.mounted.cals.length + " wrong, e.g. " + pg.badCal.slice(0, 3).join(" "));
      worstShot = pg; }
    pages.push(pg);
  }
  await evaluate(`__QA.unmountKits()`);
  if (DUMP) {
    const pg = worstShot || pages[0];
    const f = path.join(os.tmpdir(), "goalak-qa-kits.png");
    fs.writeFileSync(f, Buffer.from(pg.shotData, "base64"));
    note("kit swatch page written to " + f + " (" + pg.img.W + "x" + pg.img.H + ")"
      + (worstShot ? " — NOTE this is the FAILED capture, it is not what the page looks like" : ""));
  }

  if (calBad.length) {
    note("kits: the pixel pass STOOD DOWN — its magenta calibration tiles came back "
      + calBad[0].replace(/^clubs [\d-]+: /, "") + ". Measured: a page containing even ONE .fxkit "
      + "swatch makes this browser return an unfaithful raster of the WHOLE viewport (the same "
      + "tiles without .fxkit photograph perfectly), so no colour read off it can be trusted. "
      + "The CSS-layer assertion above is what gates. THE HUMAN CHECK THIS REPLACES: open the "
      + "live demo and look at the pitch — Liverpool, Spurs, Sevilla and Real Madrid must read "
      + "as plain shirts with trim, never as stripes. Worth one look per visual change to the "
      + "kit CSS; the CSS assertion catches the specific way it broke before.");
    return;
  }
  ok("kits: the screenshot is a true render of the page", true,
    calTiles + " calibration tiles exact across " + pages.length + " pages of "
      + pages[0].img.W + "x" + pages[0].img.H);

  const mounted = { meta: [].concat(...pages.map(p => p.mounted.meta)),
                    rects: [].concat(...pages.map(p => p.mounted.rects.map(r => ({ ...r, _pg: p })))) };
  const byId = new Map(mounted.meta.map(m => [m.id, m]));
  /* a kit's colour classification: for each column, what fraction of its (vertically inset)
     rows are nearer to c2 than to c1. Rows are sampled from 20%–80% of the height so the
     collar and the hem — which a real plain kit has and which are NOT the bug — are outside
     the window, and so are the rounded corners. */
  const outOfShot = [];
  function columns(rect, c1, c2, code) {
    const img = rect._pg.img;
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > img.W || rect.y + rect.h > img.H) {
      outOfShot.push(code); return null;
    }
    const x0 = rect.x + 3, x1 = rect.x + rect.w - 3;
    const y0 = rect.y + Math.round(rect.h * 0.20), y1 = rect.y + Math.round(rect.h * 0.80);
    const cols = [];
    for (let x = x0; x < x1; x++) {
      let n = 0, hit = 0;
      for (let y = y0; y < y1; y++) {
        const o = (y * img.W + x) * img.ch;
        const p = [img.px[o], img.px[o + 1], img.px[o + 2]];
        n++; if (d2(p, c2) < d2(p, c1)) hit++;
      }
      cols.push(hit / n);
    }
    return cols;
  }

  let checked = 0, skipped = [], fails = [], detectorDead = [];
  let maxSolid = 0, minStripe = 1;
  for (let i = 0; i < mounted.rects.length; i += 2) {
    const declared = mounted.rects[i], twin = mounted.rects[i + 1];
    const m = byId.get(declared.id);
    if (!m) continue;
    /* if this ever trips, the swatch sheet and the club list have drifted apart and every
       colour below is being judged against the wrong club's palette */
    if (declared.pat !== m.pat || twin.id !== declared.id || twin.pat !== "stripes") {
      fails.push("SHEET DESYNC at " + m.code + ": expected " + m.pat + "/stripes, got "
        + declared.pat + "/" + twin.pat); continue;
    }
    if (m.pat !== "solid") continue;
    const c1 = hex2rgb(m.c1), c2 = hex2rgb(m.c2);
    if (d2(c1, c2) < 900) { skipped.push(m.code + " (" + m.c1 + "/" + m.c2 + ")"); continue; }
    const dCols = columns(declared, c1, c2, m.code), tCols = columns(twin, c1, c2, m.code + "*");
    if (!dCols || !tCols) continue;
    const dMax = Math.max(...dCols), tMax = Math.max(...tCols);
    /* the striped twin is the control: if IT does not show a full-height band of c2, the
       measurement cannot see this club's colours at all and a pass would mean nothing */
    if (tMax < 0.9) { detectorDead.push(m.code + " (striped control only reached " + tMax.toFixed(2) + ")"); continue; }
    checked++;
    maxSolid = Math.max(maxSolid, dMax); minStripe = Math.min(minStripe, tMax);
    if (dMax >= 0.75) {
      const at = dCols.indexOf(dMax);
      fails.push(m.code + " " + m.c1 + "/" + m.c2 + " — a column of --c2 covers "
        + Math.round(dMax * 100) + "% of the shirt height"
        + (DUMP ? " (col " + at + "/" + dCols.length + " of a " + declared.w + "px swatch at "
          + declared.x + "," + declared.y + "; profile "
          + dCols.map(c => Math.round(c * 9)).join("") + ")" : ""));
    }
  }
  ok("kits: every solid club could actually be measured", outOfShot.length === 0,
    outOfShot.length ? outOfShot.length + " swatches fell outside their screenshot page — "
      + "the measurement would have been vacuous: " + outOfShot.slice(0, 8).join(",") : "");
  ok("kits: painted pixels agree — a `solid` club shows no full-height band of --c2",
    fails.length === 0 && checked > 0,
    fails.length ? fails.slice(0, 8).join("; ") + (fails.length > 8 ? " (+" + (fails.length - 8) + ")" : "")
      : checked + " solid clubs measured; worst solid column " + Math.round(maxSolid * 100)
        + "% vs striped control " + Math.round(minStripe * 100) + "%");
  if (skipped.length) note("kits: " + skipped.length + " solid clubs skipped by the pixel pass — c1 and c2 are the "
    + "same colour, so no measurement can tell a stripe from a plain field: " + skipped.slice(0, 6).join(", "));
  if (detectorDead.length) note("kits: " + detectorDead.length + " solid clubs skipped by the pixel pass — the striped "
    + "control did not read either: " + detectorDead.slice(0, 6).join(", "));
}

/* --- the tutorial ------------------------------------------------------------------- */
async function tutorialSuite() {
  const open = await evaluate(`!document.getElementById("wiz").classList.contains("hide")`);
  ok("tutorial: it opens on a first visit", open, open ? "" : "the wizard did not appear for a user with no fx_onboarded");
  if (!open) return;

  const trail = [];
  let deadEnd = null, finishedIn = -1;
  for (let step = 0; step < 40; step++) {
    const s = await evaluate(`JSON.stringify((function(){
      const hidden = document.getElementById("wiz").classList.contains("hide");
      const f = document.querySelector("#wizBox [data-tut-focus]");
      const acts = document.querySelectorAll("#wizBox [data-tut-act]").length;
      return { hidden: hidden, step: (typeof TS!=="undefined"&&TS)?TS.step:null,
               done: (typeof TS!=="undefined"&&TS)?TS.done:null, acts: acts,
               focus: f ? ((f.getAttribute("aria-label")||f.textContent||"").trim().slice(0,40)
                          + " [" + f.dataset.tutAct + "]") : null };
    })())`).then(JSON.parse);
    if (s.hidden) { finishedIn = step; break; }
    if (!s.focus) { deadEnd = { at: step, step: s.step, acts: s.acts }; break; }
    trail.push((s.step || "?") + " -> " + s.focus);
    await evaluate(`document.querySelector("#wizBox [data-tut-focus]").click()`);
    await sleep(40);
  }
  ok("tutorial: every step offers a highlighted control (no dead end)", !deadEnd,
    deadEnd ? "stuck at step \"" + deadEnd.step + "\" after " + deadEnd.at + " taps — "
      + deadEnd.acts + " tappable controls on screen but none carries data-tut-focus" : "");
  ok("tutorial: it completes by following only the highlighted control", finishedIn > 0,
    finishedIn > 0 ? finishedIn + " taps: " + trail.map(t => t.split(" -> ")[0]).join(" > ")
      : "never closed within 40 taps");
  if (finishedIn > 0) {
    const after = await evaluate(`JSON.stringify({squad: squad.length, cap: !!captain,
      onboarded: (function(){try{return localStorage.getItem("fx_onboarded")}catch(e){return null}})(),
      cards: document.querySelectorAll("#viewTeam .cc").length,
      empty: document.querySelectorAll("#viewTeam .cc--empty").length})`).then(JSON.parse);
    ok("tutorial: it hands over a complete squad with a captain",
      after.squad === 15 && after.cap && after.empty === 0,
      "squad " + after.squad + ", captain " + after.cap + ", " + after.cards + " cards on the pitch, "
      + after.empty + " empty slots");
    ok("tutorial: it is not shown again after it is finished", after.onboarded === "1",
      "fx_onboarded = " + after.onboarded);
  }
}

/* --- report ------------------------------------------------------------------------- */
function report() {
  const fails = results.filter(r => !r.pass);
  const byName = new Map();
  for (const r of results) {
    if (!byName.has(r.name)) byName.set(r.name, { pass: 0, fail: 0 });
    byName.get(r.name)[r.pass ? "pass" : "fail"]++;
  }
  console.log("\n" + "-".repeat(72));
  for (const [n, c] of byName) {
    const bad = c.fail > 0;
    console.log((bad ? "  FAIL  " : "  ok    ") + n + "  (" + c.pass + " pass"
      + (c.fail ? ", " + c.fail + " FAIL" : "") + ")");
  }
  console.log("-".repeat(72));
  console.log(results.length - fails.length + " assertions passed, " + fails.length + " failed, across "
    + VIEWPORTS.length + " viewports x " + LANGS.length + " languages");
  if (notes.length) { console.log("\nnotes:"); notes.forEach(n => console.log("  · " + n)); }
  if (fails.length) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log("  [" + f.ctx + "] " + f.name + (f.detail ? "\n      " + f.detail : ""));
  }
  cleanup();
  process.exit(fails.length ? 1 : 0);
}
function cleanup() {
  try { if (serverHandle) serverHandle.close(); } catch (_) { }
  try { if (chromeProc && !KEEP) chromeProc.kill(); } catch (_) { }
  try { if (profileDir && !KEEP) fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { }
}

main().catch(e => {
  console.log("  FAIL  the suite itself could not run: " + (e && e.stack || e));
  cleanup();
  process.exit(1);
});
