# service: Telegram-бот и планировщик

Один процесс: `python3 service/run.py`. Настройка в `docs/telegram-setup.md`.

| файл | что |
| --- | --- |
| `run.py` | точка входа: конфиг, токены, бот и планировщик в одном процессе |
| `tg.py` | клиент Telegram Bot API на стандартной библиотеке, long polling |
| `pack.py` | мост к скриптам `trader-skill`: запускает их как подпроцессы в папке проекта, читает `trader/*.json`, стоп-кран |
| `bot.py` | команды, компактные виды, двухшаговое подтверждение ордера кнопками |
| `scheduler.py` | задачи по расписанию: цены, алерты, снимок дня, сторож дневного убытка, вечерний итог |
| `config.example.json` | образец конфига |
| `tests/` | офлайн-тесты: `python3 -m unittest discover -s service/tests` |

Зависимостей нет, нужен Python 3.8 или новее. Переменные окружения:
`TELEGRAM_BOT_TOKEN`, `TINVEST_SANDBOX_TOKEN`, позже `TINVEST_TOKEN`.

Цепочка одной сделки:

```
/propose -> /risk -> /orders -> [Подтвердить] -> [Да, отправить]
            check.py  ticket.py     (показ)       ticket.py approve --via telegram:<id>:<cb>
                                                  tinvest.py order --index N
```

Планировщик ничего не отправляет брокеру. Единственный путь ордера проходит
через кнопку, нажатую разрешённым пользователем.
