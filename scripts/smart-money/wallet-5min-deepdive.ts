/**
 * Wallet 5-Minute Deep Dive - BTC/SOL/XRP/ETH UP/DOWN 5m markets only
 *
 * Fetches trades for a wallet in the same way as wallet-deepdive.ts but filters
 * to only btc-updown-5m, sol-updown-5m, xrp-updown-5m, eth-updown-5m. Computes
 * overall win rate (per SELL: win if PnL > 0) and total PnL (realized + redeemed + open value - cost).
 *
 * Usage:
 *   npx tsx scripts/smart-money/wallet-5min-deepdive.ts
 *   WALLET_ADDRESS=0x... npx tsx scripts/smart-money/wallet-5min-deepdive.ts
 *
 * Env:
 *   WALLET_ADDRESS - Address to analyze (default: 0x1979ae6b7e6534de9c4539d0c205e582ca637c9d)
 *   START_UTC      - Start of time window, ISO 8601 UTC
 *   END_UTC        - End of time window, ISO 8601 UTC
 *   LAST_N_HOURS   - Fallback: time window in hours (default: 720 = 30 days)
 */

import { PolymarketSDK } from '../../src/index.js';
import type { Position, Activity } from '../../src/clients/data-api.js';

const ALLOWED_SLUGS = ['btc-updown-5m', 'sol-updown-5m', 'xrp-updown-5m', 'eth-updown-5m'];
const LAST_N_HOURS = Number(process.env.LAST_N_HOURS) || 720;
const MAX_TRADES_IN_WINDOW = 10000;
const DEFAULT_ADDRESS = '0x1979ae6b7e6534de9c4539d0c205e582ca637c9d';

interface TradeRow {
  asset: string;
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  timestamp: number;
  outcome: string;
  outcomeIndex: number;
  slug?: string;
}

interface Lot {
  size: number;
  cost: number;
}

function is5mSlug(slug: string | undefined): boolean {
  if (!slug) return false;
  const s = slug.toLowerCase();
  return ALLOWED_SLUGS.some((allowed) => s === allowed || s.includes(allowed));
}

