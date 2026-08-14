import { EXECUTION_MODE } from '../settings.js';
import { allocateTargets, executePaired } from './paired-execution.js';
import { PhoenixService } from './phoenix-service.js';
import { shortAddr, sleep } from './utils.js';

export interface CloseAccount {
  service: PhoenixService;
}

async function flattenResiduals(accounts: CloseAccount[], symbol: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const residuals = (await Promise.all(accounts.map(async (account) => ({
      account,
      position: await account.service.getSignedPositionBaseUnits(symbol).catch(() => Number.NaN),
    })))).filter(({ position }) => !Number.isFinite(position) || Math.abs(position) > 1e-10);
    if (residuals.length === 0) return;

    await Promise.all(residuals.map(async ({ account }) => {
      try {
        await account.service.cancelAllOrders(symbol, true, true);
        await account.service.closePositionByMarket(symbol);
        console.log(`  ${shortAddr(account.service.getAddress())} residual closed via MARKET`);
      } catch (error: any) {
        console.log(
          `  Residual close ${attempt}/3 failed for ` +
          `${shortAddr(account.service.getAddress())}: ${error.message}`
        );
      }
    }));
    await sleep(1);
  }

  const stillOpen = (await Promise.all(accounts.map(async (account) => ({
    address: shortAddr(account.service.getAddress()),
    position: await account.service.getSignedPositionBaseUnits(symbol).catch(() => Number.NaN),
  })))).filter(({ position }) => !Number.isFinite(position) || Math.abs(position) > 1e-10);
  if (stillOpen.length > 0) {
    throw new Error(
      `${symbol} residual positions remain: ` +
      stillOpen.map(({ address, position }) => `${address}=${position}`).join(', ')
    );
  }
}

export async function closeLeaderFollower(
  limitAccounts: CloseAccount[],
  marketAccounts: CloseAccount[],
  symbol: string
): Promise<void> {
  const all = [...limitAccounts, ...marketAccounts];
  if (all.length === 0) return;

  await Promise.all(all.map((account) => account.service.cancelAllOrders(symbol, true)));

  if (EXECUTION_MODE === 'all-market' || limitAccounts.length === 0 || marketAccounts.length === 0) {
    console.log(`\n  Closing ${all.length} ${symbol} position(s) via MARKET...`);
    await flattenResiduals(all, symbol);
    return;
  }

  const makerPositions = await Promise.all(limitAccounts.map(async (account) => ({
    service: account.service,
    position: await account.service.getSignedPositionBaseUnits(symbol),
  })));
  const takerPositions = await Promise.all(marketAccounts.map(async (account) => ({
    service: account.service,
    position: await account.service.getSignedPositionBaseUnits(symbol),
  })));

  const makerActive = makerPositions.filter(({ position }) => Math.abs(position) > 1e-10);
  const takerActive = takerPositions.filter(({ position }) => Math.abs(position) > 1e-10);
  if (makerActive.length === 0 || takerActive.length === 0) {
    await flattenResiduals(all, symbol);
    return;
  }

  const makerSide = makerActive[0]!.position > 0 ? 'short' : 'long';
  const takerSide = takerActive[0]!.position > 0 ? 'short' : 'long';
  if (makerSide === takerSide) {
    console.log(`  ${symbol} positions are not opposite; using reduce-only MARKET fallback`);
    await flattenResiduals(all, symbol);
    return;
  }

  const makerTotal = makerActive.reduce((sum, entry) => sum + Math.abs(entry.position), 0);
  const takerTotal = takerActive.reduce((sum, entry) => sum + Math.abs(entry.position), 0);
  const pairedTotal = Math.min(makerTotal, takerTotal);

  const [makerTargets, takerTargets] = await Promise.all([
    allocateTargets(
      pairedTotal,
      makerActive.map((entry) => ({ service: entry.service, weight: Math.abs(entry.position) })),
      symbol
    ),
    allocateTargets(
      pairedTotal,
      takerActive.map((entry) => ({ service: entry.service, weight: Math.abs(entry.position) })),
      symbol
    ),
  ]);

  try {
    console.log(`\n  Closing ${symbol} with partial-fill maker/taker hedging...`);
    await executePaired({
      symbol,
      makerSide,
      takerSide,
      makerTargets,
      takerTargets,
      reduceOnly: true,
      // Halt blocks new risk, but a close must be allowed to finish safely.
      haltCheck: () => false,
    });
  } catch (error: any) {
    console.log(`  Paired close degraded to MARKET: ${error.message}`);
  } finally {
    // Handles lot rounding, unequal legacy positions, timeout and rejected FOKs.
    await flattenResiduals(all, symbol);
  }
}
