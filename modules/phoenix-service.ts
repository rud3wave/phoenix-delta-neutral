// ============================================================
//  PHOENIX SERVICE — Trading service using Rise SDK
// ============================================================

import { createPhoenixClient, Side } from '@ellipsis-labs/rise';
import { base58 } from '@scure/base';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import nacl from 'tweetnacl';

import { sleep } from './utils.js';
import {
  PhoenixApiClient,
  type SolanaInstruction,
  type TraderStateResponse,
} from './phoenix-api.js';

// ==================== CONFIG ====================

const PHOENIX_API_URL = 'https://perp-api.phoenix.trade';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const REFERRAL_CODES = ['V9EZG25S', 'X95ET4N2'];

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

export interface PlaceOrderParams {
  instrument: string;
  executionSide: 'long' | 'short';
  executionType: 'market' | 'limit';
  amountUsd: number;
  leverage?: number;
  overrideBaseUnits?: number;
}

// ==================== SERVICE ====================

export class PhoenixService {
  private readonly apiClient: PhoenixApiClient;
  private readonly connection: Connection;
  private readonly wallet: Keypair;
  private readonly walletAddress: string;
  private baseLotsDecimalsCache: Record<string, number> = {};

  constructor(wallet: Keypair, proxyUrl?: string) {
    this.wallet = wallet;
    this.walletAddress = wallet.publicKey.toString();
    this.connection = new Connection(SOLANA_RPC, 'confirmed');
    this.apiClient = new PhoenixApiClient({ proxyUrl });
  }

  public getAddress(): string {
    return this.walletAddress;
  }

  public getApiClient(): PhoenixApiClient {
    return this.apiClient;
  }

  // ==================== AUTH ====================

  public async loginHandler(): Promise<boolean> {
    console.log(`  🔑 [${this.walletAddress.slice(0, 6)}] Authenticating with Phoenix...`);

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
    console.log(`  ✅ [${this.walletAddress.slice(0, 6)}] Authenticated`);
    return true;
  }

  // ==================== REGISTRATION ====================

  public async ensureRegistered(): Promise<void> {
    // Check on-chain status
    let alreadyActive = false;
    try {
      const state = await this.apiClient.getTraderState(this.walletAddress);
      if (state.snapshot?.capabilities?.state === 'active') {
        console.log(`  ℹ️ [${this.walletAddress.slice(0, 6)}] Already active on-chain`);
        alreadyActive = true;
      }
    } catch {
      // Not registered on-chain yet
    }

    if (!alreadyActive) {
      console.log(`  📝 [${this.walletAddress.slice(0, 6)}] Registering trader on Phoenix...`);

      const registerResponse = await this.apiClient.buildRegisterInstructions({
        traderAuthority: this.walletAddress,
        txFeePayer: this.walletAddress,
      });

      if (registerResponse.includeRegisterTrader && registerResponse.instructions.length > 0) {
        const txHash = await this.buildSignAndSendTransaction(registerResponse.instructions);
        console.log(`  ✅ [${this.walletAddress.slice(0, 6)}] Trader registered | tx: ${txHash}`);
      }
    }

    // Always activate referral code (even for already-active wallets)
    await this.activateReferral();
  }

  private async activateReferral(): Promise<void> {
    let lastError = '';

    for (const code of REFERRAL_CODES) {
      try {
        const result = await this.apiClient.activateReferral({
          code,
          wallet_address: this.walletAddress,
        });

        if (result.success) {
          console.log(`  ✅ [${this.walletAddress.slice(0, 6)}] Referral code activated`);
          return;
        }

        lastError = result.message;
      } catch (e: any) {
        lastError = e.message;
      }
    }

    throw new Error(`Referral activation failed with all codes: ${lastError}`);
  }

  // ==================== BALANCE ====================

  public async getUsdcBalance(): Promise<number> {
    const state = await this.apiClient.getTraderState(this.walletAddress);
    const subaccounts = state.snapshot?.subaccounts ?? [];
    const rawCollateral = subaccounts.reduce((sum, sub) => sum + parseFloat(sub.collateral || '0'), 0);
    // Phoenix returns collateral in micro-USDC (6 decimals)
    return rawCollateral / 1e6;
  }

