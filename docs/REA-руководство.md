# REA (Reverse Engineer Anything) — руководство

Источники: https://rea.tools/get-started/, https://rea.tools/faq/, https://rea.tools/guides/,
https://github.com/morluto/rea (MIT). Актуальная версия npm-пакета `rea-agents` на момент
изучения: 6.8.0.

## 1. Что такое REA

REA — MCP-сервер и «навык» (skill) для кодового ИИ-агента (Claude Code, Claude Desktop,
Codex, Cursor и др.). Агент получает инструменты для локального анализа программ:

- JavaScript / Electron-приложения (директория или `app.asar`);
- нативные бинарники через провайдеры Ghidra (бесплатно), Hopper, IDA (платные);
- .NET-сборки, Android APK, Go/Rust-бинарники, Python `.pyc`, прошивки, образы ESP32,
  Unity/Godot-ресурсы, SQLite-базы, PCAP-захваты и др.;
- веб-страницы через Chrome с remote debugging (запросы, скрипты, DOM-события);
- запись сессии веб-приложения и экспорт её как RL-среды.

Весь анализ выполняется локально. Агент получает «улики» (псевдокод, ассемблер, граф вызовов,
файлы и строки) и объясняет или воспроизводит поведение программы. Сам REA бесплатен, аккаунт
REA не нужен. Нужен только аккаунт агента (подписка Claude или API-ключ).

## 2. Установка

### Требования
- Node.js 22 (>= 22.23.4), 24 (>= 24.22.1) или 26 (>= 26.12.1) и npm. Проверка: `node -v`, `npm -v`.
- Windows: `winget install --exact --id OpenJS.NodeJS.LTS`.
- macOS: `brew install node` или .pkg с nodejs.org.
- Linux: `curl -fsSL https://fnm.vercel.app/install | bash`, затем `fnm install 24 && fnm use 24 && fnm default 24`
  (пакеты nodejs из дистрибутивов часто устаревшие).

### Основная команда
```bash
npx rea-agents@latest setup
```
Setup находит установленные агенты, показывает план, просит подтверждение, делает резервные копии
конфигов (`.rea.backup`) и регистрирует MCP-сервер `rea` + навык, закрепляя версию пакета.

Для одного клиента: `npx rea-agents@latest setup --client claude_code`.
Если PowerShell блокирует скрипты: `npx.cmd rea-agents@latest setup`.

### Проверка
```bash
npx -y rea-agents@latest doctor --client claude_code --json
```
Здоровый результат содержит `"healthy": true`. После установки перезапустить агента
(десктопные приложения — полностью закрыть).

### Дополнительно
- Глобальный CLI: `npm install --global rea-agents` (появляется команда `rea`).
- Обновление: `rea update` или повторно `npx rea-agents@latest setup`.
- Удаление: `npx rea-agents@latest uninstall` (`--purge-data` — вместе с данными).

### Провайдеры для нативного кода (по желанию)
- **Ghidra 12.1.4** (бесплатно): нужен 64-битный JDK 21+, переменные окружения
  `GHIDRA_INSTALL_DIR` и `JAVA_HOME`. Проверка: `npx -y rea-agents@latest doctor --provider ghidra --json`.
  На Windows поддержка Ghidra экспериментальная (только PE x86/x64, read-only).
- **Hopper**: macOS 12+ и Linux x86_64 (Ubuntu 24.04+, Fedora 41+, Arch). Коммерческий, есть демо.
- **IDA**: нужен файл регистрации `ida-mcp.json`, переменная `REA_IDA_MCP_CONFIG`.
- Linux: для Ghidra, JADX, прошивок и статического JS-анализа нужен `ps` (procps) в PATH.

## 3. Связь с Claude

### Вариант A — Claude Code (рекомендуется)
1. Установить Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
   (Windows: `irm https://claude.ai/install.ps1 | iex`), запустить `claude`, войти в аккаунт.
2. `npx rea-agents@latest setup --client claude_code`.

Setup записывает `mcpServers.rea` в `~/.claude.json` и ставит навык
`reverse-engineer-anything` в `~/.claude/skills`. REA становится доступен во всех проектах.

Изолированный профиль Claude Code только для REA:
```bash
CLAUDE_CONFIG_DIR=~/.claude-rea npx rea-agents setup --client claude_code
CLAUDE_CONFIG_DIR=~/.claude-rea claude
```

### Вариант B — плагин Claude Code
Внутри Claude Code:
```
/plugin marketplace add morluto/rea
/plugin install rea@rea
```
Плагин подключает MCP-сервер (лаунчер с закреплённой версией npm-пакета) и навыки.
`rea doctor` этот способ не видит — проверять через `/mcp` в Claude Code.

### Вариант C — ручная регистрация MCP (только для текущего проекта)
```bash
claude mcp add --scope local rea -- "/абсолютный/путь/к/node" "/абсолютный/путь/к/rea/scripts/rea.mjs" mcp
```
Windows: `claude mcp add --scope local rea -- "C:\Program Files\nodejs\node.exe" "C:\tools\rea\scripts\rea.mjs" mcp`.
Не использовать `--scope project`: он пишет `.mcp.json` в репозиторий.

Универсальный stdio-конфиг для любого MCP-клиента:
```json
{"mcpServers": {"rea": {"command": "/абсолютный/путь/к/node",
  "args": ["/абсолютный/путь/к/rea/scripts/rea.mjs", "mcp"]}}}
```

### Вариант D — Claude Desktop
Установить с https://claude.ai/download, полностью закрыть, в терминале выполнить
`npx rea-agents@latest setup --client claude_desktop`, запустить заново.

