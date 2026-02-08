# Smart Money Scripts

测试和演示 SmartMoneyService 功能的脚本集合。

---

## 📋 脚本列表（按功能分组）

### ✅ 基础测试（推荐先运行）

#### 01-test-history.ts
测试历史数据查询和转换逻辑。

```bash
npx tsx scripts/smart-money/01-test-history.ts
```

**功能**：
- 查询 Smart Money 钱包的历史交易
- 验证 Activity → SmartMoneyTrade 转换
- 检查数据完整性（proxyWallet, title, usdcSize）

**适合**：验证 Data API 集成是否正常

---

#### 02-test-polling.ts
测试轮询机制和实时监控。

```bash
npx tsx scripts/smart-money/02-test-polling.ts
```

**功能**：
- 监控多个 Smart Money 钱包
- 实时轮询 (5-7秒间隔)
- 验证订阅/取消订阅
- 过滤逻辑测试

**适合**：验证轮询和过滤机制

---

#### 03-test-service.ts
测试 SmartMoneyService 完整功能。

```bash
npx tsx scripts/smart-money/03-test-service.ts
```

**功能**：
- Smart Money 检测
- 实时交易订阅
- 持仓同步
- 综合服务测试

**适合**：全面功能验证

---

### 🤖 跟单测试（需要私钥）

#### 04-auto-copy-simple.ts
简单的自动跟单示例（Dry Run）。

```bash
PRIVATE_KEY=0x... npx tsx scripts/smart-money/04-auto-copy-simple.ts
```

**功能**：
- 使用 SDK 简化 API
- 监控排行榜 Top 50
- Dry run 模式（不实际下单）
- 展示三种初始化方式

**适合**：学习 SDK 使用和跟单逻辑

---

#### 05-auto-copy-trading.ts
完整的自动跟单实现。

```bash
PRIVATE_KEY=0x... npx tsx scripts/smart-money/05-auto-copy-trading.ts
```

**功能**：
- 完整跟单逻辑
- 订单执行
- 风险控制（sizeScale, maxSize, slippage）
- 实时统计报告

**适合**：生产环境前测试

⚠️ **警告**：需要真实私钥和资金

---

#### 06-real-copy-test.ts
真实环境跟单测试。

```bash
PRIVATE_KEY=0x... npx tsx scripts/smart-money/06-real-copy-test.ts
```

**功能**：
- 实际下单测试
- 成交验证
- 性能监控

**适合**：最终验证

⚠️ **警告**：会使用真实资金

---

### 🧪 E2E 测试（完整集成）

#### 07-e2e.ts
完整 E2E 测试（使用 SmartMoneyService）。

```bash
PRIVATE_KEY=0x... npx tsx scripts/smart-money/07-e2e.ts
```

**功能**：
- 完整流程测试
- Smart Money 发现
- 自动跟单
- 结果验证

**适合**：集成测试

---

## 🚀 推荐使用顺序

### 1. 初次使用（开发阶段）
```bash
# 验证基础功能
npx tsx scripts/smart-money/01-test-history.ts
npx tsx scripts/smart-money/02-test-polling.ts
npx tsx scripts/smart-money/03-test-service.ts
```

**预期**：确认 Data API 轮询正常工作

---

### 2. 测试跟单逻辑
```bash
# Dry run 测试（安全，不会下单）
PRIVATE_KEY=0x... npx tsx scripts/smart-money/04-auto-copy-simple.ts
```

**预期**：看到交易信号但不实际下单

---

### 3. 生产环境准备
```bash
# ⚠️ 会使用真实资金！先用小额测试
PRIVATE_KEY=0x... npx tsx scripts/smart-money/05-auto-copy-trading.ts
PRIVATE_KEY=0x... npx tsx scripts/smart-money/06-real-copy-test.ts
```

**预期**：实际下单并成交

---

### 4. 完整验证
```bash
# E2E 测试
PRIVATE_KEY=0x... npx tsx scripts/smart-money/07-e2e.ts
```

**预期**：完整流程验证通过

---

## 📊 功能对比

