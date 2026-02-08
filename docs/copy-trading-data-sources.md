# Copy Trading 数据源对比

## 可用方案

### 1. Data API - `/activity` 端点
**文档**: https://docs.polymarket.com/api-reference/core/get-user-activity
**实现**: `DataApiClient.getActivity(address, params)`

### 2. Subgraph - Orderbook
**文档**: https://docs.polymarket.com/developers/subgraph/overview
**实现**: `SubgraphClient.getOrderFilledEvents(params)`

---

## 详细对比

| 维度 | Data API `/activity` | Subgraph Orderbook |
|------|---------------------|-------------------|
| **API 类型** | REST (HTTP) | GraphQL |
| **端点** | `https://data-api.polymarket.com/activity` | `https://api.goldsky.com/.../orderbook-subgraph` |
| **限流** | 300 req/min | 无明确限制 |
| **单次最大** | 500 条 | 1000+ 条 |
| **分页限制** | offset ≤ 10,000 | 无硬性限制 |
| **时间过滤** | ✅ `start` / `end` (Unix秒) | ✅ `timestamp_gt` / `timestamp_lt` |

---

## 数据字段对比

### Data API `/activity` 返回 `Activity[]`

```typescript
interface Activity {
  // 交易类型
  type: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION';
  side: 'BUY' | 'SELL';

  // 交易数据
  size: number;              // 成交数量
  price: number;             // 成交价格
  usdcSize?: number;         // USDC 金额

  // 市场标识
  asset: string;             // Token ID
  conditionId: string;       // 市场 ID
  outcome: string;           // 结果 (Yes/No)
  outcomeIndex?: number;

  // 交易信息
  timestamp: number;         // Unix 毫秒
  transactionHash: string;
  proxyWallet?: string;      // ✅ 钱包地址（已修复）

  // 市场元数据
  title?: string;            // ✅ 市场标题
  slug?: string;             // ✅ 市场 slug

  // 交易者信息
  name?: string;             // ✅ 用户名
}
```

**关键优势**：
- ✅ **查询时指定地址** - `getActivity(address, params)` 第一个参数
- ✅ **返回 `proxyWallet`** - 所有 Activity 包含交易者地址（已修复）
- ✅ 包含市场元数据（title, slug）
- ✅ 包含 USDC 金额
- ✅ 数据更丰富（包含 SPLIT/MERGE 等）
- ✅ 延迟更低（2-3秒）

---

### Subgraph Orderbook 返回 `OrderFilledEvent[]`

```typescript
interface OrderFilledEvent {
  id: string;                  // 事件 ID
  transactionHash: string;
  timestamp: string;           // Unix 秒 (字符串)
  orderHash: string;

  // 交易双方
  maker: string;               // ✅ Maker 地址
  taker: string;               // ✅ Taker 地址

  // 成交数据
  makerAssetId: string;        // Maker 的 Token ID
  takerAssetId: string;        // Taker 的 Token ID
  makerAmountFilled: string;   // Maker 成交数量
  takerAmountFilled: string;   // Taker 成交数量
  fee: string;                 // 手续费
}
```

**关键优势**：
- ✅ **有交易者地址** - `maker` 和 `taker` 都有
- ✅ 可直接按地址过滤
- ✅ 包含双边信息（Maker + Taker）
- ❌ 无市场元数据（需额外查询 title/slug）
- ❌ 无用户名信息

---

## Copy Trading 使用建议

### 方案 A：Data API (推荐用于轮询所有活动)

**适用场景**：
- 监控多个钱包的综合活动
- 需要显示市场名称
- 需要 USDC 金额

**实现方式**：
```typescript
// 轮询间隔：3-5秒
const lastCheck = Math.floor(Date.now() / 1000) - 5;

const activities = await dataApi.getActivity(targetWallet, {
  type: 'TRADE',
  start: lastCheck,
  limit: 500,
});

for (const activity of activities) {
  if (activity.side === 'BUY') {
    // 执行跟单
    await executeCopyTrade(activity);
  }
}
```

**问题**：
- ❌ 无法直接按钱包地址过滤（需查询每个目标钱包）
- ⚠️ 如果监控 10 个钱包，需要 10 次 API 调用

---

### 方案 B：Subgraph Orderbook (推荐用于单钱包深度监控)

