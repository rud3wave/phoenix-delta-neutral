// ============================================================
//  MAIN — Entry point for Phoenix Delta-Neutral Bot
// ============================================================
// Mode 1: Delta-neutral trading
// Mode 2: Close all positions
// Mode 3: Check balances
// ============================================================

import { createInterface } from 'node:readline';

import { SHUFFLE_WALLETS, DELAY_BETWEEN_WALLETS } from './settings.js';
import { DeltaNeutralController } from './modules/controller.js';
import { PhoenixService } from './modules/phoenix-service.js';
import { runReferralGuard } from './modules/referral-guard.js';
import { sendTg } from './modules/telegram.js';
import {
  loadWallets,
  readPrivateKeys,
  saveEncryptedWallets,
  loadEncryptedWallets,
  type WalletAccount,
} from './modules/wallet.js';
import { sleep, sleepByRange, shuffleArray, shortAddr } from './modules/utils.js';

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
      `\nВыбери режим:\n  1 = Дельта-нейтральная торговля\n  2 = Закрыть все позиции\n  3 = Проверить балансы\n\n> `,
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
  const services: PhoenixService[] = [];

  for (const wallet of wallets) {
    const service = new PhoenixService(wallet.keypair, wallet.proxyUrl);

    // Login
    try {
      await service.loginHandler();
    } catch (e: any) {
      console.log(`  ❌ Login failed for ${shortAddr(wallet.address)}: ${e.message}`);
      continue;
    }

    // Register if needed (includes referral activation)
    try {
      await service.ensureRegistered();
    } catch (e: any) {
      console.log(`  ❌ Registration failed for ${shortAddr(wallet.address)}: ${e.message}`);
      continue;
    }

    services.push(service);

    // Delay between wallets
    if (wallets.indexOf(wallet) < wallets.length - 1) {
      await sleepByRange(DELAY_BETWEEN_WALLETS, 'Delay between wallets');
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

  for (const service of services) {
    const addr = shortAddr(service.getAddress());
    try {
      const balance = await service.getUsdcBalance();
      totalBalance += balance;
      console.log(`  ${addr} | $${balance.toFixed(2)}`);
    } catch (e: any) {
      console.log(`  ${addr} | error: ${e.message}`);
    }
  }

  console.log(`\n  💎 Total: $${totalBalance.toFixed(2)} across ${services.length} wallet(s)`);
}

// ==================== GRACEFUL SHUTDOWN ====================

let controllerRef: DeltaNeutralController | null = null;

function setupShutdown(): void {
  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down gracefully...');
    controllerRef?.stop();
    await sendTg('BOT STOPPED | Graceful shutdown (Ctrl+C)');
    // Give a moment for pending operations
    await sleep(2);
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

  // Step 3: Referral guard
  try {
    await runReferralGuard(
      services.map((s) => ({ address: s.getAddress(), apiClient: s.getApiClient() }))
    );
  } catch (e: any) {
    console.log(`\n❌ ${e.message}`);
    process.exit(1);
  }

  // Step 4: Mode selector
  const mode = await askMode();

  switch (mode) {
    case '1':
      await runDeltaNeutral(services);
      break;
    case '2':
      await closeAllPositions(services);
      break;
    case '3':
      await checkBalances(services);
      break;
    default:
      console.log(`\n❌ Неизвестный режим: "${mode}". Выбери 1, 2 или 3.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n💥 Fatal error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
