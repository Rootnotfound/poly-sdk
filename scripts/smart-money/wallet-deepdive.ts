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
 *   START_UTC     - Start of time window, ISO 8601 UTC (e.g. 2026-02-22T09:00:00Z)
 *   END_UTC       - End of time window, ISO 8601 UTC (e.g. 2026-02-22T10:00:00Z)
 *   If both START_UTC and END_UTC are set, that exact window is used. Otherwise:
 *   LAST_N_HOURS  - Fallback: time window in hours (default: 720 = 30 days), end = current UTC hour.
 *   RPC_URL       - Optional Polygon RPC for USDC.e balance at start/end of window (default: polygon-rpc.com).
 *                   Historical balance requires an RPC that supports historical state (archive node for old blocks).
 */

import { ethers } from 'ethers';
import { PolymarketSDK, USDC_CONTRACT, USDC_DECIMALS } from '../../src/index.js';
import type { Position, Activity } from '../../src/clients/data-api.js';

const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)'];
const DEFAULT_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/IVqi8CHXQ1P4K8SLjC1m4';

/** Get block number at or before the given timestamp (seconds). Uses binary search. */
async function getBlockNumberAtOrBefore(
  provider: ethers.providers.Provider,
  timestampSec: number
): Promise<number> {
  const latest = await provider.getBlockNumber();
  const latestBlock = await provider.getBlock(latest);
  if (!latestBlock || latestBlock.timestamp <= timestampSec) return latest;
  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const block = await provider.getBlock(mid);
    if (!block) return high;
    if (block.timestamp <= timestampSec) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Fetch USDC.e balance for an address at a given block (or 'latest'). Returns formatted string or null on error. */
async function getUsdcBalanceAtBlock(
  provider: ethers.providers.Provider,
  walletAddress: string,
  blockTag: number | 'latest'
): Promise<string | null> {
  try {
    const contract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);
    const balance = await contract.balanceOf(walletAddress, { blockTag });
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  } catch {
    return null;
  }
}

