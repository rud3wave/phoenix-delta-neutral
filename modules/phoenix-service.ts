// ============================================================
//  PHOENIX SERVICE — Trading service using Rise SDK
//  Ported from myown/src/scripts/main/modules/phoenix
// ============================================================

import {
  createPhoenixClient,
  Side,
  buildAcceptEscrowRequestIx,
  getPhoenixEscrowAddress,
  getPhoenixTraderSubaccountAddress,
  PHOENIX_PROGRAM_ADDRESS,
  PHOENIX_LOG_AUTHORITY_ADDRESS,
  PHOENIX_GLOBAL_CONFIGURATION_ADDRESS,
} from '@ellipsis-labs/rise';
import { base58 } from '@scure/base';
import {
  address,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
  partiallySignTransaction,
  getBase64EncodedWireTransaction,
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  type Blockhash,
  type Instruction,
} from '@solana/kit';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import { gotScraping } from 'got-scraping';

import { sleep } from './utils.js';
import {
  PhoenixApiClient,
  type PendingEscrowRequest,
  type SolanaInstruction,
  type TraderStateResponse,
} from './phoenix-api.js';

// ==================== CONFIG ====================

const PHOENIX_API_URL = 'https://perp-api.phoenix.trade';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const REFERRAL_CODES = ['V9EZG25S', 'X95ET4N2', '23PUTC8U', 'PAKARXCD', 'GD77P82A'];

// On-chain authorities that fund referral / Flight Club rewards.
// Referral program sender + CashDrop (Flight Club) sender — matches the
// values the Phoenix website uses for `sender_pubkey` on the rewards endpoints.
const REFERRAL_SENDER_PUBKEYS = [
  '347EbVY3W2kYtXDkt336HrXR1u6JHYVQH9PYiwxA9JSc',
  '2xF8Br42GuMDtLxFhFekEZMr6hek89AZxc3RCNUZMJK8',
];

// quote lots -> USDC (USDC has 6 decimals, quote lots are micro-USDC)
const USDC_QUOTE_LOT_MULTIPLIER = 1e6;

// ==================== PROXY-AWARE FETCH FOR RPC ====================

function createProxyFetch(proxyUrl?: string): typeof fetch {
  if (!proxyUrl) return fetch;

  return (async (url: string | URL | Request, init?: RequestInit) => {
    // Convert Headers object to plain record
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) { headers[k] = v; }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    // Read body as string
    let bodyStr: string | undefined;
    if (init?.body) {
      if (typeof init.body === 'string') {
        bodyStr = init.body;
      } else {
        bodyStr = String(init.body);
      }
    }

    const response = await gotScraping({
      url: url.toString(),
      method: (init?.method as any) || 'GET',
      headers,
      body: bodyStr,
      proxyUrl,
      useHeaderGenerator: false,
      timeout: { request: 60_000 },
      responseType: 'text',
    });

    // Sanitize response headers
    const cleanHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') {
        cleanHeaders[key] = value;
      } else if (Array.isArray(value)) {
        cleanHeaders[key] = value.join(', ');
      }
    }

    return new Response(response.body as string, {
      status: response.statusCode,
      headers: cleanHeaders,
    });
  }) as typeof fetch;
}

// ==================== TYPES ====================

export interface MarketSnapshot {
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spreadPercent: number;
  bidLiquidity: number;
  askLiquidity: number;
}

export interface PositionWithLiquidation {
  hasPosition: boolean;
  side: 'long' | 'short' | null;
  entryPrice: number;
  quantity: number;
  positionUsd: number;
  collateral: number;
  effectiveLeverage: number;
  estimatedLiqPrice: number;
  liqDistancePercent: number;
}

export interface PlacePositionOrderParams {
  instrument: string;
  executionSide: 'long' | 'short';
  executionType: 'market' | 'limit';
  amountUsd: number;
  leverage?: number;
  overrideBaseUnits?: number;
  takeProfitPricePercent?: number;
  stopLossPricePercent?: number;
  useMidPrice?: boolean;
}

// ==================== SERVICE ====================

export class PhoenixService {
  private readonly apiClient: PhoenixApiClient;
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly walletAddress: string;
  private readonly proxyUrl?: string;
  private baseLotsDecimalsCache: Record<string, number> = {};
  private traderPda: string = '';

  constructor(wallet: Keypair, proxyUrl?: string) {
    this.wallet = wallet;
    this.walletAddress = wallet.publicKey.toString();
    this.proxyUrl = proxyUrl;
    this.connection = new Connection(SOLANA_RPC, 'confirmed');
    this.apiClient = new PhoenixApiClient({ proxyUrl });
  }

  public getAddress(): string {
    return this.walletAddress;
  }

  public getApiClient(): PhoenixApiClient {
    return this.apiClient;
  }

  public getTraderPda(): string {
    return this.traderPda;
  }

  // ==================== AUTH ====================

  public async loginHandler(): Promise<boolean> {
    const proxyInfo = this.proxyUrl ? ` | proxy: ${this.proxyUrl.replace(/\/\/.*@/, '//***@')}` : ' | no proxy';
    console.log(`  🔑 [${this.walletAddress.slice(0, 6)}] Authenticating${proxyInfo}`);

    const nonce = await this.apiClient.getWalletNonce(this.walletAddress);

    const msgBytes = new TextEncoder().encode(nonce.message);
    const signatureBytes = nacl.sign.detached(msgBytes, this.wallet.secretKey);
    const signatureBase58 = base58.encode(signatureBytes);

    const authResponse = await this.apiClient.loginWithWalletSignature({
      nonce_id: nonce.nonce_id,
      signature: signatureBase58,
      wallet_pubkey: this.walletAddress,
    });

    if (!authResponse.access_token) {
      throw new Error('Failed to authenticate with Phoenix');
    }

    this.apiClient.applyAuthToken(authResponse.access_token);
    console.log(`  ✅ [${this.walletAddress.slice(0, 6)}] Successfully authenticated with Phoenix`);

    // Registration and referral — after every fresh login
    await this.ensureRegistered();

    return true;
  }

