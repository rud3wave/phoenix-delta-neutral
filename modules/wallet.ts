// ============================================================
//  WALLET — Key management, encryption, proxy assignment
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { base58 } from '@scure/base';
import { mnemonicToSeedSync } from '@scure/bip39';
import { Keypair } from '@solana/web3.js';
import CryptoJS from 'crypto-js';

import { ENCRYPTION_PASSWORD } from '../global.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ==================== TYPES ====================

export interface WalletAccount {
  keypair: Keypair;
  address: string;
  proxyUrl?: string;
  index: number;
}

interface EncryptedWalletEntry {
  address: string;
  encryptedKey: string;
  proxyUrl?: string;
  index: number;
}

// ==================== SLIP10 DERIVATION ====================

/**
 * SLIP-0010 ed25519 key derivation.
 * Path: m/44'/501'/0'/0' (standard Solana derivation for Phantom, Solflare, etc.)
 */
function slip10Derive(seed: Uint8Array, path: string): Uint8Array {
  // Master key: HMAC-SHA512("ed25519 seed", seed)
  const I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  // Parse path segments (skip "m")
  const segments = path
    .split('/')
    .slice(1)
    .map((s) => {
      const hardened = s.endsWith("'");
      const index = parseInt(s.replace("'", ''), 10);
      return hardened ? index + 0x80000000 : index;
    });

  for (const index of segments) {
    // ed25519: only hardened derivation allowed
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);

    const I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  return key;
}

// ==================== KEY DETECTION & CREATION ====================

/** Check if a string looks like a mnemonic (12 or 24 words) */
function isMnemonic(key: string): boolean {
  const words = key.trim().split(/\s+/);
  return words.length === 12 || words.length === 24;
}

/**
 * Create a Solana Keypair from a private key string.
 * Supports: base58 private key OR mnemonic phrase (12/24 words).
 */
export function createKeypair(privateKey: string): Keypair {
  const trimmed = privateKey.trim();

  if (isMnemonic(trimmed)) {
    // Mnemonic → seed → slip10 derive → Keypair
    const seed = mnemonicToSeedSync(trimmed, '');
    const derivedKey = slip10Derive(seed, "m/44'/501'/0'/0'");
    return Keypair.fromSeed(derivedKey);
  }

  // Base58 private key
  const decoded = base58.decode(trimmed);
  if (decoded.length === 64) {
    // Full 64-byte secret key (secret + public)
    return Keypair.fromSecretKey(decoded);
  }
  if (decoded.length === 32) {
    // 32-byte seed
    return Keypair.fromSeed(decoded);
  }

  throw new Error(`Invalid private key length: ${decoded.length} bytes (expected 32 or 64)`);
}

// ==================== ENCRYPTION ====================

/** Encrypt a private key string using AES */
export function encryptKey(plainKey: string): string {
  return CryptoJS.AES.encrypt(plainKey, ENCRYPTION_PASSWORD).toString();
}

/** Decrypt an AES-encrypted private key */
export function decryptKey(encryptedKey: string): string {
  const bytes = CryptoJS.AES.decrypt(encryptedKey, ENCRYPTION_PASSWORD);
  const result = bytes.toString(CryptoJS.enc.Utf8);
  if (!result) throw new Error('Decryption failed — wrong ENCRYPTION_PASSWORD?');
  return result;
}

// ==================== FILE READING ====================

/** Read non-empty, non-comment lines from a file */
function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Read private keys from input_data/privatekeys.txt */
export function readPrivateKeys(): string[] {
  const filePath = join(ROOT, 'input_data', 'privatekeys.txt');
  const keys = readLines(filePath);
  if (keys.length === 0) {
    throw new Error(`No private keys found in ${filePath}`);
  }
  console.log(`📂 Loaded ${keys.length} private key(s) from privatekeys.txt`);
  return keys;
}

/** Read proxies from input_data/proxies.txt */
export function readProxies(): string[] {
  const filePath = join(ROOT, 'input_data', 'proxies.txt');
  const proxies = readLines(filePath);
  if (proxies.length > 0) {
    console.log(`📂 Loaded ${proxies.length} proxy(ies) from proxies.txt`);
  }
  return proxies;
}

// ==================== WALLET LOADING ====================

/**
 * Load wallets from privatekeys.txt, assign proxies round-robin.
 * Returns array of WalletAccount with keypairs ready to use.
 */
export function loadWallets(): WalletAccount[] {
  const keys = readPrivateKeys();
  const proxies = readProxies();

  const wallets: WalletAccount[] = keys.map((key, index) => {
    const keypair = createKeypair(key);
    const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : undefined;

    return {
      keypair,
      address: keypair.publicKey.toString(),
      proxyUrl,
      index,
    };
  });

  console.log(`✅ Created ${wallets.length} wallet(s):`);
  for (const w of wallets) {
    const proxy = w.proxyUrl ? ` | proxy: ${w.proxyUrl.slice(0, 30)}...` : ' | no proxy';
    console.log(`   [${w.index}] ${w.address.slice(0, 8)}...${w.address.slice(-6)}${proxy}`);
  }

  return wallets;
}

// ==================== ENCRYPTED STORAGE ====================

const DB_DIR = join(ROOT, 'databases');
const WALLETS_DB = join(DB_DIR, 'wallets.json');

/**
 * Encrypt private keys and save to databases/wallets.json.
 * Called on first run to persist encrypted keys.
 */
export function saveEncryptedWallets(rawKeys: string[], wallets: WalletAccount[]): void {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  const entries: EncryptedWalletEntry[] = wallets.map((w, i) => ({
    address: w.address,
    encryptedKey: encryptKey(rawKeys[i]!),
    proxyUrl: w.proxyUrl,
    index: w.index,
  }));

  writeFileSync(WALLETS_DB, JSON.stringify(entries, null, 2), 'utf-8');
  console.log(`💾 Encrypted wallets saved to databases/wallets.json`);
}

/**
 * Load wallets from encrypted databases/wallets.json.
 * Returns null if the file doesn't exist (first run).
 */
export function loadEncryptedWallets(): WalletAccount[] | null {
  if (!existsSync(WALLETS_DB)) return null;

  try {
    const raw = readFileSync(WALLETS_DB, 'utf-8');
    const entries: EncryptedWalletEntry[] = JSON.parse(raw);

    const wallets: WalletAccount[] = entries.map((entry) => {
      const decryptedKey = decryptKey(entry.encryptedKey);
      const keypair = createKeypair(decryptedKey);
      return {
        keypair,
        address: keypair.publicKey.toString(),
        proxyUrl: entry.proxyUrl,
        index: entry.index,
      };
    });

    console.log(`🔓 Loaded ${wallets.length} wallet(s) from encrypted storage`);
    return wallets;
  } catch (e: any) {
    console.log(`⚠️ Failed to load encrypted wallets: ${e.message}`);
    return null;
  }
}
