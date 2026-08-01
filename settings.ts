// ============================================================
//  SETTINGS — Phoenix Delta-Neutral Bot
// ============================================================
// Все настройки софта. Заполни под себя и запускай.
// ============================================================

// --- ОБЩИЕ НАСТРОЙКИ ---

// Количество потоков (одновременно работающих кошельков)
export const THREADS = 5;

// Перемешивать кошельки перед запуском
export const SHUFFLE_WALLETS = true;

// Количество попыток при ошибке
export const RETRY = 3;

// --- ТОКЕНЫ ДЛЯ ТОРГОВЛИ ---
// Какие токены торговать на Phoenix.
// Один токен  → ['ETH']         — все группы торгуют только ETH
// Мульти режим → ['ETH', 'SOL', 'BTC'] — каждая группа рандомно выберет один из списка
// Доступные: SOL, ETH, BTC
export const TOKENS_TO_TRADE = ['ETH', 'SOL', 'BTC'];

// --- НАСТРОЙКИ ПОЗИЦИЙ ---

// --- КАК РАБОТАЕТ ПЛЕЧО И РАЗМЕР ПОЗИЦИИ (CROSS MARGIN) ---
//
// На Phoenix НЕТ изолированной маржи — только cross margin.
// Это значит: ВЕСЬ баланс кошелька = коллатераль для всех позиций.
//
// Как сайт считает effective leverage:
//   effective_leverage = position_value (notional) / balance
//
// Как софт считает размер позиции:
//   notional = balance × leverage   (где leverage — рандом из LEVERAGE_RANGE)
//
// Пример: баланс $1000, leverage = 10x
//   notional = $1000 × 10 = $10,000
//   На сайте: effective leverage = $10,000 / $1000 = 10x ✓
//   В логах бота: Lev: 10.0x ✓
//
// Итого: LEVERAGE_RANGE = [7, 15] → на сайте увидишь плечо от 7x до 15x.
// Цифры в настройках = цифры на сайте = цифры в логах. Всё совпадает.
//
// MARGIN_MODE и MARGIN_RANGE ниже — НЕ влияют на расчёт в cross margin.
// Оставлены для совместимости / будущих режимов. Не трогай.
export const MARGIN_MODE = 'percent';
export const MARGIN_RANGE: [number, number] = [50, 60];

// Плечо (множитель) — effective leverage на сайте = balance × lev / balance = lev
// [мин, макс] — рандомное значение из диапазона
// МАКСИМАЛЬНЫЕ ПЛЕЧИ НА PHOENIX:
//   SOL → 25x
//   ETH → 25x
//   BTC → 40x
// Не ставь макс выше лимита токена — ордер отклонится.
export const LEVERAGE_RANGE: [number, number] = [7, 15];

// Конфигурация групп [longCount, shortCount]
// ДОЛЖНО совпадать с количеством кошельков!
// 3 кошелька → [2, 1] или [1, 2]
// 5 кошельков → [3, 2] или [2, 3]
export const GROUP_CONFIGS: [number, number][] = [[3, 2]];

// --- НАСТРОЙКИ ОРДЕРОВ ---

// Максимальный спред для входа (%)
// Если спред выше — софт ждёт пока сузится
export const MAX_SPREAD = 0.03;

// Тип ордера для лидера (сторона с лимитками)
// 'limit' = maker fee (дешевле) | 'market' = taker fee
export const LEADER_ORDER_TYPE: 'limit' | 'market' = 'limit';

// Таймаут ожидания заполнения лимитки (минуты)
export const LIMIT_FILL_TIMEOUT_MINUTES = 3;

// Задержка после заполнения лимитки лидера (секунды) [мин, макс]
export const DELAY_AFTER_LEADER_FILL: [number, number] = [0, 1];

// --- НАСТРОЙКИ УДЕРЖАНИЯ ---

// Время удержания позиций перед закрытием (минуты) [мин, макс]
// [0, 0] = держать бесконечно (закрытие вручную через close-positions)
export const HOLD_MINUTES: [number, number] = [10000, 12000];

// Количество торговых циклов (открытие → закрытие = 1 цикл)
export const TRADES_COUNT: [number, number] = [2, 5];

// --- НАСТРОЙКИ ЗАКРЫТИЯ ---

// Тип закрытия: 'limit' (maker fee) или 'market' (taker fee)
// 'limit' = сначала лимитка, если не заполнилась за таймаут → маркет
export const CLOSE_TYPE: 'limit' | 'market' = 'limit';

// Интервал перестановки лимитки при закрытии (минуты).
// Если не заполнилась за это время → отменяется и ставится заново по текущей цене.
// Цикл повторяется пока ВСЕ кошельки стороны не закроются лимиткой.
export const CLOSE_LIMIT_TIMEOUT_MINUTES = 3;

// --- ЗАДЕРЖКИ (секунды) [мин, макс] ---

// Задержка между циклами
export const DELAY_BETWEEN_TRADES: [number, number] = [10, 30];

// Задержка между кошельками при старте
export const DELAY_BETWEEN_WALLETS: [number, number] = [3, 8];

// Интервал поллинга позиций (секунды)
export const POLL_INTERVAL_SEC = 5;

// --- ЗАЩИТА ОТ ЛИКВИДАЦИИ ---

// Минимальное расстояние до ликвидации (%) для каждого кошелька.
// Если расчётная ликвидация ближе — группа пересчитывается.
// 0 = отключено (без проверки)
export const MIN_LIQUIDATION_DISTANCE = 15;

// --- SLIPPAGE ---
export const SLIPPAGE = 0.02;
