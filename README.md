# Web Board Games

Multiplayer browser board games on Cloudflare Workers. Every room is a Durable Object that owns the
WebSocket connections, the lobby and the running game.

## Games

| Game | Players | What it is |
| --- | --- | --- |
| **Chess** | 2 | Full rules, move list (SAN), game clocks (none, 3+2, 5, 10, 15+10), draw offers, drag and drop, captured pieces |
| **Uno** | 2-10 | Private hands, UNO call and catch, optional +2/+4 stacking, multi-round scoring to a target, turn timer |
| **Kingdomino** | 2-4 | The real draft rules: place your last tile then pick the next, 5x5 or 7x7 kingdoms, Middle Kingdom and Harmony bonuses |
| **Dice** | 2-8 | Farkle: roll six dice, set aside scoring dice, bank or push your luck; hot dice, three-farkle penalty, final round |
| **Rock Paper Scissors** | 2-12 | Secret picks and a Rock-Paper-Scissors-Shoot reveal; points mode (with sudden death) or elimination |
| **Hamsterball** | 2-12 | 3D party brawler: bump rivals off a tilting, shrinking plate over several rounds, with stamina boost |

The host can change each game's settings in the lobby (time control, target score, board size, lives, ...).

## Features

- Create a room, share the 6-character code, a link or a **QR code**; scan from the home page or any phone camera.
- **Host view**: the host can run the room without playing. They watch every game as a spectator and can pick,
  start, restart and end games, remove players and hand over the host role.
- Standings screen after every game with a countdown; the host can play again or return to the lobby.
- Synthesised **sound effects** (no audio files), mute button and haptics; every game explains itself behind a `?` button.
- Reconnects automatically (network change, locked phone) and holds your seat; reloading mid-game restores the game.
- Responsive from phones to desktop (touch controls in Hamsterball), view-transition page changes, reduced-motion support.
- Server-authoritative games, validated input, rate-limited chat, private Uno hands and secret RPS picks.

## Develop

```bash
npm install
npm run dev          # builds CSS, then http://localhost:8787
npm run build        # compile public_html/tailwind.css and vendor the QR library
npm test             # unit tests (game logic, chess engine perft)
npm run test:e2e     # protocol test against a running `npm run dev` (PORT=8787 by default)
npm run deploy
```

## Layout

| Path | What |
| --- | --- |
| `src/worker.js` | Entry point: `/ws` to the room Durable Object, `/api/*`, robots/sitemap, canonical URL rewriting |
| `src/durable-objects/GameRoom.js` | Lobby, identity, roles, chat, host powers, game options, game lifecycle, standings (`finishGame`) |
| `src/games/*.js` | Server-side game logic; `config.js` is the game catalogue and the host-editable options schema |
| `public_html/index.html`, `index.js` | Home page: nickname, create / join / rejoin, QR scanner |
| `public_html/game.html`, `game.js` | Room page: lobby, settings, drawer (people + chat), invite QR, rules, standings, game loader |
| `public_html/games/<id>.html/.js` | One UI fragment per game, loaded into the room page when a game starts |
| `public_html/core.js` | Shared client core: SVG icons and art, sound, toasts, modals, QR rendering, preferences |
| `public_html/socket-client.js` | WebSocket wrapper with reconnect/heartbeat |
| `styles/tailwind.css` | Design system (Tailwind v4 tokens + components), compiled to `public_html/tailwind.css` |
| `public_html/vendor/` | Vendored browser libraries (copied by `scripts/vendor.mjs`) |
| `test/` | `node --test` unit tests per game and the e2e protocol test |

## Design rules

- **No emojis anywhere.** Use SVG icons: add them to `ICONS` in `public_html/core.js` (or register game-specific ones with
  `WBG.addIcons`) and use `<i data-icon="name" class="size-5"></i>` or `WBG.icon('name', 'size-5')`. Chess pieces, dice
  faces, Rock Paper Scissors art and Uno symbols are SVG too.
- Components (`.btn`, `.card`, `.input`, `.chip`, `.modal`, ...) live in `styles/tailwind.css`. Tailwind only generates
  classes it finds in `public_html`, so run `npm run build` after adding new ones.
- Everything must work on a phone first: 44px touch targets, 16px inputs, safe-area padding.

## Adding a game

1. Add it to `src/games/config.js` (`available: true`, an `icon` name from `core.js`, optional `options`) and to
   `GAME_CLASSES` in `GameRoom.js`.
2. Implement a class with `constructor(room, players, options)`, `handleMessage(odId, type, payload)`, `cleanup()`, and
   optionally `onPlayerLeft(odId)` and `spectatorSync(odId)` (state for the host view). `players` only contains the people
   playing. Call `room.finishGame({ title, subtitle, rows: [{ id, name, score, rank, note }] })` when it is over; the room
   shows the standings and returns to the lobby (never call `room.endGame` yourself).
3. Add `public_html/games/<id>.html` and `<id>.js`. Call `WBG.gameReady('<id>-page-loaded')` once loaded (spectators
   automatically send `spectate-ready` instead), use `socket.off(event)` before `socket.on(event)`, register cleanup with
   `WBG.onTeardown(fn)`, describe the rules with `WBG.setRules(...)` and use `WBG.sound.play(name)` for sound.
4. Prefer full state snapshots (`<id>-state`) over incremental events: reload and host-view sync then come for free.

## SEO

- `index.html` carries the title/description, Open Graph + Twitter tags (1200x630 `og-image.png`), JSON-LD
  (WebSite, WebApplication, ItemList of games, FAQPage), a single `<h1>`, game descriptions and an FAQ.
- Canonical and OG URLs are site-relative with a `data-abs` attribute; the worker turns them into absolute URLs for
  whatever domain serves the page (`HTMLRewriter`). `/robots.txt` and `/sitemap.xml` are generated by the worker.
- Room pages (`/game`, `/games/*`) are `noindex` (meta tag + `X-Robots-Tag` in `public_html/_headers`).
- Tailwind is precompiled (no runtime script), fonts use `display=swap`, assets have cache headers, PWA icons included.

## Notes

- Identity: a player id is paired with a private per-browser secret (`userSecret` in localStorage); the room stores only
  its hash, so ids shown in the player list can't be used to take over a seat or the host role.
- Rooms reset when the last player leaves, and abandoned rooms are wiped by a Durable Object alarm. Games live in
  memory: if the Durable Object restarts (for example when you save a file under `wrangler dev`), the room returns to
  the lobby.
- Chess rules are verified against standard perft counts; the engine lives in `src/games/chess-engine.js`.
- Kingdomino tile pictures are served as downscaled JPEGs from `public_html/images/kingdomino/s/`.
- The Farkle scoring rules exist twice: on the server (authoritative) and in `public_html/games/dice.js` for the live
  preview. Keep them in sync when changing a rule.
