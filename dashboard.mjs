// Dashboard: paste credentials, watch status, test the endpoint.
// Pure helpers — no server, no fs. server.mjs owns routes and state.
function parseHeaderBlock(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('http')) continue; // URL line pasted together with headers
    const match = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const name = match[1].toLowerCase();
    headers[name] = match[2].trim();
  }
  return headers;
}

function projectIdFromUrl(raw) {
  try {
    const path = new URL(raw).pathname;
    return path.match(/^\/v2\/project\/([^/]+)\/agents/)?.[1]
      || path.match(/^\/project\/([^/]+)$/)?.[1];
  }
  catch { return undefined; }
}

// Auto-detects what the user pasted: a HAR JSON document, a cookie-export
// JSON array (Cookie-Editor / EditThisCookie extension format), a URL, or a
// copied request-header block. Returns a parse result for envOverlayFromParsed.
function cookieFromExport(json) {
  const arr = Array.isArray(json) ? json : [json];
  const pairs = arr
    .filter(item => item && typeof item === 'object' && typeof item.name === 'string' && item.value != null)
    .map(item => `${item.name}=${item.value}`);
  return pairs.length ? pairs.join('; ') : null;
}

export function parseCredentialPaste(text, urlHint = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Вставь HAR-файл, заголовки запроса или экспорт кук — инструкции выше');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json;
    try { json = JSON.parse(trimmed); }
    catch { throw new Error('Текст похож на JSON, но JSON невалиден — скопируй файл/заголовки целиком'); }
    if (json?.log?.entries) return { kind: 'har', har: json };
    const cookie = cookieFromExport(json);
    if (cookie) {
      // Cookie-Editor export: no auth tokens in it — keep parsing as headers,
      // envOverlayFromParsed will ask for authorization if it is missing.
      const urlMatch = urlHint || '';
      const projectId = projectIdFromUrl(urlMatch);
      const originMatch = urlMatch.match(/^https?:\/\/[^/]+/)?.[0];
      const result = { kind: 'headers', headers: { cookie } };
      if (projectId) result.projectId = projectId;
      if (originMatch) result.apiBase = originMatch;
      return result;
    }
    throw new Error('JSON — не HAR (нет log.entries) и не экспорт кук (нет name/value)');
  }

  const headers = parseHeaderBlock(trimmed);
  if (!headers.authorization && !headers['x-sofa-cognito-id-token'] && !headers.cookie) {
    throw new Error('В заголовках нет authorization / x-sofa-cognito-id-token / cookie — скопируй секцию Request Headers из DevTools целиком');
  }
  const urlMatch = urlHint || trimmed.match(/https?:\/\/[^\s]+\/v2\/project\/[^\s]+\/agents[^\s]*/)?.[0] || '';
  const projectId = projectIdFromUrl(urlMatch);
  const originMatch = urlMatch.match(/^https?:\/\/[^/]+/)?.[0];
  const result = { kind: 'headers', headers };
  if (projectId) result.projectId = projectId;
  if (originMatch) result.apiBase = originMatch;
  return result;
}

export function envOverlayFromParsed(parsed) {
  const h = parsed.headers || {};
  const bearer = h.authorization?.replace(/^Bearer\s+/i, '');
  if (!bearer && !h['x-sofa-cognito-id-token']) {
    throw new Error(
      'Кук недостаточно: factory.8090.ai авторизуется заголовками authorization: Bearer … и x-sofa-cognito-id-token: … ' +
      '(куки из расширения, включая posthog, — аналитические и токенов не содержат). ' +
      'Скопируй Request Headers из DevTools (F12 → Network → POST …/input → Headers) или вставь HAR с sensitive data'
    );
  }
  if (!parsed.projectId) throw new Error('Header credentials need the request URL (contains the project id) — paste it in the URL field');
  const cognito = h['x-sofa-cognito-id-token'] || '';
  return {
    FACTORY_API_BASE_URL: parsed.apiBase || 'https://api.factory.8090.dev',
    FACTORY_PROJECT_ID: parsed.projectId,
    FACTORY_ORG_ID: h['x-sofa-active-org-id'] || '',
    FACTORY_BEARER_TOKEN: bearer || cognito || '',
    FACTORY_COGNITO_TOKEN: cognito || bearer || '',
    FACTORY_ZED_TOKEN: h['x-zed-token'] || '',
    FACTORY_COOKIE: h.cookie || '',
    FACTORY_WEB_CLIENT_VERSION: h['x-web-client-version'] || '0.53.7',
    FACTORY_MODEL_KEY: 'gpt-5.6-sol',
  };
}


