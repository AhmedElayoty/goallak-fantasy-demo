# Goallak Fantasy — DEMO

A standalone, click-through demo of the club-based fantasy game for goallak.com.

**This is a demo, not the product.** It is deliberately NOT deployed to goallak.com.

- No account, no server, no network writes. Everything is stored in your browser's localStorage.
- Points and standings are **simulated** (deterministic from club id + gameweek) so the design can
  be judged without waiting for a real season.
- Club prices are **provisional** — a derived pricing model is being produced separately and will
  replace `prices.json` without any change to the app.

## What is real

- **126 clubs** across 7 leagues, pulled from ESPN and snapshotted at build time.
- **Club identity with no crests.** No football data licence includes club trademarks, so every
  club is rendered from its home-kit colours plus one of nine pure-CSS patterns and a 3-letter
  code. The colour/rim/ink algorithm runs once at build time (`scripts/build-clubs.mjs`), never on
  the device. 42 clubs carry hand-verified colour overrides because ESPN's feed is wrong for them
  (Barcelona loses the blue entirely; Fenerbahçe comes back yellow-on-white at 1.07:1).
- **One visual mode.** No light/dark toggle — Fantasy is a single committed look.
- **Arabic-first**, RTL by default, with a full English mirror and Western digits throughout.

## Reset

"ابدأ من جديد / Reset demo" on the team screen clears everything and replays onboarding.
