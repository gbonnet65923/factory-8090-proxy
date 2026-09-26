# Factory 8090 Credential Collector (Chrome MV3)

Расширение автоматически ловит auth-заголовки (authorization, x-sofa-cognito-id-token, x-zed-token, …) запросов твоей сессии на factory.8090.ai и **само** отправляет их в прокси `127.0.0.1:18090`. Никакого ручного копирования.

## Установка

1. Chrome → `chrome://extensions`
2. Включи **Developer mode** (справа сверху)
3. **Load unpacked** → выбери папку `factory_ext`
4. Убедись, что прокси запущен: `node C:/Users/User/tmp/factory_proxy/server.mjs` (порт 18090)

## Как работает

1. Открой factory.8090.ai, войди в аккаунт
2. Отправь боту любое сообщение
3. Расширение перехватит POST `api.factory.8090.dev/v2/project/<id>/agents/chat-agent/input`, соберёт заголовки и запушит их на `POST /dashboard/credentials` прокси
4. На дашборде `http://127.0.0.1:18090/` статус станет `ready`, появятся модели

Расширение только читает исходящие заголовки — ничего не блокирует и не меняет. Креды уходят только на `127.0.0.1` (твой локальный прокси).

Данные последнего перехвата: `chrome://extensions` → Factory 8090 Credential Collector → service worker → Storage (lastText / lastUrl).

Токены Cognito живут ~час — просто отправь боту ещё одно сообщение, расширение обновит креды само.
