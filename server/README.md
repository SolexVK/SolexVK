# Сервер приложения «Тайцзи»

Сервер хранит данные ученика — дневник, анкету, программу, беседы и память мастера — и передаёт запросы
мастера к нейросети Claude, чтобы ключ Claude API лежал на сервере, а не в телефоне.
Приложение работает и без сервера, но тогда данные живут только в браузере телефона.

## Что нужно

- Сервер с Linux и Node.js 20 или новее.
- Домен или поддомен, направленный на сервер, например `taichi.example.ru`. Приложение открыто по https,
  поэтому и сервер должен работать по https: браузер не пустит запросы с https-страницы на http.
- Ключ Claude API с console.anthropic.com.

## Установка

```bash
git clone -b Тай-Чи https://github.com/SolexVK/SolexVK.git /opt/taichi
```

```bash
cd /opt/taichi/server && npm install --omit=dev
```

Придумайте ключ доступа приложения к серверу — длинную случайную строку:

```bash
openssl rand -hex 24
```

Создайте файл `/opt/taichi/server/.env` (он не попадает в git):

```
APP_TOKEN=ваша_случайная_строка
ANTHROPIC_API_KEY=ключ_claude_api
PORT=8787
ALLOW_ORIGIN=https://solexvk.github.io
```

## Автозапуск через systemd

Файл `/etc/systemd/system/taichi.service`:

```
[Unit]
Description=Taiji server
After=network.target

[Service]
WorkingDirectory=/opt/taichi/server
EnvironmentFile=/opt/taichi/server/.env
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /opt/taichi/server/data && sudo chown -R www-data /opt/taichi/server/data
```

```bash
sudo chown root:www-data /opt/taichi/server/.env && sudo chmod 640 /opt/taichi/server/.env
```

```bash
sudo systemctl enable --now taichi
```

Код сервера и файл `.env` принадлежат root: служба может писать только в папку `data`, но не может изменить
собственный код или ключи.

## https через Caddy

Caddy сам получает сертификат. Файл `/etc/caddy/Caddyfile`:

```
taichi.example.ru {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

Проверка: `https://taichi.example.ru/api/health` должен ответить `{"ok":true,"ai":true}`.

## Подключение приложения

В приложении: «Настройки» → «Ваш сервер» → адрес `https://taichi.example.ru` и ключ доступа (`APP_TOKEN`)
→ «Проверить связь» → «Сохранить». Данные с телефона уйдут на сервер, дальше синхронизация идёт сама.

## Что где лежит

- `data/state.json` — все данные ученика; `data/backups/` — копия за каждый день.
- Нейросеть: Claude Haiku 5.5 — ежедневный опрос, беседы и заметки мастера;
  Claude Sonnet 5.5 — составление программы и еженедельный пересмотр. Сервер пропускает только эти две модели
  и не больше 30 запросов в минуту.

## Приложение и сервер на одном адресе (рекомендуется)

Caddy раздаёт само приложение из `/opt/taichi/docs`, а `/api/*` передаёт серверу. Блок — в
`server/deploy/Caddyfile.taichi` (поменяйте адрес и порт под себя). В `.env` добавьте:

```
ALLOW_ORIGIN=https://taichi.example.ru,https://solexvk.github.io
APP_HOME=https://taichi.example.ru
```

`APP_HOME` включайте последним, когда новый адрес уже открывается: старые копии приложения (GitHub Pages) увидят его
в `/api/health` и предложат перейти, скопировав ключ доступа. На новом адресе приложение само попросит ключ
и загрузит все данные с сервера.

### Автообновление

```bash
sudo install -m 755 /opt/taichi/server/deploy/taichi-update.sh /usr/local/sbin/taichi-update
sudo cp /opt/taichi/server/deploy/taichi-update.service /opt/taichi/server/deploy/taichi-update.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now taichi-update.timer
```

Раз в 10 минут скрипт забирает новую версию из GitHub; при изменении кода сервера перезапускает службу.
Журнал: `journalctl -u taichi-update`.

## Обновление

```bash
cd /opt/taichi && git pull && cd server && npm install --omit=dev && sudo systemctl restart taichi
```

Если сервер работает на одном адресе с приложением (`SERVE_APP=1`), он сам раздаёт приложение из папки `docs`,
и GitHub Pages не нужен.
