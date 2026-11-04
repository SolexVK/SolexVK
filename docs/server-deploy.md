# Перенос на сервер (Linux, systemd)

Сервис переезжает с ноутбука на ваш сервер и работает там круглосуточно под
отдельным пользователем `trader`. Токены лежат в файле `/opt/trader/env`,
который может читать только этот пользователь: другие процессы на той же
машине, включая другие агенты, токенов не видят.

## 0. Проверка с сервера, до установки

Зайдите на сервер по SSH и выполните две команды. Они показывают, доступны ли
Т-Банк и Telegram с адреса сервера.

```bash
curl -sS -m 15 -o /dev/null -w 'tbank HTTP %{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://sandbox-invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.SandboxService/GetSandboxAccounts
```

```bash
curl -sS -m 15 -o /dev/null -w 'telegram HTTP %{http_code}\n' https://api.telegram.org/
```

Хорошо: `tbank HTTP 401` (сервер отвечает, просто без токена) и
`telegram HTTP 200` или `404`. Плохо: `000`, таймаут или `403`. Если Т-Банк
с сервера недоступен, иностранный адрес сервера, и это решается отдельно.

Ещё проверьте версии:

```bash
python3 --version; git --version; systemctl --version | head -1
```

## 1. Установка

```bash
cd /tmp && git clone --branch "Трейдинг-с-ИИ" https://github.com/SolexVK/SolexVK.git solexvk-src && sudo bash solexvk-src/deploy/install.sh
```

Скрипт создаёт пользователя `trader`, кладёт код в `/opt/trader/app`,
создаёт папку данных `/opt/trader/app/trader`, копирует образцы конфигов,
ставит и включает службу `trader`. Повторный запуск скрипта обновляет код и
не трогает конфиги и данные.

## 2. Токены и конфиги

```bash
sudo nano /opt/trader/env
```

Впишите реальные `TELEGRAM_BOT_TOKEN` и `TINVEST_SANDBOX_TOKEN` вместо
образцов. Ctrl+O, Enter, Ctrl+X. Файл уже с правами 600.

```bash
sudo nano /opt/trader/app/trader/config.json
```

`account_id` из песочницы (тот же, что на ноутбуке).

```bash
sudo nano /opt/trader/app/service/config.json
```

`allowed_user_ids` с вашим Telegram id.

Данные с ноутбука (портфель, журнал, цели) можно перенести: скопируйте
содержимое папки `trader\` с ноутбука в `/opt/trader/app/trader/` на сервере,
например через `scp`, и выполните `sudo chown -R trader:trader /opt/trader`.
Или начните с чистого листа, песочница это позволяет.

## 3. Проверка и запуск

```bash
sudo -u trader bash -c 'set -a; . /opt/trader/env; set +a; cd /opt/trader/app && python3 service/run.py --check'
```

Ожидается то же, что на ноутбуке: `bot: @solex_trader_bot` и счёт песочницы.

```bash
sudo systemctl restart trader && sudo journalctl -u trader -f
```

В логе появится строка про бота, в Telegram придёт «Сервис запущен».
Выход из просмотра лога: Ctrl+C, служба продолжает работать.

На ноутбуке сервис больше не запускайте: два экземпляра одного бота будут
отбирать друг у друга сообщения.

## 4. Обновление кода

```bash
sudo bash /opt/trader/app/deploy/install.sh && sudo systemctl restart trader
```

## 5. Полезные команды

```bash
sudo systemctl status trader
```

```bash
sudo journalctl -u trader --since today
```

```bash
sudo systemctl stop trader
```

## Безопасность на общей машине

- Токены только в `/opt/trader/env` (права 600, владелец trader). Не
  экспортируйте их в общий профиль оболочки и не передавайте другим агентам.
- Папка данных `/opt/trader/app/trader` доступна только пользователю trader.
  Код в `/opt/trader/app` читаем всем, в нём секретов нет.
- Служба запущена с ограничениями systemd: без повышения привилегий, система
  только на чтение, запись только в папку данных.
- Стоп-кран `/stop` в Telegram работает как раньше. Остановить всё
  целиком: `sudo systemctl stop trader`.
