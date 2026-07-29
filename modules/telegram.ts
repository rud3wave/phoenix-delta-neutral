// ============================================================
//  TELEGRAM — TG alert sending via axios
// ============================================================

import axios from 'axios';
import { TELEGRAM } from '../global.js';
import { escapeMarkdownV2 } from './utils.js';

const TG_BASE_URL = 'https://api.telegram.org/bot';

/**
 * Send a message to Telegram.
 * Message is auto-escaped for MarkdownV2.
 * Silently skips if token/chatId not configured.
 */
export async function sendTg(message: string): Promise<void> {
  const { token, chatId } = TELEGRAM;

  if (!token || !chatId) {
    return; // TG not configured — skip silently
  }

  try {
    const url = `${TG_BASE_URL}${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: escapeMarkdownV2(message),
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    });
  } catch (e: any) {
    console.log(`  ⚠️ TG send failed: ${e?.message ?? e}`);
  }
}
