# Factory 8090 Proxy — бесплатный GPT-5.6/Opus через локальный OpenAI-шлюз

Превращает веб-чат [factory.8090.ai](https://factory.8090.ai) в **локальный OpenAI-совместимый API**: вставил креды — получил endpoint для Roo Code, Cline, OMP, curl и всего, что умеет `/v1/chat/completions`. Zero-dependency: нужен только Node.js 20+.

## Быстрый старт (2 минуты)

1. **Запусти** `Start-Proxy.bat` (или `node server.mjs`).
2. Открой дашборд: **http://127.0.0.1:18090/**
3. Вставь креды — два способа на выбор:
   - **HAR**: Chrome DevTools → Network → *Save all as HAR with sensitive data* → вставь JSON в форму дашборда (или просто скопируй `.har`-файл рядом с `server.mjs` — прокси подхватит его сам, без рестарта);
   - **Headers**: скопируй заголовки любого запроса к `api.factory.8090.dev` (authorization, cognito, zed, org) + URL запроса.
4. Бейдж стал **live** — эндпоинт готов:

```
Base URL:  http://127.0.0.1:18090/v1
API key:   local-trial
Models:    gpt-5.6-sol, opus-5.5, … (каталог подтягивается с сервера)
```

Готовые сниппеты для curl / Roo Code / OMP — прямо на дашборде, с копированием в один клик. Там же **playground**: выбор модели, `reasoning_effort`, стриминг.

## Фичи

- **Дашборд из коробки** — статус, вставка кредов, playground, готовые конфиги. Никаких вторых серверов и портов.
- **Degraded-старт** — без кредов прокси не падает, а ждёт: `/health` → `waiting_for_har`, completions → 503 с подсказкой. Вставил креды — сразу live.
- **Hot-reload кредов** — дроп `.har`-файла в каталог = автоподхват без рестарта (fs.watch + debounce). Headers-вставка персистится в `factory-credentials.json` и переживает рестарты.
- **Reasoning** — OpenAI-поле `reasoning_effort` (`minimal|low|medium|high|none`) маппится в `thinking_level` Factory per-request. В OMP: `model:high` суффикс.
- **Инструменты** — полный tool-calling (function calling, `tool_choice`, параллельные вызовы, потоковая передача tool calls).
- **Sessions** — conversation-resume на стороне Factory: повторные запросы в рамках задачи продолжают тот же тред (перенос токенов ниже, ответы связаны контекстом).
- **Auto-refresh токена** — если в HAR есть Cognito-refresh-запрос, прокси обновляет авторизацию сам, пока жива refresh-сессия.
- **Ретраи** — сетевые сбои и 502/503/504/429 ретраятся автоматически.
- **`usage`** в каждом ответе (оценка симв./4).

## Безопасность

- Слушает только `127.0.0.1`; защита от DNS-rebinding (Host-header whitelist).
- Локальный API-ключ (`local-trial`, меняется через `PROXY_API_KEY`).
- `.har`-файлы, `factory-session.json`, `factory-conversations.json`, `factory-credentials.json` содержат данные сессии — **не публикуй и не отправляй их** (все в `.gitignore`).

## Переменные окружения (все опциональны)

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PROXY_PORT` | `18090` | порт |
| `PROXY_API_KEY` | `local-trial` | локальный ключ |
| `PROXY_HAR_WATCH` | вкл | `0` — выключить автоподхват `.har` |
| `PROXY_HAR_WATCH_DIR` | каталог скрипта | где искать `.har` |
| `FACTORY_HAR_PATH` | — | путь к HAR при запуске из env |
| `FACTORY_MODEL_KEY` | — | модель по умолчанию, если нет в HAR |

## OMP / Claude-совместимые агенты

```yaml
hermes-factory8090:
  api: openai-completions
  apiKey: local-trial
  baseUrl: http://127.0.0.1:18090/v1
  models:
  - id: gpt-5.6-sol
    reasoning: true
```

## OpenCode

`~/.config/opencode/opencode.json` (или `opencode.json` в проекте):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "factory8090": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Factory 8090",
      "options": { "baseURL": "http://127.0.0.1:18090/v1", "apiKey": "local-trial" },
      "models": { "gpt-5.6-sol": { "name": "GPT 5.6 Sol", "limit": { "context": 200000, "output": 32000 } } }
    }
  }
}
```

Выбор модели: `opencode run -m factory8090/gpt-5.6-sol "hi"`.

## Cline (VS Code)

Cline → Settings → API Provider: **OpenAI Compatible** → Base URL `http://127.0.0.1:18090/v1`, API Key `local-trial`, Model ID `gpt-5.6-sol`.

## Continue

`~/.continue/config.yaml`:

```yaml
providers:
  factory8090:
    npm: "@continuedev/openai"
    apiBase: http://127.0.0.1:18090/v1
    apiKey: local-trial

models:
  - name: GPT 5.6 Sol
    provider: factory8090
    model: gpt-5.6-sol
    roles: [chat, edit, apply]
```

## Тесты

```
npm test
```

33 теста, без сети: reasoning-маппинг, degraded-режим, hot-reload через дашборд (HAR и headers), tool-calls, стриминг, сессии.

---
Креды Factory — твои, трафик идёт напрямую с твоей машины в factory.8090.ai. Проект для личного использования.
