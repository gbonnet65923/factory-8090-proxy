// Dashboard: paste credentials, watch status, test the endpoint.
// Pure helpers — no server, no fs. server.mjs owns routes and state.
function parseHeaderBlock(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const name = match[1].toLowerCase();
    headers[name] = match[2].trim();
  }
  return headers;
}

function projectIdFromUrl(raw) {
  try { return new URL(raw).pathname.match(/^\/v2\/project\/([^/]+)\/agents/)?.[1]; }
  catch { return undefined; }
}

// Auto-detects what the user pasted: a HAR JSON document, a URL, or a
// copied request-header block. Returns an env overlay for loadConfig.
export function parseCredentialPaste(text, urlHint = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Paste a HAR JSON export or copied request headers');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let har;
    try { har = JSON.parse(trimmed); }
    catch { throw new Error('The pasted text looks like JSON but is not valid JSON'); }
    if (!har?.log?.entries) throw new Error('The pasted JSON is not a HAR document (no log.entries)');
    return { kind: 'har', har };
  }

  const headers = parseHeaderBlock(trimmed);
  if (!headers.authorization && !headers['x-sofa-cognito-id-token'] && !headers.cookie) {
    throw new Error('Could not find authorization, x-sofa-cognito-id-token, or cookie in the pasted headers');
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
    throw new Error('Header credentials need an authorization bearer or x-sofa-cognito-id-token header');
  }
  if (!parsed.projectId) throw new Error('Header credentials need the request URL (contains the project id) — paste it in the URL field');
  return {
    FACTORY_API_BASE_URL: parsed.apiBase || 'https://api.factory.8090.dev',
    FACTORY_PROJECT_ID: parsed.projectId,
    FACTORY_ORG_ID: h['x-sofa-active-org-id'] || '',
    FACTORY_BEARER_TOKEN: bearer || '',
    FACTORY_COGNITO_TOKEN: h['x-sofa-cognito-id-token'] || '',
    FACTORY_ZED_TOKEN: h['x-zed-token'] || '',
    FACTORY_WEB_CLIENT_VERSION: h['x-web-client-version'] || '0.53.7',
    FACTORY_MODEL_KEY: 'gpt-5.6-sol',
  };
}

const CSS = `
:root { color-scheme: dark; --bg:#0e1116; --panel:#161b22; --line:#2d333b; --fg:#e6edf3; --dim:#8b949e; --ok:#3fb950; --warn:#d29922; --err:#f85149; --acc:#58a6ff; }
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; max-width: 980px; margin: 0 auto; }
h1 { font-size: 20px; margin-bottom: 4px; }
h1 span { color: var(--acc); }
.sub { color: var(--dim); margin-bottom: 20px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.card h2 { font-size: 15px; margin-bottom: 10px; color: var(--acc); }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge.ok { background: rgba(63,185,80,.15); color: var(--ok); }
.badge.warn { background: rgba(210,153,34,.15); color: var(--warn); }
.row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
.stat { color: var(--dim); }
.stat b { color: var(--fg); font-size: 16px; display: block; }
textarea, input, select { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: 13px/1.45 ui-monospace, Consolas, monospace; }
textarea { min-height: 130px; resize: vertical; }
label { display: block; color: var(--dim); font-size: 12px; margin: 10px 0 4px; }
button { background: #238636; color: #fff; border: 1px solid rgba(240,246,252,.1); border-radius: 8px; padding: 8px 16px; font-weight: 600; cursor: pointer; }
button:hover { background: #2ea043; }
button.ghost { background: transparent; border: 1px solid var(--line); color: var(--fg); font-weight: 400; padding: 4px 10px; font-size: 12px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow-x: auto; font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
.msg { margin-top: 10px; font-size: 13px; }
.msg.ok { color: var(--ok); } .msg.err { color: var(--err); }
.models { display: flex; flex-wrap: wrap; gap: 6px; }
.models code { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; font-size: 12px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
details summary { cursor: pointer; color: var(--dim); margin-bottom: 8px; }
#playout { white-space: pre-wrap; }
.hidden { display: none; }
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
<h1>Factory <span>8090</span> Proxy</h1>
<div class="sub">Локальный OpenAI-совместимый шлюз для factory.8090.ai &nbsp;·&nbsp; <span id="badge" class="badge warn">…</span></div>

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
  <p class="sub">Вставь HAR-экспорт (DevTools → Network → Save all as HAR with content) или скопированные заголовки запроса из factory.8090.ai. Прокси подхватит их без рестарта.</p>
  <label for="credtext">HAR JSON или заголовки запроса</label>
  <textarea id="credtext" placeholder='{"log":{"entries":[…]}}  —  или  authorization: Bearer eyJ…&#10;x-sofa-cognito-id-token: eyJ…&#10;x-zed-token: …&#10;x-sofa-active-org-id: …'></textarea>
  <label for="credurl">URL запроса (для заголовков — обязательно: https://api.factory.8090.dev/v2/project/&lt;id&gt;/agents/chat-agent/input)</label>
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
  <details open><summary>curl</summary><pre id="curlsample" onclick="copy('curlsample')">${curl.replace(/</g, '&lt;')}</pre></details>
  <details><summary>Roo Code / Cline settings</summary><pre id="roosample" onclick="copy('roosample')">${roo.replace(/</g, '&lt;')}</pre></details>
  <details><summary>OMP models.yml</summary><pre id="ompsample" onclick="copy('ompsample')">${omp.replace(/</g, '&lt;')}</pre></details>
  <details><summary>OpenCode — opencode.json</summary><pre id="ocsample" onclick="copy('ocsample')">${opencode.replace(/</g, '&lt;')}</pre></details>
  <details><summary>Cline — VS Code settings</summary><pre id="clsample" onclick="copy('clsample')">${cline.replace(/</g, '&lt;')}</pre></details>
  <details><summary>Continue — config.yaml</summary><pre id="ctsample" onclick="copy('ctsample')">${continueSnippet.replace(/</g, '&lt;')}</pre></details>
</div>

<div class="card">
  <h2>Playground</h2>
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