| 脚本 | 监控 | 跟单 | 下单 | 资金 | 用途 |
|------|------|------|------|------|------|
| 01 | ✅ | ❌ | ❌ | ❌ | 验证历史数据 |
| 02 | ✅ | ❌ | ❌ | ❌ | 验证轮询机制 |
| 03 | ✅ | ✅ | ❌ | ❌ | 验证服务功能 |
| 04 | ✅ | ✅ | ❌ | ❌ | 学习 SDK API |
| 05 | ✅ | ✅ | ✅ | ⚠️ | 生产测试 |
| 06 | ✅ | ✅ | ✅ | ⚠️ | 真实验证 |
| 07 | ✅ | ✅ | ✅ | ⚠️ | 集成测试 |

---

## 🔧 环境变量

| 变量 | 说明 | 必需脚本 |
|------|------|----------|
| `PRIVATE_KEY` | 钱包私钥 (0x...) | 04-07 |

---

## ⚠️ 安全提示

### 使用真实资金前

1. ✅ 在测试网测试所有功能
2. ✅ 使用小额资金（$10-50）测试
3. ✅ 设置严格的风险控制参数：
   - `sizeScale: 0.01` (1% 跟单)
   - `maxSizePerTrade: 10` ($10 最大)
   - `maxSlippage: 0.03` (3% 滑点)
4. ✅ 监控所有交易并验证
5. ✅ 准备好随时停止（Ctrl+C）

### 风险控制参数示例

```typescript
await sdk.smartMoney.startAutoCopyTrading({
  topN: 10,
  sizeScale: 0.01,        // 只跟 1%
  maxSizePerTrade: 10,    // 最多 $10
  maxSlippage: 0.03,      // 3% 滑点
  minTradeSize: 50,       // 只跟 ≥$50 的交易
  dryRun: true,           // 先 dry run 测试
});
```

---

## 🐛 故障排除

### 问题 1: 没有检测到交易

**可能原因**：
- 监控的钱包不活跃
- 轮询间隔内没有新交易
- 时间窗口太短

**解决方案**：
```bash
# 使用日排行榜（更活跃）
const leaderboard = await sdk.smartMoney.getLeaderboard({
  period: 'day',  // 而不是 'week'
  limit: 100,
});

# 延长测试时间
const MAX_WAIT_TIME = 300000; // 5 分钟
```

---

### 问题 2: 限流错误 (429)

**可能原因**：
- 监控钱包过多（>30）
- 轮询间隔太短
- Data API 限流 (300 req/min)

**解决方案**：
- 减少监控钱包数量
- 自动调整轮询间隔（代码已实现）
- 分批监控

**限流计算**：
- 10 钱包 × 5秒轮询 = 120 req/min ✅
- 30 钱包 × 7秒轮询 = 257 req/min ✅
- 50 钱包 × 10秒轮询 = 300 req/min ⚠️

---

### 问题 3: 订单失败

**可能原因**：
- 滑点太小
- 流动性不足
- 余额不足

**解决方案**：
```typescript
// 增加滑点
maxSlippage: 0.05  // 5%

// 检查余额
const balance = await tradingService.getBalance();
console.log(`Available: ${balance} USDC`);
```

---

## 🔄 重构说明（2026-02-08）

### 核心变更

- ❌ WebSocket Activity 订阅（不可用）
- ✅ Data API `/activity` 轮询（推荐）

### 延迟对比

| 方案 | 延迟 | 状态 |
|------|------|------|
| WebSocket | <100ms | ❌ 不可用 |
| Data API 轮询 | 7-13秒 | ✅ 可用 |

**总延迟 = Data API 延迟 (2-3s) + 轮询间隔 (5-10s)**

### 适用场景

- ✅ 中长期跟单（几分钟到几小时）
- ⚠️ 不适合秒级套利

---

## 📚 相关文档

- **重构总结**: `../../docs/smart-money-service-refactor.md`
- **实现方案**: `../../docs/copy-trading-implementation.md`
- **数据源对比**: `../../docs/copy-trading-data-sources.md`
- **API 文档**: https://docs.polymarket.com/api-reference/core/get-user-activity

---

## 🎯 关键发现

1. **Activity WebSocket 不可用** → 改用 Data API 轮询
2. **Data API 包含 proxyWallet** → 可按地址查询
3. **自适应轮询间隔** → 根据钱包数量自动调整（5-10秒）
4. **自动去重** → 使用 txHash 防止重复处理
5. **限流管理** → 监控 30+ 钱包需注意 300 req/min 限制
