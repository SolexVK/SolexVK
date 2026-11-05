# Передача: состояние на 2026-11-05

Ветка `Трейдинг-с-ИИ`, последний коммит см. `git log -1`. Все тесты проходят:
`python3 -m unittest discover -s trader-skill/tests` (205) и
`python3 -m unittest discover -s service/tests` (21).

## Что работает

- **Сервер** Debian 13, служба `trader` под systemd, пользователь `trader`,
  код в `/opt/trader/app`, данные в `/opt/trader/app/trader`, токены в
  `/opt/trader/env` (600). Обновление: `sudo bash /opt/trader/app/deploy/install.sh
  && sudo systemctl restart trader`. Лог: `sudo journalctl -u trader -f`.
- **Песочница Т-Банка**: счёт `9a01310a-b76c-4227-9b2c-a60e83adac95`, в
  портфеле SBER, LKOH, GAZP примерно по четверти и около 10% кэша.
- **Telegram-бот** @solex_trader_bot: команды, подтверждение в два нажатия,
  стоп-кран, планировщик (календарь биржи из API, цены, алерты, снимок дня,
  сторож дневного убытка 3%, вечерний итог в 18:55).
- **Сириус** в роли аналитика по `docs/sirius-analyst.md`: читает данные,
  кладёт `trader/inbox/targets.json`, `/propose` или `/rebalance` забирают.
  Первое предложение отработано, две сделки исполнены.
- Ноутбук с Windows больше не нужен для работы сервиса; там остаётся клон
  репозитория для ручных команд, если понадобятся.

## Открытые вопросы

- `deploy` имеет sudo без пароля: изоляция токенов от Сириуса держится на
  договорённости. Закрыть до выхода на реальный счёт.
- Первый живой торговый день планировщика ещё не прошёл: 2026-11-05
  смотреть `/jobs`, `/status`, вечерний «Итог дня».
- TMOS в песочнице недоступен через API; на реальной бирже должен быть.
  Проверить, когда появится токен только для чтения на боевом контуре.
- Ордер #2 (TMOS) от 2026-11-04 остался в журнале как «approved» без
  результата: безвредно, с новой датой не мешает.

## Сделано 2026-11-05: пять исследовательских скиллов под Московскую биржу

analyst, screener, news, copycat получили российские источники (T-Invest
GetAssetFundamentals, ISS Мосбиржи, пять RSS-лент), pelosi остался для США.
В боте команды `/news`, `/metrics`, `/screen`, `/index`, задача `news` в
планировщике. Подробности в `trader-skill/UPSTREAM.md`.

Не проверено на живом API: единицы процентных полей в GetAssetFundamentals
(проценты или доли). Первый запуск `/metrics SBER` покажет; при
необходимости поправить `MAP` в `moex_facts.py` и пороги в
`rules.moex.example.json`.

## Где что лежит

| путь | что |
| --- | --- |
| `trader-skill/` | пакет скиллов, `UPSTREAM.md` с источником и списком изменений |
| `trader-skill/trader-tinvest/` | адаптер Т-Банка |
| `trader-skill/common/net.py` | единая сеть: https, белый список, прокси, российский корень для Т-Банка |
| `service/` | бот, планировщик, мост к скриптам, `README.md` |
| `deploy/` | установка на сервер, systemd, образец env |
| `docs/` | `windows-start.md`, `tbank-setup.md`, `telegram-setup.md`, `telegram-relay.md`, `server-deploy.md`, `sirius-analyst.md` |