### Только навык, без MCP
`npx skills add morluto/rea --skill reverse-engineer-anything` — инструкции для агента без инструментов.

### Полезные переменные окружения
`REA_MCP_INPUT_SCHEMA_PROFILE=full|compact`, `REA_MCP_OUTPUT_SCHEMA_PROFILE=compact|off`,
`REA_MCP_MAX_RESPONSE_BYTES`, `REA_MCP_TOOL_FAMILIES`, `REA_ANALYSIS_PROVIDER=ghidra|hopper|ida`.

Готовый промпт для агента, чтобы он сам всё поставил:
> Install REA and connect it to this coding agent using npx rea-agents@latest setup.
> Show me the setup plan for approval, then verify the installation.

## 4. Как пользоваться

### Через агента
Даём абсолютный путь к программе и вопрос. Пример:
> Use REA to find what happens when I click Export notes. Show where notes.csv is written,
> which fields it contains, and the relevant files and lines.

Можно писать по-русски: «Используй REA, разберись, что происходит при нажатии кнопки
"Экспорт" в приложении /путь/к/app. Где создаётся файл и какие у него колонки?»

### Учебный пример (первое расследование)
1. Скачать https://rea.tools/examples/notes-example.zip (Electron-приложение «Notes», 6 файлов).
2. Задать агенту вопрос выше. Ожидаемый ответ: кнопка вызывает `notes.exportCsv()`, preload
   шлёт IPC-сообщение `notes:export`, main-процесс пишет `Downloads/notes.csv` с колонками
   `id`, `title` (обработчик `ipcMain.handle("notes:export", ...)` в main.js, строки 8–12).
3. Проверить предсказание: для записи `{id: 1, title: 'Hello, "REA"'}` CSV должен быть
   `id,title` и `1,"Hello, ""REA"""`.
4. Уточнить: «Что будет, если файл нельзя записать? Проследи ошибку до страницы».

### CLI без агента
```bash
# JS / Electron (директория или .asar; обычно resources/app.asar)
npx -y rea-agents@latest analyze-javascript-application "/абс/путь/к/app" --json

# нативная функция через Ghidra
npx -y rea-agents@latest function "/абс/путь/к/program" main --provider ghidra --json

# браузер: запустить Chrome с отладкой, найти вкладку, наблюдать
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/rea-browser https://rea.tools/examples/notes-web/
npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222 --json
npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TARGET_ID --observation-ms 10000 \
  --include-accessibility-text --include-json-body-shapes --include-script-sources --json

# прочее
npx -y rea-agents@latest inspect-sqlite-database "/абс/путь/к/db.sqlite" --table NAME --row-limit 20
npx -y rea-agents@latest providers --json
npx -y rea-agents@latest capabilities --json
```
Основные подкоманды: `analyze`, `search`, `function`, `decompile`, `xrefs`, `trace`, `instructions`
(нативные, `--provider ghidra|hopper|ida`); `analyze-javascript-application`;
`inspect-managed-artifact`, `inspect-managed-members` (.NET); `inspect-go-binary`, `inspect-rust-binary`,
`inspect-pe-imports`, `inspect-pe-certificates`, `inspect-elf-notes`, `inspect-python-pyc`,
`inspect-il2cpp-metadata`, `inspect-model-artifact` (GGUF/safetensors); `inspect-artifact`,
`extract-artifact` (Godot PCK, UnityFS, wxapkg, ESP32, UF2 и др.); `inspect-web-page`,
`capture-browser-scenario`, `analyze-web-bundle`, `inspect-web-network-capture`;
`environment-build`, `environment-serve` (RL-среды); `evidence-import/export`, `compare`;
`--snapshot PATH` для сохранения результата; форматы `--json`, `--format md|csv|yaml|toon`.

### Если агент не видит инструменты
Перезапустить агента, выполнить `doctor`, при необходимости повторить
`npx rea-agents@latest setup --client <id>`.

## 5. Ограничения и правовая сторона
- REA бесплатен, но Hopper/IDA/JEB требуют своих лицензий.
- Windows + Ghidra — экспериментально; Linux arm64 требует Ghidra и сборки декомпилятора;
  WSL — ставить REA внутри Linux, если агент работает там.
- Данные анализа локальны, но результаты уходят агенту, то есть действует политика провайдера модели.
- Назначение: законные исследования, обучение, совместимость, сохранение ПО, анализ программ,
  которыми вы владеете или на анализ которых есть разрешение.

## 6. Идеи для первых проектов
1. **Notes (Electron)** — официальный пример, проверка связки Claude Code + REA.
2. **Notes Web** — https://rea.tools/examples/notes-web/ через Chrome remote debugging:
   какие запросы делает страница и как собирается CSV.
3. **Собственный Electron/JS-инструмент** — найти, куда пишутся настройки и как устроен экспорт.
4. **Простой нативный бинарник** (своя программа на C) через Ghidra: восстановить алгоритм функции.
5. **APK с открытым кодом** (например, Aegis из showcase) — сопоставить поведение с исходниками.
6. **SQLite-база приложения** — разобрать схему и связи таблиц.

## 7. Ссылки
- Сайт: https://rea.tools/ · Get started: https://rea.tools/get-started/ · FAQ: https://rea.tools/faq/
- Гайды: https://rea.tools/guides/ (javascript, native, browser, rl-environments),
  https://rea.tools/first-investigation/
- GitHub: https://github.com/morluto/rea · npm: https://www.npmjs.com/package/rea-agents
- Документация: docs/getting-started/installation.md, docs/getting-started/cli.md,
  docs/reference/mcp-contracts.md в репозитории
- Discord: https://discord.gg/GkcryMnJDM
