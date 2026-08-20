// ============================================================
//  MAIN — Entry point for Phoenix Delta-Neutral Bot
// ============================================================
// Mode 1: Delta-neutral trading
// Mode 2: Close all positions
// Mode 3: Check balances
// Mode 4: Claim rewards
// Mode 5: Deposit USDC
// Mode 6: Withdraw USDC
// ============================================================

import { createInterface } from 'node:readline';

import { EXECUTION_MODE, ID_FILTER, LEVERAGE, SHUFFLE_WALLETS } from './settings.js';
import { DeltaNeutralController } from './modules/controller.js';
import { closeLeaderFollower } from './modules/close-strategy.js';
import { PhoenixService } from './modules/phoenix-service.js';
import { sendTg } from './modules/telegram.js';
import {
  loadWallets,
  readProxies,
  saveEncryptedWallets,
  loadEncryptedWallets,
  createKeypair,
  checkAssignedProxiesHealth,
  readPrivateKeyEntries,
  type WalletAccount,
} from './modules/wallet.js';
import { filterWalletsById, type WalletIdFilter } from './modules/wallet-filter.js';
import { sleep, shuffleArray, shortAddr } from './modules/utils.js';
import {
  acquireTradingLock,
  clearTradingHalt,
  releaseTradingLock,
  requestTradingHalt,
} from './modules/runtime-control.js';

const TOKENS_TO_TRADE = Object.keys(LEVERAGE);

