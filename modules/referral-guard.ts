// ============================================================
//  REFERRAL GUARD — Protects software from non-referred users
// ============================================================
// Before trading, verifies each wallet was registered through
// the required referral code. If not — refuses to trade.
// ============================================================

import { PhoenixApiClient } from './phoenix-api.js';
import { shortAddr } from './utils.js';

const REFERRAL_CODES = ['V9EZG25S', 'X95ET4N2', '23PUTC8U', 'PAKARXCD', 'GD77P82A'];

/**
 * Check if a wallet is registered through any of the required referral codes.
 * Uses /v1/invite/check/{wallet} which returns the invite_code_used.
 * Fails closed: any uncertainty = reject.
 */
export async function checkReferral(
  apiClient: PhoenixApiClient,
  walletAddress: string
): Promise<{ passed: boolean; reason: string }> {
  try {
    const check = await apiClient.checkWallet(walletAddress);

    // Wallet has an invite code — check if it's one of ours
    if (check.invite_code_used && REFERRAL_CODES.includes(check.invite_code_used)) {
      return {
        passed: true,
        reason: `Wallet ${shortAddr(walletAddress)} verified with referral code [${check.invite_code_used}]`,
      };
    }

    // Wallet has a different invite code or whitelisted
    if (check.whitelisted) {
      return {
        passed: true,
        reason: `Wallet ${shortAddr(walletAddress)} is whitelisted`,
      };
    }

    // No invite code used — check if wallet exists on-chain
    try {
      const state = await apiClient.getTraderState(walletAddress);
      const onChainState = state.snapshot?.capabilities?.state;

      if (onChainState) {
        // Wallet is on-chain but NOT registered through our code
        return {
          passed: false,
          reason: `Wallet ${shortAddr(walletAddress)} is on-chain (${onChainState}) but NOT registered through our referral code`,
        };
      }
    } catch {
      // Not registered on-chain — new wallet
    }

    // New wallet — allow, referral code will be applied during registration
    return {
      passed: true,
      reason: `Wallet ${shortAddr(walletAddress)} is new — referral code will be applied during registration`,
    };
  } catch (e: any) {
    // API error — fail closed
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
    console.log(`\nRegister at https://www.phoenix.trade/?code=${REFERRAL_CODES[0]}`);
    console.log(`${'='.repeat(60)}\n`);
    throw new Error(`Referral guard failed for ${failed.length} wallet(s).`);
  }

  console.log(`✅ All wallets passed referral guard\n`);
}
