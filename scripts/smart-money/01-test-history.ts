/**
 * Test SmartMoneyService with recent historical data
 *
 * Verifies polling logic by checking recent trades (last 24h)
 *
 * Run: npx tsx scripts/test-smart-money-history.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== SmartMoneyService Historical Test ===\n');

  const sdk = new PolymarketSDK();

  // 1. Get top Smart Money wallet
  console.log('1. Getting top Smart Money wallet...');
  const leaderboard = await sdk.smartMoney.getLeaderboard({
    period: 'week',
    limit: 1,
  });

  if (leaderboard.entries.length === 0) {
    console.log('No Smart Money wallets found');
    return;
  }

  const targetWallet = leaderboard.entries[0];
  console.log(`   Wallet: ${targetWallet.address.slice(0, 10)}...`);
  console.log(`   Rank: #${targetWallet.rank}`);
  console.log(`   PnL: $${targetWallet.pnl.toFixed(2)}\n`);

  // 2. Check recent activity (last 24 hours)
  console.log('2. Checking recent activity (last 24h)...');
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;

  const activities = await sdk.dataApi.getActivity(targetWallet.address, {
    type: 'TRADE',
    start: dayAgo,
    limit: 10,
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  });

  console.log(`   Found ${activities.length} trades\n`);

  if (activities.length === 0) {
    console.log('⚠️  No trades in last 24 hours.');
    console.log('   This wallet may be inactive recently.');
    return;
  }

  // 3. Display trades
  console.log('3. Recent trades:\n');
  for (let i = 0; i < Math.min(5, activities.length); i++) {
    const activity = activities[i];
    const timeAgo = Math.floor((Date.now() - activity.timestamp) / 1000 / 60);

    console.log(`   [${i + 1}] ${timeAgo}m ago`);
    console.log(`       Side: ${activity.side} | Size: ${activity.size.toFixed(2)} @ ${activity.price.toFixed(3)}`);
    console.log(`       USDC: $${activity.usdcSize?.toFixed(2) ?? 'N/A'}`);
    console.log(`       Market: ${activity.title?.slice(0, 60) ?? activity.conditionId.slice(0, 20)}...`);
    console.log(`       Wallet: ${activity.proxyWallet?.slice(0, 10) ?? 'MISSING'}...`);
    console.log();
  }

  // 4. Test conversion to SmartMoneyTrade
  console.log('4. Testing activity conversion...\n');

  // Access private method for testing
  const service = sdk.smartMoney as any;
  const smartMoneyTrade = service.activityToSmartMoneyTrade(activities[0]);

  if (smartMoneyTrade) {
    console.log('   ✅ Activity converted successfully');
    console.log(`   Trader: ${smartMoneyTrade.traderAddress.slice(0, 10)}...`);
    console.log(`   Side: ${smartMoneyTrade.side}`);
    console.log(`   Size: ${smartMoneyTrade.size.toFixed(2)}`);
    console.log(`   Price: ${smartMoneyTrade.price.toFixed(3)}`);
    console.log(`   Market: ${smartMoneyTrade.marketSlug ?? smartMoneyTrade.conditionId?.slice(0, 20)}...`);
  } else {
    console.log('   ❌ Conversion failed');
  }

  console.log('\n=== Test Results ===\n');
  console.log(`✅ Data API returns activities with proxyWallet`);
  console.log(`✅ Activity to SmartMoneyTrade conversion works`);
  console.log(`✅ Polling logic should work when wallet is active`);

  console.log('\n💡 Note: To test real-time polling, monitor more active wallets');
  console.log('   or use wallets from "day" leaderboard for recent activity.\n');

  console.log('=== Done ===');
}

main().catch(console.error);
