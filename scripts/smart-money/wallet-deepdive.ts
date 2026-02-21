/**
 * Wallet Deep Dive - Sub-$1 trades and ROI %
 *
 * Fetches trades for a wallet, filters sub-$1 BUYs, and computes realized ROI
 * from SELLs plus redemption value of open/redeemable positions originating
 * from sub-$1 BUYs.
 *
 * Usage:
 *   npx tsx scripts/smart-money/wallet-deepdive.ts
 *   WALLET_ADDRESS=0x... npx tsx scripts/smart-money/wallet-deepdive.ts
 *
 * Env:
 *   WALLET_ADDRESS - Address to analyze (default: 0xe00740bce98a594e26861838885ab310ec3b548c)
 *   LAST_N_DAYS   - Time window for fetching trades and total ROI % in days (default: 30)
 */

import { PolymarketSDK } from '../../src/index.js';
import type { Position } from '../../src/clients/data-api.js';

const DEFAULT_ADDRESS = '0xf247584e41117bbbe4cc06e4d2c95741792a5216';
const MIN_VALUE_USD = 1;
/** Time window in days; trades and ROI are computed over [now - N days, now] */
const LAST_N_DAYS = Number(process.env.LAST_N_DAYS) || 30;
const MAX_TRADES_IN_WINDOW = 10000;

interface Lot {
  size: number;
  cost: number;
  fromSub1Buy: boolean;
}

interface SimpleLot {
  size: number;
  cost: number;
}

function tradeValue(t: { size: number; price: number }): number {
  return t.size * t.price;
}

