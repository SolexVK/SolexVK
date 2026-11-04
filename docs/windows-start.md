# Запуск на Windows, шаг за шагом (PowerShell)

Каждый блок кода вставляется в окно PowerShell целиком и запускается клавишей
Enter. После блока написано, что должно появиться на экране. Если появилось
что-то другое, скопируйте весь текст из окна и пришлите в чат: токены в
выводе команд не печатаются, присылать его безопасно.

Одно правило на всё время: ничего, что начинается с `t.` (токен Т-Банка) или
похоже на `123456789:AAH...` (токен бота), в чат не вставлять.

## Шаг 0. Открыть PowerShell и включить русские буквы

Пуск, наберите `PowerShell`, откройте «Windows PowerShell» (или «Терминал»).
Первой командой в каждом новом окне:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $env:PYTHONIOENCODING = "utf-8"
```

Ничего не выводит. Это чтобы русский текст и названия веток читались.

## Шаг 1. Проверить Python и Git

```powershell
python --version
```

Ожидается: `Python 3.11.x` или другая версия не ниже 3.8. Если написано, что
команда не найдена или открывается Microsoft Store: установите Python с
https://www.python.org/downloads/windows/ и при установке поставьте галочку
**Add python.exe to PATH**. Потом закройте PowerShell, откройте заново.

```powershell
git --version
```

Ожидается: `git version 2.xx`. Если не найден: https://git-scm.com/download/win,
установка со всеми настройками по умолчанию, затем новое окно PowerShell.

## Шаг 2. Скачать репозиторий и перейти в нашу ветку

```powershell
cd $HOME\Documents
```

```powershell
git clone https://github.com/SolexVK/SolexVK.git
```

Ожидается несколько строк и в конце `Receiving objects: 100%` без слова error.

```powershell
cd SolexVK
```

```powershell
git checkout "Трейдинг-с-ИИ"
```

Ожидается: `branch 'Трейдинг-с-ИИ' set up to track 'origin/Трейдинг-с-ИИ'`
и `Switched to a new branch 'Трейдинг-с-ИИ'`. Если кириллица не проходит,
посмотрите список веток командой `git branch -r` и пришлите его.

Проверка, что всё на месте:

```powershell
python -m unittest discover -s trader-skill\tests
```

Ожидается в конце: `Ran 200 tests in ...` и `OK`.

## Шаг 3. Переменные окружения

Вы уже создали `TINVEST_SANDBOX_TOKEN`. Проверка, что PowerShell её видит,
без показа самого токена:

```powershell
$env:TINVEST_SANDBOX_TOKEN.Length
```

Ожидается число, примерно 80 или больше. Если пусто или ошибка: переменная
задана не для вашего пользователя или окно открыто до её создания. Создайте
заново и откройте новое окно:

```powershell
[Environment]::SetEnvironmentVariable("TINVEST_SANDBOX_TOKEN", "t.ВАШ_ТОКЕН", "User")
```

Вторая переменная, `TELEGRAM_BOT_TOKEN`, появится на шаге 6. Третья,
`TINVEST_TOKEN`, пока не нужна: она только для реального счёта.

## Шаг 4. Папка данных и конфиг

```powershell
mkdir trader
```

```powershell
Copy-Item trader-skill\trader-tinvest\config.example.json trader\config.json
```

Ничего не выводит. Папка `trader\` это рабочие данные (портфель, цены,
ордера, журнал), в git она не попадает.

## Шаг 5. Песочница Т-Банка

Открыть счёт в песочнице:

```powershell
python trader-skill\trader-tinvest\tinvest.py sandbox open --name robot
```

Ожидается: `Opened sandbox account 1234abcd-.... Put it in trader/config.json as "account_id".`
Скопируйте этот номер счёта. Он не секретный.

Вписать его в конфиг:

```powershell
notepad trader\config.json
```

В открывшемся Блокноте найдите строку `"account_id": "",` и вставьте номер
между кавычками: `"account_id": "1234abcd-...",`. Сохраните (Ctrl+S) и
закройте Блокнот.

Пополнить песочницу на 100 000 виртуальных рублей:

```powershell
python trader-skill\trader-tinvest\tinvest.py sandbox payin 100000
```

Ожидается: `Paid 100,000 RUB into sandbox account .... Balance now 100,000 RUB.`

Кто я:

```powershell
python trader-skill\trader-tinvest\tinvest.py whoami
```

Ожидается:
```
Environment: sandbox (https://sandbox-invest-public-api.tbank.ru/rest)
  1234abcd-...  TINKOFF  OPEN  FULL_ACCESS  robot
config account_id: 1234abcd-... (found)
```

Цены:

```powershell
python trader-skill\trader-tinvest\tinvest.py quote SBER LKOH GAZP --write
```

Ожидается три строки с ценами и лотами и `wrote trader/prices.json`.

Портфель:

```powershell
python trader-skill\trader-tinvest\tinvest.py portfolio --write
```

Ожидается: `Account ... (sandbox): total 100,000 RUB, cash 100,000 RUB` и
`wrote trader/portfolio.json`.

**Что прислать мне после шага 5:** вывод четырёх последних команд целиком.

## Шаг 6. Бот в Telegram

1. В Telegram найдите **@BotFather**, отправьте `/newbot`. Имя любое,
   username должен кончаться на `bot`, например `solex_trader_bot`.
2. BotFather пришлёт токен вида `123456789:AAH...`. Сохраните в менеджер
   паролей.
3. Положите его в переменную окружения, подставив свой токен:

```powershell
[Environment]::SetEnvironmentVariable("TELEGRAM_BOT_TOKEN", "123456789:AAH...", "User")
```

4. **Закройте PowerShell и откройте новое окно.** Повторите шаг 0 и
   перейдите в папку:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $env:PYTHONIOENCODING = "utf-8"; cd $HOME\Documents\SolexVK
```

5. Конфиг сервиса:

```powershell
Copy-Item service\config.example.json service\config.json
```

6. Проверка без запуска бота:

```powershell
python service\run.py --check
```

Ожидается:
```
WARNING: allowed_user_ids is empty. The bot will only answer /start with your id.
bot: @solex_trader_bot, project: C:\Users\...\SolexVK
Environment: sandbox (...)
  1234abcd-...  TINKOFF  OPEN  FULL_ACCESS  robot
config account_id: ... (found)
```

7. Запуск:

```powershell
python service\run.py
```

Окно «зависнет», это нормально: сервис работает. В Telegram откройте своего
бота и отправьте `/start`. Он ответит: `Ваш Telegram id: 123456789`.

8. В окне PowerShell нажмите Ctrl+C, сервис остановится. Откройте конфиг:

```powershell
notepad service\config.json
```

Строку `"allowed_user_ids": [],` замените на `"allowed_user_ids": [123456789],`
с вашим числом. Сохраните, закройте.

9. Запустите снова:

```powershell
python service\run.py
```

Бот напишет «Сервис запущен. /status». Отправьте ему `/status`, `/portfolio`,
`/quotes SBER`, `/jobs`.

**Что прислать мне после шага 6:** вывод `--check`, и скриншот или текст
ответов бота на `/status` и `/portfolio`. Ваш Telegram id в них есть, это
не секрет, можно присылать.

## Шаг 7. Первая сделка в песочнице

Пока сервис запущен, в Telegram:

1. `/propose` нужен файл целей `trader/targets.json`. На первом круге
   проще задать цели вручную: напишите мне, какие две-три бумаги и в каких
   долях хотите взять в песочнице, и я сделаю файл. Или создайте сами:

```powershell
notepad trader\targets.json
```

и вставьте, например:

```json
{"weights": {"SBER": 50, "LKOH": 30, "GAZP": 20}}
```

2. В Telegram: `/propose`, затем `/risk`, затем `/orders`. У каждого ордера
   две кнопки. Нажмите «Подтвердить», потом «Да, отправить» на одном ордере.
   В сообщении появится ответ брокера: `Placed. Broker order id ...`.
3. `/portfolio` покажет купленные бумаги, `/log` покажет решения дня.

**Что прислать мне:** текст сообщений бота про ордер и `/log`.

## Прокси и VPN

Два разных случая, и они настраиваются отдельно.

**Т-Банк** из России доступен напрямую, и скрипты ходят к нему напрямую,
не трогая системный прокси и VPN. Так убирается ошибка
`407 Proxy Authentication Required`.

**Telegram** из России напрямую часто не доходит (ошибка `WinError 10060`,
соединение не установлено). Ему нужен тот же прокси или VPN, через который
работает ваш Telegram. Варианты по убыванию простоты:

1. VPN-приложение в режиме «весь трафик» (TUN, полный туннель). Тогда прямое
   соединение само идёт через VPN, и ничего настраивать не нужно. Просто
   включите VPN и повторите команду.
2. HTTP-прокси с логином и паролем. Укажите его только для Telegram:

```powershell
[Environment]::SetEnvironmentVariable("TELEGRAM_PROXY", "http://логин:пароль@хост:порт", "User")
```

3. Системный прокси Windows без пароля: значение `system` вместо адреса.
4. Свой ретранслятор на Cloudflare, если прокси нет совсем:
   `docs/telegram-relay.md`. Это самый надёжный вариант, настраивается один
   раз за 10 минут.

После смены переменной нужно новое окно PowerShell. Посмотреть, какой прокси
прописан в Windows (паролей в выводе нет):

```powershell
python -c "import urllib.request; print(urllib.request.getproxies())"
```

Переменные: `TELEGRAM_PROXY` только для api.telegram.org, `TINVEST_PROXY`
только для Т-Банка (по умолчанию напрямую), `TRADER_PROXY` для всего
остального. Значения: адрес прокси, `system` или `direct`.

## Если что-то пошло не так

- `python: command not found` или открывается Store: шаг 1.
- `tinvest.py: no token for sandbox`: шаг 3, затем новое окно PowerShell.
- `HTTP 401` или `40003`: токен истёк или это токен не песочницы. Выпустите
  новый на tbank.ru/invest/settings, обновите переменную, новое окно.
- `no bot token`: шаг 6, пункт 3 и 4.
- Бот молчит: ваш id не в `allowed_user_ids`, или сервис не запущен.
- `407 Proxy Authentication Required`: обновите код (`git pull`), это исправлено.
- `could not reach api.telegram.org` или `WinError 10060`: раздел «Прокси и VPN».
- Любая другая ошибка: скопируйте весь текст из окна и пришлите.