  // ==================== REGISTRATION ====================

  public async ensureRegistered(): Promise<void> {
    // Check on-chain status
    try {
      const state = await this.apiClient.getTraderState(this.walletAddress);
      const onChainState = state.snapshot?.capabilities?.state;

      if (onChainState === 'active') {
        this.traderPda = state.authority;
        return;
      }

      if (onChainState) {
        // Registered but not fully active — finish referral onboarding via activate-tx
        this.traderPda = state.authority;
        const activated = await this.activateReferralViaTx();
        if (!activated) {
          console.log(`  ⚠️ [${this.walletAddress.slice(0, 6)}] Registered but referral activation skipped`);
        }
        return;
      }
    } catch {
      // Not registered on-chain yet
    }

    console.log(`  📝 [${this.walletAddress.slice(0, 6)}] Registering trader on Phoenix...`);

    // Preferred path: referral activate-tx (API co-signs as onboarder + broadcasts)
    const activated = await this.activateReferralViaTx();
    if (activated) return;

    // Fallback: builder flow without referral (build-register-ixs → send-register-ixs)
    await this.registerWithoutReferral();
  }

  /**
   * Onboard via POST /v1/referral/activate-tx.
   * Builds + partially signs locally; Phoenix adds onboarder sig and submits.
   */
  private async activateReferralViaTx(): Promise<boolean> {
    const tag = this.walletAddress.slice(0, 6);
    const signer = await createKeyPairSignerFromBytes(this.wallet.secretKey);
    const rpc = createSolanaRpc(this.connection.rpcEndpoint);

    const client = createPhoenixClient({
      apiUrl: PHOENIX_API_URL,
      rpcUrl: this.connection.rpcEndpoint,
      auth: false,
      ws: false,
      exchangeMetadata: { stream: false },
    });

    try {
      for (const code of REFERRAL_CODES) {
        try {
          const latestBlockhash = await rpc
            .getLatestBlockhash({ commitment: 'finalized' })
            .send();

          const built = await client.api.invite().buildActivateReferralTxRequest({
            referralCode: code,
            traderAuthority: signer.address as any,
            traderPdaIndex: 0,
            traderSubaccountIndex: 0,
            recentBlockhash: latestBlockhash.value.blockhash,
            lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight,
            registerTraderMaxPositions: 128n,
            rpc,
            signTransaction: (transaction: any) =>
              partiallySignTransaction([signer.keyPair], transaction),
          });

          const response = await this.apiClient.activateReferralTx(built.request);
          this.traderPda = response.trader_pda;

          if (response.status === 'already_activated') {
            console.log(`  ✅ [${tag}] Already onboarded (referral ${code})`);
            return true;
          }

          const sig = response.signature ?? 'n/a';
          console.log(`  ✅ [${tag}] Registered via referral ${code} | status=${response.status} | tx: ${sig}`);

          // Phoenix broadcasts; confirm via trader state rather than public RPC alone
          await this.waitUntilTraderActive(45_000);
          return true;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (msg.includes('insufficient lamports')) {
            const match = msg.match(/need (\d+)/);
            const needSol = match ? (parseInt(match[1]!) / 1e9).toFixed(3) : '0.04';
            throw new Error(`Not enough SOL (need ~${needSol} SOL). Send SOL to this wallet first.`);
          }
          // Invalid/exhausted code or transient API error — try next code
          console.log(`  ⚠️ [${tag}] Referral ${code} failed: ${msg.slice(0, 160)}`);
        }
      }
      return false;
    } finally {
      client.dispose();
    }
  }

  /**
   * Fallback onboarding without referral:
   * build-register-ixs → local sign → send-register-ixs (API co-signs + broadcasts).
   */
  private async registerWithoutReferral(): Promise<void> {
    const tag = this.walletAddress.slice(0, 6);

    const registerResponse = await this.apiClient.buildRegisterInstructions({
      traderAuthority: this.walletAddress,
      txFeePayer: this.walletAddress,
      maxPositions: 128,
    });

    this.traderPda = registerResponse.traderPda;

    if (!registerResponse.includeRegisterTrader || registerResponse.instructions.length === 0) {
      console.log(`  ✅ [${tag}] Trader already registered on-chain`);
      return;
    }

    try {
      const { blockhash } = await this.connection.getLatestBlockhash('finalized');
      const ixs = registerResponse.instructions.map((ix) => ({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((key) => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: Buffer.from(ix.data),
      }));

      const messageV0 = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([this.wallet]);
      const transactionB64 = Buffer.from(transaction.serialize()).toString('base64');

      const result = await this.apiClient.sendRegisterIxs({
        transaction: transactionB64,
        traderAuthority: this.walletAddress,
        txFeePayer: this.walletAddress,
        maxPositions: 128,
        traderPdaIndex: 0,
        traderSubaccountIndex: 0,
      });

      this.traderPda = result.traderPda;
      console.log(`  ✅ [${tag}] Trader registered | tx: ${result.signature}`);
      await this.waitUntilTraderActive(45_000);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes('insufficient lamports')) {
        const match = msg.match(/need (\d+)/);
        const needSol = match ? (parseInt(match[1]!) / 1e9).toFixed(3) : '0.04';
        throw new Error(`Not enough SOL (need ~${needSol} SOL). Send SOL to this wallet first.`);
      }

      try {
        const recheck = await this.apiClient.getTraderState(this.walletAddress);
        if (recheck.snapshot?.capabilities?.state) {
          console.log(`  ✅ [${tag}] Registration confirmed on-chain`);
          this.traderPda = recheck.authority;
          return;
        }
      } catch {
        // ignore
      }
      throw new Error(`Registration failed: ${msg}`);
    }
  }