const CSS = `
:root { color-scheme: dark; --bg:#0a0c10; --panel:#10141b; --panel2:#161c26; --line:#232b37; --fg:#e6edf3; --dim:#93a1b0; --ok:#3fb950; --warn:#d29922; --err:#f85149; --acc:#58a6ff; --grad:linear-gradient(135deg,#58a6ff,#bc8cff); }
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); background-image: radial-gradient(1100px 480px at 75% -12%, rgba(88,166,255,.10), transparent 60%), radial-gradient(800px 380px at 8% -4%, rgba(188,140,255,.07), transparent 60%); color: var(--fg); font: 15px/1.55 -apple-system, "Segoe UI", Inter, Roboto, sans-serif; padding: 32px 24px 72px; max-width: 1040px; margin: 0 auto; -webkit-font-smoothing: antialiased; }
header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
.logo { width: 46px; height: 46px; border-radius: 13px; background: var(--grad); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 15px; color: #fff; letter-spacing: -0.5px; flex: none; box-shadow: 0 6px 18px rgba(88,166,255,.35); }
h1 { font-size: 24px; letter-spacing: -0.3px; font-weight: 700; }
h1 span { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.sub { color: var(--dim); font-size: 13px; }
p.sub { margin-bottom: 14px; }
.card { background: linear-gradient(180deg, var(--panel2), var(--panel)); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 18px; box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 10px 30px rgba(0,0,0,.35); }
.card h2 { font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--dim); font-weight: 600; margin-bottom: 14px; }
.badge { display: inline-block; padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; vertical-align: middle; }
.badge.ok { background: rgba(63,185,80,.14); color: var(--ok); box-shadow: inset 0 0 0 1px rgba(63,185,80,.35); }
.badge.warn { background: rgba(210,153,34,.14); color: var(--warn); box-shadow: inset 0 0 0 1px rgba(210,153,34,.35); }
.row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; }
.stat { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; color: var(--dim); font-size: 12px; }
.stat b { color: var(--fg); font-size: 18px; display: block; font-variant-numeric: tabular-nums; }
.models { display: flex; flex-wrap: wrap; gap: 6px; }
.models code { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; font-size: 12px; color: var(--acc); font-family: ui-monospace, Consolas, monospace; }
textarea, input, select { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: 13px/1.5 ui-monospace, Consolas, monospace; transition: border-color .15s; }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--acc); box-shadow: 0 0 0 3px rgba(88,166,255,.12); }
textarea { min-height: 140px; resize: vertical; }
label { display: block; color: var(--dim); font-size: 12px; font-weight: 500; margin: 12px 0 5px; }
button { background: linear-gradient(180deg, #2ea043, #238636); color: #fff; border: 1px solid rgba(240,246,252,.12); border-radius: 10px; padding: 9px 18px; font-weight: 600; font-size: 14px; cursor: pointer; box-shadow: 0 4px 14px rgba(46,160,67,.25); }
button:hover { filter: brightness(1.12); }
button:active { transform: translateY(1px); }
button.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); font-weight: 500; padding: 5px 12px; font-size: 12px; box-shadow: none; }
pre { position: relative; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; overflow-x: auto; font: 12px/1.55 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; cursor: copy; transition: border-color .15s; }
pre:hover { border-color: var(--acc); }
pre:hover::after { content: "копировать"; position: absolute; top: 6px; right: 8px; font-size: 10px; color: var(--dim); background: var(--panel2); border: 1px solid var(--line); padding: 2px 7px; border-radius: 5px; font-family: -apple-system, "Segoe UI", sans-serif; }
details { border: 1px solid var(--line); border-radius: 10px; background: var(--bg); margin-bottom: 10px; overflow: hidden; }
details summary { cursor: pointer; padding: 11px 14px; color: var(--fg); font-weight: 600; font-size: 13px; list-style: none; display: flex; align-items: center; gap: 9px; user-select: none; }
details summary::-webkit-details-marker { display: none; }
details summary::before { content: "▸"; color: var(--dim); transition: transform .15s; flex: none; }
details[open] summary::before { transform: rotate(90deg); }
details[open] summary { border-bottom: 1px solid var(--line); background: rgba(88,166,255,.05); }
details > ol, details > p, details > pre, details > div { margin: 0 14px; padding-top: 12px; }
details > :last-child { padding-bottom: 14px; }
ol.sub { list-style: none; padding: 0; }
ol.sub li { position: relative; padding-left: 34px; margin-bottom: 9px; color: var(--dim); font-size: 13.5px; }
ol.sub li::before { content: counter(list-item); position: absolute; left: 0; top: 1px; width: 22px; height: 22px; border-radius: 7px; background: rgba(88,166,255,.12); color: var(--acc); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 1px solid rgba(88,166,255,.25); }
ol.sub li b { color: var(--fg); }
.reco { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; background: rgba(63,185,80,.14); color: var(--ok); padding: 2px 8px; border-radius: 999px; margin-left: auto; flex: none; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.msg { margin-top: 12px; font-size: 13px; font-family: ui-monospace, Consolas, monospace; }
.msg.ok { color: var(--ok); } .msg.err { color: var(--err); }
#playout { white-space: pre-wrap; min-height: 44px; margin-top: 12px; }
.hidden { display: none; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } .row { gap: 8px; } .card { padding: 16px; } }
`;