  // ==================== POSITIONS ====================

  public async getPositions(): Promise<TraderStateResponse> {
    return this.apiClient.getTraderState(this.walletAddress);
  }

  private findPosition(state: TraderStateResponse, symbol: string) {
    const subaccounts = state.snapshot?.subaccounts ?? [];
    for (const sub of subaccounts) {
      const positions = sub.positions ?? [];
      const pos = positions.find((p) => p.symbol === symbol && Number(p.basePositionLots) !== 0);
      if (pos) return pos;
    }
    return undefined;
  }

  private getTotalCollateral(state: TraderStateResponse): number {
    const subaccounts = state.snapshot?.subaccounts ?? [];
    return subaccounts.reduce((sum, sub) => sum + parseFloat(sub.collateral || '0'), 0);
  }

  // ==================== BASE LOTS DECIMALS ====================

  public async getBaseLotsDecimals(symbol: string): Promise<number> {
    if (this.baseLotsDecimalsCache[symbol] !== undefined) {
      return this.baseLotsDecimalsCache[symbol]!;
    }

    try {
      const client = createPhoenixClient({
        apiUrl: PHOENIX_API_URL,
        rpcUrl: SOLANA_RPC,
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

  public lotsToBaseUnits(lots: number, symbol: string): number {
    const decimals = this.baseLotsDecimalsCache[symbol] ?? 0;
    return lots / Math.pow(10, decimals);
  }

  public async getPositionBaseUnits(symbol: string): Promise<number> {
    const state = await this.getPositions();
    const position = this.findPosition(state, symbol);
    if (!position) return 0;

    await this.getBaseLotsDecimals(symbol);
    const rawLots = Math.abs(Number(position.basePositionLots));
    return this.lotsToBaseUnits(rawLots, symbol);
  }

  public async getPositionWithLiquidation(symbol: string): Promise<PositionWithLiquidation> {
    const state = await this.getPositions();
    const collateral = this.getTotalCollateral(state) / 1e6;
    const position = this.findPosition(state, symbol);

    if (!position) {
      return {
        hasPosition: false, side: null, entryPrice: 0, quantity: 0,
        positionUsd: 0, collateral, effectiveLeverage: 0,
        estimatedLiqPrice: 0, liqDistancePercent: 0,
      };
    }

    await this.getBaseLotsDecimals(symbol);
    const rawLots = Number(position.basePositionLots);
    const isLong = rawLots > 0;
    const baseUnits = this.lotsToBaseUnits(Math.abs(rawLots), symbol);
    const entryPrice = parseFloat(position.entryPriceUsd || '0');
    const positionUsd = baseUnits * entryPrice;
    const effectiveLeverage = collateral > 0 ? positionUsd / collateral : 0;

    // Phoenix maintenance margin rate ~0.5%
    const mmr = 0.005;
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

  // ==================== MARKET SNAPSHOT ====================

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
        console.log(`  📊 Spread OK: ${snapshot.spreadPercent.toFixed(4)}% <= ${maxSpreadPercent}%`);
        return { midPrice: snapshot.midPrice, spreadPercent: snapshot.spreadPercent };
      }

      if (Date.now() - startTime > timeoutSeconds * 1000) {
        throw new Error(`Spread timeout: ${snapshot.spreadPercent.toFixed(4)}% > ${maxSpreadPercent}%`);
      }

      console.log(`  ⏳ Waiting for spread: ${snapshot.spreadPercent.toFixed(4)}%...`);
      await sleep(pollingSeconds);
    }
  }

  // ==================== TRADING (Rise SDK) ====================

  public async placePositionOrder(params: PlaceOrderParams): Promise<{ rfqId: string }> {
    const { instrument, executionSide, executionType, amountUsd, overrideBaseUnits } = params;

    // Re-auth if token expired
    try {
      await this.apiClient.getTraderState(this.walletAddress);
    } catch {
      console.log(`  🔄 [${this.walletAddress.slice(0, 6)}] Token expired, re-authenticating...`);
      await this.loginHandler();
    }

    const orderbook = await this.apiClient.getOrderbook(instrument);
    const midPrice = orderbook.mid ?? 0;
    if (midPrice <= 0) throw new Error(`Invalid mid price for ${instrument}`);

    const quantity = overrideBaseUnits ?? amountUsd / midPrice;

    // Use Rise SDK for cross-margin compatible orders
    const client = createPhoenixClient({
      apiUrl: PHOENIX_API_URL,
      rpcUrl: SOLANA_RPC,
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
        const limitPrice = executionSide === 'long' ? bestBid : bestAsk;

        console.log(`  📋 Limit ${executionSide.toUpperCase()} @ ${limitPrice} (mid: ${midPrice})`);

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

    if (ixs.length === 0) throw new Error('No instructions returned from SDK');

    const txHash = await this.sendTransaction(ixs);
    console.log(`  ✅ Order: ${executionSide.toUpperCase()} ${instrument} $${amountUsd.toFixed(2)} | tx: ${txHash}`);
    return { rfqId: txHash };
  }

  // ==================== CLOSE POSITIONS ====================

  public async closeAllPositionsAndOrders(): Promise<void> {
    const state = await this.apiClient.getTraderState(this.walletAddress);
    const subaccounts = state.snapshot?.subaccounts ?? [];

    for (const subaccount of subaccounts) {
      const positions = subaccount.positions ?? [];

      for (const position of positions) {
        const baseLots = Number(position.basePositionLots);
        if (baseLots === 0) continue;

        const symbol = position.symbol;
        await this.getBaseLotsDecimals(symbol);
        const baseUnits = this.lotsToBaseUnits(Math.abs(baseLots), symbol);
        const closeSide = baseLots > 0 ? 'short' : 'long';

        console.log(`  🔄 Closing ${symbol} | ${closeSide.toUpperCase()} | ${baseUnits.toFixed(6)} base units`);

        try {
          await this.placePositionOrder({
            instrument: symbol,
            executionSide: closeSide as 'long' | 'short',
            executionType: 'market',
            amountUsd: 0,
            overrideBaseUnits: baseUnits,
          });
        } catch (e: any) {
          console.log(`  ⚠️ Failed to close ${symbol}: ${e.message}`);
        }
      }
    }
  }

  public async closePositionByLimit(symbol: string): Promise<void> {
    const state = await this.getPositions();
    const position = this.findPosition(state, symbol);

    if (!position) {
      console.log(`  ℹ️ No open position for ${symbol}`);
      return;
    }

    await this.getBaseLotsDecimals(symbol);
    const baseUnits = this.lotsToBaseUnits(Math.abs(Number(position.basePositionLots)), symbol);
    const closeSide = Number(position.basePositionLots) > 0 ? 'short' : 'long';

    console.log(`  📋 Closing ${symbol} via LIMIT | ${closeSide.toUpperCase()} | ${baseUnits.toFixed(6)}`);

    await this.placePositionOrder({
      instrument: symbol,
      executionSide: closeSide as 'long' | 'short',
      executionType: 'limit',
      amountUsd: 0,
      overrideBaseUnits: baseUnits,
    });
  }

  // ==================== CANCEL ORDERS ====================

  public async cancelAllOrders(symbol: string): Promise<void> {
    let client: any;

    try {
      client = createPhoenixClient({
        apiUrl: PHOENIX_API_URL,
        auth: false,
        ws: false,
      });
      await client.exchange.ready();

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

          const txHash = await this.sendTransaction(ixs);
          console.log(`  ✅ Cancelled orders subaccount[${subIdx}] ${symbol} | tx: ${txHash}`);
        } catch {
          // No orders to cancel — ok
        }
      }
    } catch (e: any) {
      console.log(`  ⚠️ Cancel orders failed: ${e.message}`);
    } finally {
      client?.dispose();
    }
  }

  // ==================== TRANSACTION HELPERS ====================

  private async sendTransaction(ixs: TransactionInstruction[]): Promise<string> {
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
    return txHash;
  }

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

    return this.sendTransaction(ixs);
  }

  private async waitForConfirmation(
    signature: string,
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
    timeout = 30_000,
    pollInterval = 3000
  ): Promise<void> {
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
