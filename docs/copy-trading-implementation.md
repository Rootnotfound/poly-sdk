# Copy Trading 实现方案（最终版）

## 结论：使用 Data API `/activity` ⭐

经过详细调研和测试，**Data API `/activity`** 是 Copy Trading 的最佳数据源。

---

## 为什么选择 Data API？

### ✅ 关键优势

1. **按地址精确查询**
   ```typescript
   const activities = await dataApi.getActivity(targetWallet, {
     type: 'TRADE',
     start: lastCheckTimestamp,
     limit: 100
   });
   ```

2. **延迟更低** - 2-3秒（vs Subgraph 5-15秒）

3. **数据完整**
   - ✅ `proxyWallet` - 交易者地址（已修复）
   - ✅ `title` / `slug` - 市场名称
   - ✅ `usdcSize` - USDC 金额
   - ✅ `name` - 交易者用户名
   - ✅ `price` / `size` - 成交数据

4. **实时性好** - 适合高频监控

---

## 实现方案

### 核心代码

```typescript
class SmartMoneyService {
  private lastCheckTimestamp: number = Math.floor(Date.now() / 1000);

  async pollTargetWallets(targetWallets: string[]): Promise<Activity[]> {
    const now = Math.floor(Date.now() / 1000);
    const start = this.lastCheckTimestamp;

    // 并发查询所有目标钱包
    const results = await Promise.all(
      targetWallets.map(wallet =>
        this.dataApi.getActivity(wallet, {
          type: 'TRADE',
          start,
          limit: 100,
          sortBy: 'TIMESTAMP',
          sortDirection: 'DESC',
        })
      )
    );

    // 更新时间戳
    this.lastCheckTimestamp = now;

    // 合并结果并按时间排序
    return results
      .flat()
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async startCopyTrading(targetWallets: string[]) {
    const intervalId = setInterval(async () => {
      try {
        const newActivities = await this.pollTargetWallets(targetWallets);

        for (const activity of newActivities) {
          if (activity.side === 'BUY') {
            await this.executeCopyTrade(activity);
          }
        }
      } catch (error) {
        console.error('Poll error:', error);
      }
    }, 5000); // 5秒轮询

    return () => clearInterval(intervalId);
  }

  private async executeCopyTrade(activity: Activity) {
    // 计算跟单数量（例如：10%）
    const copySize = (activity.usdcSize ?? 0) * 0.1;

    // 执行订单
    const result = await this.tradingService.createMarketOrder({
      tokenId: activity.asset,
      side: activity.side,
      amount: copySize,
      price: activity.price * 1.02, // 2% 滑点
      orderType: 'FOK',
    });

    console.log(`Copy trade: ${activity.proxyWallet} ${activity.side} ${copySize} USDC`);
    return result;
  }
}
```

---

## 配置参数

### 轮询间隔建议

| 监控钱包数 | 轮询间隔 | 请求频率 | 限流状态 |
|-----------|---------|---------|---------|
| 1-10 | 3秒 | 200 req/min | ✅ 安全 |
| 11-30 | 5秒 | 180-360 req/min | ⚠️ 接近 |
| 31-50 | 10秒 | 186-300 req/min | ⚠️ 临界 |
| 51+ | 15秒+ | 需分批 | ❌ 超限 |

**Data API 限流**：300 req/min

---

## 与 Subgraph 对比

| 维度 | Data API | Subgraph |
|------|----------|----------|
| **延迟** | 2-3秒 ⭐ | 5-15秒 |
| **查询方式** | 按地址查询 ⭐ | GraphQL 批量 |
| **市场信息** | ✅ 包含 | ❌ 缺失 |
| **限流** | 300/min | 无明确限制 |
| **数据完整性** | 高 ⭐ | 中 |
| **实现复杂度** | 低 ⭐ | 中 |

---

## 修复记录

### Bug 修复：Activity 缺少 proxyWallet 字段

