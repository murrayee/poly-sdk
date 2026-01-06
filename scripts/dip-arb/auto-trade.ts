#!/usr/bin/env npx tsx
/**
 * DipArb Auto Trading - 15m Crypto Markets
 *
 * 策略原理：
 * 1. 检测 10 秒内 5% 以上的瞬时暴跌
 * 2. 买入暴跌侧 (Leg1)
 * 3. 等待对侧价格下降，满足 sumTarget 后买入 (Leg2)
 * 4. 双持仓锁定利润：UP + DOWN = $1
 *
 * 日志：每个市场单独一个日志文件，存放在 /tmp/dip-arb-logs/
 *
 * Run with:
 *   npx tsx scripts/dip-arb/auto-trade.ts --eth
 *   npx tsx scripts/dip-arb/auto-trade.ts --btc
 *   npx tsx scripts/dip-arb/auto-trade.ts --sol
 *   npx tsx scripts/dip-arb/auto-trade.ts --xrp
 */

import * as fs from 'fs';
import * as path from 'path';
import { PolymarketSDK } from '../../src/index.js';

// ========================================
// Parse Command Line Arguments
// ========================================

type CoinType = 'BTC' | 'ETH' | 'SOL' | 'XRP';

function parseCoin(): CoinType {
  const args = process.argv.slice(2);

  if (args.includes('--btc') || args.includes('-b')) return 'BTC';
  if (args.includes('--eth') || args.includes('-e')) return 'ETH';
  if (args.includes('--sol') || args.includes('-s')) return 'SOL';
  if (args.includes('--xrp') || args.includes('-x')) return 'XRP';

  // Default to ETH if no argument provided
  console.log('No coin specified, defaulting to ETH');
  console.log('Usage: npx tsx scripts/dip-arb/auto-trade.ts [--btc|-b] [--eth|-e] [--sol|-s] [--xrp|-x]');
  return 'ETH';
}

const SELECTED_COIN = parseCoin();

// Config
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const MONITOR_DURATION_MS = 60 * 60 * 1000; // 1 hour
const LOG_DIR = '/tmp/dip-arb-logs';

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  process.exit(1);
}

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ========================================
// Per-Market Logging
// ========================================

let currentMarketSlug: string | null = null;
let currentLogs: string[] = [];
let currentLogPath: string | null = null;

function getLogFilename(marketSlug: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const time = new Date().toISOString().slice(11, 19).replace(/:/g, ''); // HHMMSS
  return path.join(LOG_DIR, `${date}_${time}_${marketSlug}.log`);
}

function log(msg: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  currentLogs.push(line);
}

function sdkLogHandler(message: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  currentLogs.push(line);
}

function saveCurrentLog(suffix?: string) {
  if (currentLogs.length === 0) return;

  const logPath = currentLogPath || path.join(LOG_DIR, `unknown_${Date.now()}.log`);
  const finalPath = suffix ? logPath.replace('.log', `_${suffix}.log`) : logPath;

  fs.writeFileSync(finalPath, currentLogs.join('\n'));
  console.log(`📁 Log saved: ${finalPath} (${currentLogs.length} lines)`);
}

function startNewMarketLog(marketSlug: string) {
  // Save previous market log if exists
  if (currentLogs.length > 0 && currentMarketSlug) {
    saveCurrentLog();
  }

  // Start new log
  currentMarketSlug = marketSlug;
  currentLogs = [];
  currentLogPath = getLogFilename(marketSlug);

  log(`📝 New log file: ${currentLogPath}`);
}

// ========================================
// Main
// ========================================