const JS = `
const $ = id => document.getElementById(id);
async function refresh() {
  try {
    const s = await (await fetch('/v1/status')).json();
    $('badge').textContent = s.ready ? 'live' : 'waiting for credentials';
    $('badge').className = 'badge ' + (s.ready ? 'ok' : 'warn');
    $('mcount').textContent = s.models ? s.models.length : 0;
    $('sessions').textContent = s.sessions;
    $('authexp').textContent = s.auth ? new Date(s.auth.expiresAt).toLocaleString() : '—';
    $('models').innerHTML = (s.models || []).map(m => '<code>' + m + '</code>').join('');
    const needCreds = !s.ready;
    $('credcard').classList.toggle('hidden', !needCreds);
    $('readycard').classList.toggle('hidden', needCreds);
    const sel = $('pmodel');
    const current = sel.value;
    sel.innerHTML = (s.models || []).map(m => '<option' + (m === current ? ' selected' : '') + '>' + m + '</option>');
  } catch { $('badge').textContent = 'unreachable'; $('badge').className = 'badge warn'; }
}
async function applyCreds() {
  $('credmsg').textContent = 'Applying…'; $('credmsg').className = 'msg';
  try {
    const res = await fetch('/dashboard/credentials', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: $('credtext').value, url: $('credurl').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    $('credmsg').textContent = 'Credentials applied — proxy is live.'; $('credmsg').className = 'msg ok';
    refresh();
  } catch (e) { $('credmsg').textContent = e.message; $('credmsg').className = 'msg err'; }
}
function copy(id) {
  const text = $(id).textContent;
  navigator.clipboard.writeText(text).then(() => { $(id).dataset.hint = 'copied!'; });
}
async function install(target) {
  const msg = $('instmsg');
  msg.textContent = 'Устанавливаю в ' + target + '…'; msg.className = 'msg';
  try {
    const res = await fetch('/dashboard/install', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.message || data.error?.message || res.statusText);
    msg.textContent = '✔ ' + (data.message || 'готово'); msg.className = 'msg ok';
  } catch (e) { msg.textContent = '✖ ' + e.message; msg.className = 'msg err'; }
}
async function play() {
  $('playout').textContent = '…';
  const body = { model: $('pmodel').value, messages: [{ role: 'user', content: $('pmsg').value }], max_tokens: 200 };
  if ($('peffort').value) body.reasoning_effort = $('peffort').value;
  if ($('pstream').checked) { await playStream(body); return; }
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    $('playout').textContent = data.choices[0].message.content + '\\n\\n[usage: ' + JSON.stringify(data.usage) + ']';
  } catch (e) { $('playout').textContent = e.message; }
}
async function playStream(body) {
  body.stream = true;
  const res = await fetch('/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) { $('playout').textContent = (await res.json()).error?.message; return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\\n\\n')) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split('\\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try { out += (JSON.parse(payload).choices[0].delta.content || ''); } catch { }
    }
  }
  $('playout').textContent = out;
}
refresh(); setInterval(refresh, 5000);
`;

