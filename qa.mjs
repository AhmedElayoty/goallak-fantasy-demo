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
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: 1, mobile: false });
}
/* one-shot event wait. This has to be armed BEFORE the command that triggers it, and the
   reload has to be awaited properly: the first version polled for `CLUBS` straight after
   asking for a reload, saw the OLD document's CLUBS still sitting there, and ran the whole
   matrix against a page that had never been reloaded — so every run was in Arabic with the
   onboarding wizard still covering the pitch. The suite was reporting its own race. */
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
async function reload() {
  const done = once("Page.loadEventFired");
  await cdp.send("Page.reload", { ignoreCache: false });
  await done;
}

/* Boot the app in a known state. `fresh` leaves onboarding armed (for the tutorial suite);
   otherwise onboarding is marked done and a full legal squad is installed, because an empty
   pitch has no cards to hit-test. The squad is built with the app's OWN blockReason(), so it
   is a squad the app itself would accept — not a fixture we invented. */
async function loadApp({ lang, fresh }) {
  await navigate(BASE + "/index.html");
  await waitFor(`typeof CLUBS !== "undefined" && CLUBS && CLUBS.length > 0`, 15000, "club data");
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
  function mountKits(){
    const old = document.getElementById("__qaKits"); if(old) old.remove();
    const host = document.createElement("div");
    host.id = "__qaKits";
    host.style.cssText = "position:fixed;inset:0;z-index:99999;background:#101010;overflow:hidden;"
      + "display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px;padding:6px";
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
    for(let i = 0; i < 15; i++) host.appendChild(cal());
    let k = 0;
    for(const c of CLUBS){
      host.appendChild(mk(c, c.pat)); host.appendChild(mk(c, "stripes"));
      if(++k % 15 === 0) host.appendChild(cal());
      meta.push({ id: c.id, code: c.code, pat: c.pat, c1: c.c1, c2: c.c2 });
    }
    for(let i = 0; i < 15; i++) host.appendChild(cal());
    document.body.appendChild(host);
    const all = [...host.children].map(el => { const r = R(el);
      return { cal: el.dataset.qaCal === "1", id: el.dataset.qaId, pat: el.dataset.qaPat,
               x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
               bg: el.dataset.qaCal ? "" : getComputedStyle(el).backgroundImage.slice(0, 200) }; });
    return { meta, rects: all.filter(r => !r.cal), cals: all.filter(r => r.cal),
             hostH: Math.round(R(host).height), gridH: host.scrollHeight };
  }
  function unmountKits(){ const o = document.getElementById("__qaKits"); if(o) o.remove(); }

  return { hitTest, transforms3d, textFit, rowGeometry, underNav, scoreboard,
           pointsSeasonTotal, mountKits, unmountKits };
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
  const rec = (level, text) => {
    if (!/error|severe/i.test(level)) return;
    if (IGNORE_ERR.some(r => r.test(text))) return;
    consoleErrors.push({ ctx, text: String(text).slice(0, 220) });
  };
  cdp.on("Runtime.consoleAPICalled", p => { if (p.type === "error" || p.type === "assert")
    rec("error", (p.args || []).map(a => a.value ?? a.description ?? a.type).join(" ")); });
  cdp.on("Runtime.exceptionThrown", p => rec("error",
    (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text));
  cdp.on("Log.entryAdded", p => rec(p.entry.level, p.entry.text));

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
  setCtx("kits");
  /* tall enough for all 252 swatches (126 clubs x declared + striped control) to be inside
     one screenshot — a swatch that falls below the fold samples nothing and would "pass" */
  await setViewport(1240, 1500);
  await loadApp({ lang: "en", fresh: false });
  await kitSuite();

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
async function kitSuite() {
  const mounted = await evaluate(`JSON.stringify(__QA.mountKits())`).then(JSON.parse);

  /* Capture, then MAKE THE SCREENSHOT PROVE ITSELF against the magenta tiles before it is
     allowed to accuse anybody. After a dozen viewport changes Chrome's compositor surface
     lags behind the emulated metrics and hands back a blurry upscale in which every colour
     is wrong; re-asserting the metrics and giving it frames fixes it, but the only safe
     posture is to keep checking and to fail loudly if it never comes good. */
  let img = null, badCal = [], shotData = null, tries = 0;
  for (; tries < 8; tries++) {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1240, height: 1500, deviceScaleFactor: 1, mobile: false });
    await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await sleep(120 + tries * 150);
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
  await evaluate(`__QA.unmountKits()`);
  const shot = { data: shotData };

  ok("kits: the screenshot is a true render of the page", badCal.length === 0,
    badCal.length ? badCal.length + "/" + mounted.cals.length + " calibration tiles came back the wrong colour after "
      + tries + " attempts — the capture is stale or upscaled, so every colour reading below would be "
      + "meaningless: " + badCal.slice(0, 5).join(" ")
      : mounted.cals.length + " calibration tiles exact across " + img.W + "x" + img.H
        + (tries ? " (settled after " + tries + " retries)" : ""));
  if (badCal.length) return;
  if (DUMP) {
    const f = path.join(os.tmpdir(), "goalak-qa-kits.png");
    fs.writeFileSync(f, Buffer.from(shot.data, "base64"));
    note("kit swatch sheet written to " + f + " (" + img.W + "x" + img.H + ") — every club's declared kit "
      + "beside a striped twin in the same two colours. Look at it if a kit assertion argues with you.");
  }

  const byId = new Map(mounted.meta.map(m => [m.id, m]));
  /* a kit's colour classification: for each column, what fraction of its (vertically inset)
     rows are nearer to c2 than to c1. Rows are sampled from 20%–80% of the height so the
     collar and the hem — which a real plain kit has and which are NOT the bug — are outside
     the window, and so are the rounded corners. */
  const outOfShot = [];
  function columns(rect, c1, c2, code) {
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
    outOfShot.length ? outOfShot.length + " swatches fell outside the screenshot ("
      + img.W + "x" + img.H + ") — the measurement would have been vacuous: " + outOfShot.slice(0, 8).join(",") : "");
  ok("kits: a `solid` club never renders a full-height band of its second colour",
    fails.length === 0 && checked > 0,
    fails.length ? fails.slice(0, 8).join("; ") + (fails.length > 8 ? " (+" + (fails.length - 8) + ")" : "")
      : checked + " solid clubs measured; worst solid column " + Math.round(maxSolid * 100)
        + "% vs striped control " + Math.round(minStripe * 100) + "%");
  if (skipped.length) note("kits: " + skipped.length + " solid clubs skipped — c1 and c2 are the same colour, "
    + "so no measurement can tell a stripe from a plain field: " + skipped.slice(0, 6).join(", "));
  if (detectorDead.length) note("kits: " + detectorDead.length + " solid clubs skipped — the striped control did not "
    + "read either, so the pixel test would have been vacuous: " + detectorDead.slice(0, 6).join(", "));

  /* every non-solid club must actually pick up its own pattern rule rather than falling
     through to the plain background — a cheap computed-style check over all 126 */
  const solidBg = mounted.rects.find((r, i) => byId.get(r.id) && byId.get(r.id).pat === "solid" && r.pat === "solid");
  const notApplied = [];
  const seenPat = new Set();
  for (const r of mounted.rects) {
    if (r.pat !== (byId.get(r.id) || {}).pat) continue;
    const m = byId.get(r.id);
    seenPat.add(m.pat);
    if (!/gradient/.test(r.bg)) notApplied.push(m.code + " (" + m.pat + "): " + r.bg);
  }
  ok("kits: every club's declared pattern actually renders as a gradient",
    notApplied.length === 0, notApplied.slice(0, 6).join("; ") + " | patterns seen: " + [...seenPat].sort().join(","));
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
