// ============================================================
//  AUDIT — фактические расходы по аккаунтам за последние 24ч
// ============================================================
// Запуск: npm start не нужен — `node --import tsx audit.ts`
// По каждому кошельку: баланс, открытые позиции (+ uPnL к текущему
// миду), все taker/market филлы за 24ч и итоги: maker-комиссии,
// taker-комиссии, funding, realized PnL. В конце — сумма по всем.
// ============================================================

import { LEVERAGE } from './settings.js';
import { PhoenixService } from './modules/phoenix-service.js';
import {
  loadWallets,
  readPrivateKeyEntries,
  loadEncryptedWallets,
  type WalletAccount,
} from './modules/wallet.js';
import { shortAddr } from './modules/utils.js';

const WINDOW_MS = 24 * 3600 * 1000;

/** timestamp из API может быть в ms или в секундах — приводим к ms. */
function toMs(t: string | number): number {
  if (typeof t === 'string') return Date.parse(t);
  return t < 1e12 ? t * 1000 : t;
}

async function main(): Promise<void> {
  const keyEntries = readPrivateKeyEntries();
  const encrypted = loadEncryptedWallets();
  const wallets: WalletAccount[] = encrypted && encrypted.length > 0
    ? encrypted.map((w, i) => ({ ...w, id: keyEntries[i]!.id }))
    : await loadWallets(keyEntries);

  const sinceMs = Date.now() - WINDOW_MS;

  const totals = { maker: 0, taker: 0, funding: 0, rpnl: 0, balance: 0, upnl: 0 };

  for (const wallet of wallets) {
    const service = new PhoenixService(wallet.keypair, wallet.proxyUrl);
    await service.loginHandler();
    const addr = shortAddr(service.getAddress());

    const balance = await service.getUsdcBalance();
    totals.balance += balance;

    console.log(`\n========== ${addr} | balance $${balance.toFixed(2)} ==========`);

    let wMaker = 0;
    let wTaker = 0;
    let wFunding = 0;
    let wRpnl = 0;
    let wUpnl = 0;

    for (const symbol of Object.keys(LEVERAGE)) {
      // Позиция + uPnL к текущему миду
      try {
        const pos = await service.getPositionWithLiquidation(symbol);
        if (pos.hasPosition && pos.side) {
          const snap = await service.getMarketSnapshot(symbol);
          const entry = pos.positionUsd / pos.quantity;
          const dir = pos.side === 'long' ? 1 : -1;
          const upnl = (snap.midPrice - entry) * pos.quantity * dir;
          wUpnl += upnl;
          console.log(
            `  📌 ${pos.side.toUpperCase()} ${pos.quantity.toFixed(4)} ${symbol} | ` +
            `entry $${entry.toFixed(1)} | mid $${snap.midPrice.toFixed(1)} | ` +
            `uPnL ${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}$ | lev ${pos.effectiveLeverage.toFixed(1)}x`
          );
        }
      } catch (e: any) {
        console.log(`  ⚠️ position ${symbol}: ${e.message}`);
      }

      // Филлы за 24ч (baseLotsDelta уже в базовых единицах)
      try {
        const fills = await service.getTradeFills(symbol, 200);
        const recent = fills
          .filter((f) => toMs(f.timestamp) >= sinceMs)
          .sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));

        for (const f of recent) {
          const fee = parseFloat(f.fees) || 0;
          const rp = parseFloat(f.realizedPnl) || 0;
          if (f.liquidity === 'maker') wMaker += fee;
          else wTaker += fee;
          wRpnl += rp;

          if (f.liquidity === 'taker') {
            const delta = parseFloat(f.baseLotsDelta) || 0;
            const side = delta > 0 ? 'BUY ' : 'SELL';
            console.log(
              `  💥 ${new Date(toMs(f.timestamp)).toISOString().replace('T', ' ').slice(0, 19)} | ` +
              `${side} ${Math.abs(delta).toFixed(4)} ${symbol} @ ${parseFloat(f.price).toFixed(1)} | ` +
              `${f.tradeType}/taker (${f.instructionType}) | fee ${fee.toFixed(4)} | rPnL ${rp.toFixed(4)}`
            );
          }
        }
        console.log(`  ${symbol}: fills за 24ч = ${recent.length}`);
      } catch (e: any) {
        console.log(`  ⚠️ fills ${symbol}: ${e.message}`);
      }

      // Funding за 24ч
      try {
        const events = await service.getFundingEvents(symbol, 200);
        for (const e of events) {
          const t = toMs((e as any).timestamp);
          if (t >= sinceMs) wFunding += parseFloat((e as any).fundingPayment) || 0;
        }
      } catch (e: any) {
        console.log(`  ⚠️ funding ${symbol}: ${e.message}`);
      }
    }

    console.log(
      `  🧾 ${addr} итоги 24ч: maker ${wMaker.toFixed(4)}$ | taker -${Math.abs(wTaker).toFixed(4)}$ | ` +
      `funding ${wFunding >= 0 ? '+' : ''}${wFunding.toFixed(4)}$ | realized ${wRpnl >= 0 ? '+' : ''}${wRpnl.toFixed(4)}$ | uPnL ${wUpnl >= 0 ? '+' : ''}${wUpnl.toFixed(2)}$`
    );

    totals.maker += wMaker;
    totals.taker += wTaker;
    totals.funding += wFunding;
    totals.rpnl += wRpnl;
    totals.upnl += wUpnl;
  }

  console.log('\n================== ВСЕГО ЗА 24ч ==================');
  console.log(`  💰 Балансы сейчас: $${totals.balance.toFixed(2)}`);
  console.log(`  Maker-комиссии: ${totals.maker.toFixed(4)}$`);
  console.log(`  Taker-комиссии: -${Math.abs(totals.taker).toFixed(4)}$`);
  console.log(`  Funding: ${totals.funding >= 0 ? '+' : ''}${totals.funding.toFixed(4)}$`);
  console.log(`  Realized PnL: ${totals.rpnl >= 0 ? '+' : ''}${totals.rpnl.toFixed(4)}$`);
  console.log(`  Unrealized PnL (открытые): ${totals.upnl >= 0 ? '+' : ''}${totals.upnl.toFixed(2)}$`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`💥 Audit failed: ${e.message}`);
  process.exit(1);
});