// DevTools console one-liner: hooks fetch/XHR on factory.8090.ai, captures the
// auth headers of the next chat-agent/input request and copies them (with the
// URL as the first line) so the whole thing can be pasted into one field.
const CONSOLE_SNIPPET = [
  '(() => {',
  '  const emit = (url, h) => {',
  '    const lines = Object.keys(h).map(k => k + ": " + h[k]);',
  '    const text = url + "\\n" + lines.join("\\n");',
  '    window.__FACTORY_CREDENTIALS__ = text;',
  '    try { navigator.clipboard.writeText(text);',
  '      console.log("%c\\u2714 \\u0413\\u043e\\u0442\\u043e\\u0432\\u043e \\u2014 \\u043a\\u0440\\u0435\\u0434\\u044b \\u0432 \\u0431\\u0443\\u0444\\u0435\\u0440\\u0435. \\u0412\\u0441\\u0442\\u0430\\u0432\\u044c \\u0432\\u0441\\u0451 \\u0432 \\u043e\\u0434\\u043d\\u043e \\u043f\\u043e\\u043b\\u0435 \\u043d\\u0430 \\u0434\\u0430\\u0448\\u0431\\u043e\\u0440\\u0434\\u0435.", "color:#3fb950;font-size:14px"); }',
  '    catch (e) { console.log("\\u0421\\u043a\\u043e\\u043f\\u0438\\u0440\\u0443\\u0439 \\u0432\\u0440\\u0443\\u0447\\u043d\\u0443\\u044e \\u0438\\u0437 \\u043b\\u043e\\u0433\\u0430 \\u043d\\u0438\\u0436\\u0435:"); }',
  '    console.log(text);',
  '  };',
  '  const of = window.fetch;',
  '  window.fetch = function(input, init) {',
  '    try {',
  '      init = init || {};',
  '      const url = typeof input === "string" ? input : (input && input.url) || "";',
  '      if (/chat-agent\\/input/.test(url)) {',
  '        const h = {};',
  '        if (init.headers && typeof init.headers.forEach === "function") init.headers.forEach(function(v, k) { h[k] = v; });',
  '        else if (init.headers) Object.assign(h, init.headers);',
  '        emit(url, h);',
  '      }',
  '    } catch (e) {}',
  '    return of.apply(this, arguments);',
  '  };',
  '  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.setRequestHeader, osd = XMLHttpRequest.prototype.send;',
  '  XMLHttpRequest.prototype.open = function(m, u) { this.__furl = u; return oo.apply(this, arguments); };',
  '  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {',
  '    if (this.__furl && /chat-agent\\/input/.test(this.__furl)) (this.__fh = this.__fh || {})[k] = v;',
  '    return os.apply(this, arguments);',
  '  };',
  '  XMLHttpRequest.prototype.send = function() {',
  '    if (this.__furl && this.__fh) emit(this.__furl, this.__fh);',
  '    return osd.apply(this, arguments);',
  '  };',
  '  const found = [];',
  '  for (let i = 0; i < localStorage.length; i++) {',
  '    const k = localStorage.key(i), v = localStorage.getItem(k);',
  '    if (/^eyJ/.test(v) || /token/i.test(k)) found.push(k);',
  '  }',
  '  if (found.length) console.log("\\u041a\\u043b\\u044e\\u0447\\u0438 localStorage \\u0441 \\u0442\\u043e\\u043a\\u0435\\u043d\\u0430\\u043c\\u0438: " + found.join(", "));',
  '  console.log("%c\\u{1F3A4} \\u0425\\u0443\\u043a \\u0443\\u0441\\u0442\\u0430\\u043d\\u043e\\u0432\\u043b\\u0435\\u043d. \\u0422\\u0435\\u043f\\u0435\\u0440\\u044c \\u043e\\u0442\\u043f\\u0440\\u0430\\u0432\\u044c \\u0431\\u043e\\u0442\\u0443 \\u043b\\u044e\\u0431\\u043e\\u0435 \\u0441\\u043e\\u043e\\u0431\\u0449\\u0435\\u043d\\u0438\\u0435 \\u2014 \\u043a\\u0440\\u0435\\u0434\\u044b \\u0441\\u043e\\u0431\\u0435\\u0440\\u0443\\u0442\\u0441\\u044f \\u0441\\u0430\\u043c\\u0438.", "color:#58a6ff;font-size:14px");',
  '})();',
].join('\n');