async function main() {
  // ========================================
  // Configuration
  // ========================================
  const config = {
    // 交易参数
    shares: 25,             // 每次交易总份数 (最低 100 确保 $1 最低限额: 100 × $0.01 = $1)
    sumTarget: 0.95,         // 放宽到 0.95 提高 Leg2 成交率 (5%+ 利润)

    // 订单拆分参数
    splitOrders: 1,          // ✅ 改为 1，避免份额不匹配问题
    orderIntervalMs: 500,    // 订单间隔 500ms (仅在 splitOrders > 1 时使用)

    // 信号检测参数
    slidingWindowMs: 10000,  // 10 秒滑动窗口
    dipThreshold: 0.20,      // 20% 跌幅触发 Leg1
    windowMinutes: 14,       // 轮次开始后 14 分钟内可交易

    // 执行参数
    maxSlippage: 0.02,       // ✅ 提高到 3% 滑点，确保成交
    autoExecute: true,       // 自动执行
    executionCooldown: 500,  // 冷却时间 500ms

    // 其他
    enableSurge: false,      // 禁用暴涨检测
    autoMerge: true,         // 自动 merge
    leg2TimeoutSeconds: 9999, // 禁用止损：持有到期，等待市场结算后自动赎回

    debug: true,             // 调试日志

    // 日志处理器 - 将 SDK 日志也写入当前 market 的 logs 数组
    logHandler: sdkLogHandler,
  };

  // 计算预期利润率
  const expectedProfit = ((1 - config.sumTarget) / config.sumTarget * 100).toFixed(1);

  // Start initial log
  startNewMarketLog('init');

  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log(`║           DipArb Auto Trading - ${SELECTED_COIN} Markets              ║`);
  log('╠══════════════════════════════════════════════════════════╣');
  log(`║  Dip Threshold:   ${(config.dipThreshold * 100).toFixed(0)}% in ${config.slidingWindowMs / 1000}s window                    ║`);
  log(`║  Sum Target:      ${config.sumTarget} (profit >= ${expectedProfit}%)                   ║`);
  log(`║  Auto Execute:    ${config.autoExecute ? 'YES' : 'NO'}                                        ║`);
  log(`║  Log Directory:   ${LOG_DIR}`);
  log('╚══════════════════════════════════════════════════════════╝');
  log('');

  // Initialize SDK
  log('Initializing SDK...');
  const sdk = new PolymarketSDK({
    privateKey: PRIVATE_KEY,
  });

  sdk.dipArb.updateConfig(config);

  // ========================================
  // Event Listeners
  // ========================================

  sdk.dipArb.on('started', (market) => {
    // Start new log for this market
    startNewMarketLog(market.slug || market.conditionId.slice(0, 20));

    log('');
    log('┌──────────────────────────────────────────────────────────┐');
    log('│                    MARKET STARTED                        │');
    log('├──────────────────────────────────────────────────────────┤');
    log(`│ ${market.name.slice(0, 56)}`);
    log(`│ ${market.underlying} ${market.durationMinutes}m`);
    log(`│ End Time: ${market.endTime.toISOString()}`);
    log(`│ Condition: ${market.conditionId.slice(0, 30)}...`);
    log('└──────────────────────────────────────────────────────────┘');
  });

  sdk.dipArb.on('stopped', () => {
    log('>>> SERVICE STOPPED');
  });

  sdk.dipArb.on('newRound', (event) => {
    const sum = event.upOpen + event.downOpen;
    log(`>>> NEW ROUND | UP: ${event.upOpen.toFixed(3)} | DOWN: ${event.downOpen.toFixed(3)} | Sum: ${sum.toFixed(3)}`);
  });

  sdk.dipArb.on('signal', (signal) => {
    log('');
    log('╔══════════════════════════════════════════════════════════╗');
    if (signal.type === 'leg1') {
      log(`║  LEG1 SIGNAL: Buy ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)}`);
      log(`║  Drop: ${(signal.dropPercent * 100).toFixed(1)}% | Opposite: ${signal.oppositeAsk.toFixed(4)}`);
    } else {
      log(`║  LEG2 SIGNAL: Buy ${signal.hedgeSide} @ ${signal.currentPrice.toFixed(4)}`);
      log(`║  Total Cost: ${signal.totalCost.toFixed(4)} | Profit: ${(signal.expectedProfitRate * 100).toFixed(2)}%`);
    }
    log('╚══════════════════════════════════════════════════════════╝');
  });

  sdk.dipArb.on('execution', (result) => {
    if (result.success) {
      log(`✅ ${result.leg.toUpperCase()} FILLED: ${result.side} @ ${result.price?.toFixed(4)} x${result.shares}`);
    } else {
      log(`❌ ${result.leg.toUpperCase()} FAILED: ${result.error}`);
    }
  });

  sdk.dipArb.on('roundComplete', (result) => {
    log('');
    log('┌──────────────────────────────────────────────────────────┐');
    log(`│  ROUND ${result.status.toUpperCase()}`);
    if (result.profit !== undefined) {
      log(`│  Profit: $${result.profit.toFixed(4)} (${(result.profitRate! * 100).toFixed(2)}%)`);
    }
    log('└──────────────────────────────────────────────────────────┘');
  });

  sdk.dipArb.on('rotate', (event) => {
    // Save current market log before rotation
    log('');
    log('╔══════════════════════════════════════════════════════════╗');
    log(`║  🔄 MARKET ROTATION                                      ║`);
    log(`║  Reason: ${event.reason}`);
    log(`║  Previous: ${event.previousMarket?.slice(0, 40) || 'none'}...`);
    log(`║  New: ${event.newMarket.slice(0, 40)}...`);
    log('╚══════════════════════════════════════════════════════════╝');

    // Save old log and start new one
    // Note: 'started' event will be triggered after rotate, which will start new log
  });

  sdk.dipArb.on('settled', (result) => {
    log(`>>> SETTLED: ${result.strategy} | Success: ${result.success}`);
    if (result.amountReceived) {
      log(`    Amount: $${result.amountReceived.toFixed(2)}`);
    }
    if (result.error) {
      log(`    Error: ${result.error}`);
    }
  });

  sdk.dipArb.on('error', (error) => {
    log(`[ERROR] ${error.message}`);
  });

  // ========================================
  // Scan and Start
  // ========================================

  log(`Scanning for ${SELECTED_COIN} 15m markets...`);
  const markets = await sdk.dipArb.scanUpcomingMarkets({
    coin: SELECTED_COIN,
    duration: '15m',
    limit: 5,
  });

  log(`Found ${markets.length} markets:`);
  for (const m of markets) {
    const endIn = Math.round((m.endTime.getTime() - Date.now()) / 60000);
    const status = endIn <= 0 ? '(ENDED)' : `(ends in ${endIn}m)`;
    log(`  - ${m.name.slice(0, 50)} ${status}`);
    log(`    Condition: ${m.conditionId.slice(0, 30)}...`);
    log(`    End: ${m.endTime.toISOString()}`);
  }

  if (markets.length === 0) {
    log('No markets found. Exiting.');
    saveCurrentLog('no-markets');
    return;
  }

  // Filter out already ended markets
  const activeMarkets = markets.filter(m => m.endTime.getTime() > Date.now());
  if (activeMarkets.length === 0) {
    log('All markets have ended. Waiting for new markets...');
  } else {
    log(`Active markets: ${activeMarkets.length}`);
  }

  // Start
  const market = await sdk.dipArb.findAndStart({
    coin: SELECTED_COIN,
    preferDuration: '15m',
  });

  if (!market) {
    log('Failed to start. Exiting.');
    saveCurrentLog('failed');
    return;
  }

  log(`Selected market ends at: ${market.endTime.toISOString()}`);
  const timeUntilEnd = Math.round((market.endTime.getTime() - Date.now()) / 1000);
  log(`Time until market end: ${timeUntilEnd}s (${Math.round(timeUntilEnd / 60)}m)`);

  // Enable auto-rotate with redeem strategy
  sdk.dipArb.enableAutoRotate({
    enabled: true,
    underlyings: [SELECTED_COIN],
    duration: '15m',
    settleStrategy: 'redeem',  // 等待市场结算后赎回 (5分钟后)
    autoSettle: true,
    preloadMinutes: 2,
    redeemWaitMinutes: 5,       // 市场结束后等待 5 分钟再赎回
    redeemRetryIntervalSeconds: 30,  // 每 30 秒检查一次
  });
  log(`Auto-rotate enabled for ${SELECTED_COIN} (with background redemption)`);

  log('');
  log('═══════════════════════════════════════════════════════════');
  log('  AUTO TRADING ACTIVE - Press Ctrl+C to stop');
  log('═══════════════════════════════════════════════════════════');
  log('');

  // Status update every 30 seconds (more frequent to catch rotation)
  let statusCount = 0;
  const statusInterval = setInterval(() => {
    const stats = sdk.dipArb.getStats();
    const round = sdk.dipArb.getCurrentRound();
    const currentMarket = sdk.dipArb.getMarket();
    statusCount++;

    // Check if market has ended
    if (currentMarket) {
      const timeLeft = Math.round((currentMarket.endTime.getTime() - Date.now()) / 1000);
      const timeLeftStr = timeLeft > 0 ? `${timeLeft}s left` : `ENDED ${-timeLeft}s ago`;
      log(`[Status #${statusCount}] Market: ${currentMarket.underlying} | ${timeLeftStr} | Signals: ${stats.signalsDetected} | L1: ${stats.leg1Filled} | L2: ${stats.leg2Filled}`);
    } else {
      log(`[Status #${statusCount}] No market active | Signals: ${stats.signalsDetected}`);
    }

    // Show current position
    if (round) {
      if (round.phase === 'leg1_filled' && round.leg1) {
        log(`  📊 Position: ${round.leg1.shares}x ${round.leg1.side} @ ${round.leg1.price.toFixed(4)} | Waiting for Leg2...`);
      } else if (round.phase === 'completed' && round.leg1 && round.leg2) {
        const totalCost = round.leg1.price + round.leg2.price;
        const profit = (1 - totalCost) * round.leg1.shares;
        log(`  📊 Position: ${round.leg1.shares}x UP + ${round.leg2.shares}x DOWN | Cost: ${totalCost.toFixed(4)} | Profit: $${profit.toFixed(2)}`);
      } else if (round.phase === 'waiting') {
        log(`  📊 Position: None (waiting for signal)`);
      }
    }
  }, 30000);

  // Wait
  await new Promise(resolve => setTimeout(resolve, MONITOR_DURATION_MS));

  // Cleanup
  clearInterval(statusInterval);

  // Final stats
  const stats = sdk.dipArb.getStats();
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║                     FINAL STATS                          ║');
  log('╠══════════════════════════════════════════════════════════╣');
  log(`║ Running Time:     ${Math.round(stats.runningTimeMs / 1000)}s`);
  log(`║ Rounds Monitored: ${stats.roundsMonitored}`);
  log(`║ Signals Detected: ${stats.signalsDetected}`);
  log(`║ Leg1 Filled:      ${stats.leg1Filled}`);
  log(`║ Leg2 Filled:      ${stats.leg2Filled}`);
  log(`║ Total Profit:     $${stats.totalProfit.toFixed(2)}`);
  log('╚══════════════════════════════════════════════════════════╝');

  await sdk.dipArb.stop();
  sdk.stop();

  // Save final log
  saveCurrentLog('final');
}

// Handle Ctrl+C
process.on('SIGINT', async () => {
  log('');
  log('Interrupted. Saving logs...');
  saveCurrentLog('interrupted');
  process.exit(0);
});

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  console.error(err);
  saveCurrentLog('error');
  process.exit(1);
});
