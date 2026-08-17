/* Does index.html parse, and does everything it references exist?
 *
 * Run by .git/hooks/pre-commit, which REFUSES the commit on failure. It is wired that way
 * because the soft version of this check already failed once in the way that matters: it
 * printed SYNTAX ERROR beside a commit that went through anyway, and the deployed demo was
 * a blank page until someone read the right line of output.
 *
 * Run directly:  node check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const s = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
const fail = [];

/* 1. the page's own script must parse */
const blocks = (s.match(/<script>([\s\S]*?)<\/script>/g) || []).map(b => b.slice(8, -9));
for (const b of blocks) {
  if (!b.trim()) continue;
  try { new Function(b); } catch (e) { fail.push("index.html does not parse: " + e.message); }
}
const body = blocks.join("\n");

/* 2. the shipped bundle must parse too — it is generated, and a bad strip breaks it silently */
const modPath = path.join(HERE, "modules.js");
if (fs.existsSync(modPath)) {
  try { new Function(fs.readFileSync(modPath, "utf8")); }
  catch (e) { fail.push("modules.js does not parse: " + e.message); }
}

/* 3. every onclick target must exist — the pitch is built as strings, so a renamed
      function is invisible until a user taps it */
const called = new Set();
for (const m of s.matchAll(/onclick\s*=\s*["'][^"']*?([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
for (const m of body.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)) called.add(m[1]);
const defined = new Set();
for (const m of body.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
const missingFns = [...called].filter(x => !defined.has(x) && !["window", "document"].includes(x));
if (missingFns.length) fail.push("onclick targets not defined: " + missingFns.join(", "));

/* 4. every t() key must exist, or the UI renders the key name at the user */
const keys = new Set([...body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\[/g)].map(m => m[1]));
const usedKeys = new Set([...body.matchAll(/\bt\(\s*["']([A-Za-z_$][\w$]*)["']/g)].map(m => m[1]));
const missingKeys = [...usedKeys].filter(k => !keys.has(k) && !/^tier$/.test(k));
if (missingKeys.length) fail.push("t() keys missing from STR: " + missingKeys.join(", "));

/* 5. the data files must be valid JSON and carry what the app reads */
for (const [f, need] of [["clubs.json", ["clubs", "leagues"]], ["prices.json", ["clubs"]],
                         ["calendar.json", ["gws"]]]) {
  const p = path.join(HERE, f);
  if (!fs.existsSync(p)) { fail.push(f + " is missing"); continue; }
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const k of need) if (!j[k]) fail.push(f + " has no `" + k + "`");
  } catch (e) { fail.push(f + " is not valid JSON: " + e.message); }
}

/* 6. every club must have a price and a calibrated strength, or it scores as an average one */
try {
  const clubs = JSON.parse(fs.readFileSync(path.join(HERE, "clubs.json"), "utf8")).clubs;
  const prices = JSON.parse(fs.readFileSync(path.join(HERE, "prices.json"), "utf8")).clubs;
  const byId = new Map(prices.map(p => [String(p.id), p]));
  const noPrice = clubs.filter(c => !byId.has(String(c.id))).map(c => c.code);
  const noStr = prices.filter(p => typeof p.str !== "number").length;
  if (noPrice.length) fail.push("clubs with no price: " + noPrice.join(", "));
  if (noStr) fail.push(noStr + " clubs have no calibrated `str` — run scripts/build-strength.mjs");
} catch (_) { /* already reported above */ }

/* 7. NEVER AGAIN: a 3D transform on the row stack.
      translateZ/rotateX inside a perspective context made every card in the affected rows
      completely untappable — elementFromPoint returned nothing anywhere on them — and it
      shipped because the checks measured geometry and contrast, neither of which notices
      that a control has stopped existing. Depth on the pitch is a 2D scale. */
const css = s.slice(s.indexOf("<style>"), s.indexOf("</style>"));
const rowRule = (css.match(/\.st__row\{[^}]*\}/) || [""])[0];
if (/translateZ|rotateX|rotate3d|matrix3d/.test(rowRule))
  fail.push(".st__row uses a 3D transform — that makes every card in the row untappable");
if (/\.st__cards\{[^}]*(perspective|preserve-3d)/.test(css))
  fail.push(".st__cards declares a perspective/preserve-3d context — cards inside stop hit-testing");

if (fail.length) { fail.forEach(f => console.log("  FAIL  " + f)); process.exit(1); }
console.log("check.mjs: index.html parses, " + called.size + " handlers and "
  + usedKeys.size + " strings resolve, data files intact");
