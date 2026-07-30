// ============================================================
//  PHOENIX API — REST client using got-scraping
//  Ported from myown/src/scripts/main/modules/phoenix
// ============================================================

import type { Response } from 'got';
import { gotScraping } from 'got-scraping';

// ==================== CONSTANTS ====================

export const PHOENIX_API_URL = 'https://perp-api.phoenix.trade';
export const PHOENIX_SITE_URL = 'https://www.phoenix.trade';

// ==================== RANDOM USER-AGENT ====================

const CHROME_VERSIONS = [
  '127.0.6533.24',
  '127.0.6533.23',
  '126.0.6478.153',
  '126.0.6478.108',
  '126.0.6478.132',
  '126.0.6478.71',
  '126.0.6478.61',
  '127.0.6533.4',
  '127.0.6533.3',
  '127.0.6533.2',
  '127.0.6533.0',
  '126.0.6478.50',
  '126.0.6478.54',
  '127.0.6533.57',
  '128.0.6613.84',
  '129.0.6668.58',
  '130.0.6723.59',
  '131.0.6778.108',
  '132.0.6834.83',
  '133.0.6943.137',
  '134.0.6998.33',
  '135.0.7037.79',
  '136.0.7103.113',
  '137.0.7151.68',
];

const WINDOWS_VERSIONS = ['10.0', '10.0.22000'];

const MACOS_VERSIONS = [
  '10_15_7',
  '11_7_10',
  '12_7_3',
  '13_6_4',
  '14_3_1',
  '14_4',
  '14_4_1',
  '14_5',
  '14_6',
  '14_6_1',
  '14_7',
  '15_0',
  '15_0_1',
  '15_1',
  '15_1_1',
  '15_5',
];

const APPLE_WEBKIT_VERSIONS = ['537.36', '605.1.15', '604.1', '600.1.4'];

