# Copy Trade Dashboard – Draft

Simple web dashboard for the copy trading feature: copy trade orders, real-time PnL (positions + closed), and positions to be redeemed.

---

## 1. What the dashboard shows

| Section | Data | Source |
|--------|------|--------|
| **Copy trade orders** | List of executed copy trades (BUY/SELL, size, price, value, market, time, success/error) | Wallet activity/trades for the copy-trader wallet |
| **Real-time PnL** | Open positions with current value, unrealized PnL; closed trades with realized PnL | Data API: positions + activity/trades |
| **To be redeemed** | Positions with `redeemable === true` (market resolved, can claim) | Data API: `getPositions(address, { redeemable: true })` |

All data is for **one wallet** (the one running copy trading). The dashboard backend needs that wallet address (and optionally API credentials if you use a dedicated key).

---

## 2. Data sources (existing SDK/API)

- **Positions (open + PnL)**  
  `sdk.dataApi.getPositions(wallet)`  
  Fields: `size`, `avgPrice`, `curPrice`, `currentValue`, `cashPnl`, `percentPnl`, `realizedPnl`, `title`, `slug`, `redeemable`, etc.

- **Activity / trades (copy orders history)**  
  `sdk.dataApi.getActivity(wallet, { type: 'TRADE', limit, sortBy: 'TIMESTAMP', sortDirection: 'DESC' })`  
  or `sdk.dataApi.getTradesByUser(wallet, { limit })`  
  Gives: side, size, price, asset, slug, timestamp, transactionHash.

- **Redeemable only**  
  `sdk.dataApi.getPositions(wallet, { redeemable: true })`.

Real-time PnL = positions with `curPrice` / `currentValue` / `cashPnl` (Data API already returns these). “Real-time” = refresh every 10–30 s via polling (or add WebSocket price later).

---

## 3. Architecture (recommended)

```
┌─────────────────────────────────────────────────────────────┐
│  Copy Trade Dashboard                                       │
├─────────────────────────────────────────────────────────────┤
│  Backend (Node, same repo)                                  │
│  - Express (or Fastify) server                              │
│  - Uses PolymarketSDK (dataApi only; no privateKey needed   │
│    for read-only, or with key for “my wallet” positions)    │
│  - GET /api/positions     → open positions + PnL             │
│  - GET /api/trades        → copy trade history (activity)   │
│  - GET /api/redeemable    → positions with redeemable=true  │
│  - Serves static frontend (or separate SPA)                 │
├─────────────────────────────────────────────────────────────┤
│  Frontend (simple)                                          │
│  - Single HTML + JS + CSS, or minimal Vite + React          │
│  - Polls /api/* every 10–15 s (or SSE for live updates)    │
│  - Sections: Orders | Open positions (PnL) | To redeem     │
└─────────────────────────────────────────────────────────────┘
```

- **Deploy**: Dashboard can run on the same machine as `crypto-copy-trade.ts` or on another. If same host, you can run copy-trade and dashboard in one process (copy-trade starts the HTTP server) or as two processes (dashboard only needs wallet + optional credentials).
- **Auth**: For local use, no auth. For remote, add a simple secret query param or API key header.

---

## 4. Backend (sketch)

- **Location**: e.g. `scripts/dashboard/` or `dashboard/` at repo root.
- **Dependencies**: Add `express` (or `fastify`) and use existing SDK.

**Env / config**

- `DASHBOARD_WALLET` or `COPY_TRADE_WALLET` – wallet address whose positions/trades to show.  
- Optional: `PRIVATE_KEY` only if you need to derive proxy wallet or use authenticated endpoints.

**Endpoints**

1. **GET /api/positions**  
   Call `dataApi.getPositions(wallet)`.  
   Return JSON: list of positions with `size`, `avgPrice`, `curPrice`, `currentValue`, `cashPnl`, `percentPnl`, `title`, `slug`, `redeemable`, etc.  
   Frontend uses this for “Open positions” and “Real-time PnL”.

