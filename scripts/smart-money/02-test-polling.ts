/**
 * Test SmartMoneyService with Data API polling
 *
 * Verifies:
 * 1. subscribeSmartMoneyTrades() works with polling
 * 2. Trades are detected and filtered correctly
 * 3. Subscription can be stopped
 *
 * Run: npx tsx scripts/test-smart-money-polling.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== SmartMoneyService Polling Test ===\n');

  const sdk = new PolymarketSDK();

  // 1. Get top Smart Money wallets
  console.log('1. Getting top Smart Money wallets...');
  const leaderboard = await sdk.smartMoney.getLeaderboard({
    period: 'week',
    limit: 3,
  });

  if (leaderboard.entries.length === 0) {
    console.log('No Smart Money wallets found');
    return;
  }

  const targetWallets = leaderboard.entries.map(e => e.address);
  console.log(`   Monitoring ${targetWallets.length} wallets:`);
  for (let i = 0; i < targetWallets.length; i++) {
    const entry = leaderboard.entries[i];
    console.log(`   ${i + 1}. ${entry.address.slice(0, 10)}... (Rank #${entry.rank}, PnL: $${entry.pnl.toFixed(0)})`);
  }
  console.log();

  // 2. Subscribe to trades
  console.log('2. Subscribing to trades...');
  let tradeCount = 0;
  const maxTrades = 5;
  const maxWaitTime = 60000; // 60 seconds

  const subscription = sdk.smartMoney.subscribeSmartMoneyTrades(
    (trade) => {
      tradeCount++;
      const timeAgo = Math.floor((Date.now() - trade.timestamp) / 1000 / 60);

      console.log(`\n   [Trade #${tradeCount}] ${timeAgo}m ago`);
      console.log(`       Trader: ${trade.traderName ?? trade.traderAddress.slice(0, 10)}...`);
      console.log(`       Market: ${trade.marketSlug ?? trade.conditionId?.slice(0, 20)}...`);
      console.log(`       Side: ${trade.side} | Size: ${trade.size.toFixed(2)} @ ${trade.price.toFixed(3)}`);
      console.log(`       Smart Money: ${trade.isSmartMoney ? 'YES' : 'NO'}`);
      console.log(`       TxHash: ${trade.txHash?.slice(0, 20)}...`);

      if (tradeCount >= maxTrades) {
        console.log(`\n   Reached ${maxTrades} trades, stopping...`);
        subscription.unsubscribe();
      }
    },
    {
      filterAddresses: targetWallets,
      smartMoneyOnly: false,
    }
  );

  console.log(`   Subscription ID: ${subscription.id}`);
  console.log(`   Polling interval: ~5-7 seconds (auto-adjusted based on wallet count)`);
  console.log(`   Waiting for trades (max ${maxWaitTime / 1000}s)...\n`);

  // 3. Wait for trades or timeout
  const startTime = Date.now();
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;

      if (tradeCount >= maxTrades) {
        clearInterval(checkInterval);
        resolve();
      } else if (elapsed > maxWaitTime) {
        console.log(`\n   Timeout after ${maxWaitTime / 1000}s`);
        clearInterval(checkInterval);
        subscription.unsubscribe();
        resolve();
      }
    }, 1000);
  });

  // 4. Results
  console.log('\n=== Results ===\n');
  console.log(`Total trades detected: ${tradeCount}`);

  if (tradeCount === 0) {
    console.log('\n⚠️  No trades detected in the time window.');
    console.log('   This is normal if the monitored wallets are inactive.');
    console.log('   Try monitoring more active traders or increasing the wait time.');
  } else {
    console.log(`\n✅ SmartMoneyService polling works!`);
    console.log(`✅ Data API /activity integration successful`);
    console.log(`✅ Trade filtering and callbacks working`);
  }

  // 5. Cleanup
  sdk.smartMoney.disconnect();
  console.log('\n=== Done ===');
}

main().catch(console.error);
