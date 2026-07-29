// ============================================================
//  REFERRAL GUARD — Protects software from non-referred users
// ============================================================
// Before trading, verifies each wallet was registered through
// the required referral code. If not — refuses to trade.
// ============================================================

import { PhoenixApiClient } from './phoenix-api.js';
import { shortAddr } from './utils.js';

const REFERRAL_CODE = 'V9EZG25S';

/**
 * Check if a wallet is registered through the required referral code.
 * Fails closed: any uncertainty = reject.
 */
export async function checkReferral(
  apiClient: PhoenixApiClient,
  walletAddress: string
): Promise<{ passed: boolean; reason: string }> {
  try {
    const validateResult = await apiClient.validateInvite({
      code: REFERRAL_CODE,
      wallet_address: walletAddress,
    });

    if (validateResult.success || validateResult.whitelisted) {
      return {
        passed: true,
        reason: `Wallet ${shortAddr(walletAddress)} verified with referral code`,
      };
    }

    // validateInvite didn't confirm referral — check on-chain state
    try {
      const state = await apiClient.getTraderState(walletAddress);
      const onChainState = state.snapshot?.capabilities?.state;

      if (onChainState) {
        // Wallet exists on-chain in ANY state but referral not confirmed — reject
        return {
          passed: false,
          reason: `Wallet ${shortAddr(walletAddress)} is on-chain (${onChainState}) but NOT registered through the referral code`,
        };
      }
    } catch {
      // Not registered on-chain — new wallet, referral will be applied during registration
    }

    // New wallet — allow, referral code will be applied during registration
    return {
      passed: true,
      reason: `Wallet ${shortAddr(walletAddress)} is new — referral code will be applied during registration`,
    };
  } catch (e: any) {
    // API error — fail closed, do not allow trading
    return {
      passed: false,
      reason: `Referral check failed for ${shortAddr(walletAddress)}: ${e.message}`,
    };
  }
}

/**
 * Run referral guard for all wallets.
 * Throws if any wallet fails the check.
 */
export async function runReferralGuard(
  wallets: { address: string; apiClient: PhoenixApiClient }[]
): Promise<void> {
  console.log(`\n🛡️ Referral Guard — checking ${wallets.length} wallet(s)...`);

  const failed: string[] = [];

  for (const { address, apiClient } of wallets) {
    const result = await checkReferral(apiClient, address);
    if (result.passed) {
      console.log(`  ✅ ${result.reason}`);
    } else {
      console.log(`  ❌ ${result.reason}`);
      failed.push(address);
    }
  }

  if (failed.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`❌ REFERRAL GUARD FAILED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`The following wallets are NOT registered through the referral code:`);
    for (const addr of failed) {
      console.log(`  - ${addr}`);
    }
    console.log(`\nRegister at https://www.phoenix.trade/?ref=${REFERRAL_CODE}`);
    console.log(`${'='.repeat(60)}\n`);
    throw new Error(`Referral guard failed for ${failed.length} wallet(s).`);
  }

  console.log(`✅ All wallets passed referral guard\n`);
}