export function renderDashboardPage({ port, apiKey, models = [] }) {
  const base = `http://127.0.0.1:${port}/v1`;
  const curl = `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${models[0] || 'gpt-5.6-sol'}","messages":[{"role":"user","content":"Say OK"}]}'`;
  const roo = JSON.stringify({
    apiProvider: 'openai-compatible',
    baseUrl: base,
    apiKey,
    defaultModel: models[0] || 'gpt-5.6-sol',
  }, null, 2);
  const omp = `  hermes-factory8090:\n    api: openai-completions\n    apiKey: ${apiKey}\n    baseUrl: ${base}\n    compat:\n      supportsStreaming: true\n      supportsToolChoice: true\n    models:\n    - id: ${models[0] || 'gpt-5.6-sol'}\n      reasoning: true`;
  const modelList = (models.length ? models : ['gpt-5.6-sol']);
  const opencode = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      factory8090: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Factory 8090',
        options: { baseURL: base, apiKey },
        models: Object.fromEntries(modelList.map(m => [m, { name: m, limit: { context: 200000, output: 32000 } }])),
      },
    },
  }, null, 2);
  const cline = JSON.stringify({
    apiProvider: 'openai-compatible',
    openAiBaseUrl: base,
    openAiApiKey: apiKey,
    openAiModelId: modelList[0],
  }, null, 2);
  const continueSnippet = `models:\n${modelList.map(m => `  - name: ${m}\n    provider: factory8090\n    roles: [chat, edit, apply]\n    model: ${m}\n    apiKey: ${apiKey}`).join('\n')}\n\nproviders:\n  factory8090:\n    npm: '@continuedev/openai'\n    apiBase: ${base}\n    apiKey: ${apiKey}`;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Factory 8090 Proxy</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style></head>
<body>
<header>
  <div class="logo">F8</div>
  <div>
    <h1>Factory <span>8090</span> Proxy</h1>
    <div class="sub">Локальный OpenAI-совместимый шлюз для factory.8090.ai &nbsp;·&nbsp; <span id="badge" class="badge warn">…</span></div>
  </div>
</header>

<div class="card" id="readycard">
  <h2>Статус</h2>
  <div class="row">
    <div class="stat"><b id="mcount">0</b>моделей</div>
    <div class="stat"><b id="sessions">0</b>активных сессий</div>
    <div class="stat"><b id="authexp">—</b>токен истекает</div>
  </div>
  <div class="models" id="models"></div>
</div>

