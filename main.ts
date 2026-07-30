// ============================================================
//  MAIN — Entry point for Phoenix Delta-Neutral Bot
// ============================================================
// Mode 1: Delta-neutral trading
// Mode 2: Close all positions
// Mode 3: Check balances
// ============================================================

import { createInterface } from 'node:readline';

import { SHUFFLE_WALLETS } from './settings.js';
import { DeltaNeutralController } from './modules/controller.js';
import { PhoenixService } from './modules/phoenix-service.js';
import { sendTg } from './modules/telegram.js';
import {
  loadWallets,
  readPrivateKeys,
  saveEncryptedWallets,
  loadEncryptedWallets,
  type WalletAccount,
} from './modules/wallet.js';
import { sleep, shuffleArray, shortAddr } from './modules/utils.js';

// ==================== BANNER ====================

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════════════════╗
║     🔥 PHOENIX DELTA-NEUTRAL VOLUME BOT 🔥      ║
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
      `\nВыбери режим:\n  1 = Дельта-нейтральная торговля\n  2 = Закрыть все позиции\n  3 = Проверить балансы\n  4 = Клеймить награды\n  5 = Пополнить биржу с кошелька\n\n> `,
      (answer) => {
        rl.close();
        resolve(answer.trim());
      }
    );
  });
}

// ==================== WALLET INITIALIZATION ====================

async function initWallets(): Promise<WalletAccount[]> {
  // Try loading from encrypted storage first
  const encrypted = loadEncryptedWallets();
  if (encrypted && encrypted.length > 0) {
    return encrypted;
  }

  // First run: load from privatekeys.txt, encrypt, and save
  console.log('\n📂 First run — loading wallets from privatekeys.txt...');
  const rawKeys = readPrivateKeys();
  const wallets = loadWallets();

  // Encrypt and persist
  saveEncryptedWallets(rawKeys, wallets);

  return wallets;
}

// ==================== SERVICE CREATION ====================

