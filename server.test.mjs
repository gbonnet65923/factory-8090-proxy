import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  createProxyServer,
  loadConfig,
  factoryPrompt,
  extractTaskId,
  extractRequestId,
} from './server.mjs';
import { createConversationStore } from './conversations.mjs';

const baseEnv = {
  FACTORY_API_BASE_URL: 'http://127.0.0.1:9',
  FACTORY_PROJECT_ID: 'project-test',
  FACTORY_ORG_ID: 'org-test',
  FACTORY_BEARER_TOKEN: 'bearer-test',
  FACTORY_COGNITO_TOKEN: 'cognito-test',
  FACTORY_ZED_TOKEN: 'zed-test',
  PROXY_API_KEY: 'local-key-test',
  FACTORY_MODEL_KEY: 'test-model',
};

// ---------------------------------------------------------------------------
// factoryPrompt
// ---------------------------------------------------------------------------

test('factoryPrompt returns content for a single message without tools', () => {
  assert.equal(factoryPrompt([{ role: 'user', content: 'hi there' }], []), 'hi there');
});

test('factoryPrompt embeds TOOLS_JSON and required tool_choice phrasing', () => {
  const prompt = factoryPrompt(
    [{ role: 'user', content: 'read foo' }],
    [{ type: 'function', function: { name: 'read_file', description: '', parameters: { type: 'object' } } }],
    'required',
    true,
  );
  assert.match(prompt, /TOOLS_JSON/);
  assert.match(prompt, /"name":"read_file"/);
  assert.match(prompt, /You must call at least one function/);
});

test('factoryPrompt honours a named tool_choice and parallel=false', () => {
  const prompt = factoryPrompt(
    [{ role: 'user', content: 'read foo' }],
    [{ type: 'function', function: { name: 'read_file', description: '', parameters: { type: 'object' } } }],
    { type: 'function', function: { name: 'read_file' } },
    false,
  );
  assert.match(prompt, /Call only read_file/);
  assert.match(prompt, /Return at most one tool call/);
});