async function main() {
  const address = (process.env.WALLET_ADDRESS || DEFAULT_ADDRESS).toLowerCase();

  console.log('='.repeat(60));
  console.log('Wallet Deep Dive - Sub-$1 Trades & ROI %');
  console.log('='.repeat(60));
  const endTs = Date.now();
  const startTs = endTs - LAST_N_DAYS * 24 * 60 * 60 * 1000;
  const startDate = new Date(startTs).toISOString().slice(0, 10);
  const endDate = new Date(endTs).toISOString().slice(0, 10);

  console.log(`Address:  ${address}`);
  console.log(`Window:   last ${LAST_N_DAYS} days (${startDate} → ${endDate})`);
  console.log(`Filter:   value (size × price) < $${MIN_VALUE_USD}`);
  console.log('='.repeat(60));

  const sdk = await PolymarketSDK.create({ privateKey: '0x' + '1'.repeat(64) });

  const [trades, positions] = await Promise.all([
    sdk.dataApi.getAllTrades(
      { user: address, startTimestamp: startTs, endTimestamp: endTs },
      MAX_TRADES_IN_WINDOW
    ),
    sdk.dataApi.getPositions(address).catch(() => [] as Position[]),
  ]);

  const value = tradeValue;
  const belowOne = trades.filter(t => value(t) < MIN_VALUE_USD);

  console.log(`\nTotal trades in window: ${trades.length}`);
  console.log(`Trades with value < $${MIN_VALUE_USD}: ${belowOne.length}`);
  console.log(`Open positions fetched: ${positions.length}`);

  // Sort trades chronologically for FIFO
  const sorted = [...trades].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const lotsByAsset = new Map<string, Lot[]>();
  let totalSub1Cost = 0;
  let realizedSub1Cost = 0;
  let realizedSub1Proceeds = 0;

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
      const fromSub1 = cost < MIN_VALUE_USD;
      if (fromSub1) totalSub1Cost += cost;
      lots.push({ size: t.size, cost, fromSub1Buy: fromSub1 });
    } else {
      let toSell = t.size;
      while (toSell > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(lot.size, toSell);
        const costRatio = take / lot.size;
        const costTaken = lot.cost * costRatio;
        const proceedsTaken = take * t.price;
        if (lot.fromSub1Buy) {
          realizedSub1Cost += costTaken;
          realizedSub1Proceeds += proceedsTaken;
        }
        toSell -= take;
        lot.size -= take;
        lot.cost -= costTaken;
        if (lot.size <= 0) lots.shift();
      }
    }
  }

  const positionByAsset = new Map<string, Position>();
  for (const p of positions) {
    positionByAsset.set(p.asset, p);
  }

  let redemptionValue = 0;
  let openSub1Cost = 0;
  const openSub1ByAsset: { asset: string; size: number; cost: number; curPrice?: number; currentValue?: number }[] = [];

  for (const [asset, lots] of lotsByAsset) {
    let sub1Size = 0;
    let sub1Cost = 0;
    for (const lot of lots) {
      if (lot.fromSub1Buy && lot.size > 0) {
        sub1Size += lot.size;
        sub1Cost += lot.cost;
      }
    }
    if (sub1Size <= 0) continue;
    openSub1Cost += sub1Cost;
    const pos = positionByAsset.get(asset);
    const curPrice = pos?.curPrice;
    const currentValue = pos?.currentValue;
    const redeemVal = currentValue !== undefined && pos?.size !== undefined && pos.size > 0
      ? (sub1Size / pos.size) * currentValue
      : (curPrice !== undefined ? sub1Size * curPrice : 0);
    redemptionValue += redeemVal;
    openSub1ByAsset.push({
      asset,
      size: sub1Size,
      cost: sub1Cost,
      curPrice,
      currentValue: pos?.currentValue,
    });
  }

  const totalCost = totalSub1Cost;
  const totalReturn = realizedSub1Proceeds + redemptionValue;
  const roiPct = totalCost > 0 ? ((totalReturn - totalCost) / totalCost) * 100 : 0;

  if (belowOne.length > 0) {
    console.log('\n--- Sub-$1 trades ---');
    belowOne.forEach((t, i) => {
      const v = value(t);
      const time = t.timestamp ? new Date(t.timestamp < 1e12 ? t.timestamp * 1000 : t.timestamp).toISOString() : '—';
      const marketLabel = t.slug || t.market?.slice(0, 20) || '—';
      console.log(
        `${i + 1}. ${t.side} ${t.size.toFixed(4)} @ $${t.price.toFixed(4)} = $${v.toFixed(4)}  ` +
          `${marketLabel}  ${time}`
      );
    });
  }

  console.log('\n--- Sub-$1 BUY ROI % ---');
  console.log(`Total sub-$1 BUY cost:     $${totalCost.toFixed(4)}`);
  console.log(`Realized from SELLs:       $${realizedSub1Proceeds.toFixed(4)} (cost closed: $${realizedSub1Cost.toFixed(4)})`);
  console.log(`Redemption value (open):  $${redemptionValue.toFixed(4)} (cost open: $${openSub1Cost.toFixed(4)})`);
  console.log(`Total return:              $${totalReturn.toFixed(4)}`);
  console.log(`ROI %:                     ${roiPct.toFixed(2)}%`);

  if (openSub1ByAsset.length > 0) {
    console.log('\n--- Open positions from sub-$1 BUYs (to be redeemed) ---');
    openSub1ByAsset.forEach((p, i) => {
      const pos = positionByAsset.get(p.asset);
      const slug = pos?.slug ?? p.asset.slice(0, 16);
      const redeemVal = p.currentValue !== undefined && pos?.size && pos.size > 0
        ? (p.size / pos.size) * p.currentValue
        : (p.curPrice !== undefined ? p.size * p.curPrice : null);
      console.log(
        `${i + 1}. ${slug}  size=${p.size.toFixed(4)}  cost=$${p.cost.toFixed(4)}  ` +
          `redeemValue=${redeemVal != null ? `$${redeemVal.toFixed(4)}` : '?'}  redeemable=${pos?.redeemable ?? '?'}`
      );
    });
  }

  // --- Total ROI % for time window (all BUYs/SELLs in window, including redemption) ---
  const lotsAllByAsset = new Map<string, SimpleLot[]>();
  let totalCostAll = 0;
  let realizedProceedsAll = 0;

  for (const t of sorted) {
    const asset = t.asset || t.market;
    if (!asset) continue;

    let lots = lotsAllByAsset.get(asset);
    if (!lots) {
      lots = [];
      lotsAllByAsset.set(asset, lots);
    }

    if (t.side === 'BUY') {
      const cost = t.size * t.price;
      totalCostAll += cost;
      lots.push({ size: t.size, cost });
    } else {
      let toSell = t.size;
      while (toSell > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(lot.size, toSell);
        const costRatio = take / lot.size;
        lot.size -= take;
        lot.cost -= lot.cost * costRatio;
        realizedProceedsAll += take * t.price;
        toSell -= take;
        if (lot.size <= 0) lots.shift();
      }
    }
  }

  let redemptionAll = 0;
  for (const [asset, lots] of lotsAllByAsset) {
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
    const redeemVal = pos?.currentValue !== undefined && pos?.size !== undefined && pos.size > 0
      ? (openSize / pos.size) * pos.currentValue
      : (pos?.curPrice !== undefined ? openSize * pos.curPrice : 0);
    redemptionAll += redeemVal;
  }

  const totalReturnAll = realizedProceedsAll + redemptionAll;
  const roiAllPct = totalCostAll > 0 ? ((totalReturnAll - totalCostAll) / totalCostAll) * 100 : 0;

  console.log('\n--- Total ROI % (last ' + LAST_N_DAYS + ' days, incl. redemption) ---');
  console.log(`Trades in window:         ${sorted.length}`);
  console.log(`Total BUY cost:            $${totalCostAll.toFixed(4)}`);
  console.log(`Realized from SELLs:       $${realizedProceedsAll.toFixed(4)}`);
  console.log(`Redemption value (open):   $${redemptionAll.toFixed(4)}`);
  console.log(`Total return:              $${totalReturnAll.toFixed(4)}`);
  console.log(`ROI %:                     ${roiAllPct.toFixed(2)}%`);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