async function createServices(wallets: WalletAccount[]): Promise<PhoenixService[]> {
  const results = await Promise.allSettled(
    wallets.map(async (wallet) => {
      const service = new PhoenixService(wallet.keypair, wallet.proxyUrl);

      await service.loginHandler();
      await service.ensureRegistered();

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

  // Register all services with their balances
  for (const service of services) {
    try {
      const balance = await service.getUsdcBalance();
      controller.register(service, balance);
    } catch (e: any) {
      console.log(`  ⚠️ Failed to get balance for ${shortAddr(service.getAddress())}: ${e.message}`);
    }
  }

  await sendTg(`BOT STARTED | ${services.length} wallet(s) | Delta-neutral mode`);

  // Run the controller loop
  await controller.run();

  await sendTg('BOT STOPPED | Delta-neutral mode finished');
}

// ==================== MODE 2: CLOSE ALL ====================

async function closeAllPositions(services: PhoenixService[]): Promise<void> {
  console.log('\n🔄 Closing all positions and orders...');

  for (const service of services) {
    const addr = shortAddr(service.getAddress());
    try {
      console.log(`  📋 ${addr} — closing...`);
      await service.closeAllPositionsAndOrders();
      console.log(`  ✅ ${addr} — done`);
    } catch (e: any) {
      console.log(`  ❌ ${addr} — failed: ${e.message}`);
    }
  }

  console.log('\n✅ Close-all complete');
  await sendTg(`CLOSE ALL | ${services.length} wallet(s) processed`);
}

// ==================== MODE 3: CHECK BALANCES ====================

async function checkBalances(services: PhoenixService[]): Promise<void> {
  console.log('\n💰 Checking balances...\n');

  let totalBalance = 0;
  const lines: string[] = ['💰 Checked balances', ''];

  for (const service of services) {
    const addr = shortAddr(service.getAddress());
    try {
      const balance = await service.getUsdcBalance();
      totalBalance += balance;
      console.log(`  ✅ ${addr} | $${balance.toFixed(2)}`);
      lines.push(`✅ ${addr} | $${balance.toFixed(2)}`);
    } catch (e: any) {
      console.log(`  ${addr} | error: ${e.message}`);
      lines.push(`${addr} | error`);
    }
  }

  console.log(`\n  💎 Total: $${totalBalance.toFixed(2)} across ${services.length} wallet(s)`);
  lines.push('', `💎 Total: $${totalBalance.toFixed(2)} across ${services.length} wallet(s)`);
  await sendTg(lines.join('\n'));
}

// ==================== MODE 4: CLAIM REWARDS ====================

async function claimRewards(services: PhoenixService[]): Promise<void> {
  console.log('\n🎁 Claiming rewards...\n');

  let claimedCount = 0;
  let totalClaimed = 0;
  const lines: string[] = ['🎁 Claiming rewards', ''];

  for (const service of services) {
    const addr = shortAddr(service.getAddress());
    try {
      const result = await service.claimRewards();
      if (result.claimed) {
        claimedCount++;
        totalClaimed += result.amountUsd;
        lines.push(`✅ ${addr} | +$${result.amountUsd.toFixed(2)}`);
      } else {
        console.log(`  ℹ️ ${addr} | Nothing to claim`);
      }
    } catch (e: any) {
      console.log(`  ⚠️ ${addr} | ${e.message}`);
      lines.push(`⚠️ ${addr} | ${e.message}`);
    }

    if (services.indexOf(service) < services.length - 1) {
      await sleep(1 + Math.random());
    }
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

  let totalDeposited = 0;
  let depositCount = 0;
  const lines: string[] = ['💰 Deposit USDC', ''];

  for (const service of services) {
    const addr = shortAddr(service.getAddress());
    try {
      const result = await service.depositUsdc();
      if (result.deposited > 0) {
        depositCount++;
        totalDeposited += result.deposited;
        lines.push(`✅ ${addr} | +$${result.deposited.toFixed(2)}`);
      }
    } catch (e: any) {
      console.log(`  ⚠️ ${addr} | ${e.message}`);
      lines.push(`⚠️ ${addr} | ${e.message}`);
    }

    if (services.indexOf(service) < services.length - 1) {
      await sleep(1 + Math.random());
    }
  }

  lines.push('', `Deposited: $${totalDeposited.toFixed(2)} from ${depositCount}/${services.length} wallet(s)`);

  if (depositCount > 0) {
    console.log(`\n✅ Deposited $${totalDeposited.toFixed(2)} from ${depositCount}/${services.length} wallet(s)`);
  } else {
    console.log('\nℹ️ Nothing to deposit');
  }

  await sendTg(lines.join('\n'));
}

// ==================== GRACEFUL SHUTDOWN ====================

let controllerRef: DeltaNeutralController | null = null;

function setupShutdown(): void {
  const shutdown = async () => {
    controllerRef?.stop();
    await sleep(1);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  printBanner();
  setupShutdown();

  // Step 1: Load wallets
  let wallets: WalletAccount[];
  try {
    wallets = await initWallets();
  } catch (e: any) {
    console.log(`\n❌ Failed to load wallets: ${e.message}`);
    process.exit(1);
  }

  // Shuffle if configured
  if (SHUFFLE_WALLETS) {
    wallets = shuffleArray(wallets);
    console.log('🔀 Wallets shuffled');
  }

  // Step 2: Create services (login + register)
  console.log('\n🔌 Connecting to Phoenix...');
  const services = await createServices(wallets);

  if (services.length === 0) {
    console.log('\n❌ No wallets could connect. Exiting.');
    process.exit(1);
  }

  console.log(`\n✅ ${services.length}/${wallets.length} wallet(s) connected`);

  // Step 3: Mode selector
  const mode = await askMode();

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
      default:
        console.log(`\n❌ Неизвестный режим: "${mode}". Выбери 1, 2, 3, 4 или 5.`);
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