<div class="card" id="credcard">
  <h2>Креды</h2>
  <p class="sub">Прокси стартует без кредов и ждёт их здесь. Вставь — подхватит на лету, без рестарта.</p>

  <details>
    <summary><b>Способ 1 — HAR-файл</b> (рекомендуется, куки и токены внутри)</summary>
    <ol class="sub">
      <li>Открой <b>factory.8090.ai</b> в Chrome и войди в аккаунт.</li>
      <li>F12 → вкладка <b>Network</b> (Сеть). Отправь боту любое сообщение.</li>
      <li>Клик правой кнопкой по любому запросу в списке → <b>«Save all as HAR with sensitive data»</b> (Сохранить всё как HAR с конфиденциальными данными).<br>Важно: нужен именно вариант <i>with sensitive data</i> — обычный HAR не содержит токенов.</li>
      <li>Открой сохранённый .har файл блокнотом → Ctrl+A, Ctrl+C.</li>
      <li>Вставь всё в поле ниже → <b>Применить</b>. URL не нужен.</li>
    </ol>
  </details>

  <details>
    <summary><b>Способ 2 — Заголовки запроса + куки</b> (вручную)</summary>
    <ol class="sub">
      <li>Открой <b>factory.8090.ai</b> в Chrome и войди в аккаунт.</li>
      <li>F12 → вкладка <b>Network</b> → отправь боту любое сообщение.</li>
      <li>Найди запрос <b>POST …/agents/chat-agent/input</b> → клик по нему → вкладка <b>Headers</b> (Заголовки).</li>
      <li>В секции <b>Request Headers</b> скопируй <b>все строки</b> — включая строку <b>cookie: …</b> (куки идут сюда же, отдельного поля не нужно).<br>Проще всего: правый клик по списку заголовков → «Copy value»/выделить всё и скопировать.</li>
      <li>Вставь в поле ниже. Обязательно нужны строки <b>authorization: Bearer …</b> или <b>x-sofa-cognito-id-token: …</b>.</li>
      <li>В поле <b>URL запроса</b> скопируй адрес из шапки того же запроса (там есть project id) → <b>Применить</b>.</li>
    </ol>
  </details>

  <details>
    <summary><b>Способ 3 — Куки из расширения</b> (формат Cookie-Editor / EditThisCookie JSON)</summary>
    <ol class="sub">
      <li>Поставь в Chrome расширение <b>Cookie-Editor</b>, открой <b>factory.8090.ai</b> (войдя в аккаунт).</li>
      <li>Клик по иконке расширения → <b>Export</b> (JSON) → вставь массив кук в поле ниже.</li>
      <li>Вставь также <b>URL</b> страницы в поле URL.</li>
    </ol>
    <p class="sub" style="color: var(--warn)">⚠ Одних кук <b>недостаточно</b>: авторизация у factory идёт заголовками <b>authorization: Bearer …</b> и <b>x-sofa-cognito-id-token: …</b>, а куки вида posthog_* — только аналитика. Способ 3 годится как дополнение к способу 2 (вставь куки + заголовки в одно поле), сам по себе — нет.</p>
  </details>
  <details open>
    <summary><b>Способ 4 — Команда в консоль</b> (авто-сбор, без ручного копирования)<span class="reco">проще всего</span></summary>
    <ol class="sub">
      <li>Открой <b>factory.8090.ai</b> (войдя в аккаунт) и нажми <b>F12</b> → вкладка <b>Console</b>.</li>
      <li>Скопируй команду (клик по блоку ниже) и вставь её в консоль → <b>Enter</b>.</li>
      <li>Отправь боту <b>любое сообщение</b> — команда перехватит запрос к API и сама скопирует URL и все auth-заголовки в буфер обмена.</li>
      <li>Вернись сюда и вставь всё <b>одним куском</b> в поле ниже (URL будет первой строкой, отдельное поле URL не нужно).</li>
    </ol>
    <pre id="cssnippet" style="max-height:220px;overflow:auto;cursor:pointer;white-space:pre-wrap;word-break:break-all" onclick="copy('cssnippet')">${CONSOLE_SNIPPET.replace(/</g, '&lt;')}</pre>
    <p class="sub">Клик по блоку — копирование. Команда безвредна: она только читает исходящий запрос, ничего не отправляет и не меняет.</p>
  </details>

  <label for="credtext">HAR JSON, заголовки запроса или экспорт кук — всё в это поле (cookie строкой «cookie: …» или JSON-массивом)</label>
  <textarea id="credtext" placeholder='{"log":{"entries":[…]}}  —  HAR целиком&#10;&#10;либо заголовки:&#10;authorization: Bearer eyJ…&#10;x-sofa-cognito-id-token: eyJ…&#10;cookie: __Host-session=…; other=…&#10;x-sofa-active-org-id: …&#10;&#10;либо куки из расширения:&#10;[{"domain":".8090.ai","name":"…","value":"…"}]'></textarea>
  <label for="credurl">URL запроса — нужен для способов 2 и 3: https://api.factory.8090.dev/v2/project/&lt;id&gt;/agents/chat-agent/input (для способа 3 можно URL страницы: https://factory.8090.ai/project/&lt;id&gt;)</label>
  <input id="credurl" placeholder="https://api.factory.8090.dev/v2/project/.../agents/chat-agent/input">
  <div style="margin-top:10px"><button onclick="applyCreds()">Применить</button></div>
  <div class="msg" id="credmsg"></div>
