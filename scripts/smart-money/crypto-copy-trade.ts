/**
 * Crypto Copy Trading - 跟单指定地址的加密货币交易
 *
 * 专门跟单指定钱包地址（而非排行榜前N名），适用于：
 * - 已知的聪明钱地址
 * - 特定 KOL / 大户钱包
 * - 自己的其他钱包
 *
 * 用法：
 *   PRIVATE_KEY=0x... npx tsx scripts/smart-money/crypto-copy-trade.ts
 *
 * 环境变量：
 *   PRIVATE_KEY          - 你的钱包私钥
 *   COPY_ADDRESSES       - 逗号分隔的目标地址（可选，会与脚本内 TARGET_ADDRESSES 合并）
 *   DRY_RUN              - "false" 启用真实交易，其他值为模拟模式
 *   COPY_TRADE_LOG_DIR   - 结果日志目录（默认 /tmp/crypto-copy-trade-logs）
 *
 * 实盘延迟（DRY_RUN=false）：约 200–600 ms（活动推送 → 下单结果）。
 * 主要来自：活动 WebSocket 推送 + getTickSize/isNegRisk 两次 API + createAndPostMarketOrder 一次 API。
 * 每笔实盘成交会打印实际 Latency (activity → order result)。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PolymarketSDK } from '../../src/index.js';

// ============================================================================
// Configuration
// ============================================================================

const LOG_DIR = process.env.COPY_TRADE_LOG_DIR || '/tmp/crypto-copy-trade-logs';

// Target addresses to copy — add your target wallets here
const TARGET_ADDRESSES: string[] = [
  // Example addresses (replace with real ones):
  // '0x1234567890abcdef1234567890abcdef12345678',
  // '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
];

const DRY_RUN = process.env.DRY_RUN === 'false' ? false : true;
const SIZE_SCALE = 0.3;           // Copy 30% of their trade size
const MIN_TRADE_SIZE = 1;    // Skip BUY when copy value below this ($); SELL has no minimum
const MAX_PRICE_PER_SHARE = 0.96; // Skip trade when price per share > this
const MAX_SLIPPAGE = 0.05;        // 5% slippage
const STATS_INTERVAL_MS = 60_000; // Print stats every 60s

// ============================================================================
// Main
// ============================================================================

async function main() {
  const privateKey = process.env.PRIVATE_KEY || process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  // Merge CLI env addresses with hardcoded list
  const envAddresses = (process.env.COPY_ADDRESSES || '')
    .split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0);

  const allAddresses = [...new Set([...TARGET_ADDRESSES, ...envAddresses])];

  if (allAddresses.length === 0) {
    console.error('❌ No target addresses configured.');
    console.error('   Set TARGET_ADDRESSES in the script or pass COPY_ADDRESSES env var.');
    console.error('   Example: COPY_ADDRESSES=0xabc...,0xdef... npx tsx crypto-copy-trade.ts');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('🎯 Crypto Copy Trading - Follow Specific Wallets');
  console.log('='.repeat(60));
  console.log(`Mode:           ${DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE TRADING'}`);
  console.log(`Targets:        ${allAddresses.length} wallet(s)`);
  console.log(`Size Scale:     ${SIZE_SCALE * 100}%`);
  console.log(`Min trade size: $${MIN_TRADE_SIZE} (skip BUY when below; SELL any size)`);
  console.log(`Max price/share: $${MAX_PRICE_PER_SHARE} (skip if above)`);
  console.log(`SELL limits:    none`);
  console.log(`Max slippage:   ${MAX_SLIPPAGE * 100}%`);
  if (!DRY_RUN) {
    console.log(`Latency:        ~200–600 ms (activity → order sent; 3 API round-trips)`);
  }
  console.log('='.repeat(60));

  allAddresses.forEach((addr, i) => {
    console.log(`  ${i + 1}. ${addr}`);
  });
  console.log('');

  // Log file for this run
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore if exists
  }
  const logFileName = `crypto-copy-trade-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`;
  const logFilePath = join(LOG_DIR, logFileName);

  // Initialize SDK with WebSocket
  console.log('[Init] Starting SDK...');
  const sdk = await PolymarketSDK.create({ privateKey });
  console.log('  ✅ SDK ready (WebSocket connected)');

  let tradeLog: Array<{
    time: string;
    trader: string;
    market: string;
    side: string;
    outcome: string;
    price: number;
    copySize: number;
    copyValue: number;
    tokenId?: string;
    success: boolean;
    orderId?: string;
    error?: string;
  }> = [];

  /** Open positions from BUYs not yet closed by SELLs (tokenId -> shares, cost basis, market) */
  const holdings = new Map<string, { shares: number; costBasis: number; marketSlug: string }>();

  // Start copy trading with specific addresses (no topN)
  const subscription = await sdk.smartMoney.startAutoCopyTrading({
    targetAddresses: allAddresses,
    sizeScale: SIZE_SCALE,
    maxSizePerTrade: Infinity,
    maxSlippage: MAX_SLIPPAGE,
    orderType: 'FOK',
    minTradeSize: 0,
    minOrderSizeUsdc: MIN_TRADE_SIZE,
    maxPricePerShare: MAX_PRICE_PER_SHARE,
    noSellLimits: true,
    dryRun: DRY_RUN,
    getPositionSharesForToken: (tokenId) => holdings.get(tokenId)?.shares ?? 0,

    onTrade: (trade, result) => {
      const now = new Date().toLocaleTimeString();
      const status = result.success ? '✅' : '❌';
      const traderLabel = trade.traderName || `${trade.traderAddress.slice(0, 8)}...${trade.traderAddress.slice(-4)}`;
      const origValue = trade.size * trade.price;
      const computedSize = trade.size * SIZE_SCALE;
      const computedValue = computedSize * trade.price;
      const copySize = (result as { copySizeUsed?: number }).copySizeUsed ?? computedSize;
      const copyValue = (result as { copyValueUsed?: number }).copyValueUsed ?? computedValue;
      const slippagePrice = trade.side === 'BUY'
        ? trade.price * (1 + MAX_SLIPPAGE)
        : trade.price * (1 - MAX_SLIPPAGE);

      const activityTsMs = trade.timestamp < 1e12 ? trade.timestamp * 1000 : trade.timestamp;
      const latencyMs = !DRY_RUN ? Math.round(Date.now() - activityTsMs) : undefined;

      console.log(`\n${status} [${now}] Copy Trade`);
      console.log(`  Trader:  ${traderLabel}`);
      console.log(`  Market:  ${trade.marketSlug || 'unknown'}`);
      console.log(`  Original: ${trade.side} ${trade.outcome || '?'} — ${trade.size.toFixed(2)} shares @ $${trade.price.toFixed(4)} ($${origValue.toFixed(2)})`);
      console.log(`  Copy:     ${trade.side} ${trade.outcome || '?'} — ${copySize.toFixed(2)} shares @ $${slippagePrice.toFixed(4)} ($${copyValue.toFixed(2)})`);
      if (latencyMs !== undefined) console.log(`  Latency:  ${latencyMs} ms (activity → order result)`);
      if (result.orderId) console.log(`  OrderId: ${result.orderId}`);
      if (result.errorMsg) console.log(`  Error:   ${result.errorMsg}`);

      tradeLog.push({
        time: now,
        trader: traderLabel,
        market: trade.marketSlug || 'unknown',
        side: trade.side,
        outcome: trade.outcome || '?',
        price: trade.price,
        copySize,
        copyValue,
        tokenId: trade.tokenId,
        success: result.success,
        orderId: result.orderId,
        error: result.errorMsg,
      });

      if (result.success && trade.tokenId) {
        const key = trade.tokenId;
        if (trade.side === 'BUY') {
          const cur = holdings.get(key);
          if (cur) {
            cur.shares += copySize;
            cur.costBasis += copyValue;
          } else {
            holdings.set(key, { shares: copySize, costBasis: copyValue, marketSlug: trade.marketSlug || 'unknown' });
          }
        } else {
          const cur = holdings.get(key);
          if (cur && cur.shares > 0) {
            const ratio = Math.min(1, copySize / cur.shares);
            cur.costBasis -= cur.costBasis * ratio;
            cur.shares -= copySize;
            if (cur.shares <= 0) holdings.delete(key);
          }
        }
      }
    },

    onError: (error) => {
      console.error(`\n⚠️  [${new Date().toLocaleTimeString()}] Error: ${error.message}`);
    },
  });

  console.log(`\n✅ Tracking ${subscription.targetAddresses.length} wallet(s)`);
  console.log('⏳ Listening for trades... (runs indefinitely)\n');
  console.log('Type "stop" or press Ctrl+C to shut down.\n');

  // Graceful shutdown
  const shutdown = () => {
    const stats = subscription.getStats();
    const runSec = Math.floor((Date.now() - stats.startTime) / 1000);

    // Profit and unredeemed: use only executed (successful) trades, same as holdings
    const executedSuccess = tradeLog.filter(t => t.success);
    const buyExecuted = executedSuccess.filter(t => t.side === 'BUY');
    const sellExecuted = executedSuccess.filter(t => t.side === 'SELL');
    const totalBuySpent = buyExecuted.reduce((sum, t) => sum + t.copyValue, 0);
    const totalSellReceived = sellExecuted.reduce((sum, t) => sum + t.copyValue, 0);
    const netPnl = totalSellReceived - totalBuySpent;

    const openPositions = Array.from(holdings.entries()).filter(([, p]) => p.shares > 0);
    const unredeemedCount = openPositions.length;
    const valueAfterRedeemed = openPositions.reduce((sum, [, p]) => sum + p.shares, 0);

    const lines: string[] = [
      '',
      '='.repeat(60),
      '📊 Final Stats',
      '='.repeat(60),
      `  Running time:     ${Math.floor(runSec / 60)}m ${runSec % 60}s`,
      `  Activity recv'd:  ${stats.activityReceived}`,
      `  Address matched:  ${stats.activityMatched}`,
      `  Trades detected:  ${stats.tradesDetected}`,
      `  Trades executed:  ${stats.tradesExecuted}`,
      `  Trades skipped:   ${stats.tradesSkipped}`,
      `  Trades failed:    ${stats.tradesFailed}`,
      '',
      '  --- Profit (executed trades only) ---',
      `  BUY executed:     ${buyExecuted.length} ($${totalBuySpent.toFixed(2)} spent)`,
      `  SELL executed:    ${sellExecuted.length} ($${totalSellReceived.toFixed(2)} received)`,
      `  Net P&L:          ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`,
      '',
      '  --- Unredeemed (executed BUYs not yet sold) ---',
      `  Positions open:   ${unredeemedCount} (waiting to be sold/redeemed)`,
      `  Value after redeemed: $${valueAfterRedeemed.toFixed(2)}`,
    ];

    if (executedSuccess.length > 0) {
      lines.push('', '📋 Trade Log (executed only):');
      executedSuccess.forEach((t, i) => {
        const icon = t.success ? '✅' : '❌';
        const slipPrice = t.side === 'BUY' ? t.price * (1 + MAX_SLIPPAGE) : t.price * (1 - MAX_SLIPPAGE);
        lines.push(`  ${i + 1}. ${icon} [${t.time}] ${t.side} ${t.outcome} — ${t.copySize.toFixed(2)} shares @ $${slipPrice.toFixed(4)} ($${t.copyValue.toFixed(2)}) — ${t.market}`);
      });
    }

    lines.push('='.repeat(60), '');

    const report = lines.join('\n');
    console.log(report);

    try {
      const header = `Crypto Copy Trade — ${new Date().toISOString()} — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`;
      writeFileSync(logFilePath, header + report, 'utf8');
      console.log(`📁 Log saved: ${logFilePath}`);
    } catch (err) {
      console.error(`Failed to write log file: ${err}`);
    }

    subscription.stop();
    sdk.stop();
    console.log('\n✅ Stopped');
    process.exit(0);
  };

  // Periodic stats
  const statsInterval = setInterval(() => {
    const stats = subscription.getStats();
    const runSec = Math.floor((Date.now() - stats.startTime) / 1000);
    console.log(`  [${Math.floor(runSec / 60)}m${runSec % 60}s] ws_recv: ${stats.activityReceived} | matched: ${stats.activityMatched} | detected: ${stats.tradesDetected} | executed: ${stats.tradesExecuted} | skipped: ${stats.tradesSkipped} | failed: ${stats.tradesFailed}`);
  }, STATS_INTERVAL_MS);

  // Listen for "stop" command from stdin
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (data: string) => {
    const input = data.trim().toLowerCase();
    if (input === 'stop' || input === 'quit' || input === 'exit') {
      clearInterval(statsInterval);
      shutdown();
    }
  });

  process.on('SIGINT', () => {
    clearInterval(statsInterval);
    shutdown();
  });
  process.on('SIGTERM', () => {
    clearInterval(statsInterval);
    shutdown();
  });

  // Run forever
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
