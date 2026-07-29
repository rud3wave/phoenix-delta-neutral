// ============================================================
//  PHOENIX API — Simplified REST client using got-scraping
// ============================================================

import { gotScraping } from 'got-scraping';

const PHOENIX_API_URL = 'https://perp-api.phoenix.trade';
const PHOENIX_SITE_URL = 'https://www.phoenix.trade';

// ==================== TYPES ====================

export interface WalletNonceResponse {
  nonce_id: string;
  message: string;
  expires_at: string;
}

export interface WalletLoginRequest {
  nonce_id: string;
  signature: string;
  wallet_pubkey: string;
}

export interface AuthTokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
}

export interface OrderbookView {
  slot: number;
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  mid: number | null;
}

export interface TraderPositionSnapshot {
  symbol: string;
  basePositionLots: string;
  entryPriceUsd: string;
}

export interface TraderOrderSnapshot {
  side: 'bid' | 'ask';
  priceUsd: string;
  sizeRemainingLots: string;
  initialSizeLots: string;
  status: string;
}

export interface TraderSubaccountSnapshot {
  subaccountIndex: number;
  collateral: string;
  orders: { symbol: string; orders: TraderOrderSnapshot[] }[];
  positions: TraderPositionSnapshot[];
}

export interface TraderStateSnapshot {
  capabilities: { state: string };
  subaccounts: TraderSubaccountSnapshot[];
}

export interface TraderStateResponse {
  authority: string;
  traderPdaIndex: number;
  snapshot: TraderStateSnapshot;
}

export interface SolanaInstruction {
  data: number[];
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  programId: string;
}

export interface BuildRegisterResponse {
  includeRegisterTrader: boolean;
  instructions: SolanaInstruction[];
  traderPda: string;
}

export interface ValidateInviteResponse {
  success: boolean;
  message: string;
  whitelisted: boolean;
}

export interface ActivateReferralResponse {
  success: boolean;
  message: string;
}

export interface ActivateReferralTxResponse {
  referral_code: string;
  signature: string | null;
  status: 'activated' | 'submitted' | 'already_activated';
  trader_pda: string;
}

// ==================== API CLIENT ====================

interface PhoenixApiClientOpts {
  proxyUrl?: string;
}

export class PhoenixApiClient {
  private session: typeof gotScraping;
  private accessToken = '';

  constructor(opts: PhoenixApiClientOpts = {}) {
    this.session = gotScraping.extend({
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        Origin: PHOENIX_SITE_URL,
        Referer: `${PHOENIX_SITE_URL}/`,
      },
      proxyUrl: opts.proxyUrl,
      useHeaderGenerator: false,
      timeout: { request: 30_000 },
      retry: { limit: 1 },
      responseType: 'json',
    });
  }

  public applyAuthToken(token: string): void {
    this.accessToken = token;
    this.session = this.session.extend({
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  public getAccessToken(): string {
    return this.accessToken;
  }

  // ==================== AUTH ====================

  public async getWalletNonce(walletPubkey: string): Promise<WalletNonceResponse> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/auth/nonce`, {
      searchParams: { wallet_pubkey: walletPubkey },
    });
    return this.extractBody<WalletNonceResponse>(res);
  }

  public async loginWithWalletSignature(req: WalletLoginRequest): Promise<AuthTokenResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/auth/login/wallet`, {
      json: req,
    });
    return this.extractBody<AuthTokenResponse>(res);
  }

  // ==================== EXCHANGE ====================

  public async getOrderbook(symbol: string): Promise<OrderbookView> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/view/orderbook/${symbol}`);
    return this.extractBody<OrderbookView>(res);
  }

  // ==================== TRADER ====================

  public async getTraderState(authorityPubkey: string): Promise<TraderStateResponse> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/trader/state/${authorityPubkey}`);
    return this.extractBody<TraderStateResponse>(res);
  }

  // ==================== ORDERS (REST fallback) ====================

  public async buildMarketOrderInstructions(req: {
    authority: string;
    symbol: string;
    side: string;
    quantity?: number;
    numBaseLots?: number;
  }): Promise<SolanaInstruction[]> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/ix/place-isolated-market-order`, {
      json: req,
    });
    return this.extractBody<SolanaInstruction[]>(res);
  }

  public async buildLimitOrderInstructions(req: {
    authority: string;
    symbol: string;
    side: string;
    price?: number;
    quantity?: number;
    numBaseLots?: number;
    isPostOnly?: boolean;
  }): Promise<SolanaInstruction[]> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/ix/place-isolated-limit-order`, {
      json: req,
    });
    return this.extractBody<SolanaInstruction[]>(res);
  }

  // ==================== REGISTER ====================

  public async buildRegisterInstructions(req: {
    traderAuthority: string;
    txFeePayer: string;
  }): Promise<BuildRegisterResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/exchange/build-register-ixs`, {
      json: req,
    });
    return this.extractBody<BuildRegisterResponse>(res);
  }

  // ==================== REFERRAL ====================

  public async validateInvite(req: {
    code: string;
    wallet_address: string;
  }): Promise<ValidateInviteResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/invite/validate`, {
      json: req,
    });
    return this.extractBody<ValidateInviteResponse>(res);
  }

  public async activateReferral(req: {
    code: string;
    wallet_address: string;
  }): Promise<ActivateReferralResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/referral/activate`, {
      json: req,
    });
    return this.extractBody<ActivateReferralResponse>(res);
  }

  public async activateReferralTx(req: {
    recent_blockhash: string;
    referral_code: string;
    trader_authority: string;
    transaction: string;
  }): Promise<ActivateReferralTxResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/referral/activate-tx`, {
      json: req,
    });
    return this.extractBody<ActivateReferralTxResponse>(res);
  }

  // ==================== HELPERS ====================

  private extractBody<T>(res: any): T {
    if (res.statusCode >= 400) {
      const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      throw new Error(`Phoenix API error [${res.statusCode}]: ${bodyStr}`);
    }
    // got-scraping with responseType:'json' already parses the body
    if (typeof res.body === 'string') {
      try {
        return JSON.parse(res.body) as T;
      } catch {
        return res.body as unknown as T;
      }
    }
    return res.body as T;
  }
}