</div>

<div class="card">
  <h2>Эндпоинт</h2>
  <div class="grid">
    <div><label>Base URL</label><pre id="curlurl" onclick="copy('curlurl')">${base}</pre></div>
    <div><label>API-ключ</label><pre id="curlkey" onclick="copy('curlkey')">${apiKey}</pre></div>
  </div>
  <label style="margin-top:14px">Установить провайдер в CLI/IDE одним кликом (конфиг обновится сам, бэкап рядом)</label>
  <div style="display:flex; gap:8px; flex-wrap:wrap">
    <button class="ghost" onclick="install('opencode')">OpenCode</button>
    <button class="ghost" onclick="install('cline')">Cline</button>
    <button class="ghost" onclick="install('roo')">Roo Code</button>
    <button class="ghost" onclick="install('continue')">Continue</button>
    <button class="ghost" onclick="install('omp')">OMP</button>
  </div>
  <div class="msg" id="instmsg"></div>
  <details open><summary>curl</summary><pre id="curlsample" onclick="copy('curlsample')">${curl.replace(/</g, '&lt;')}</pre></details>
  <details><summary>Roo Code / Cline settings</summary><pre id="roosample" onclick="copy('roosample')">${roo.replace(/</g, '&lt;')}</pre></details>
  <details><summary>OMP models.yml</summary><pre id="ompsample" onclick="copy('ompsample')">${omp.replace(/</g, '&lt;')}</pre></details>
  <details><summary>OpenCode — opencode.json</summary><pre id="ocsample" onclick="copy('ocsample')">${opencode.replace(/</g, '&lt;')}</pre></details>
  <details><summary>Cline — VS Code settings</summary><pre id="clsample" onclick="copy('clsample')">${cline.replace(/</g, '&lt;')}</pre></details>
  <details><summary>Continue — config.yaml</summary><pre id="ctsample" onclick="copy('ctsample')">${continueSnippet.replace(/</g, '&lt;')}</pre></details>
</div>

<div class="card">
  <h2>Playground</h2>
<p class="sub" style="margin-bottom:10px">Модели и выбор появятся, как только вставишь креды выше (сейчас прокси ждёт авторизацию).</p>
  <div class="grid">
    <div><label>Модель</label><select id="pmodel"></select></div>
    <div><label>reasoning_effort</label>
      <select id="peffort"><option value="">— по умолчанию —</option><option>minimal</option><option>low</option><option>medium</option><option>high</option></select></div>
  </div>
  <label>Сообщение</label>
  <textarea id="pmsg" style="min-height:70px">Say OK</textarea>
  <div style="margin-top:10px; display:flex; gap:12px; align-items:center">
    <button onclick="play()">Отправить</button>
    <label style="display:flex; gap:6px; margin:0; align-items:center"><input type="checkbox" id="pstream" style="width:auto"> stream</label>
  </div>
  <pre id="playout" class="msg"></pre>
</div>

<script>const KEY = ${JSON.stringify(apiKey)};\n${JS}</script>
</body></html>`;
}
