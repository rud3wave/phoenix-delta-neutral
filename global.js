// ============================================================
//  GLOBAL CONFIG — Phoenix Delta-Neutral Bot
// ============================================================

// --- TELEGRAM ALERTS ---
// Создаём бота тут -> https://t.me/BotFather
// Узнать свой chat ID тут -> https://t.me/getmyid_bot
export const TELEGRAM = {
  token: '',
  chatId: 0,
};

// --- ENCRYPTION PASSWORD ---
// Пароль для шифрования приватных ключей в базе данных
// При первом запуске ключи из privatekeys.txt зашифруются этим паролем
// НЕ МЕНЯЙ после первого запуска, иначе ключи не расшифруются
export const ENCRYPTION_PASSWORD = 'change_me_to_something_secure';