**适用场景**：
- 监控特定钱包的所有成交
- 需要 Maker/Taker 详细信息
- 对市场名称不敏感

**实现方式**：
```typescript
// 轮询间隔：5-10秒
const lastTimestamp = Math.floor(Date.now() / 1000) - 10;

const events = await subgraphClient.getOrderFilledEvents({
  where: {
    maker: targetWallet.toLowerCase(),
    timestamp_gt: lastTimestamp.toString()
  },
  orderBy: 'timestamp',
  orderDirection: 'desc',
  first: 100,
});

for (const event of events) {
  // 执行跟单
  await executeCopyTrade(event);
}
```

**优势**：
- ✅ 可以一次查询多个钱包（GraphQL `maker_in: [addr1, addr2]`）
- ✅ 包含完整的成交信息
- ✅ 可以同时监控 Maker 和 Taker 侧

---

## 混合方案（最佳实践）

### 实时监控：Subgraph Orderbook
```typescript
// 每 5 秒查询一次
const recentEvents = await subgraphClient.getOrderFilledEvents({
  where: {
    maker_in: targetWallets.map(w => w.toLowerCase()),
    timestamp_gt: lastCheckTimestamp
  },
  orderBy: 'timestamp',
  first: 100,
});
```

### 元数据补充：Data API
```typescript
// 获取市场信息（缓存）
const marketInfo = await gammaApi.getMarket(conditionId);
console.log(`${trader} bought ${size} @ ${price} in "${marketInfo.question}"`);
```

---

## 性能对比

| 指标 | Data API | Subgraph |
|------|----------|----------|
| **延迟** | 2-3秒 | 5-15秒 (索引延迟) |
| **限流** | 300/min | 无明确限制 |
| **批量查询** | ❌ 需多次请求 | ✅ GraphQL 支持 |
| **实时性** | 较高 | 较低 |
| **数据完整性** | 高 | 中 |

---

## 推荐方案总结

### 🥇 推荐：Data API `/activity` ⭐

**原因**：
1. ✅ 可以按地址精确查询 - `getActivity(address, params)`
2. ✅ 延迟更低（2-3秒 vs Subgraph 5-15秒）
3. ✅ 包含市场元数据（title, slug）
4. ✅ 包含 USDC 金额
5. ✅ 返回 `proxyWallet` 字段（已修复）
6. ✅ 数据更丰富（SPLIT/MERGE/REDEEM 等）

**缺点**：
- ⚠️ 需要为每个目标钱包单独查询（可并发）
- ⚠️ 分页限制 10,000 条（但可用时间过滤）

### 🥈 备选：Subgraph Orderbook

**原因**：
1. ✅ 支持批量查询（GraphQL `maker_in: [...]`）
2. ✅ 包含双边信息（Maker + Taker）
3. ✅ 无硬性分页限制

**缺点**：
- ❌ 索引延迟 5-15秒（更慢）
- ❌ 无市场名称（需额外查询）
- ❌ 数据较少（只有成交事件）

---

## 实现建议

对于 `SmartMoneyService`，推荐使用 **Data API `/activity`** 实现：

```typescript
async pollSmartMoneyTrades(targetWallets: string[]): Promise<Activity[]> {
  const lastCheck = Math.floor(Date.now() / 1000) - 5; // 5 seconds ago

  // 并发查询所有目标钱包
  const results = await Promise.all(
    targetWallets.map(wallet =>
      this.dataApi.getActivity(wallet, {
        type: 'TRADE',
        start: lastCheck,
        limit: 100,
        sortBy: 'TIMESTAMP',
        sortDirection: 'DESC',
      })
    )
  );

  // 合并并按时间排序
  return results
    .flat()
    .sort((a, b) => b.timestamp - a.timestamp);
}
```

**轮询间隔**：**3-5秒**（延迟低，可以更频繁）

**优势**：
- ✅ 延迟 2-3秒（vs Subgraph 5-15秒）
- ✅ 包含市场名称（无需额外查询）
- ✅ 包含 USDC 金额（直接显示）
- ✅ 包含交易者信息（name, profileImage）

**限流注意**：
- Data API 限流：300 req/min
- 如果监控 10 个钱包，5秒轮询 = 120 req/min ✅
- 如果监控 50 个钱包，需要 10秒轮询 = 300 req/min ⚠️
