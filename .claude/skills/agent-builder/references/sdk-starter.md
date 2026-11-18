# Стартовые шаблоны реализации

API меняется — перед сборкой сверься с актуальной документацией:
https://code.claude.com/docs/en/agent-sdk/overview (Quickstart, Python/TypeScript reference, Hooks, Permissions, Subagents).

## Вариант 1. Субагент Claude Code (самый быстрый старт)

Файл `.claude/agents/<имя>.md`:
```markdown
---
name: review-analyst
description: Анализирует отзывы покупателей и готовит черновики ответов. Используй, когда нужно разобрать новые отзывы.
tools: Read, Grep, Glob, Write
---
<системный промпт по system-prompt-template.md>
```
`tools` — белый список. Без инструментов записи агент физически не может ничего изменить.

## Вариант 2. Автономный агент на Claude Agent SDK (Python)

```bash
pip install claude-agent-sdk
```
Требуется Python 3.10+ и ключ API в переменной окружения `ANTHROPIC_API_KEY` (не в коде).

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, HookMatcher

SYSTEM_PROMPT = open("agents/my-agent/system_prompt.md", encoding="utf-8").read()

# Хук-ограничитель: проверяет каждую shell-команду ДО выполнения.
BLOCKED = ("rm -rf", "git push --force", "curl ", "wget ")

async def guard_bash(input_data, tool_use_id, context):
    cmd = input_data.get("tool_input", {}).get("command", "")
    if any(b in cmd for b in BLOCKED):
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"Заблокировано политикой агента: {cmd}",
            }
        }
    return {}

options = ClaudeAgentOptions(
    system_prompt=SYSTEM_PROMPT,
    allowed_tools=["Read", "Glob", "Grep", "Write"],  # белый список
    permission_mode="default",                         # опасное — с подтверждением
    max_turns=30,                                      # лимит шагов
    cwd="agents/my-agent/workdir",
    hooks={"PreToolUse": [HookMatcher(matcher="Bash", hooks=[guard_bash])]},
    # mcp_servers={...},   # внешние инструменты через MCP
    # agents={...},        # субагенты-исполнители
)

async def main():
    async for message in query(prompt="Выполни задачу: ...", options=options):
        print(message)  # здесь же — запись лога запуска

asyncio.run(main())
```

Для многоходового диалога с сохранением контекста — `ClaudeSDKClient` (см. Python reference).

## Вариант 3. Запуск по расписанию
- Локально/на сервере: cron/systemd вызывает скрипт из варианта 2.
- В облаке Claude Code: scheduled task, который запускает сессию с промптом агента.

## Структура папки агента
```
agents/<имя>/
  SPEC.md              # спецификация
  system_prompt.md     # промпт
  tools/               # свои инструменты/скрипты
  knowledge/           # справочные файлы, подгружаемые по требованию
  PROGRESS.md          # память между запусками
  evals/
    evals.json
    fixtures/
    runs/
    RESULTS.md
  SAFETY.md
  README.md            # как запускать, как общаться, как улучшать
```
