---
name: trader-tinvest
description: >-
  T-Invest (Т-Банк) broker adapter for the Moscow Exchange. Connects the trader
  pack to a T-Invest API account over its REST gateway with the standard
  library only: sandbox by default (a separate sandbox token and host), live
  only when the config says "paper": false AND TINVEST_LIVE=yes is set for that
  run. Reads accounts, instruments, last prices and the portfolio into the
  pack's trader/prices.json and trader/portfolio.json, converts shares or an
  amount into MOEX lots, and places ONE approved order at a time after
  trader-risk passed it and the user's yes was recorded by trader-broker.
  Tokens live in environment variables and are never printed. Use when the
  user says "подключи Т-Банк", "песочница", "покажи портфель", "котировки
  SBER", "выстави заявку", "place the order with T-Invest", "sandbox", or
  after /trader-broker recorded a yes with "broker": "tinvest".
argument-hint: "[whoami | sandbox open | sandbox payin N | quote TICKER | portfolio | order --index N]"
---

# trader-tinvest

Адаптер брокера Т-Банк (T-Invest API) для пакета trader. Заменяет Alpaca
для Московской биржи. Песочница играет роль «бумажного счёта».

`${CLAUDE_SKILL_DIR}` ниже это папка этого скилла.

```bash
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" whoami                     # среда, счета, уровень доступа токена
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" sandbox open --name robot  # открыть счёт в песочнице
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" sandbox payin 100000       # пополнить песочницу (RUB)
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" find сбер                  # поиск инструмента
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" quote SBER LKOH --write    # цены -> trader/prices.json
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" portfolio --write          # позиции и кэш -> trader/portfolio.json
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" order --index 1 --dry-run  # показать запрос, ничего не слать
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" order --index 1            # выставить ОДИН одобренный ордер
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" orders                     # активные заявки
python3 "${CLAUDE_SKILL_DIR}/tinvest.py" order-state --id <orderId> # статус заявки
```

## Две среды, два токена

| среда | хост | переменная окружения | когда |
| --- | --- | --- | --- |
| sandbox | sandbox-invest-public-api.tbank.ru | `TINVEST_SANDBOX_TOKEN` | `"paper": true` (по умолчанию) |
| prod | invest-public-api.tbank.ru | `TINVEST_TOKEN` | `"paper": false` и `TINVEST_LIVE=yes` |

Токен песочницы не работает на боевом хосте и наоборот, так что перепутать
среды нельзя. Токен читается только из переменной окружения или из файла,
указанного в `--token-file`. Скрипт никогда не печатает токен, не пишет его
в файлы и не передаёт никуда, кроме заголовка запроса к хосту из белого
списка (`common/net.py`).

Как выпустить токены: `docs/tbank-setup.md` в корне репозитория.

## Что читает и пишет

| файл | что |
| --- | --- |
| `trader/config.json` | `broker: "tinvest"`, `paper`, `account_id`, `class_code` (TQBR), `currency` (RUB), лимиты |
| `trader/prices.json` | `quote --write`: последние цены, лотность в `detail` |
| `trader/portfolio.json` | `portfolio --write`: кэш в рублях и позиции; налоговые лоты, записанные trader-broker, сохраняются |
| `trader/orders.json` | предложения trader-budget, trader-rebalance, trader-tax |
| `trader/state/risk.json` | вердикты trader-risk (читает) |
| `trader/state/broker.json` | решения пользователя (читает) и результаты заявок (дописывает) |

`config.example.json` в этой папке это стартовый конфиг под рубли: бюджет
100 000, минимальная заявка 500, максимальная 30 000. Поля с суффиксом
`_usd` унаследованы от оригинала и означают сумму в валюте `currency`.

## Лоты

На Московской бирже торгуют лотами: у SBER лот 10 акций, у LKOH лот 1.
Ордер из `trader/orders.json` задаёт либо `qty` (штук), либо `notional`
(сумма). Адаптер переводит это в целое число лотов вниз и показывает
результат перед отправкой: «BUY 3 lots of SBER (30 shares) ~ 9 300 RUB».
Если сумма меньше одного лота, ордер не отправляется.

Поддерживаются рыночные и лимитные заявки на день. Стоп-заявки и другие
сроки действия адаптер не отправляет.

## Шаги для выставления заявки

1. `tinvest.py quote --write` для бумаг из портфеля и целей, чтобы
   trader-risk и trader-budget считали по свежим ценам.
2. trader-budget или trader-rebalance пишет `trader/orders.json`.
3. `/trader-risk`: `check.py`. Только PASS идёт дальше.
4. `/trader-broker`: `ticket.py show`, один тикет, вопрос пользователю,
   `ticket.py approve --index N --reply "<ответ дословно>"`. Принимаются
   «yes» и «да» для одного ордера; «да на все», «ок», ответ с другим тикером
   или другой суммой не принимаются.
5. `tinvest.py order --index N`. Скрипт сам проверяет все три условия:
   PASS от trader-risk сегодня для этого отпечатка ордера, записанное «да»
   сегодня, отсутствие результата. Потом сверяет среду с конфигом, счёт с
   ответом API (открыт, полный доступ, не Инвесткопилка) и отправляет.
   Claude Code перед запуском команды показывает свой запрос разрешения,
   это второй барьер.
6. Результат пишется в `trader/state/broker.json` со статусом placed и
   биржевым id. Если заявка исполнилась сразу, сделка попадает в
   `trader/portfolio.json` как налоговый лот. Иначе позже:
   `tinvest.py order-state --id ...` и `ticket.py fill ...`.

Ключ идемпотентности `orderId` считается из счёта, отпечатка ордера, даты и
номера, поэтому повторный запуск той же команды не создаст второй заявки.

## Example: the sandbox run

```
$ python3 tinvest.py whoami
Environment: sandbox (https://sandbox-invest-public-api.tbank.ru/rest)
  a1b2c3  TINKOFF  OPEN  FULL_ACCESS  robot
$ python3 tinvest.py quote SBER --write
SBER       310.50 RUB  lot 10
$ python3 tinvest.py order --index 1
BUY 3 lots of SBER (30 shares) ~ 9,315 RUB, market, SANDBOX account a1b2c3
Placed. Broker order id 42, status FILL, executed 3 of 3 lots at 310.50 RUB.
Recorded the fill (30 shares at 310.50 RUB) in trader/portfolio.json.
```

## What it never does

- Never places an order without all three records: trader-risk PASS today,
  the user's explicit yes today, no result yet. One order per run.
- Never switches sandbox to live on its own: live needs `"paper": false` in
  the user's config and `TINVEST_LIVE=yes` in the environment of that run.
- Never asks for, prints, stores or repeats a token.
- Never runs from a scheduled task: nobody is there to say yes.
- Never places stop orders, orders for qualified-investor-only instruments
  (unless `allow_qual_only` is true) or on an Invest Box account.

## Safety

- Education and tooling, not financial advice. A placed order is the user's decision, not a recommendation.
- Sandbox by default. Going live is the user's own decision, in their own config and environment.
- Only `/trader-broker` records a yes, and only `tinvest.py order` can send it, after that yes.
- No margin, short selling or options unless the config allows it and the user confirms.
- Broker tokens live in environment variables, never in the chat, never in git.
- Это не инвестиционная рекомендация. Решение о каждой сделке принимает пользователь.