test('factoryPrompt throws 413 for oversized histories', () => {
  assert.throws(
    () => factoryPrompt([{ role: 'user', content: 'a' }, { role: 'user', content: 'x'.repeat(300_000) }], []),
    error => error?.status === 413 && /too large/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// extractTaskId / extractRequestId
// ---------------------------------------------------------------------------

test('extractTaskId prefers headers and trims', () => {
  assert.equal(extractTaskId({ headers: { 'x-roo-task-id': 't1', 'x-task-id': 't2' } }), 't1');
  assert.equal(extractTaskId({ headers: { 'x-task-id': '  t2  ' } }), 't2');
  assert.equal(extractTaskId({ headers: { 'x-session-id': 's' } }), 's');
  assert.equal(extractTaskId({ headers: { 'x-conversation-id': 'c' } }), 'c');
});

test('extractTaskId falls back to body fields and null', () => {
  assert.equal(extractTaskId({}, { user: 'u1' }), 'u1');
  assert.equal(extractTaskId({}, { task_id: 't' }), 't');
  assert.equal(extractTaskId({}, { metadata: { task_id: 'mt' } }), 'mt');
  assert.equal(extractTaskId({}, { metadata: { sessionId: 'ms' } }), 'ms');
  assert.equal(extractTaskId({ headers: {} }, { user: 'u1', task_id: 't' }), 'u1');
  assert.equal(extractTaskId({ headers: {} }, {}), null);
  assert.equal(extractTaskId({}, {}), null);
});

test('extractRequestId prefers headers and falls back to body', () => {
  assert.equal(extractRequestId({ headers: { 'idempotency-key': 'i1', 'x-request-id': 'r1' } }), 'i1');
  assert.equal(extractRequestId({ headers: { 'x-request-id': 'r1', 'x-client-request-id': 'c1' } }), 'r1');
  assert.equal(extractRequestId({ headers: { 'x-retry-id': ' ry ' } }), 'ry');
  assert.equal(extractRequestId({}, { request_id: 'br' }), 'br');
  assert.equal(extractRequestId({ headers: {} }, {}), null);
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

test('loadConfig applies defaults and does not fabricate models', () => {
  const config = loadConfig({ ...baseEnv, PROXY_MODEL_IDS: 'extra-1, extra-2' });
  assert.equal(config.apiBase, 'http://127.0.0.1:9');
  assert.equal(config.projectId, 'project-test');
  assert.equal(config.port, 18090);
  assert.equal(config.thinkingLevel, 'medium');
  assert.equal(config.webClientVersion, '0.53.7');
  assert.equal(config.conversationPath, null);
  assert.equal(config.authInitial, null);
  assert.deepEqual(config.modelKeys, ['test-model', 'extra-1', 'extra-2']);
  assert.deepEqual(config.modelSettings, {});
});

test('loadConfig rejects invalid PROXY_PORT', () => {
  for (const bad of ['0', '-1', '70000', 'abc', '12.5']) {
    assert.throws(() => loadConfig({ ...baseEnv, PROXY_PORT: bad }), /PROXY_PORT is invalid/);
  }
});

test('loadConfig enforces HTTPS except for loopback', () => {
  assert.throws(() => loadConfig({ ...baseEnv, FACTORY_API_BASE_URL: 'http://example.com' }), /HTTPS/);
  const loopback = loadConfig({ ...baseEnv, FACTORY_API_BASE_URL: 'http://localhost:9' });
  assert.equal(loopback.apiBase, 'http://localhost:9');
  const https = loadConfig({ ...baseEnv, FACTORY_API_BASE_URL: 'https://api.factory.8090.dev' });
  assert.equal(https.apiBase, 'https://api.factory.8090.dev');
  const noUrl = { ...baseEnv };
  delete noUrl.FACTORY_API_BASE_URL;
  assert.equal(loadConfig(noUrl).apiBase, 'https://api.factory.8090.dev');
});

test('loadConfig requires FACTORY_MODEL_KEY without a catalog', () => {
  const env = { ...baseEnv, PROXY_MODEL_IDS: 'extra-1' };
  delete env.FACTORY_MODEL_KEY;
  assert.throws(() => loadConfig(env), /FACTORY_MODEL_KEY is required/);
});

test('loadConfig requires the local API key', () => {
  const env = { ...baseEnv };
  delete env.PROXY_API_KEY;
  assert.throws(() => loadConfig(env), /PROXY_API_KEY is required/);
});

// ---------------------------------------------------------------------------
// Integration helpers
// ---------------------------------------------------------------------------

const doneFrame = 'data: {"type":"done","finish_reason":"stop"}\n\n';

function deltaFrame(text) {
  return `data: {"type":"content","delta":${JSON.stringify(text)}}\n\n`;
}

// Fake Factory backend. Startup live-catalog probe gets 500 so the env
// catalog is kept; input is accepted; each stream call consumes one batch of
// SSE frames (strings or functions resolving to strings), FIFO.
function fakeFetch(frameBatches) {
  const batches = Array.isArray(frameBatches[0]) ? frameBatches : [frameBatches];
  let batchIndex = 0;
  return async url => {
    if (url.includes('/agents/models')) {
      return new Response(JSON.stringify({ models: [] }), { status: 500 });
    }
    if (url.includes('/agents/chat-agent/input')) {
      return new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/agents/chat-agent/stream')) {
      const frames = batches[batchIndex++];
      if (!frames) throw new Error('fakeFetch: no more stream batches');
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(typeof frame === 'function' ? await frame() : frame));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`fakeFetch: unexpected URL ${url}`);
  };
}

function tempFilePath() {
  return path.join(os.tmpdir(), `factory-proxy-test-${randomUUID()}.json`);
}

function requestRaw(port, method, pathname, { host, auth, extra = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    headers.host = host || `127.0.0.1:${port}`;
    if (auth) headers.authorization = `Bearer ${auth}`;
    Object.assign(headers, extra);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* body may be SSE */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withServer(frames, fn, env = {}) {
  const config = loadConfig({ ...baseEnv, PROXY_CONVERSATIONS_PATH: tempFilePath(), ...env });
  const server = createProxyServer(config, fakeFetch(frames));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    return await fn(config, port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    try { unlinkSync(config.conversationPath); } catch { /* ignore */ }
  }
}

function completionBody(overrides = {}) {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration: chat completions
// ---------------------------------------------------------------------------

test('non-stream completion returns content, finish_reason and usage', async () => {
  const frames = [deltaFrame('Hello world'), doneFrame];
  await withServer(frames, async (config, port) => {
    const res = await requestRaw(port, 'POST', '/v1/chat/completions', {
      auth: config.localApiKey,
      body: completionBody(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.choices[0].message.content, 'Hello world');
    assert.equal(res.json.choices[0].finish_reason, 'stop');
    assert.ok(res.json.usage, 'completion must include usage');
    assert.ok(Number.isInteger(res.json.usage.prompt_tokens) && res.json.usage.prompt_tokens >= 0);
    assert.ok(Number.isInteger(res.json.usage.completion_tokens) && res.json.usage.completion_tokens >= 0);
    assert.equal(res.json.usage.total_tokens, res.json.usage.prompt_tokens + res.json.usage.completion_tokens);
    assert.ok(res.json.usage.total_tokens > 0);
  });
});

test('streaming completion emits role, content and done chunks', async () => {
  const frames = [deltaFrame('Hello '), deltaFrame('world'), doneFrame];
  await withServer(frames, async (config, port) => {
    const res = await requestRaw(port, 'POST', '/v1/chat/completions', {
      auth: config.localApiKey,
      body: completionBody({ stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/event-stream/);
    const dataFrames = res.text
      .split('\n\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice(6));
    assert.equal(dataFrames.at(-1), '[DONE]');
    const chunks = dataFrames.slice(0, -1).map(frame => JSON.parse(frame));
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    const content = chunks.map(chunk => chunk.choices[0].delta.content || '').join('');
    assert.equal(content, 'Hello world');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  });
});

test('tool call flow surfaces tool_calls, finish_reason and usage', async () => {
  const toolDoc = '{"kind":"tool_calls","tool_calls":[{"name":"read_file","arguments":{"path":"foo.txt"}}]}';
  const half = Math.ceil(toolDoc.length / 2);
  const frames = [
    deltaFrame(toolDoc.slice(0, half)),
    deltaFrame(toolDoc.slice(half)),
    doneFrame,
  ];
  await withServer(frames, async (config, port) => {
    const res = await requestRaw(port, 'POST', '/v1/chat/completions', {
      auth: config.localApiKey,
      body: completionBody({
        messages: [{ role: 'user', content: 'read foo' }],
        tools: [{
          type: 'function',
          function: {
            name: 'read_file',
            description: '',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        }],
      }),
    });
    assert.equal(res.status, 200);
    const choice = res.json.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.tool_calls[0].function.name, 'read_file');
    assert.equal(JSON.parse(choice.message.tool_calls[0].function.arguments).path, 'foo.txt');
    assert.ok(res.json.usage && res.json.usage.total_tokens > 0);
  });
});

// ---------------------------------------------------------------------------
// Integration: admin endpoints and auth
// ---------------------------------------------------------------------------

test('GET /v1/models lists the configured models', async () => {
  await withServer([], async (config, port) => {
    const res = await requestRaw(port, 'GET', '/v1/models', { auth: config.localApiKey });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.map(item => item.id), config.modelKeys);
  });
});

test('GET /v1/status reports models, active sessions and auth state', async () => {
  const delayedDone = () => new Promise(resolve => setTimeout(() => resolve(doneFrame), 800));
  await withServer([], async (config, port) => {
    const before = await requestRaw(port, 'GET', '/v1/status', { auth: config.localApiKey });
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.models, config.modelKeys);
    assert.equal(before.json.sessions, 0);
    assert.equal(before.json.auth, null);
  });
  // A continuation of a finished turn holds the conversation lock while the
  // upstream stream is open, so sessions must count it as active.
  await withServer([[deltaFrame('ok'), doneFrame], [deltaFrame('x'), delayedDone]], async (config, port) => {
    const first = await requestRaw(port, 'POST', '/v1/chat/completions', {
      auth: config.localApiKey,
      extra: { 'x-roo-task-id': 'test-task' },
      body: completionBody(),
    });
    assert.equal(first.status, 200);
    const pending = requestRaw(port, 'POST', '/v1/chat/completions', {
      auth: config.localApiKey,
      extra: { 'x-roo-task-id': 'test-task' },
      body: completionBody({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'more' },
        ],
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    const during = await requestRaw(port, 'GET', '/v1/status', { auth: config.localApiKey });
    assert.equal(during.json.sessions, 1);
    await pending;
    const after = await requestRaw(port, 'GET', '/v1/status', { auth: config.localApiKey });
    assert.equal(after.json.sessions, 0);
  });
});

test('wrong or missing API key is rejected with 401', async () => {
  await withServer([], async (config, port) => {
    const chat = await requestRaw(port, 'POST', '/v1/chat/completions', { auth: 'wrong-key', body: completionBody() });
    assert.equal(chat.status, 401);
    const models = await requestRaw(port, 'GET', '/v1/models', { auth: 'wrong-key' });
    assert.equal(models.status, 401);
    const noKey = await requestRaw(port, 'GET', '/v1/models', {});
    assert.equal(noKey.status, 401);
  });
});

test('/health is open and invalid Host headers are rejected', async () => {
  await withServer([], async (config, port) => {
    const health = await requestRaw(port, 'GET', '/health', {});
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { status: 'ok' });
    const spoofed = await requestRaw(port, 'GET', '/health', { host: 'evil.example.com' });
    assert.equal(spoofed.status, 403);
    const spoofedChat = await requestRaw(port, 'POST', '/v1/chat/completions', {
      host: 'evil.example.com',
      auth: config.localApiKey,
      body: completionBody(),
    });
    assert.equal(spoofedChat.status, 403);
  });
});

// ---------------------------------------------------------------------------
// createConversationStore
// ---------------------------------------------------------------------------

test('select returns mode new for an unknown request', () => {
  const store = createConversationStore(null);
  const sel = store.select('test-model', [{ role: 'user', content: 'hi' }], { taskId: 'task-1' });
  assert.equal(sel.mode, 'new');
  assert.equal(sel.session, null);
});

test('begin + commit then extended messages continue with resumeAt', () => {
  const store = createConversationStore(null);
  const messages = [{ role: 'user', content: 'hi' }];
  const first = store.select('test-model', messages, { taskId: 'task-1' });
  const session = store.begin(first, 'test-model', { taskId: 'task-1' });
  const response = { role: 'assistant', content: 'hello there' };
  store.commit(session, response, {
    id: 'x', object: 'chat.completion', created: 0, model: 'test-model',
    choices: [{ index: 0, message: response, finish_reason: 'stop' }],
  });
  const second = store.select('test-model', [...messages, response, { role: 'user', content: 'more' }], { taskId: 'task-1' });
  assert.equal(second.mode, 'continue');
  assert.equal(second.resumeAt, messages.length + 1);
});

test('continued when the boundary carries an appended tool result', () => {
  const store = createConversationStore(null);
  const call = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } };
  const messages = [{ role: 'user', content: 'read a.txt' }];
  const first = store.select('test-model', messages, { taskId: 'task-1' });
  const session = store.begin(first, 'test-model', { taskId: 'task-1' });
  const assistant = { role: 'assistant', content: null, tool_calls: [call] };
  store.commit(session, assistant, {
    id: 'x', object: 'chat.completion', created: 0, model: 'test-model',
    choices: [{ index: 0, message: assistant, finish_reason: 'tool_calls' }],
  });
  const extended = [
    ...messages,
    assistant,
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    { role: 'user', content: 'thanks' },
  ];
  const second = store.select('test-model', extended, { taskId: 'task-1' });
  assert.equal(second.mode, 'continue');
  assert.equal(second.resumeAt, messages.length + 1);
});

test('byte-identical request after commit replays the cached completion', () => {
  const store = createConversationStore(null);
  const messages = [{ role: 'user', content: 'hi' }];
  const first = store.select('test-model', messages, { taskId: 'task-1' });
  const session = store.begin(first, 'test-model', { taskId: 'task-1' });
  const response = { role: 'assistant', content: 'hello' };
  const completion = {
    id: 'x', object: 'chat.completion', created: 0, model: 'test-model',
    choices: [{ index: 0, message: response, finish_reason: 'stop' }],
  };
  store.commit(session, response, completion);
  const replay = store.select('test-model', messages, { taskId: 'task-1' });
  assert.equal(replay.mode, 'cached');
  assert.equal(replay.completion.id, 'x');
});

test('commitParseError makes a same-body retry continue', () => {
  const store = createConversationStore(null);
  const messages = [{ role: 'user', content: 'hi' }];
  const first = store.select('test-model', messages, { taskId: 'task-1' });
  const session = store.begin(first, 'test-model', { taskId: 'task-1' });
  store.commitParseError(session, 'broken json');
  const retry = store.select('test-model', messages, { taskId: 'task-1' });
  assert.equal(retry.mode, 'continue');
  assert.equal(retry.session.id, session.id);
});

test('sessions persist and resume after reload from disk', () => {
  const filePath = tempFilePath();
  try {
    const messages = [{ role: 'user', content: 'hello disk' }];
    const storeA = createConversationStore(filePath);
    const first = storeA.select('test-model', messages, { taskId: 'task-1' });
    const session = storeA.begin(first, 'test-model', { taskId: 'task-1' });
    const response = { role: 'assistant', content: 'persisted' };
    storeA.commit(session, response, {
      id: 'x', object: 'chat.completion', created: 0, model: 'test-model',
      choices: [{ index: 0, message: response, finish_reason: 'stop' }],
    });
    const storeB = createConversationStore(filePath);
    assert.equal(storeB.getSessions().length, 1);
    const second = storeB.select('test-model', [...messages, response, { role: 'user', content: 'again' }], { taskId: 'task-1' });
    assert.equal(second.mode, 'continue');
  } finally {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
});