const DEFAULT_ADDRESS = '0x571c285a83eba5322b5f916ba681669dc368a61f';
const MIN_VALUE_USD = 1;
const LAST_N_HOURS = Number(process.env.LAST_N_HOURS) || 720;
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
  console.log(`Filter:   value (size × price) < $${MIN_VALUE_USD}`);
  console.log('='.repeat(60));

  const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const nowSec = Math.floor(Date.now() / 1000);
  const balanceStartSec = Math.floor(startTs / 1000);
  const balanceEndSec = Math.floor(endTs / 1000);
  let usdcAtStart: string | null = null;
  let usdcAtEnd: string | null = null;
  try {
    const endBlockTag: number | 'latest' =
      balanceEndSec >= nowSec ? 'latest' : await getBlockNumberAtOrBefore(provider, balanceEndSec);
    const startBlock =
      balanceStartSec >= nowSec
        ? endBlockTag
        : await getBlockNumberAtOrBefore(provider, balanceStartSec);
    const startTag = typeof startBlock === 'number' ? startBlock : 'latest';
    [usdcAtStart, usdcAtEnd] = await Promise.all([
      getUsdcBalanceAtBlock(provider, address, startTag),
      getUsdcBalanceAtBlock(provider, address, endBlockTag),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('(USDC balance at start/end skipped:', msg, ')');
  }

  const sdk = await PolymarketSDK.create({ privateKey: '0x' + '1'.repeat(64) });

  let trades: Array<{ asset: string; market: string; side: 'BUY' | 'SELL'; size: number; price: number; timestamp: number; outcome: string; outcomeIndex: number; slug?: string }>;
  let positions: Position[];

  if (startUtcEnv && endUtcEnv) {
    // Fixed window: Data API /trades returns only the N most recent trades (no server-side time filter).
    // Use /activity with start/end (server-side) to get trades in the exact window.
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
    trades = activity.map((a: Activity) => ({
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
    trades = tradesList;
    positions = positionsList;
  }

  // REDEEM and MERGE activity in the same time window (for unified FIFO ROI)
  const startSec = Math.floor(startTs / 1000);
  const endSec = Math.floor(endTs / 1000);
  const [redeemActivity, mergeActivity] = await Promise.all([
    sdk.dataApi.getAllActivity(address, {
      start: startSec,
      end: endSec,
      type: 'REDEEM',
      sortBy: 'TIMESTAMP',
      sortDirection: 'ASC',
    }, 5000),
    sdk.dataApi.getAllActivity(address, {
      start: startSec,
      end: endSec,
      type: 'MERGE',
      sortBy: 'TIMESTAMP',
      sortDirection: 'ASC',
    }, 5000),
  ]);
  const value = tradeValue;
  const belowOne = trades.filter(t => value(t) < MIN_VALUE_USD);

  console.log(`\nTotal trades in window: ${trades.length}`);
  console.log(`Trades with value < $${MIN_VALUE_USD}: ${belowOne.length}`);
  console.log(`Open positions fetched: ${positions.length}`);
  console.log(`Redemption events in window: ${redeemActivity.length}`);
  console.log(`Merge events in window: ${mergeActivity.length}`);

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

  // --- Total ROI % for time window: unified FIFO (trades + REDEEMs + MERGEs) so closes reflect actual cost basis ---
  type CloseEvent =
    | { kind: 'SELL'; asset: string; size: number; proceeds: number; ts: number }
    | { kind: 'REDEEM'; asset: string; size: number; proceeds: number; ts: number }
    | { kind: 'MERGE'; conditionId: string; size: number; proceeds: number; ts: number };
  type BuyEvent = { type: 'BUY'; asset: string; size: number; cost: number; ts: number };
  type AllEvent = BuyEvent | CloseEvent;
  const toMs = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

  const conditionIdToAssets = new Map<string, string[]>();
  for (const p of positions) {
    if (!p.conditionId || !p.asset) continue;
    let arr = conditionIdToAssets.get(p.conditionId);
    if (!arr) {
      arr = [];
      conditionIdToAssets.set(p.conditionId, arr);
    }
    if (!arr.includes(p.asset)) arr.push(p.asset);
  }
  for (const t of sorted) {
    const cid = t.market;
    const asset = t.asset || t.market;
    if (!cid || !asset) continue;
    let arr = conditionIdToAssets.get(cid);
    if (!arr) {
      arr = [];
      conditionIdToAssets.set(cid, arr);
    }
    if (!arr.includes(asset)) arr.push(asset);
  }

  const closeEvents: CloseEvent[] = [];
  for (const t of sorted) {
    if (t.side !== 'SELL') continue;
    const asset = t.asset || t.market;
    if (!asset) continue;
    closeEvents.push({
      kind: 'SELL',
      asset,
      size: t.size,
      proceeds: t.size * t.price,
      ts: toMs(t.timestamp || 0),
    });
  }
  for (const a of redeemActivity) {
    const size = a.size ?? (a.usdcSize ?? 0);
    if (!size || !a.asset) continue;
    closeEvents.push({
      kind: 'REDEEM',
      asset: a.asset,
      size,
      proceeds: a.usdcSize ?? a.size ?? 0,
      ts: toMs(a.timestamp),
    });
  }
  for (const a of mergeActivity) {
    const size = a.size ?? (a.usdcSize ?? 0);
    if (!size || !a.conditionId) continue;
    closeEvents.push({
      kind: 'MERGE',
      conditionId: a.conditionId,
      size,
      proceeds: a.usdcSize ?? a.size ?? 0,
      ts: toMs(a.timestamp),
    });
  }
  closeEvents.sort((a, b) => a.ts - b.ts);

  const lotsAllByAsset = new Map<string, SimpleLot[]>();
  let totalCostAll = 0;
  let realizedProceedsAll = 0;
  let realizedRedeemProceeds = 0;
  let realizedMergeProceeds = 0;
  let closedPositionsWon = 0;
  let amountWon = 0;

  const allOrdered: AllEvent[] = [];
  for (const t of sorted) {
    const asset = t.asset || t.market;
    if (!asset) continue;
    if (t.side === 'BUY') {
      allOrdered.push({ type: 'BUY', asset, size: t.size, cost: t.size * t.price, ts: toMs(t.timestamp || 0) });
    }
  }
  for (const e of closeEvents) {
    allOrdered.push(e);
  }
  allOrdered.sort((a, b) => a.ts - b.ts);

  for (const ev of allOrdered) {
    if ('type' in ev && ev.type === 'BUY') {
      totalCostAll += ev.cost;
      let lots = lotsAllByAsset.get(ev.asset);
      if (!lots) {
        lots = [];
        lotsAllByAsset.set(ev.asset, lots);
      }
      lots.push({ size: ev.size, cost: ev.cost });
      continue;
    }
    const closeEv = ev as CloseEvent;
    let costClosed = 0;
    const size = closeEv.size;
    const proceeds = closeEv.proceeds;

    if (closeEv.kind === 'MERGE') {
      const assets = conditionIdToAssets.get(closeEv.conditionId);
      if (assets && assets.length >= 2) {
        for (const asset of assets) {
          let lots = lotsAllByAsset.get(asset);
          if (!lots) lots = [];
          let toClose = size;
          while (toClose > 0 && lots.length > 0) {
            const lot = lots[0];
            const take = Math.min(lot.size, toClose);
            const costRatio = take / lot.size;
            costClosed += lot.cost * costRatio;
            toClose -= take;
            lot.size -= take;
            lot.cost -= lot.cost * costRatio;
            if (lot.size <= 0) lots.shift();
          }
        }
      }
      realizedMergeProceeds += proceeds;
    } else {
      const asset = closeEv.asset;
      let lots = lotsAllByAsset.get(asset);
      if (!lots) lots = [];
      let toClose = size;
      while (toClose > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(lot.size, toClose);
        const costRatio = take / lot.size;
        costClosed += lot.cost * costRatio;
        toClose -= take;
        lot.size -= take;
        lot.cost -= lot.cost * costRatio;
        if (lot.size <= 0) lots.shift();
      }
      if (closeEv.kind === 'SELL') {
        realizedProceedsAll += proceeds;
      } else {
        realizedRedeemProceeds += proceeds;
      }
    }
    const pnl = proceeds - costClosed;
    if (pnl > 0) {
      closedPositionsWon += 1;
      amountWon += pnl;
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

  const totalReturnAll = realizedProceedsAll + realizedRedeemProceeds + realizedMergeProceeds + redemptionAll;
  const roiAllPct = totalCostAll > 0 ? ((totalReturnAll - totalCostAll) / totalCostAll) * 100 : 0;

  console.log('\n--- Total ROI % (window, incl. redemption) ---');
  console.log(`Trades in window:         ${sorted.length}`);
  console.log(`Total BUY cost:            $${totalCostAll.toFixed(4)}`);
  console.log(`Realized from SELLs:       $${realizedProceedsAll.toFixed(4)}`);
  console.log(`Closed positions won:      ${closedPositionsWon} (in window)`);
  console.log(`Amount won (closed):       $${amountWon.toFixed(4)}`);
  console.log(`Realized from REDEEMs:     $${realizedRedeemProceeds.toFixed(4)}`);
  console.log(`Realized from MERGEs:      $${realizedMergeProceeds.toFixed(4)}`);
  console.log(`Redemption value (open):   $${redemptionAll.toFixed(4)}`);
  console.log(`Total return:              $${totalReturnAll.toFixed(4)} (SELLs + REDEEMs + MERGEs + open)`);
  console.log(`ROI %:                     ${roiAllPct.toFixed(2)}%`);
  console.log(
    `USDC.e at start (window):  ${usdcAtStart != null ? `$${Number(usdcAtStart).toFixed(2)}` : 'N/A'}`
  );
  console.log(
    `USDC.e at end (window):    ${usdcAtEnd != null ? `$${Number(usdcAtEnd).toFixed(2)}` : 'N/A'}`
  );

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