  private async waitUntilTraderActive(timeoutMs = 45_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const state = await this.apiClient.getTraderState(this.walletAddress);
        const onChainState = state.snapshot?.capabilities?.state;
        if (onChainState) {
          this.traderPda = state.authority;
          return;
        }
      } catch {
        // not visible yet
      }
      await sleep(2);
    }
  }

  // ==================== BALANCE ====================

  public async getUsdcBalance(): Promise<number> {
    const state = await this.apiClient.getTraderState(this.walletAddress);
    // Sum collateral across all subaccounts
    const rawCollateral = this.getTotalCollateral(state);
    // Phoenix returns collateral in micro-USDC (6 decimals)
    return rawCollateral / 1e6;
  }

  // ==================== POSITIONS ====================

  public async getPositions(): Promise<TraderStateResponse> {
    return this.apiClient.getTraderState(this.walletAddress);
  }

  // Searches position across ALL subaccounts (isolated margin creates separate ones)
  private findPosition(state: TraderStateResponse, symbol: string) {
    const subaccounts = state.snapshot?.subaccounts ?? [];
    for (const sub of subaccounts) {
      const positions = sub.positions ?? [];
      const pos = positions.find((p) => p.symbol === symbol && Number(p.basePositionLots) !== 0);
      if (pos) return pos;
    }
    return undefined;
  }

  // Sums collateral across ALL subaccounts
  private getTotalCollateral(state: TraderStateResponse): number {
    const subaccounts = state.snapshot?.subaccounts ?? [];
    return subaccounts.reduce((sum, sub) => sum + parseFloat(sub.collateral || '0'), 0);
  }

  // ==================== BASE LOTS DECIMALS ====================

  // baseLotsDecimals for a symbol (1 lot = 10^-baseLotsDecimals base units)
  public async getBaseLotsDecimals(symbol: string): Promise<number> {
    if (this.baseLotsDecimalsCache[symbol] !== undefined) {
      return this.baseLotsDecimalsCache[symbol]!;
    }

    try {
      const client = createPhoenixClient({
        apiUrl: PHOENIX_API_URL,
        rpcUrl: this.connection.rpcEndpoint,
        auth: false,
        ws: false,
        exchangeMetadata: { stream: false },
      });
      const snapshot = await client.exchange.ready();

      const market = snapshot.markets.find(
        (m: any) =>
          m.symbol.toUpperCase() === symbol.toUpperCase() ||
          m.symbol.toUpperCase() === `${symbol.toUpperCase()}-PERP`
      );

      const decimals = market?.baseLotsDecimals ?? 0;
      this.baseLotsDecimalsCache[symbol] = decimals;
      client.dispose();
      return decimals;
    } catch {
      return 0;
    }
  }

  // Convert lots to base units
  public lotsToBaseUnits(lots: number, symbol: string): number {
    const decimals = this.baseLotsDecimalsCache[symbol] ?? 0;
    return lots / Math.pow(10, decimals);
  }

  // Read position size in base units (ETH, SOL, etc.)
  public async getPositionBaseUnits(symbol: string): Promise<number> {
    const state = await this.getPositions();
    const position = this.findPosition(state, symbol);
    if (!position) return 0;

    await this.getBaseLotsDecimals(symbol);
    const rawLots = Math.abs(Number(position.basePositionLots));
    return this.lotsToBaseUnits(rawLots, symbol);
  }

  // ==================== CLOSE POSITIONS ====================

  /** Snapshot open positions for TG/PnL reporting before a force-close. */
  public async getOpenPositionSummaries(): Promise<
    Array<{ symbol: string; side: 'long' | 'short'; quantity: number; positionUsd: number }>
  > {
    const state = await this.apiClient.getTraderState(this.walletAddress);
    const subaccounts = state.snapshot?.subaccounts ?? [];
    const out: Array<{ symbol: string; side: 'long' | 'short'; quantity: number; positionUsd: number }> = [];

    for (const subaccount of subaccounts) {
      for (const position of subaccount.positions ?? []) {
        const baseLots = Number(position.basePositionLots);
        if (baseLots === 0) continue;

        const symbol = position.symbol;
        await this.getBaseLotsDecimals(symbol);
        const quantity = this.lotsToBaseUnits(Math.abs(baseLots), symbol);
        const entryPrice = parseFloat(position.entryPriceUsd || '0');
        out.push({
          symbol,
          side: baseLots > 0 ? 'long' : 'short',
          quantity,
          positionUsd: quantity * entryPrice,
        });
      }
    }

    return out;
  }

  public async closeAllPositionsAndOrders(): Promise<void> {
    const state = await this.apiClient.getTraderState(this.walletAddress);
    const subaccounts = state.snapshot?.subaccounts ?? [];

    for (const subaccount of subaccounts) {
      const positions = subaccount.positions ?? [];

      for (const position of positions) {
        const baseLots = Number(position.basePositionLots);
        if (baseLots === 0) continue;

        // Close via SDK (cross-margin compatible)
        const symbol = position.symbol;
        await this.getBaseLotsDecimals(symbol);
        const baseUnits = this.lotsToBaseUnits(Math.abs(baseLots), symbol);
        const closeSide = baseLots > 0 ? 'short' : 'long'; // opposite side to close

        console.log(`  🔄 Closing ${symbol} | ${closeSide.toUpperCase()} | ${parseFloat(baseUnits.toFixed(6))} ${symbol}`);

        try {
          await this.placePositionOrder({
            instrument: symbol,
            executionSide: closeSide as 'long' | 'short',
            executionType: 'market',
            amountUsd: 0,
            overrideBaseUnits: baseUnits,
          });
          console.log(`  ✅ Position ${symbol} closed`);
        } catch (e) {
          console.log(`  ⚠️ Failed to close ${symbol}: ${e}`);
        }
      }
    }
  }

  // ==================== CANCEL ORDERS ====================

  // Cancel ALL limit orders via Rise SDK (on-chain)
  public async cancelAllOrders(symbol: string): Promise<void> {
    let client: any;

    try {
      client = createPhoenixClient({
        apiUrl: PHOENIX_API_URL,
        auth: false,
        ws: false,
      });

      await client.exchange.ready();

      // Cancel only for subaccounts that API actually sees with orders
      const state = await this.apiClient.getTraderState(this.walletAddress);
      const subaccounts = state.snapshot?.subaccounts ?? [];
      const subaccountIndices: number[] = [0];

      for (const sub of subaccounts) {
        const hasOrders = (sub.orders ?? []).some((g) =>
          (g.orders ?? []).some((o) => o.status === 'open' || o.status === 'active')
        );
        if (hasOrders && !subaccountIndices.includes(sub.subaccountIndex)) {
          subaccountIndices.push(sub.subaccountIndex);
        }
      }

      for (const subIdx of subaccountIndices) {
        try {
          const result = await client.ixs.buildCancelAll({
            authority: this.walletAddress as any,
            symbol: symbol as any,
            traderPdaIndex: 0,
            traderSubaccountIndex: subIdx,
          });

          if (!result) continue;

          const rawIxs = Array.isArray(result) ? result : [result];
          const ixs = rawIxs.map((ix: any) => {
            const programId = new PublicKey(ix.programAddress ?? ix.programId?.toString() ?? '');
            const keys = (ix.accounts ?? ix.keys ?? []).map((k: any) => ({
              pubkey: new PublicKey(k.address ?? k.pubkey?.toString() ?? k.pubkey ?? ''),
              isSigner: k.role === 2 || k.role === 3 || k.isSigner === true,
              isWritable: k.role === 1 || k.role === 3 || k.isWritable === true,
            }));
            const data = Buffer.from(ix.data ?? new Uint8Array());
            return new TransactionInstruction({ programId, keys, data });
          });

          // Inline transaction building (NOT through sendTransaction helper)
          const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

          const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: ixs,
          }).compileToV0Message();

          const transaction = new VersionedTransaction(messageV0);
          transaction.sign([this.wallet]);

          const txHash = await this.connection.sendTransaction(transaction, {
            skipPreflight: true,
            preflightCommitment: 'confirmed',
          });

          await this.waitForConfirmation(txHash);
          console.log(`  ✅ Cancelled orders subaccount[${subIdx}] ${symbol} | tx: ${txHash}`);
        } catch (e) {
          console.log(`  ℹ️ Cancel subaccount[${subIdx}] ${symbol}: skipped (${e})`);
        }
      }
    } catch (e) {
      console.log(`  ⚠️ Failed to cancel orders via SDK: ${e}`);
    } finally {
      client?.dispose();
    }
  }

  // ==================== CLOSE BY LIMIT ====================

  public async closePositionByLimit(symbol: string): Promise<void> {
    const state = await this.getPositions();
    const position = this.findPosition(state, symbol);

    if (!position) {
      console.log(`  ℹ️ No open position for ${symbol} to close`);
      return;
    }

    // Close via SDK (cross-margin compatible)
    await this.getBaseLotsDecimals(symbol);
    const baseUnits = this.lotsToBaseUnits(Math.abs(Number(position.basePositionLots)), symbol);
    const closeSide = Number(position.basePositionLots) > 0 ? 'short' : 'long';

    console.log(`  📋 Closing ${symbol} via LIMIT | ${closeSide.toUpperCase()} | ${parseFloat(baseUnits.toFixed(6))} ${symbol}`);

    await this.placePositionOrder({
      instrument: symbol,
      executionSide: closeSide as 'long' | 'short',
      executionType: 'limit',
      amountUsd: 0,
      overrideBaseUnits: baseUnits,
      useMidPrice: true,
    });
  }

  // ==================== MARKET MONITORING ====================

  public async getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
    const orderbook = await this.apiClient.getOrderbook(symbol);

    const bestBid = orderbook.bids[0]?.[0] ?? 0;
    const bestAsk = orderbook.asks[0]?.[0] ?? 0;
    const midPrice = orderbook.mid ?? (bestAsk + bestBid) / 2;
    const spreadPercent = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 999;

    const bidLiquidity = orderbook.bids.slice(0, 5).reduce((sum, [, size]) => sum + size, 0);
    const askLiquidity = orderbook.asks.slice(0, 5).reduce((sum, [, size]) => sum + size, 0);

    return { midPrice, bestBid, bestAsk, spreadPercent, bidLiquidity, askLiquidity };
  }

  public async waitForSpread(
    symbol: string,
    maxSpreadPercent: number,
    pollingSeconds: number,
    timeoutSeconds: number
  ): Promise<{ midPrice: number; spreadPercent: number }> {
    const startTime = Date.now();

    while (true) {
      const snapshot = await this.getMarketSnapshot(symbol);

      if (snapshot.spreadPercent <= maxSpreadPercent) {
        console.log(
          `  📊 Spread OK: ${snapshot.spreadPercent.toFixed(4)}% <= ${maxSpreadPercent}% | mid: ${snapshot.midPrice}`
        );
        return { midPrice: snapshot.midPrice, spreadPercent: snapshot.spreadPercent };
      }

      if (Date.now() - startTime > timeoutSeconds * 1000) {
        throw new Error(
          `Spread timeout: ${snapshot.spreadPercent.toFixed(4)}% > ${maxSpreadPercent}% for ${timeoutSeconds}s`
        );
      }

      console.log(`  ⏳ Waiting for spread: ${snapshot.spreadPercent.toFixed(4)}% > ${maxSpreadPercent}%...`);

      await sleep(pollingSeconds);
    }
  }

  // ==================== POSITION WITH LIQUIDATION ====================

  public async getPositionWithLiquidation(symbol: string): Promise<PositionWithLiquidation> {
    const state = await this.getPositions();
    const collateral = this.getTotalCollateral(state) / 1e6;
    const position = this.findPosition(state, symbol);

    if (!position) {
      return {
        hasPosition: false,
        side: null,
        entryPrice: 0,
        quantity: 0,
        positionUsd: 0,
        collateral,
        effectiveLeverage: 0,
        estimatedLiqPrice: 0,
        liqDistancePercent: 0,
      };
    }

    // basePositionLots in LOTS — convert to base units
    await this.getBaseLotsDecimals(symbol);
    const rawLots = Number(position.basePositionLots);
    const isLong = rawLots > 0;
    const baseUnits = this.lotsToBaseUnits(Math.abs(rawLots), symbol);
    const entryPrice = parseFloat(position.entryPriceUsd || '0');
    const positionUsd = baseUnits * entryPrice;
    const effectiveLeverage = collateral > 0 ? positionUsd / collateral : 0;

    // Phoenix maintenance margin rate ~0.5% for most markets
    const mmr = 0.005;

    // Liq price LONG: entry * (1 - (collateral / positionUsd) + mmr)
    // Liq price SHORT: entry * (1 + (collateral / positionUsd) - mmr)
    const marginFraction = collateral / positionUsd;
    const estimatedLiqPrice = isLong
      ? entryPrice * (1 - marginFraction + mmr)
      : entryPrice * (1 + marginFraction - mmr);

    const currentPrice = entryPrice;
    const liqDistancePercent = isLong
      ? ((currentPrice - estimatedLiqPrice) / currentPrice) * 100
      : ((estimatedLiqPrice - currentPrice) / currentPrice) * 100;

    return {
      hasPosition: true,
      side: isLong ? 'long' : 'short',
      entryPrice,
      quantity: baseUnits,
      positionUsd,
      collateral,
      effectiveLeverage,
      estimatedLiqPrice,
      liqDistancePercent,
    };
  }

  // ==================== TRADING (Rise SDK) ====================

  public async placePositionOrder(params: PlacePositionOrderParams): Promise<{ rfqId: string }> {
    const { instrument, executionSide, executionType, amountUsd, overrideBaseUnits, useMidPrice } = params;

    // Check token validity before API calls — if expired, re-login
    try {
      await this.apiClient.getTraderState(this.walletAddress);
    } catch {
      console.log(`  🔄 [${this.walletAddress.slice(0, 6)}] Token expired before order, re-authenticating...`);
      await this.loginHandler();
    }

    const orderbook = await this.apiClient.getOrderbook(instrument);
    const midPrice = orderbook.mid ?? 0;

    if (midPrice <= 0) {
      throw new Error(`Invalid mid price for ${instrument}`);
    }

    const quantity = overrideBaseUnits ?? amountUsd / midPrice;

    // Use Rise SDK for building instructions — it correctly handles margin mode
    const client = createPhoenixClient({
      apiUrl: PHOENIX_API_URL,
      rpcUrl: this.connection.rpcEndpoint,
      auth: false,
      ws: false,
      exchangeMetadata: { stream: false },
    });
    await client.exchange.ready();

    const sdkSide = executionSide === 'long' ? Side.Bid : Side.Ask;

    // Resolve market symbol (SDK may use "ETH-PERP" instead of "ETH")
    const snapshot = client.exchange.snapshot();
    const availableSymbols = snapshot?.markets?.map((m: any) => m.symbol) ?? [];
    const marketSymbol =
      availableSymbols.find((s: string) => s.toUpperCase() === instrument.toUpperCase()) ??
      availableSymbols.find((s: string) => s.toUpperCase() === `${instrument.toUpperCase()}-PERP`) ??
      instrument;

    let rawIxs: any[];

    try {
      if (executionType === 'market') {
        const orderPacket = await client.orderPackets.buildMarketOrderPacket({
          symbol: marketSymbol as any,
          side: sdkSide,
          baseUnits: quantity.toString(),
        });

        const ix = await client.ixs.buildPlaceMarketOrder({
          authority: this.walletAddress as any,
          symbol: marketSymbol as any,
          orderPacket,
          traderPdaIndex: 0,
        });

        rawIxs = Array.isArray(ix) ? ix : [ix];
      } else {
        const bestBid = orderbook.bids[0]?.[0] ?? midPrice;
        const bestAsk = orderbook.asks[0]?.[0] ?? midPrice;
        // For closes (useMidPrice): place at mid for faster fill while staying maker.
        // For opens: place at same side (passive maker).
        const limitPrice = useMidPrice
          ? midPrice
          : (executionSide === 'long' ? bestBid : bestAsk);

        console.log(
          `  📋 Limit ${executionSide.toUpperCase()} @ ${limitPrice} (mid: ${midPrice}, spread: ${(
            ((bestAsk - bestBid) / bestBid) *
            100
          ).toFixed(4)}%)`
        );

        const orderPacket = await client.orderPackets.buildLimitOrderPacket({
          symbol: marketSymbol as any,
          side: sdkSide,
          priceUsd: limitPrice.toString(),
          baseUnits: quantity.toString(),
        });

        const ix = await client.ixs.buildPlaceLimitOrder({
          authority: this.walletAddress as any,
          symbol: marketSymbol as any,
          orderPacket,
          traderPdaIndex: 0,
        });

        rawIxs = Array.isArray(ix) ? ix : [ix];
      }
    } finally {
      client.dispose();
    }

    // Convert from @solana/kit format to legacy TransactionInstruction
    const ixs = rawIxs.map((ix: any) => {
      const programId = new PublicKey(ix.programAddress ?? ix.programId?.toString() ?? '');
      const keys = (ix.accounts ?? ix.keys ?? []).map((k: any) => ({
        pubkey: new PublicKey(k.address ?? k.pubkey?.toString() ?? k.pubkey ?? ''),
        isSigner: k.role === 2 || k.role === 3 || k.isSigner === true,
        isWritable: k.role === 1 || k.role === 3 || k.isWritable === true,
      }));
      const data = Buffer.from(ix.data ?? new Uint8Array());
      return new TransactionInstruction({ programId, keys, data });
    });

    if (ixs.length === 0) {
      throw new Error('No instructions returned from SDK');
    }

    // Delay before sending to avoid rate limiting and nonce conflicts
    await sleep(2 + Math.random() * 1);

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([this.wallet]);

    const txHash = await this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await this.waitForConfirmation(txHash);

    console.log(
      `  ✅ Order placed: ${executionSide.toUpperCase()} ${instrument} | $${amountUsd.toFixed(2)} | tx: ${txHash}`
    );

    return { rfqId: txHash };
  }

  // ==================== REWARDS CLAIM ====================

  /**
   * Claim accrued referral + Flight Club rewards.
   *
   * The Phoenix backend escrows reward funds on our behalf. Claimable rewards
   * surface as "pending escrow requests"; claiming accepts each one on-chain
   * (AcceptEscrowRequest, signed by us as the receiver) and submits the
   * partially-signed transaction to the sponsorship endpoint, which co-signs
   * with a fee payer (so the wallet needs no SOL for gas) and broadcasts.
   */
  public async claimRewards(): Promise<{ claimed: boolean; amountUsd: number; signature: string | null }> {
    const tag = this.walletAddress.slice(0, 6);

    // 1. Rewards summary
    const summary = await this.apiClient.getRewardsSummary(this.walletAddress, REFERRAL_SENDER_PUBKEYS);
    const earnedUsd = (summary.rewardsEarnedQuoteLots ?? 0) / USDC_QUOTE_LOT_MULTIPLIER;
    const claimedUsd =
      (summary.rewardsClaimedHistory ?? []).reduce((sum, h) => sum + (h.amount || 0), 0) / USDC_QUOTE_LOT_MULTIPLIER;
    console.log(`  🎁 [${tag}] Rewards earned: $${earnedUsd.toFixed(4)} | already claimed: $${claimedUsd.toFixed(4)}`);

    try {
      const campaign = await this.apiClient.getCampaignRewardsSummary(this.walletAddress, 'Flight Club');
      console.log(`  🛩️ [${tag}] Flight Club total: $${(campaign.totalAmount / USDC_QUOTE_LOT_MULTIPLIER).toFixed(4)}`);
    } catch { /* ignore */ }

    // 2. Pending escrow requests
    const pending = await this.apiClient.getPendingEscrowRequests(this.walletAddress, REFERRAL_SENDER_PUBKEYS);
    const claimable = pending.filter((req) => req.actions.some((a) => a.kind === 'cash' && a.amount > 0));

    if (claimable.length === 0) {
      console.log(`  ℹ️ [${tag}] Nothing to claim (no pending escrow requests)`);
      return { claimed: false, amountUsd: 0, signature: null };
    }

    const claimableUsd =
      claimable.reduce((sum, req) => {
        for (const a of req.actions) {
          if (a.kind === 'cash' && a.amount > 0) sum += a.amount;
        }
        return sum;
      }, 0) / USDC_QUOTE_LOT_MULTIPLIER;

    console.log(`  💰 [${tag}] Claimable: $${claimableUsd.toFixed(4)} across ${claimable.length} escrow request(s)`);

    // 3. Resolve a sponsored fee payer (pool first, then per-user allocator like the website)
    let feePayer: string;
    try {
      const { payers } = await this.apiClient.getFeePayers();
      if (!payers?.length) throw new Error('empty pool');
      feePayer = payers[Math.floor(Math.random() * payers.length)]!;
    } catch {
      feePayer = await this.apiClient.allocateFeePayer(this.walletAddress);
    }

    // 4. Build AcceptEscrowRequest instructions via the Rise SDK
    const ixs = await this.buildClaimInstructions(claimable);

    // 5. Sign + submit through the sponsorship endpoint
    const signature = await this.submitSponsoredClaim(ixs, feePayer);

    console.log(`  ✅ [${this.walletAddress.slice(0, 6)}] Claimed $${claimableUsd.toFixed(2)} | tx: ${signature}`);
    return { claimed: true, amountUsd: claimableUsd, signature };
  }

  // Build one AcceptEscrowRequest instruction per pending escrow request (kit format).
  private async buildClaimInstructions(requests: PendingEscrowRequest[]): Promise<Instruction[]> {
    const client = createPhoenixClient({
      apiUrl: PHOENIX_API_URL,
      rpcUrl: this.connection.rpcEndpoint,
      auth: false,
      ws: false,
      exchangeMetadata: { stream: false },
    });

    try {
      const snapshot: any = await client.exchange.ready();
      const exchange = snapshot.exchange;

      const programAddress = PHOENIX_PROGRAM_ADDRESS;
      const logAuthorityAddress = PHOENIX_LOG_AUTHORITY_ADDRESS;
      const globalConfigurationAddress = PHOENIX_GLOBAL_CONFIGURATION_ADDRESS;

      const receiverEscrow = await getPhoenixEscrowAddress(this.walletAddress as any, programAddress);

      const ixs: Instruction[] = [];

      for (const req of requests) {
        const [receiverTraderAccount, senderTraderAccount] = await Promise.all([
          getPhoenixTraderSubaccountAddress({
            authority: this.walletAddress as any,
            traderPdaIndex: req.receiverPdaIndex,
            subaccountIndex: req.receiverSubaccountIndex,
            phoenixProgramAddress: programAddress,
          }),
          getPhoenixTraderSubaccountAddress({
            authority: req.senderAuthority as any,
            traderPdaIndex: req.senderPdaIndex,
            subaccountIndex: req.senderSubaccountIndex,
            phoenixProgramAddress: programAddress,
          }),
        ]);

        const ix = buildAcceptEscrowRequestIx({
          programAddress,
          logAuthorityAddress,
          globalConfigurationAddress,
          receiverWallet: this.walletAddress as any,
          receiverTraderAccount,
          receiverEscrow,
          senderWallet: req.senderAuthority as any,
          senderTraderAccount,
          perpAssetMap: exchange.perpAssetMap,
          globalTraderIndex: exchange.globalTraderIndex,
          activeTraderBuffer: exchange.activeTraderBuffer,
        });

        // buildAcceptEscrowRequestIx returns InstructionsWithAccountsAndData which IS a kit Instruction
        ixs.push(ix as unknown as Instruction);
      }

      if (ixs.length === 0) {
        throw new Error('No claim instructions built');
      }

      return ixs;
    } finally {
      client.dispose();
    }
  }

  // Convert a @solana/kit instruction into a legacy TransactionInstruction
  // (same pattern used for SDK-built order instructions).
  private convertKitInstruction(ix: any): TransactionInstruction {
    const programId = new PublicKey(ix.programAddress ?? ix.programId?.toString() ?? '');
    const keys = (ix.accounts ?? ix.keys ?? []).map((k: any) => ({
      pubkey: new PublicKey(k.address ?? k.pubkey?.toString() ?? k.pubkey ?? ''),
      isSigner: k.role === 2 || k.role === 3 || k.isSigner === true,
      isWritable: k.role === 1 || k.role === 3 || k.isWritable === true,
    }));
    const data = Buffer.from(ix.data ?? new Uint8Array());
    return new TransactionInstruction({ programId, keys, data });
  }

  // Match Phoenix website sponsorship path exactly:
  // kit legacy message → compile → partiallySign → getBase64EncodedWireTransaction
  private async submitSponsoredClaim(kitIxs: Instruction[], feePayer: string): Promise<string> {
    const {
      context: { slot },
      value: { blockhash, lastValidBlockHeight },
    } = await this.connection.getLatestBlockhashAndContext('finalized');

    const computeUnitLimitIx: Instruction = {
      programAddress: address('ComputeBudget111111111111111111111111111111'),
      accounts: [],
      data: (() => {
        const data = new Uint8Array(5);
        const view = new DataView(data.buffer);
        view.setUint8(0, 2); // SetComputeUnitLimit
        view.setUint32(1, 500_000, true);
        return data;
      })(),
    };

    // Phoenix website always appends a Lighthouse clock assertion to sponsored txs
    // (default: UnixTimestamp < now+300s). Required by the sponsorship endpoint.
    const lighthouseClockIx: Instruction = {
      programAddress: address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
      accounts: [],
      data: (() => {
        const maxTimestamp = BigInt(Math.floor(Date.now() / 1000) + 300);
        const data = new Uint8Array(12);
        const view = new DataView(data.buffer);
        view.setUint8(0, 15); // AssertClock discriminator
        view.setUint8(1, 0); // logLevel Silent
        view.setUint8(2, 4); // UnixTimestamp variant
        view.setBigInt64(3, maxTimestamp, true);
        view.setUint8(11, 3); // LessThan
        return data;
      })(),
    };

    const message = appendTransactionMessageInstructions(
      [computeUnitLimitIx, ...kitIxs, lighthouseClockIx],
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash as Blockhash,
          lastValidBlockHeight: BigInt(lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          address(feePayer),
          createTransactionMessage({ version: 'legacy' })
        )
      )
    );

    const compiled = compileTransaction(message);
    const signer = await createKeyPairSignerFromBytes(this.wallet.secretKey);
    const signed = await partiallySignTransaction([signer.keyPair], compiled);

    const transactionB64 = getBase64EncodedWireTransaction(signed);
    const userAddr = address(this.walletAddress);
    const userSig = signed.signatures[userAddr];
    if (!userSig) {
      throw new Error('Failed to sign claim transaction with wallet');
    }

    // Frontend uses getBase58Decoder().decode(sigBytes) → base58 string (~88 chars).
    const userSignature = getBase58Decoder().decode(userSig);
    const messageBytes = Uint8Array.from(signed.messageBytes);
    const sigBytes = Uint8Array.from(userSig);
    if (!nacl.sign.detached.verify(messageBytes, sigBytes, this.wallet.publicKey.toBytes())) {
      throw new Error('Local signature verification failed before sponsorship submit');
    }

    const result = await this.apiClient.submitSponsoredTransaction({
      userPubkey: this.walletAddress,
      transaction: transactionB64,
      userSignature,
      slot: slot.toString(),
    });

    await this.waitForConfirmation(result.signature).catch(() => {
      // Sponsorship already submitted; confirmation can lag
    });
    return result.signature;
  }

  // ==================== DEPOSIT ====================

  private static readonly USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  /**
   * Get the wallet's USDC SPL token balance (on-chain wallet, NOT exchange).
   */
  public async getWalletUsdcBalance(): Promise<number> {
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
      this.wallet.publicKey,
      { mint: new PublicKey(PhoenixService.USDC_MINT) }
    );

    if (tokenAccounts.value.length === 0) return 0;

    const parsed = tokenAccounts.value[0]!.account.data as any;
    const uiAmount = parsed?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    return uiAmount as number;
  }

  /**
   * Deposit all USDC from the wallet to the Phoenix exchange account.
   * Returns the amount deposited (0 if nothing to deposit).
   */
  public async depositUsdc(): Promise<{ deposited: number; txHash: string | null }> {
    const tag = this.walletAddress.slice(0, 6);
    const walletBalance = await this.getWalletUsdcBalance();

    if (walletBalance <= 0.01) {
      console.log(`  ℹ️ [${tag}] No USDC on wallet to deposit`);
      return { deposited: 0, txHash: null };
    }

    console.log(`  💰 [${tag}] Wallet USDC: $${walletBalance.toFixed(2)} — depositing to exchange...`);

    // Amount in micro-USDC (6 decimals), leave 0.01 for safety
    const depositAmount = Math.floor((walletBalance - 0.01) * 1e6);
    if (depositAmount <= 0) {
      console.log(`  ℹ️ [${tag}] Balance too small to deposit`);
      return { deposited: 0, txHash: null };
    }

    const client = createPhoenixClient({
      apiUrl: PHOENIX_API_URL,
      rpcUrl: this.connection.rpcEndpoint,
      auth: false,
      ws: false,
      exchangeMetadata: { stream: false },
    });

    try {
      const flow = await (client as any).ixs.buildDepositIxs({
        authority: this.walletAddress,
        traderPdaIndex: 0,
        traderSubaccountIndex: 0,
        amount: BigInt(depositAmount),
      });

      if (!flow?.instructions?.length) {
        throw new Error('No deposit instructions built');
      }

      // Convert kit instructions to legacy TransactionInstruction
      const ixs = flow.instructions.map((ix: any) => {
        const programId = new PublicKey(ix.programAddress ?? ix.programId?.toString() ?? '');
        const keys = (ix.accounts ?? ix.keys ?? []).map((k: any) => ({
          pubkey: new PublicKey(k.address ?? k.pubkey?.toString() ?? k.pubkey ?? ''),
          isSigner: k.role === 2 || k.role === 3 || k.isSigner === true,
          isWritable: k.role === 1 || k.role === 3 || k.isWritable === true,
        }));
        const data = Buffer.from(ix.data ?? new Uint8Array());
        return new TransactionInstruction({ programId, keys, data });
      });

      await sleep(1 + Math.random());

      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

      const messageV0 = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([this.wallet]);

      const txHash = await this.connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      await this.waitForConfirmation(txHash);

      const depositedUsd = depositAmount / 1e6;
      console.log(`  ✅ [${tag}] Deposited $${depositedUsd.toFixed(2)} to exchange | tx: ${txHash}`);
      return { deposited: depositedUsd, txHash };
    } catch (e: any) {
      console.log(`  ⚠️ [${tag}] Deposit failed: ${e.message}`);
      return { deposited: 0, txHash: null };
    } finally {
      client.dispose();
    }
  }

  // ==================== TRANSACTION BUILDING ====================

  public async buildSignAndSendTransaction(instructions: SolanaInstruction[]): Promise<string> {
    const ixs = instructions.map((ix) => ({
      programId: new PublicKey(ix.programId),
      keys: ix.keys.map((key) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      data: Buffer.from(ix.data),
    }));

    // Delay before sending
    await sleep(2 + Math.random() * 1);

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([this.wallet]);

    const rawTx = transaction.serialize();
    const txHash = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });

    await this.waitForConfirmation(txHash);

    return txHash;
  }

  // ==================== CONFIRMATION ====================

  private async waitForConfirmation(
    signature: string,
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
    timeout = 120_000,
    pollInterval = 3000
  ): Promise<void> {
    // Initial delay before first poll
    await sleep(1 + Math.random() * 1);

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const statuses = await this.connection
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .catch(() => null);
      const status = statuses?.value?.[0];
      if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === commitment || status?.confirmationStatus === 'finalized') return;
      await sleep(pollInterval / 1000);
    }

    throw new Error(`Transaction confirmation timeout after ${timeout}ms`);
  }
}