// ==================== BANNER ====================

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════════════════╗
║     🔥 PHOENIX DELTA-NEUTRAL VOLUME BOT 🔥       ║
║                                                  ║
║     Phoenix Trade | Solana Perps                 ║
║     Delta-Neutral Volume Farming                 ║
╚══════════════════════════════════════════════════╝
`);
}

// ==================== MODE SELECTOR ====================

function askMode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `\nВыбери режим:\n  1 = Дельта-нейтральная торговля\n  2 = Закрыть все позиции\n  3 = Проверить балансы\n  4 = Клеймить награды\n  5 = Пополнить биржу с кошелька\n  6 = Вывод средств\n  7 = Снять все ордера\n\n> `,
      (answer) => {
        rl.close();
        resolve(answer.trim());
      }
    );
  });
}

// ==================== WALLET INITIALIZATION ====================

async function initWallets(): Promise<WalletAccount[]> {
  // Always read from privatekeys.txt to check for changes and preserve physical line IDs.
  const keyEntries = readPrivateKeyEntries();
  const rawKeys = keyEntries.map((entry) => entry.privateKey);
  const txtAddresses = rawKeys.map((k) => createKeypair(k).publicKey.toString());

  // Try loading from encrypted storage
  const encrypted = loadEncryptedWallets();

  if (encrypted && encrypted.length > 0) {
    const dbAddresses = encrypted.map((w) => w.address);

    // Compare: same count and same addresses in same order?
    const match =
      txtAddresses.length === dbAddresses.length &&
      txtAddresses.every((addr, i) => addr === dbAddresses[i]);

    if (match) {
      console.log(`🔓 Loaded ${encrypted.length} wallet(s) from encrypted storage`);
      const wallets = encrypted.map((wallet, index) => ({
        ...wallet,
        id: keyEntries[index]!.id,
      }));
      await checkAssignedProxiesHealth(wallets);
      return wallets;
    }

    console.log(`\n🔄 privatekeys.txt changed (${txtAddresses.length} keys) vs DB (${dbAddresses.length} keys) — re-encrypting...`);
  } else {
    console.log('\n📂 First run — loading wallets from privatekeys.txt...');
  }

  // Load from txt and encrypt
  const wallets = await loadWallets(keyEntries);
  saveEncryptedWallets(rawKeys, wallets);

  return wallets;
}

// ==================== SERVICE CREATION ====================

async function createServices(wallets: WalletAccount[]): Promise<PhoenixService[]> {
  const results = await Promise.allSettled(
    wallets.map(async (wallet) => {
      const service = new PhoenixService(wallet.keypair, wallet.proxyUrl);

      // loginHandler already runs ensureRegistered() after auth
      await service.loginHandler();

      return service;
    })
  );

  const services: PhoenixService[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      services.push(result.value);
    } else {
      console.log(`  ❌ ${shortAddr(wallets[i]!.address)} | ${result.reason?.message ?? result.reason}`);
    }
  }

  return services;
}

// ==================== MODE 1: DELTA-NEUTRAL ====================

async function runDeltaNeutral(services: PhoenixService[]): Promise<void> {
  console.log('\n🚀 Starting delta-neutral trading...');

  const controller = new DeltaNeutralController();
  controllerRef = controller;
  controller.setProxyPool(readProxies());

  // Register all services with their balances
  for (const service of services) {
    try {
      const balance = await service.getUsdcBalance();
      controller.register(service, balance);
    } catch (e: any) {
      console.log(`  ⚠️ Failed to get balance for ${shortAddr(service.getAddress())}: ${e.message}`);
    }
  }

  // Stale orders from an interrupted run (killed close limits) must not
  // interfere with the new cycle.
  await Promise.all(services.flatMap((service) => TOKENS_TO_TRADE.map(async (symbol) => {
    try {
      await service.cancelAllOrders(symbol);
    } catch (e: any) {
      console.log(`  ⚠️ ${shortAddr(service.getAddress())} ${symbol} stale-order cleanup: ${e.message}`);
    }
  })));

  // Run the controller loop
  try {
    controllerDone = controller.run();
    await controllerDone;
  } finally {
    controllerDone = null;
    controllerRef = null;
    releaseTradingLock();
  }
}

// ==================== MODE 2: CLOSE ALL ====================

async function closeAllPositions(services: PhoenixService[]): Promise<void> {
  // Расширяем литерал settings.ts до string — как в close-strategy.ts
  const mode: string = EXECUTION_MODE;
  const closeStyle = mode === 'market' ? 'all via MARKET' : 'both sides maker LIMIT';
  console.log(`\n🔄 Closing all positions (${closeStyle})...`);

  // Cancel configured-symbol orders on every wallet, including wallets that do
  // not currently have a position but may still have a resting entry order.
  await Promise.all(services.flatMap((service) => TOKENS_TO_TRADE.map(async (symbol) => {
    try {
      await service.cancelAllOrders(symbol, true);
    } catch (error: any) {
      console.log(`  ⚠️ ${shortAddr(service.getAddress())} ${symbol} cancel: ${error.message}`);
    }
  })));

  // Step 1: Snapshot balances + open positions per wallet
  const snapshot = await Promise.all(services.map(async (service) => {
    const addr = shortAddr(service.getAddress());
    try {
      const balanceBefore = await service.getUsdcBalance();
      const positions = await service.getOpenPositionSummaries();
      const volume = positions.reduce((s, p) => s + p.positionUsd, 0);
      const side = positions.length
        ? [...positions].sort((a, b) => b.positionUsd - a.positionUsd)[0]!.side
        : null;
      return { service, addr, balanceBefore, positions, volume, side, error: null as string | null };
    } catch (e: any) {
      console.log(`  ❌ ${addr} — snapshot failed: ${e.message}`);
      return { service, addr, balanceBefore: 0, positions: [], volume: 0, side: null, error: e.message as string };
    }
  }));

  // Step 2: Group positioned wallets by symbol, close leader-limit / follower-market
  const bySymbol = new Map<string, { service: PhoenixService; side: 'long' | 'short'; positionUsd: number }[]>();
  for (const s of snapshot) {
    for (const p of s.positions) {
      if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
      bySymbol.get(p.symbol)!.push({ service: s.service, side: p.side, positionUsd: p.positionUsd });
    }
  }

  for (const [symbol, entries] of bySymbol) {
    // Leader side = side of the single largest position
    const biggest = entries.reduce((a, b) => (b.positionUsd > a.positionUsd ? b : a));
    const limitSide = biggest.side;
    const limitAccounts = entries.filter((e) => e.side === limitSide);
    const marketAccounts = entries.filter((e) => e.side !== limitSide);
    await closeLeaderFollower(limitAccounts, marketAccounts, symbol);
  }

  // Step 3: Report per-wallet PnL
  const allPositions = snapshot.flatMap((s) => s.positions);
  const longVol = allPositions.filter((p) => p.side === 'long').reduce((sum, p) => sum + p.positionUsd, 0);
  const shortVol = allPositions.filter((p) => p.side === 'short').reduce((sum, p) => sum + p.positionUsd, 0);
  const maxSideVol = Math.max(longVol, shortVol);
  const deltaPct = maxSideVol > 0 ? (Math.abs(longVol - shortVol) / maxSideVol) * 100 : 0;

  const lines: string[] = ['📂 POSITIONS CLOSED | Force close', ''];
  lines.push(`🟢 LONG: $${longVol.toFixed(2)} | 🔴 SHORT: $${shortVol.toFixed(2)} | Δ: ${deltaPct.toFixed(2)}%`);
  if (deltaPct > 2) {
    lines.push(
      `⚠️ Книга закрыта с перекосом дельты ${deltaPct.toFixed(1)}% ` +
      `(${longVol > shortVol ? 'net LONG' : 'net SHORT'} $${Math.abs(longVol - shortVol).toFixed(0)})`
    );
  }
  lines.push('');
  let totalPnl = 0;
  let totalVolume = 0;
  let totalFees = 0;
  let totalFeesOpen = 0;
  let totalFeesClose = 0;
  let totalFunding = 0;
  let costsSeen = 0;

  for (const s of snapshot) {
    if (s.error) {
      lines.push(`❌ ${s.addr} | error: ${s.error}`);
      continue;
    }
    try {
      const balanceAfter = await s.service.getUsdcBalance();
      const pnl = balanceAfter - s.balanceBefore;
      totalPnl += pnl;
      totalVolume += s.volume;

      for (const sym of new Set(s.positions.map((p) => p.symbol))) {
        try {
          const costs = await s.service.getLastCycleCosts(sym);
          totalFees += costs.fees;
          totalFeesOpen += costs.feesOpen;
          totalFeesClose += costs.feesClose;
          totalFunding += costs.funding;
          costsSeen++;
        } catch {
          // non-critical
        }
      }

      if (s.side) {
        const emoji = s.side === 'long' ? '🟢' : '🔴';
        const sideLabel = s.side === 'long' ? 'LONG' : 'SHORT';
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlEmoji = pnl >= 0 ? '📈' : '📉';
        const line =
          `${emoji} ${sideLabel} ${s.addr} | ${pnlEmoji} PnL: ${pnlSign}${pnl.toFixed(4)}$ | ` +
          `Bal: $${balanceAfter.toFixed(2)} | Vol: $${s.volume.toFixed(2)}`;
        console.log(`  ✅ ${line}`);
        lines.push(line);
      } else {
        console.log(`  ✅ ${s.addr} — no open positions`);
        lines.push(`⚪ ${s.addr} | no open positions | Bal: $${balanceAfter.toFixed(2)}`);
      }
    } catch (e: any) {
      console.log(`  ❌ ${s.addr} — failed: ${e.message}`);
      lines.push(`❌ ${s.addr} | error: ${e.message}`);
    }
  }

  const costPer100k = totalVolume > 0 ? (-totalPnl / totalVolume) * 100_000 : 0;
  const pnlSign = totalPnl >= 0 ? '+' : '';
  const totalEmoji = totalPnl >= 0 ? '📈' : '📉';

  lines.push('');
  lines.push(`${totalEmoji} Total PnL: ${pnlSign}${totalPnl.toFixed(4)}$`);
  lines.push(`💰 Total Volume: $${totalVolume.toFixed(2)}`);
  if (costsSeen > 0) {
    const fundingSign = totalFunding >= 0 ? '+' : '';
    lines.push(
      `💸 Fees: -${totalFees.toFixed(4)}$ (open: -${totalFeesOpen.toFixed(4)}$, close: -${totalFeesClose.toFixed(4)}$) | ` +
      `Funding: ${fundingSign}${totalFunding.toFixed(4)}$`
    );
  }
  lines.push(` Cost per 100k: ${costPer100k.toFixed(3)}$`);

  console.log('\n✅ Close-all complete');
  console.log(lines.join('\n'));
  await sendTg(lines.join('\n'));
}

// ==================== MODE 3: CHECK BALANCES ====================

async function checkBalances(services: PhoenixService[]): Promise<void> {
  console.log('\n💰 Checking balances...\n');

  const results = await Promise.all(services.map(async (service) => {
    const addr = shortAddr(service.getAddress());
    try {
      const balance = await service.getUsdcBalance();
      console.log(`  ✅ ${addr} | $${balance.toFixed(2)}`);
      return { line: `✅ ${addr} | $${balance.toFixed(2)}`, balance };
    } catch (e: any) {
      console.log(`  ${addr} | error: ${e.message}`);
      return { line: `${addr} | error`, balance: 0 };
    }
  }));

  const totalBalance = results.reduce((s, r) => s + r.balance, 0);
  const lines: string[] = ['💰 Checked balances', ''];
  for (const r of results) lines.push(r.line);

  console.log(`\n  💎 Total: $${totalBalance.toFixed(2)} across ${services.length} wallet(s)`);
  lines.push('', `💎 Total: $${totalBalance.toFixed(2)} across ${services.length} wallet(s)`);
  await sendTg(lines.join('\n'));
}

// ==================== MODE 4: CLAIM REWARDS ====================

async function claimRewards(services: PhoenixService[]): Promise<void> {
  console.log('\n🎁 Claiming rewards...\n');

  const results = await Promise.all(services.map(async (service) => {
    const addr = shortAddr(service.getAddress());
    try {
      const result = await service.claimRewards();
      if (result.claimed) {
        return { line: `✅ ${addr} | +$${result.amountUsd.toFixed(2)}`, claimed: true, amount: result.amountUsd };
      } else {
        console.log(`  ℹ️ ${addr} | Nothing to claim`);
        return { line: '', claimed: false, amount: 0 };
      }
    } catch (e: any) {
      console.log(`  ⚠️ ${addr} | ${e.message}`);
      return { line: `⚠️ ${addr} | ${e.message}`, claimed: false, amount: 0 };
    }
  }));

  const lines: string[] = ['🎁 Claiming rewards', ''];
  let claimedCount = 0;
  let totalClaimed = 0;
  for (const r of results) {
    if (r.line) lines.push(r.line);
    if (r.claimed) { claimedCount++; totalClaimed += r.amount; }
  }

  lines.push('', `Claimed: $${totalClaimed.toFixed(2)} from ${claimedCount}/${services.length} wallet(s)`);

  if (claimedCount > 0) {
    console.log(`\n✅ Claimed $${totalClaimed.toFixed(2)} from ${claimedCount}/${services.length} wallet(s)`);
  } else {
    console.log('\nℹ️ Nothing to claim');
  }

  await sendTg(lines.join('\n'));
}

// ==================== MODE 5: DEPOSIT USDC ====================

async function depositUsdc(services: PhoenixService[]): Promise<void> {
  console.log('\n💰 Depositing USDC from wallets to exchange...\n');

  const results = await Promise.all(services.map(async (service) => {
    const addr = shortAddr(service.getAddress());
    try {
      const result = await service.depositUsdc();
      if (result.deposited > 0) {
        return { line: `✅ ${addr} | +$${result.deposited.toFixed(2)}`, deposited: result.deposited };
      }
      return { line: '', deposited: 0 };
    } catch (e: any) {
      console.log(`  ⚠️ ${addr} | ${e.message}`);
      return { line: `⚠️ ${addr} | ${e.message}`, deposited: 0 };
    }
  }));

  const lines: string[] = ['💰 Deposit USDC', ''];
  let totalDeposited = 0;
  let depositCount = 0;
  for (const r of results) {
    if (r.line) lines.push(r.line);
    if (r.deposited > 0) { depositCount++; totalDeposited += r.deposited; }
  }

  lines.push('', `Deposited: $${totalDeposited.toFixed(2)} from ${depositCount}/${services.length} wallet(s)`);

  if (depositCount > 0) {
    console.log(`\n✅ Deposited $${totalDeposited.toFixed(2)} from ${depositCount}/${services.length} wallet(s)`);
  } else {
    console.log('\nℹ️ Nothing to deposit');
  }

  await sendTg(lines.join('\n'));
}

// ==================== MODE 6: WITHDRAW USDC ====================

async function withdrawUsdc(services: PhoenixService[]): Promise<void> {
  console.log('\n💸 Withdrawing USDC from exchange to wallets...\n');

  const results = await Promise.all(services.map(async (service) => {
    const addr = shortAddr(service.getAddress());
    try {
      const result = await service.withdrawUsdc();
      if (result.withdrawn > 0) {
        return {
          line: `✅ ${addr} | +$${result.withdrawn.toFixed(2)} to wallet`,
          withdrawn: result.withdrawn,
        };
      }
      return { line: '', withdrawn: 0 };
    } catch (e: any) {
      console.log(`  ⚠️ ${addr} | ${e.message}`);
      return { line: `⚠️ ${addr} | ${e.message}`, withdrawn: 0 };
    }
  }));

  const lines: string[] = ['💸 Вывод средств', ''];
  let totalWithdrawn = 0;
  let withdrawCount = 0;
  for (const result of results) {
    if (result.line) lines.push(result.line);
    if (result.withdrawn > 0) {
      withdrawCount++;
      totalWithdrawn += result.withdrawn;
    }
  }

  lines.push(
    '',
    `Выведено: $${totalWithdrawn.toFixed(2)} с ${withdrawCount}/${services.length} кошельков`
  );

  if (withdrawCount > 0) {
    console.log(
      `\n✅ Withdrawn $${totalWithdrawn.toFixed(2)} to ` +
      `${withdrawCount}/${services.length} wallet(s)`
    );
  } else {
    console.log('\nℹ️ Nothing to withdraw');
  }

  await sendTg(lines.join('\n'));
}

// ==================== GRACEFUL SHUTDOWN ====================

let controllerRef: DeltaNeutralController | null = null;
let controllerDone: Promise<void> | null = null;
let servicesRef: PhoenixService[] = [];
let shuttingDown = false;

function setupShutdown(): void {
  const shutdown = async () => {
    if (shuttingDown) {
      console.log('\n⏳ Already stopping — cleaning up orders...');
      return;
    }
    shuttingDown = true;
    console.log('\n🛑 Stopped by user (Ctrl+C)');
    requestTradingHalt();
    controllerRef?.stop();
    try {
      if (controllerDone) {
        // in-flight цикл видит halt и сам снимает свои ордера
        await Promise.race([controllerDone, sleep(2000)]);
      } else {
        // режим 2: in-flight close-цикл видит halt и сам снимает лимитки
        await sleep(1500);
      }
      await Promise.race([cancelAllRestingOrders(), sleep(10_000)]);
    } catch {
      // cleanup best-effort — выходим в любом случае
    }
    releaseTradingLock();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Best-effort снять все висящие ордера на всех кошельках. */
async function cancelAllRestingOrders(): Promise<void> {
  if (servicesRef.length === 0) return;
  console.log('🧹 Cancelling resting orders...');
  const results = await Promise.allSettled(
    servicesRef.flatMap((service) =>
      TOKENS_TO_TRADE.map((symbol) => service.cancelAllOrders(symbol))
    )
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(
    failed === 0
      ? '✅ Resting orders cancelled'
      : `⚠️ Order cancel finished with ${failed} error(s)`
  );
}

// ==================== MAIN ====================

// Допустимые значения EXECUTION_MODE (settings.ts). Опечатка ловится здесь
// понятным сообщением, а не типом в пользовательском файле.
const VALID_EXECUTION_MODES = ['limit', 'leader-follower', 'market'];

async function main(): Promise<void> {
  printBanner();

  if (!VALID_EXECUTION_MODES.includes(EXECUTION_MODE)) {
    console.log(
      `\n❌ Неизвестный EXECUTION_MODE "${EXECUTION_MODE}" в settings.ts. ` +
      `Допустимые значения: 'limit', 'leader-follower', 'market'.`
    );
    process.exit(1);
  }

  if (TOKENS_TO_TRADE.length === 0) {
    console.log(
      `\n❌ В LEVERAGE (settings.ts) нет ни одного раскоментированного токена — боту нечем торговать.`
    );
    process.exit(1);
  }

  setupShutdown();

  // Step 1: Mode selector (before any connection)
  const mode = await askMode();
  if (mode === '1') {
    acquireTradingLock();
    clearTradingHalt();
  } else if (mode === '2') {
    requestTradingHalt();
  }

  // Step 2: Load wallets
  let wallets: WalletAccount[];
  try {
    wallets = await initWallets();
    const walletCountBeforeFilter = wallets.length;
    wallets = filterWalletsById(wallets, ID_FILTER as WalletIdFilter);
    if (wallets.length === 0) {
      throw new Error('Wallet ID filter selected no wallets');
    }
    if (wallets.length !== walletCountBeforeFilter) {
      console.log(`🔒 Wallet filter selected ${wallets.length}/${walletCountBeforeFilter} wallet(s)`);
    }
  } catch (e: any) {
    console.log(`\n❌ Failed to load wallets: ${e.message}`);
    process.exit(1);
  }

  // Shuffle if configured
  if (SHUFFLE_WALLETS) {
    wallets = shuffleArray(wallets);
    console.log('🔀 Wallets shuffled');
  }

  // Step 3: Create services (login + register)
  console.log('\n🔌 Connecting to Phoenix...');
  const services = await createServices(wallets);

  if (services.length === 0) {
    console.log('\n❌ No wallets could connect. Exiting.');
    process.exit(1);
  }

  console.log(`\n✅ ${services.length}/${wallets.length} wallet(s) connected`);
  servicesRef = services;

  // Step 4: Execute selected mode
  try {
    switch (mode) {
      case '1':
        await runDeltaNeutral(services);
        break;
      case '2':
        await closeAllPositions(services);
        break;
      case '3': {
        await checkBalances(services);
        break;
      }
      case '4':
        await claimRewards(services);
        break;
      case '5':
        await depositUsdc(services);
        break;
      case '6':
        await withdrawUsdc(services);
        break;
      case '7':
        await cancelAllRestingOrders();
        break;
      default:
        console.log(`\n❌ Неизвестный режим: "${mode}". Выбери 1, 2, 3, 4, 5, 6 или 7.`);
        process.exit(1);
    }
  } catch (e: any) {
    console.log(`\n❌ Mode ${mode} failed: ${e.message}`);
    await sendTg(`❌ ERROR | Mode ${mode} | ${e.message}`);
  }
}

main().catch(async (e) => {
  console.error(`\n💥 Fatal error: ${e.message}`);
  console.error(e.stack);
  await sendTg(`💥 FATAL | ${e.message}`);
  process.exit(1);
});