2. **GET /api/trades**  
   Call `dataApi.getActivity(wallet, { type: 'TRADE', limit: 200, sortBy: 'TIMESTAMP', sortDirection: 'DESC' })`  
   (or `getTradesByUser`).  
   Return JSON: list of trades (side, size, price, value, slug, timestamp, txHash).  
   Frontend uses this for “Copy trade orders” (order history).

3. **GET /api/redeemable**  
   Call `dataApi.getPositions(wallet, { redeemable: true })`.  
   Return JSON: list of redeemable positions (same shape as positions, plus `redeemable: true`).  
   Frontend uses this for “To be redeemed”.

4. **GET /api/summary** (optional)  
   Aggregate: total unrealized PnL (sum `cashPnl`), total realized (from activity or derived), count open, count redeemable.  
   Single poll for a header/summary row.

All timestamps in UTC or ISO; keep amounts as numbers (frontend formats $).

---

## 5. Frontend (sketch)

- **Stack**: Vanilla HTML + JS + CSS, or a minimal Vite + React app in the same `dashboard/` folder.
- **Layout**: Three sections (tabs or stacked):
  1. **Copy trade orders** – Table: time (UTC), side, market (slug), outcome, size, price, value, status/link to tx.
  2. **Open positions & PnL** – Table: market, outcome, size, avg price, cur price, current value, unrealized PnL ($ and %). Optional: total unrealized at bottom.
  3. **To be redeemed** – Table: market, outcome, size, current value, redeemable (yes). Optional: link to Polymarket redeem flow or CTF docs.

- **Refresh**: Poll `/api/positions`, `/api/trades`, `/api/redeemable` (or `/api/summary`) every 10–15 s. Optionally add a “Refresh” button and last-updated time.
- **Styling**: Keep it minimal (e.g. a single CSS file, or Tailwind if you add Vite). No design system required for v1.

---

## 6. Where to put code

- **Option A – Inside poly-sdk**  
  - `dashboard/server.ts` – Express (or Fastify) + SDK, serves `dashboard/static` or built SPA.  
  - `dashboard/static/index.html` (+ app.js, style.css) or `dashboard/src/` for Vite+React.  
  - Script: `pnpm run dashboard` or `npx tsx dashboard/server.ts`.  
  - Fits “simple and local” and reuses SDK types.

- **Option B – Separate repo**  
  - Standalone Node + frontend repo that depends on `@catalyst-team/poly-sdk` and calls Data API.  
  - Use when you want the dashboard fully separate from the SDK repo.

Recommendation: **Option A** for a first version (single repo, one `dashboard/` tree, run with one command).

---

## 7. Optional enhancements

- **SSE (Server-Sent Events)**  
  One endpoint e.g. `GET /api/stream` that pushes JSON every N seconds (positions + summary). Frontend subscribes and updates DOM. Reduces polling.

- **Run with copy-trade in one process**  
  In `crypto-copy-trade.ts`, after `startAutoCopyTrading`, start the dashboard server and pass `tradeLog` / `holdings` as extra in-memory state (e.g. “last 100 copy orders from this run”). API can merge in-memory log with Data API trades for a fuller “this run” view.

- **Redeem link**  
  Link “To be redeemed” rows to Polymarket UI or to a small “how to redeem” note (e.g. CTF redeem flow in docs).

- **Filters**  
  Query params: `?limit=50`, `?redeemable=true` to narrow lists.

---

## 8. Summary

| Item | Choice |
|------|--------|
| Backend | Express (or Fastify) in `dashboard/server.ts`, use SDK `dataApi` |
| Data | positions, activity (TRADE), redeemable positions |
| Frontend | Simple HTML/JS or minimal Vite+React; poll /api every 10–15 s |
| Real-time PnL | Positions already have curPrice/currentValue/cashPnl; refresh via polling |
| Location | `dashboard/` inside poly-sdk; run with one command |

This gives you a simple web dashboard for copy trade orders, real-time PnL for positions and closed orders, and orders (positions) to be redeemed, using only existing SDK and Data API.