async function main() {
  const address = (process.env.WALLET_ADDRESS || DEFAULT_ADDRESS).toLowerCase();

  console.log('='.repeat(60));
  console.log('Wallet 5-Minute Deep Dive (BTC/SOL/XRP/ETH UP/DOWN 5m)');
  console.log('='.repeat(60));

  const startUtcEnv = process.env.START_UTC;
  const endUtcEnv = process.env.END_UTC;
  let startTs: number;
  let endTs: number;
  let windowLabel: string;

  if (startUtcEnv && endUtcEnv) {
    startTs = new Date(startUtcEnv).getTime();
    endTs = new Date(endUtcEnv).getTime();
    windowLabel = `${startUtcEnv} → ${endUtcEnv}`;
  } else {
    const now = new Date();
    endTs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0,
      0,
      0
    );
    startTs = endTs - LAST_N_HOURS * 60 * 60 * 1000;
    const startUtc = new Date(startTs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    const endUtc = new Date(endTs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    windowLabel = `last ${LAST_N_HOURS} h (UTC) ${startUtc} → ${endUtc}`;
  }

  console.log(`Address:  ${address}`);
  console.log(`Window:   ${windowLabel}`);
  console.log(`Markets:  ${ALLOWED_SLUGS.join(', ')}`);
  console.log('='.repeat(60));

  const sdk = await PolymarketSDK.create({ privateKey: '0x' + '1'.repeat(64) });

  let allTrades: TradeRow[];
  let positions: Position[];

  if (startUtcEnv && endUtcEnv) {
    const startSec = Math.floor(startTs / 1000);
    const endSec = Math.floor(endTs / 1000);
    const [activity, positionsList] = await Promise.all([
      sdk.dataApi.getAllActivity(address, {
        start: startSec,
        end: endSec,
        type: 'TRADE',
        sortBy: 'TIMESTAMP',
        sortDirection: 'ASC',
      }, MAX_TRADES_IN_WINDOW),
      sdk.dataApi.getPositions(address).catch(() => [] as Position[]),
    ]);
    allTrades = activity.map((a: Activity) => ({
      asset: a.asset,
      market: a.conditionId ?? a.asset,
      side: a.side,
      size: a.size,
      price: a.price,
      timestamp: a.timestamp,
      outcome: a.outcome ?? '',
      outcomeIndex: a.outcomeIndex ?? 0,
      slug: a.slug,
    }));
    positions = positionsList;
  } else {
    const [tradesList, positionsList] = await Promise.all([
      sdk.dataApi.getTradesByUser(address, {
        startTimestamp: startTs,
        endTimestamp: endTs,
        limit: MAX_TRADES_IN_WINDOW,
      }),
      sdk.dataApi.getPositions(address).catch(() => [] as Position[]),
    ]);
    allTrades = tradesList;
    positions = positionsList;
  }

  const trades = allTrades.filter((t) => is5mSlug(t.slug));
  const positionByAsset = new Map<string, Position>();
  for (const p of positions) {
    if (is5mSlug(p.slug)) positionByAsset.set(p.asset, p);
  }

  const startSec = Math.floor(startTs / 1000);
  const endSec = Math.floor(endTs / 1000);
  const allRedeem = await sdk.dataApi.getAllActivity(address, {
    start: startSec,
    end: endSec,
    type: 'REDEEM',
    sortBy: 'TIMESTAMP',
    sortDirection: 'ASC',
  }, 5000);
  const redeem5m = allRedeem.filter((a) => is5mSlug(a.slug));
  const redeemedValueInWindow = redeem5m.reduce((sum, a) => sum + (a.usdcSize ?? a.size), 0);

  console.log(`\nTotal trades (all markets) in window: ${allTrades.length}`);
  console.log(`Trades in 5m markets:                 ${trades.length}`);
  console.log(`Open positions (5m):                  ${positionByAsset.size}`);
  console.log(`Redeemed in window (5m):              $${redeemedValueInWindow.toFixed(2)} (${redeem5m.length} redemption(s))`);

  const sorted = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const lotsByAsset = new Map<string, Lot[]>();
  let totalCost = 0;
  let realizedProceeds = 0;
  let realizedCost = 0;
  const sellPnLs: number[] = [];

  for (const t of sorted) {
    const asset = t.asset || t.market;
    if (!asset) continue;

    let lots = lotsByAsset.get(asset);
    if (!lots) {
      lots = [];
      lotsByAsset.set(asset, lots);
    }

    if (t.side === 'BUY') {
      const cost = t.size * t.price;
      totalCost += cost;
      lots.push({ size: t.size, cost });
    } else {
      let toSell = t.size;
      let costClosed = 0;
      let proceedsClosed = 0;
      while (toSell > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(lot.size, toSell);
        const costRatio = take / lot.size;
        costClosed += lot.cost * costRatio;
        proceedsClosed += take * t.price;
        toSell -= take;
        lot.size -= take;
        lot.cost -= lot.cost * costRatio;
        if (lot.size <= 0) lots.shift();
      }
      realizedCost += costClosed;
      realizedProceeds += proceedsClosed;
      sellPnLs.push(proceedsClosed - costClosed);
    }
  }

  const wins = sellPnLs.filter((pnl) => pnl > 0).length;
  const totalSells = sellPnLs.length;
  const winRatePct = totalSells > 0 ? (wins / totalSells) * 100 : 0;
  const realizedPnL = realizedProceeds - realizedCost;

  let openRedemptionValue = 0;
  for (const [asset, lots] of lotsByAsset) {
    let openSize = 0;
    let openCost = 0;
    for (const lot of lots) {
      if (lot.size > 0) {
        openSize += lot.size;
        openCost += lot.cost;
      }
    }
    if (openSize <= 0) continue;
    const pos = positionByAsset.get(asset);
    const redeemVal =
      pos?.currentValue !== undefined && pos?.size !== undefined && pos.size > 0
        ? (openSize / pos.size) * pos.currentValue
        : (pos?.curPrice !== undefined ? openSize * pos.curPrice : 0);
    openRedemptionValue += redeemVal;
  }

  const totalReturn = realizedProceeds + redeemedValueInWindow + openRedemptionValue;
  const totalPnL = totalReturn - totalCost;

  console.log('\n--- 5m markets: Win rate & PnL ---');
  console.log(`Closed trades (SELLs):     ${totalSells}`);
  console.log(`Wins (PnL > 0):           ${wins}`);
  console.log(`Win rate:                 ${winRatePct.toFixed(1)}%`);
  console.log(`Total BUY cost:           $${totalCost.toFixed(4)}`);
  console.log(`Realized from SELLs:      $${realizedProceeds.toFixed(4)} (cost: $${realizedCost.toFixed(4)})`);
  console.log(`Realized PnL:             $${realizedPnL.toFixed(4)}`);
  console.log(`Redeemed in window:       $${redeemedValueInWindow.toFixed(4)}`);
  console.log(`Open position value:      $${openRedemptionValue.toFixed(4)}`);
  console.log(`Total return:             $${totalReturn.toFixed(4)}`);
  console.log(`Total PnL:               $${totalPnL.toFixed(4)}`);

  if (sorted.length > 0) {
    console.log('\n--- 5m trades (chronological) ---');
    sorted.forEach((t, i) => {
      const ts = t.timestamp
        ? new Date(t.timestamp < 1e12 ? t.timestamp * 1000 : t.timestamp).toISOString()
        : '—';
      const val = (t.size * t.price).toFixed(4);
      console.log(
        `${i + 1}. ${t.side} ${t.size.toFixed(4)} @ $${t.price.toFixed(4)} = $${val}  ${t.slug ?? t.asset}  ${ts}`
      );
    });
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