const LANGUAGES = [
  'en-US',
  'en-US',
  'en-US',
  'en-US',
  'en-US',
  'en-GB',
  'en-AU',
  'en-CA',
  'de-DE',
  'fr-FR',
  'es-ES',
  'ru-RU',
  'uk-UA',
  'pl-PL',
  'ja-JP',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateRandomChromeUserAgent(): string {
  const chromeVersion = randomItem(CHROME_VERSIONS);
  const appleWebKitVersion = randomItem(APPLE_WEBKIT_VERSIONS);
  const isWindows = Math.random() > 0.3; // 70% Windows, 30% macOS

  let osPart: string;
  let platform: string;

  if (isWindows) {
    const winVer = randomItem(WINDOWS_VERSIONS);
    osPart = `Windows NT ${winVer}; Win64; x64`;
    platform = 'Windows';
  } else {
    const macVer = randomItem(MACOS_VERSIONS);
    osPart = `Macintosh; Intel Mac OS X ${macVer}`;
    platform = 'macOS';
  }

  const ua = `Mozilla/5.0 (${osPart}) AppleWebKit/${appleWebKitVersion} (KHTML, like Gecko) Chrome/${chromeVersion} Safari/${appleWebKitVersion}`;
  return ua;
}

function generateAcceptLanguage(): string {
  const lang = randomItem(LANGUAGES);
  const base = lang.split('-')[0];
  return `${lang},${base};q=0.9`;
}

function generateHeaders(): Record<string, string> {
  const userAgent = generateRandomChromeUserAgent();
  const isWindows = userAgent.includes('Windows');
  const platform = isWindows ? 'Windows' : 'macOS';

  return {
    accept: '*/*',
    'accept-language': generateAcceptLanguage(),
    'content-type': 'application/json',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `\\"${platform}\\"`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'User-Agent': userAgent,
    pragma: 'no-cache',
    priority: 'u=0, i',
    Origin: PHOENIX_SITE_URL,
    Referer: `${PHOENIX_SITE_URL}/`,
  };
}

// ==================== TYPES ====================

// --- AUTH ---

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
  pop_key: string;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

// --- EXCHANGE ---

export interface OrderbookView {
  slot: number;
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  mid: number | null;
}

// --- TRADER ---

export interface TraderCapabilities {
  flags: number;
  state: 'uninitialized' | 'cold' | 'active' | 'reduceOnly' | 'frozen';
  capabilities: {
    placeLimitOrder: { immediate: boolean; viaColdActivation: boolean };
    placeMarketOrder: { immediate: boolean; viaColdActivation: boolean };
    riskIncreasingTrade: { immediate: boolean; viaColdActivation: boolean };
    riskReducingTrade: { immediate: boolean; viaColdActivation: boolean };
    depositCollateral: { immediate: boolean; viaColdActivation: boolean };
    withdrawCollateral: { immediate: boolean; viaColdActivation: boolean };
  };
}

export interface TraderPositionSnapshot {
  symbol: string;
  positionSequenceNumber: string;
  basePositionLots: string;
  entryPriceTicks: string;
  entryPriceUsd: string;
  virtualQuotePositionLots: string;
  unsettledFundingQuoteLots: string;
  accumulatedFundingQuoteLots: string;
  takeProfitTriggers: unknown[];
  stopLossTriggers: unknown[];
  conditionalTakeProfitTriggers: unknown[];
  conditionalStopLossTriggers: unknown[];
}

export interface TraderOrderSnapshot {
  orderSequenceNumber: string;
  side: 'bid' | 'ask';
  orderType: string;
  priceTicks: string;
  priceUsd: string;
  sizeRemainingLots: string;
  initialSizeLots: string;
  reduceOnly: boolean;
  status: string;
  isConditionalOrder: boolean;
  isStopLoss: boolean;
}

export interface TraderSubaccountSnapshot {
  subaccountIndex: number;
  sequence: number;
  collateral: string;
  capabilities: TraderCapabilities | null;
  orders: { symbol: string; orders: TraderOrderSnapshot[] }[];
  positions: TraderPositionSnapshot[];
}

export interface TraderStateSnapshot {
  version: number;
  capabilities: TraderCapabilities;
  makerFeeOverrideMultiplier: number;
  takerFeeOverrideMultiplier: number;
  subaccounts: TraderSubaccountSnapshot[];
}

export interface TraderStateResponse {
  authority: string;
  traderPdaIndex: number;
  slot: number;
  slotIndex: number;
  snapshot: TraderStateSnapshot;
}

// --- ORDERS ---

export interface SolanaAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface SolanaInstruction {
  data: number[];
  keys: SolanaAccountMeta[];
  programId: string;
}

export interface TpSlConfig {
  numBaseLots?: number;
  orderKind?: string;
  quantity?: number;
  stopLossExecutionPrice?: number;
  stopLossTriggerPrice?: number;
  takeProfitExecutionPrice?: number;
  takeProfitTriggerPrice?: number;
}

export interface PlaceMarketOrderRequest {
  authority: string;
  symbol: string;
  side: string;
  quantity?: number;
  numBaseLots?: number;
  maxPriceInTicks?: number;
  isReduceOnly?: boolean;
  feePayer?: string;
  pdaIndex?: number;
  positionAuthority?: string;
  skipTransferToParent?: boolean;
  transferAmount?: number;
  allowCrossAndIsolatedForAsset?: boolean;
  tpSl?: TpSlConfig;
}

export interface PlaceLimitOrderRequest {
  authority: string;
  symbol: string;
  side: string;
  price?: number;
  priceInTicks?: number;
  quantity?: number;
  numBaseLots?: number;
  isPostOnly?: boolean;
  isReduceOnly?: boolean;
  slide?: boolean;
  feePayer?: string;
  pdaIndex?: number;
  positionAuthority?: string;
  skipTransferToParent?: boolean;
  transferAmount?: number;
  allowCrossAndIsolatedForAsset?: boolean;
  tpSl?: TpSlConfig;
}

// --- REGISTER ---

export interface BuildRegisterRequest {
  traderAuthority: string;
  txFeePayer: string;
  maxPositions?: number;
}

export interface BuildRegisterResponse {
  includeRegisterTrader: boolean;
  instructions: SolanaInstruction[];
  maxPositions: number;
  traderOnboarder: string;
  traderPda: string;
  txFeePayer: string;
}

export interface SendRegisterIxsRequest {
  transaction: string;
  traderAuthority: string;
  txFeePayer: string;
  maxPositions?: number;
  traderPdaIndex?: number;
  traderSubaccountIndex?: number;
}

export interface SendRegisterIxsResponse {
  signature: string;
  traderPda: string;
  traderOnboarder: string;
  txFeePayer: string;
  maxPositions: number;
}

// --- REFERRAL ---

export interface ValidateInviteRequest {
  code: string;
  wallet_address: string;
  transaction_signature?: string | null;
}

export interface ValidateInviteResponse {
  success: boolean;
  message: string;
  whitelisted: boolean;
}

export interface ActivateReferralTxRequest {
  recent_blockhash: string;
  referral_code: string;
  trader_authority: string;
  trader_pda_index?: number;
  trader_subaccount_index?: number;
  transaction: string;
}

export interface ActivateReferralTxResponse {
  referral_code: string;
  signature: string | null;
  status: 'activated' | 'submitted' | 'already_activated';
  trader_pda: string;
}

export interface ActivateReferralResponse {
  success: boolean;
  message: string;
}

export interface CheckWalletResponse {
  whitelisted: boolean;
  whitelisted_at?: string | null;
  invite_code_used?: string | null;
}

// --- REWARDS / SPONSORSHIP ---

export interface RewardsEarnedHistoryEntry {
  amount: number;
  timestamp: string;
  sender_pubkey: string;
}

export interface RewardsClaimedHistoryEntry {
  amount: number;
  timestamp: string;
  signature?: string | null;
  sender_amounts?: { sender_pubkey: string; amount: number }[];
}

export interface RewardsSummaryResponse {
  referredUsers: unknown[];
  referralTierId: number | null;
  referralTierName: string | null;
  referrerFeeShareBps: number | null;
  refereeDiscountBps: number | null;
  maxUses: number | null;
  currentUses: number | null;
  rewardsEarnedQuoteLots: number;
  rewardsEarnedHistory: RewardsEarnedHistoryEntry[];
  rewardsClaimedHistory: RewardsClaimedHistoryEntry[];
}

export interface CampaignRewardsSummaryResponse {
  campaignType: string | null;
  totalAmount: number;
}

export type EscrowActionView = { kind: 'noop' } | { kind: 'cash'; amount: number };

export interface PendingEscrowRequest {
  sequenceNumber: number;
  senderAuthority: string;
  senderPdaIndex: number;
  senderSubaccountIndex: number;
  receiverPdaIndex: number;
  receiverSubaccountIndex: number;
  expirationOffset: number | null;
  initialSlot: number;
  actions: EscrowActionView[];
}

export interface FeePayersResponse {
  payers: string[];
}

export interface SponsorTransactionRequest {
  userPubkey: string;
  transaction: string;
  userSignature: string;
  slot: string;
  traderPubkey?: string;
  positionAuthority?: string;
}

export interface SponsorTransactionResponse {
  signature: string;
}

// ==================== API CLIENT ====================

interface PhoenixApiClientOpts {
  proxyUrl?: string;
}

type StringRecord = Record<string, string>;

export class PhoenixApiClient {
  private session: typeof gotScraping;
  private accessToken = '';

  constructor(opts: PhoenixApiClientOpts = {}) {
    const baseHeaders = generateHeaders();

    this.session = gotScraping.extend({
      headers: baseHeaders,
      proxyUrl: opts.proxyUrl,
      useHeaderGenerator: false,
      timeout: { request: 60_000 },
      retry: { limit: 1 },
    });
  }

  public extendSession(headers: StringRecord): void {
    this.session = this.session.extend({ headers });
  }

  public applyAuthToken(token: string): void {
    this.accessToken = token;
    this.extendSession({
      Authorization: `Bearer ${token}`,
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

  public async refreshSession(req: RefreshTokenRequest): Promise<AuthTokenResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/auth/refresh`, {
      json: req,
    });
    return this.extractBody<AuthTokenResponse>(res);
  }

  // ==================== EXCHANGE ====================

  public async getOrderbook(symbol: string): Promise<OrderbookView> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/view/orderbook/${symbol}`);
    return this.extractBody<OrderbookView>(res);
  }

  public async getMarkets(): Promise<unknown[]> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/view/exchange/markets`);
    return this.extractBody<unknown[]>(res);
  }

  // ==================== TRADER ====================

  public async getTraderState(authorityPubkey: string, traderPdaIndex?: number): Promise<TraderStateResponse> {
    const searchParams: Record<string, string | number> = {};
    if (traderPdaIndex !== undefined) {
      searchParams.traderPdaIndex = traderPdaIndex;
    }

    const res = await this.session.get(`${PHOENIX_API_URL}/v1/trader/state/${authorityPubkey}`, {
      searchParams,
    });
    return this.extractBody<TraderStateResponse>(res);
  }

  public async getTraderCapabilities(): Promise<unknown> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/view/trader-capabilities`);
    return this.extractBody<unknown>(res);
  }

  // ==================== ORDERS ====================

  public async buildMarketOrderInstructions(req: PlaceMarketOrderRequest): Promise<SolanaInstruction[]> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/ix/place-isolated-market-order`, {
      json: req,
    });
    return this.extractBody<SolanaInstruction[]>(res);
  }

  public async buildLimitOrderInstructions(req: PlaceLimitOrderRequest): Promise<SolanaInstruction[]> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/ix/place-isolated-limit-order`, {
      json: req,
    });
    return this.extractBody<SolanaInstruction[]>(res);
  }

  // ==================== REGISTER ====================

  public async buildRegisterInstructions(req: BuildRegisterRequest): Promise<BuildRegisterResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/exchange/build-register-ixs`, {
      json: req,
    });
    return this.extractBody<BuildRegisterResponse>(res);
  }

  public async sendRegisterIxs(req: SendRegisterIxsRequest): Promise<SendRegisterIxsResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/exchange/send-register-ixs`, {
      json: req,
    });
    return this.extractBody<SendRegisterIxsResponse>(res);
  }

  // ==================== REFERRAL ====================

  public async validateInvite(req: ValidateInviteRequest): Promise<ValidateInviteResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/invite/validate`, {
      json: req,
    });
    return this.extractBody<ValidateInviteResponse>(res);
  }

  public async checkWallet(walletAddress: string): Promise<CheckWalletResponse> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/invite/check/${walletAddress}`);
    return this.extractBody<CheckWalletResponse>(res);
  }

  public async activateReferral(req: {
    code: string;
    wallet_address: string;
  }): Promise<ActivateReferralResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/referral/activate`, {
      json: {
        ...req,
        authority: req.wallet_address,
      },
    });
    return this.extractBody<ActivateReferralResponse>(res);
  }

  public async activateReferralTx(req: ActivateReferralTxRequest): Promise<ActivateReferralTxResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/referral/activate-tx`, {
      json: req,
    });
    return this.extractBody<ActivateReferralTxResponse>(res);
  }

  // ==================== REWARDS / SPONSORSHIP ====================

  public async getRewardsSummary(address: string, senderPubkeys: string[]): Promise<RewardsSummaryResponse> {
    const params = new URLSearchParams();
    for (const pk of senderPubkeys) params.append('sender_pubkey', pk);

    const res = await this.session.get(
      `${PHOENIX_API_URL}/v1/users/${encodeURIComponent(address)}/rewards/summary`,
      { searchParams: params }
    );
    return this.extractBody<RewardsSummaryResponse>(res);
  }

  public async getCampaignRewardsSummary(
    address: string,
    campaignType: string
  ): Promise<CampaignRewardsSummaryResponse> {
    const res = await this.session.get(
      `${PHOENIX_API_URL}/v1/users/${encodeURIComponent(address)}/campaign-rewards/summary`,
      { searchParams: { campaign_type: campaignType } }
    );
    return this.extractBody<CampaignRewardsSummaryResponse>(res);
  }

  public async getPendingEscrowRequests(
    address: string,
    senderPubkeys: string[]
  ): Promise<PendingEscrowRequest[]> {
    const params = new URLSearchParams();
    for (const pk of senderPubkeys) params.append('sender_pubkey', pk);

    const res = await this.session.get(
      `${PHOENIX_API_URL}/v1/users/${encodeURIComponent(address)}/pending-escrow-requests`,
      { searchParams: params }
    );
    return this.extractBody<PendingEscrowRequest[]>(res);
  }

  public async getFeePayers(): Promise<FeePayersResponse> {
    const res = await this.session.get(`${PHOENIX_API_URL}/v1/sponsorship/fee-payers`);
    return this.extractBody<FeePayersResponse>(res);
  }

  /** Fallback allocator used by the Phoenix website when the fee-payer pool fetch fails. */
  public async allocateFeePayer(userPubkey: string): Promise<string> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/sponsorship/fee-payer`, {
      json: { userPubkey },
    });
    const body = this.extractBody<{ payer: string }>(res);
    if (!body.payer) throw new Error('Sponsorship fee-payer allocation returned empty payer');
    return body.payer;
  }

  public async submitSponsoredTransaction(req: SponsorTransactionRequest): Promise<SponsorTransactionResponse> {
    const res = await this.session.post(`${PHOENIX_API_URL}/v1/sponsorship/transaction`, { json: req });
    return this.extractBody<SponsorTransactionResponse>(res);
  }

  // ==================== HELPERS ====================

  private extractBody<T>(res: Response<string>): T {
    if (res.statusCode >= 400) {
      const rawBody = res.body;
      const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      throw new Error(`Phoenix API error [${res.statusCode}]: ${bodyStr}`);
    }

    try {
      return JSON.parse(res.body as string) as T;
    } catch {
      return res.body as unknown as T;
    }
  }
}