**问题**：
- `Activity` 接口缺少 `proxyWallet` 字段
- `normalizeActivities` 方法没有提取该字段

**修复**（2026-02-08）：
1. 添加 `proxyWallet?: string` 到 `Activity` 接口
2. 更新 `normalizeActivities` 提取 `proxyWallet` 字段

**测试**：
```bash
npx tsx scripts/test-data-api-activity.ts
```

结果：✅ 所有 Activity 对象现在包含 `proxyWallet` 字段

---

## 性能优化

### 1. 并发查询

```typescript
// ✅ 好：并发查询多个钱包
const results = await Promise.all(
  wallets.map(w => dataApi.getActivity(w, params))
);

// ❌ 差：串行查询
for (const wallet of wallets) {
  const activities = await dataApi.getActivity(wallet, params);
}
```

### 2. 增量查询

```typescript
// ✅ 好：只查询新数据
const activities = await dataApi.getActivity(wallet, {
  start: lastCheckTimestamp, // Unix 秒
  limit: 100
});

// ❌ 差：每次查询所有历史
const activities = await dataApi.getActivity(wallet, { limit: 500 });
```

### 3. 限流控制

```typescript
// 如果钱包数 > 30，分批查询
const batchSize = 30;
for (let i = 0; i < wallets.length; i += batchSize) {
  const batch = wallets.slice(i, i + batchSize);
  const results = await Promise.all(
    batch.map(w => dataApi.getActivity(w, params))
  );
  await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒延迟
}
```

---

## 测试验证

### 测试脚本

```bash
# 测试 Data API /activity 端点
npx tsx scripts/test-data-api-activity.ts

# 测试 WebSocket Activity（已证明不可用）
npx tsx scripts/test-live-data-endpoint.ts
```

### 测试结果

| 功能 | 状态 | 说明 |
|------|------|------|
| Data API `/activity` | ✅ 可用 | 推荐使用 |
| WebSocket LIVE_DATA `activity` | ❌ 不可用 | 30秒内 0 条消息 |
| WebSocket USER Channel | ⚠️ 仅自己 | 需认证，只能看自己 |
| Subgraph Orderbook | ✅ 可用 | 备选方案 |

---

## 部署注意事项

### 1. 错误处理

```typescript
try {
  const activities = await dataApi.getActivity(wallet, params);
} catch (error) {
  if (error.code === 'RATE_LIMIT') {
    // 增加轮询间隔
    await new Promise(resolve => setTimeout(resolve, 10000));
  } else {
    console.error('Failed to fetch activities:', error);
  }
}
```

### 2. 去重

```typescript
const seenTxHashes = new Set<string>();

for (const activity of activities) {
  if (seenTxHashes.has(activity.transactionHash)) {
    continue; // 跳过重复
  }
  seenTxHashes.add(activity.transactionHash);

  await executeCopyTrade(activity);
}
```

### 3. 日志记录

```typescript
console.log(`[CopyTrading] Poll: ${targetWallets.length} wallets`);
console.log(`[CopyTrading] Found: ${activities.length} new trades`);
console.log(`[CopyTrading] Executed: ${executedCount} copy trades`);
```

---

## 参考文档

- **API 文档**: https://docs.polymarket.com/api-reference/core/get-user-activity
- **SDK 实现**: `src/clients/data-api.ts` (line 523-558)
- **测试脚本**: `scripts/test-data-api-activity.ts`
- **对比分析**: `docs/copy-trading-data-sources.md`

---

## 总结

✅ **Data API `/activity`** 是 Copy Trading 的最佳选择：
- 低延迟（2-3秒）
- 数据完整（proxyWallet, title, usdcSize）
- 实现简单（REST API）
- 适合实时监控

❌ **不推荐**：
- WebSocket Activity（不可用）
- User Channel（只能看自己）

⚠️ **备选**：
- Subgraph Orderbook（延迟较高，但无限流）
