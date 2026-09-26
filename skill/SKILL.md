---
name: factory-8090-proxy
description: Factory 8090 web2api proxy — запуск, дашборд 18090, вставка HAR/headers кредов, reasoning_effort, OMP integration. Триггеры: factory, 8090, factory proxy, factory.8090.ai, hermes-factory8090.
---

# Factory 8090 Proxy

Локальный OpenAI-совместимый шлюз для factory.8090.ai. Каталог: `C:/Users/User/tmp/factory_proxy/` (репо: gbonnet65923/factory-8090-proxy). Zero-dep Node 22 ESM, stdlib only.

## Запуск

```
cd C:/Users/User/tmp/factory_proxy && node server.mjs
```

Или `Start-Proxy.bat`. Порт **18090**, listen 127.0.0.1 только.

## Креды

Без кредов прокси стартует degraded (`/health` → `waiting_for_har`, completions → 503). Ждёт:

1. **Дашборд** `http://127.0.0.1:18090/` — вставить HAR JSON (DevTools → Network → Save all as HAR **with sensitive data**) или headers запроса к `api.factory.8090.dev` (authorization/x-sofa-cognito-id-token/x-zed-token/x-sofa-active-org-id) + URL с project id. Headers-режим персистится в `factory-credentials.json`.
2. **Дроп `.har`-файла** в каталог скрипта — hot-reload, без рестарта (fs.watch, debounce 500ms).

Логи: `Factory credentials loaded from X; proxy is live`.

## Эндпоинты

- `POST /v1/chat/completions` — Bearer `local-trial` (PROXY_API_KEY), stream + tools.
- `GET /v1/models`, `GET /v1/status` (ready/models/sessions/auth), `GET /health`.
- `GET /` — дашборд (playground, reasoning_effort select, сниппеты curl/Roo/OMP).

## Reasoning

`reasoning_effort` (minimal/low/medium/high/none) → `thinking_level` Factory per-request: minimal→low, none→null (дефолт), остальные напрямую. OMP: суффикс `:high` к имени модели.

## OMP

`~/.omp/agent/models.yml` → провайдер `hermes-factory8090` (baseUrl `http://127.0.0.1:18090/v1`, apiKey `local-trial`, модели `gpt-5.6-sol` + `opus-5.5`, reasoning: true). config.yml: enabledModels + modelProviderOrder.

## Тесты

`node --test` в каталоге (33 теста, без сети). Смоук: `/health` → `{"status":"ok"}` после вставки кредов.

## Границы

- Секреты (`.har`, `factory-session.json`, `factory-conversations.json`, `factory-credentials.json`) не в репо — в `.gitignore`.
- Пуш репо — через `C:/Users/User/tmp/ghprobe/apipush.mjs` (REST Contents API, git-remote-https отсутствует).
- catalog refresh при degraded-старте пропускается; после live-перехода подтягивается с сервера.
