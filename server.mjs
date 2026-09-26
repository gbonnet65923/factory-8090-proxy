import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, watch, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { authFromHar, createFactoryAuth } from './factory-auth.mjs';
import { parseCredentialPaste, envOverlayFromParsed, renderDashboardPage } from './dashboard.mjs';
import { createConversationStore } from './conversations.mjs';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FACTORY_PROMPT_CHARS = 240_000;

class ProxyError extends Error {
  constructor(status, message, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function settingsFromHar(path) {
  let har;
  try { har = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('FACTORY_HAR_PATH does not point to a readable HAR JSON file'); }
  const inputEntry = har.log?.entries?.findLast(item =>
    item.request?.method === 'POST' && /\/agents\/chat-agent\/input$/.test(item.request.url || ''));
  const entry = inputEntry || har.log?.entries?.findLast(item =>
    item.request?.method === 'GET' && /\/agents\/models$/.test(item.request.url || ''));
  if (!entry) throw new Error('The HAR has no Factory Agent chat input or models request');
  const header = name => entry.request.headers?.find(item => item.name?.toLowerCase() === name)?.value;
  const requestUrl = new URL(entry.request.url);
  const projectId = requestUrl.pathname.match(/^\/v2\/project\/([^/]+)\/agents\//)?.[1];
  let payload = {};
  if (inputEntry) {
    try { payload = JSON.parse(inputEntry.request.postData.text); }
    catch { throw new Error('The Factory input request in the HAR has no readable JSON body'); }
  }
  const selectionEntry = har.log?.entries?.findLast(item =>
    item.request?.method === 'GET' && /\/agents\/user-preferences\/model-selection/.test(item.request.url || ''));
  let selectedModel;
  try { selectedModel = JSON.parse(selectionEntry?.response?.content?.text || '{}').effective_model_key; }
  catch { /* A missing selection can fall back to the catalog recommendation. */ }
  let recommendedModel;
  try { recommendedModel = JSON.parse(entry.response?.content?.text || '{}').recommended_model; }
  catch { /* The chat input response is not a model catalog. */ }
  const cognitoToken = header('x-sofa-cognito-id-token');
  return {
    FACTORY_API_BASE_URL: requestUrl.origin,
    FACTORY_PROJECT_ID: projectId,
    FACTORY_ORG_ID: header('x-sofa-active-org-id'),
    // Chrome's sanitized HAR drops Authorization. Supply it separately unless
    // the HAR was exported with sensitive data.
    FACTORY_BEARER_TOKEN: header('authorization')?.replace(/^Bearer\s+/i, ''),
    FACTORY_COGNITO_TOKEN: cognitoToken,
    FACTORY_ZED_TOKEN: header('x-zed-token'),
    FACTORY_WEB_CLIENT_VERSION: header('x-web-client-version'),
    FACTORY_MODEL_KEY: payload.model?.model_key || selectedModel || recommendedModel,
    FACTORY_THINKING_LEVEL: payload.model?.configuration?.thinking_level,
    FACTORY_CONTEXT_WINDOW: payload.model?.configuration?.context_window,
    FACTORY_GENERATION_MODE: payload.model?.configuration?.generation_mode,
    FACTORY_SERVING_SOURCE: payload.model?.configuration?.serving_source,
  };
}

function modelCatalogFromHar(path) {
  let har;
  try { har = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('FACTORY_MODELS_HAR_PATH does not point to a readable HAR JSON file'); }
  const entry = har.log?.entries?.findLast(item =>
    item.request?.method === 'GET' && /\/agents\/models$/.test(new URL(item.request.url || 'http://invalid').pathname));
  if (!entry) throw new Error('The model HAR has no Factory agents/models response');
  let catalog;
  try { catalog = JSON.parse(entry.response.content.text); }
  catch { throw new Error('The Factory model catalog in the HAR is not readable JSON'); }
  if (!Array.isArray(catalog.models) || !catalog.models.length) {
    throw new Error('The Factory model catalog in the HAR is empty');
  }
  return catalog.models.filter(model => typeof model.key === 'string' && model.key.length > 0);
}

export function loadConfig(env = process.env) {
  const values = env.FACTORY_HAR_PATH ? { ...settingsFromHar(env.FACTORY_HAR_PATH), ...env } : env;
  const authInitial = values.FACTORY_AUTH_HAR_PATH ? authFromHar(values.FACTORY_AUTH_HAR_PATH) : null;
  const apiBase = new URL(values.FACTORY_API_BASE_URL || 'https://api.factory.8090.dev');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(apiBase.hostname);
  if (apiBase.protocol !== 'https:' && !(apiBase.protocol === 'http:' && loopback)) {
    throw new Error('FACTORY_API_BASE_URL must use HTTPS (HTTP is allowed only for loopback tests)');
  }
  const port = Number(values.PROXY_PORT || 18090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROXY_PORT is invalid');
  const catalog = values.FACTORY_MODELS_HAR_PATH ? modelCatalogFromHar(values.FACTORY_MODELS_HAR_PATH) : [];
  const modelKey = values.FACTORY_MODEL_KEY ||
    (catalog.some(model => model.key === 'gpt-5.6-sol') ? 'gpt-5.6-sol' : catalog[0]?.key);
  if (!modelKey) throw new Error('FACTORY_MODEL_KEY is required when the HAR has no model catalog');
  const modelKeys = [...new Set([modelKey, ...catalog.map(model => model.key),
    ...(values.PROXY_MODEL_IDS || '').split(',').map(value => value.trim()).filter(Boolean)])];
  const modelSettings = Object.fromEntries(catalog.map(model => [model.key, {
    thinkingLevel: model.capabilities?.thinking?.choices?.default || model.capabilities?.thinking?.default || model.default_thinking_level || 'medium',
  }]));
  const bearerToken = values.FACTORY_BEARER_TOKEN?.trim() || authInitial?.accessToken;
  if (!bearerToken) throw new Error('FACTORY_BEARER_TOKEN is required (or provide FACTORY_AUTH_HAR_PATH)');
  const cognitoToken = values.FACTORY_COGNITO_TOKEN?.trim() || authInitial?.idToken;
  if (!cognitoToken) throw new Error('FACTORY_COGNITO_TOKEN is required (or provide FACTORY_AUTH_HAR_PATH)');
  const defaultConversationPath = env === process.env && process.env.NODE_ENV !== 'test'
    ? 'factory-conversations.json'
    : null;
  return {
    apiBase: apiBase.origin,
    projectId: required(values, 'FACTORY_PROJECT_ID'),
    orgId: required(values, 'FACTORY_ORG_ID'),
    bearerToken,
    cognitoToken,
    cookie: values.FACTORY_COOKIE?.trim() || null,
    authInitial,
    authSessionPath: values.FACTORY_SESSION_PATH,
    conversationPath: values.PROXY_CONVERSATIONS_PATH || defaultConversationPath,
    blockDuplicateTools: values.PROXY_BLOCK_DUPLICATE_TOOLS === '1',
    zedToken: required(values, 'FACTORY_ZED_TOKEN'),
    modelKey,
    modelKeys,
    modelSettings,
    thinkingLevelOverride: env.FACTORY_THINKING_LEVEL || null,
    localApiKey: required(values, 'PROXY_API_KEY'),
    webClientVersion: values.FACTORY_WEB_CLIENT_VERSION || '0.53.7',
    thinkingLevel: values.FACTORY_THINKING_LEVEL || 'medium',
    contextWindow: values.FACTORY_CONTEXT_WINDOW || 'default',
    generationMode: values.FACTORY_GENERATION_MODE || 'standard',
    servingSource: values.FACTORY_SERVING_SOURCE || 'platform',
    ready: true,
    clientSessionId: randomUUID(),
    port,
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendError(res, error) {
  if (res.headersSent) {
    res.write(`data: ${JSON.stringify({ error: { message: error.message, type: error.type || 'upstream_error' } })}\n\n`);
    res.end();
    return;
  }
  sendJson(res, error.status || 502, {
    error: { message: error.message, type: error.type || 'upstream_error' },
  });
}

function authorized(req, key) {
  const supplied = req.headers.authorization;
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return false;
  const a = Buffer.from(supplied.slice(7));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new ProxyError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProxyError(400, 'Invalid JSON request body');
  }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content) && content.every(part => part?.type === 'text' && (typeof part.text === 'string' || typeof part.content === 'string'))) {
    return content.map(part => part.text ?? part.content ?? '').join('\n');
  }
  throw new ProxyError(400, 'Only text message content is supported');
}

function normalizeMessages(messages) {
  const normalized = messages.map(message => {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message?.role)) {
      throw new ProxyError(400, 'Unsupported message role');
    }
    const result = { role: message.role };
    if ((message.content === null || message.content === undefined || message.content === '') && message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      result.content = null;
    } else {
      result.content = textContent(message.content);
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      result.tool_calls = message.tool_calls.map(call => ({
        id: call.id, name: call.function?.name, arguments: call.function?.arguments,
      }));
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string') throw new ProxyError(400, 'Tool result needs tool_call_id');
      result.tool_call_id = message.tool_call_id;
    }
    return result;
  });
  if (!['user', 'tool'].includes(normalized.at(-1)?.role)) {
    throw new ProxyError(400, 'The last message must have role user or tool');
  }
  return normalized;
}

export function factoryPrompt(messages, tools, toolChoice, parallelToolCalls) {
  if (!tools.length && messages.length === 1) return messages[0].content;
  if (tools.length) {
    const choice = typeof toolChoice === 'object'
      ? `Call only ${toolChoice.function?.name || 'the selected function'}.`
      : toolChoice === 'required' ? 'You must call at least one function.'
        : 'Call a function only when needed; otherwise answer normally.';
    const prefix = [
      'You are supplying the next response in an OpenAI Chat Completions conversation.',
      'Return exactly one JSON object, with no Markdown or surrounding text.',
      'To request client-side function execution, return:',
      '{"kind":"tool_calls","tool_calls":[{"name":"function_name","arguments":{}}]}',
      'To answer the user, return: {"kind":"message","content":"your answer"}',
      'Use only a listed function name and arguments matching its JSON schema.',
      'Do not execute, simulate, or claim to have executed client-side functions. The client will run them and send results in a later request.',
      choice,
      parallelToolCalls === false ? 'Return at most one tool call.' : '',
      `TOOLS_JSON:\n${JSON.stringify(tools)}`,
    ].filter(Boolean).join('\n\n');
    for (const budget of [120_000, 90_000, 60_000, 30_000]) {
      const prompt = `${prefix}\n\nMESSAGES_JSON:\n${JSON.stringify(compactToolHistory(messages, budget))}\n\n` +
        'Tool results appear only in MESSAGES_JSON. Reuse available results; if a result was shortened, request only the missing range instead of rereading the same range.';
      if (prompt.length <= MAX_FACTORY_PROMPT_CHARS) return prompt;
    }
    throw new ProxyError(413, 'Conversation history is too large for the Factory text bridge; start a new Roo task');
  }
  for (const budget of [120_000, 90_000, 60_000, 30_000]) {
    const prompt = 'Continue this conversation. Messages are JSON with explicit roles. Reply with only the next assistant message.\n\n'
      + JSON.stringify(compactToolHistory(messages, budget));
    if (prompt.length <= MAX_FACTORY_PROMPT_CHARS) return prompt;
  }
  throw new ProxyError(413, 'Conversation history is too large for the Factory text bridge; start a new Roo task');
}

function shortenedResult(content, limit) {
  if (content.length <= limit) return content;
  const marker = `\n[Tool result shortened: ${content.length} characters total; request only a missing range if needed.]\n`;
  const available = Math.max(0, limit - marker.length);
  const front = Math.ceil(available * 2 / 3);
  return content.slice(0, front) + marker + content.slice(-Math.floor(available / 3));
}

function compactToolHistory(messages, budget) {
  const seen = new Set();
  let remaining = budget;
  let largeKept = 0;
  return messages.toReversed().map(message => {
    if (message.role !== 'tool') return message;
    if (seen.has(message.content)) {
      return { ...message, content: '[Repeated tool result omitted; identical content appears in a later tool result in MESSAGES_JSON.]' };
    }
    if (message.content.length > 4096 && largeKept++ >= 4) {
      return { ...message, content: '[Older large tool result omitted to keep context bounded; request a specific range if needed.]' };
    }
    const limit = Math.min(message.content.length, 48_000, remaining);
    if (remaining < 100) {
      return { ...message, content: '[Tool result omitted because context budget is exhausted.]' };
    }
    remaining -= limit;
    seen.add(message.content);
    return { ...message, content: shortenedResult(message.content, limit) };
  }).reverse();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toolSignature(name, argumentsValue) {
  try {
    const args = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
    return `${name}\0${canonicalJson(args)}`;
  } catch { return null; }
}

function completedToolCalls(messages) {
  const calls = new Map();
  const completed = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) calls.set(call.id, call);
    } else if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id);
      if (!call) continue;
      const signature = toolSignature(call.name, call.arguments);
      if (signature) completed.push({ name: call.name, arguments: call.arguments,
        content: message.content, signature });
    }
  }
  return completed;
}

const WRITE_TOOLS = new Set([
  'write_file', 'write_to_file', 'apply_diff', 'apply_patch', 'edit_file', 'search_replace', 'insert_content',
]);

function callName(call) {
  return call?.function?.name || call?.name || '';
}

function callArguments(call) {
  return call?.function?.arguments ?? call?.arguments;
}

function argumentPath(argumentsValue) {
  let args;
  try { args = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue; }
  catch { return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (typeof args.path === 'string' && args.path) return args.path;
  if (typeof args.file_path === 'string' && args.file_path) return args.file_path;
  return null;
}

function readFileRange(argumentsValue) {
  let args;
  try { args = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue; }
  catch { return null; }
  const path = argumentPath(args);
  if (!path || !Number.isInteger(args?.offset) || !Number.isInteger(args?.limit) || args.limit < 1) return null;
  return { path, start: args.offset, end: args.offset + args.limit - 1 };
}

function fileEditState(messages) {
  const pending = new Map();
  const reads = [];
  const writes = [];
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) pending.set(call.id, call);
      return;
    }
    if (message.role !== 'tool') return;
    const call = pending.get(message.tool_call_id);
    if (!call) return;
    const name = callName(call);
    const args = callArguments(call);
    const path = argumentPath(args);
    if (WRITE_TOOLS.has(name) && path) writes.push({ path, index });
    if (name === 'read_file' && path) {
      reads.push({
        path,
        signature: toolSignature(name, args),
        range: readFileRange(args),
        index,
      });
    }
  });
  return { reads, writes };
}

function readWasEditedAfter(state, path, index) {
  return state.writes.some(write => write.path === path && write.index > index);
}

function isUselessRead(call, state) {
  if (callName(call) !== 'read_file') return false;
  const args = callArguments(call);
  const path = argumentPath(args);
  const signature = toolSignature('read_file', args);
  const range = readFileRange(args);
  if (!path) return false;
  return state.reads.some(prior => {
    if (prior.path !== path || readWasEditedAfter(state, path, prior.index)) return false;
    if (signature && prior.signature === signature) return true;
    return Boolean(range && prior.range && prior.range.start <= range.start && prior.range.end >= range.end);
  });
}

function isBlockedRepeat(call, messages, blockOtherTools) {
  const state = fileEditState(messages);
  if (isUselessRead(call, state)) return true;
  if (!blockOtherTools || callName(call) === 'read_file') return false;
  const signature = toolSignature(callName(call), callArguments(call));
  if (!signature) return false;
  return completedToolCalls(messages).some(item => item.signature === signature);
}

function validateCompletion(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProxyError(400, 'A JSON object is required');
  if (!config.modelKeys.includes(body.model)) throw new ProxyError(400, `Unknown model: ${body.model}`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new ProxyError(400, 'messages must be a nonempty array');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new ProxyError(400, 'stream must be a boolean');
  if (body.functions?.length || body.function_call) throw new ProxyError(400, 'Legacy functions are not supported');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new ProxyError(400, 'tools must be an array');
  const tools = (body.tools || []).map(tool => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || typeof fn?.name !== 'string' || !fn.name ||
        !fn.parameters || typeof fn.parameters !== 'object') {
      throw new ProxyError(400, 'Only named function tools with JSON parameters are supported');
    }
    return { name: fn.name, description: fn.description || '', parameters: fn.parameters };
  });
  const choice = body.tool_choice ?? 'auto';
  if (!['auto', 'none', 'required'].includes(choice) &&
      !(choice?.type === 'function' && typeof choice.function?.name === 'string')) {
    throw new ProxyError(400, 'Unsupported tool_choice');
  }
  if (choice === 'required' && !tools.length) throw new ProxyError(400, 'tool_choice required needs tools');
  if (typeof choice === 'object' && !tools.some(tool => tool.name === choice.function.name)) {
    throw new ProxyError(400, 'tool_choice names an unavailable tool');
  }
  if (body.response_format || body.modalities || body.audio || body.stop || (body.n !== undefined && body.n !== 1)) {
    throw new ProxyError(400, 'Requested output format or options are not supported by this proxy');
  }
  const effort = body.reasoning_effort;
  if (effort !== undefined && !['minimal', 'low', 'medium', 'high', 'none'].includes(effort)) {
    throw new ProxyError(400, 'reasoning_effort must be one of minimal, low, medium, high, none');
  }
  const messages = normalizeMessages(body.messages);
  const activeTools = choice === 'none' ? [] : tools;
  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    tools: activeTools,
    toolChoice: choice,
    parallelToolCalls: body.parallel_tool_calls !== false,
    thinkingLevel: effort === undefined || effort === null || effort === 'none'
      ? null
      : ({ minimal: 'low', low: 'low', medium: 'medium', high: 'high' })[effort] || 'medium',
  };
}
function invalidToolCall(reason) {
  const messages = {
    'malformed tool call JSON': 'Factory returned malformed tool call JSON',
    'truncated tool call': 'Factory response was truncated due to length before the tool call JSON completed',
    'empty tool call list': 'Factory returned no tool calls',
    'parallel tool calls disabled': 'Factory returned parallel tool calls when disabled',
    'unknown tool': 'Factory selected an unknown tool',
    'invalid arguments': 'Factory returned invalid tool arguments',
    'tool call list failed validation': 'Factory returned a tool call list that failed validation',
  };
  const error = new ProxyError(502, messages[reason] || 'Factory returned an invalid tool call', 'upstream_error');
  error.repairable = true;
  error.reason = reason;
  return error;
}

function toolReplyCandidate(text) {
  const trimmed = String(text ?? '').trim().replace(/^\uFEFF/, '');
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const opened = trimmed.match(/^```(?:json)?\s*([\s\S]*)$/i);
  if (opened) return opened[1].trim();
  return trimmed;
}

// A reply is a tool-call attempt only when the reply itself starts as that JSON
// document. A later example inside ordinary prose does not qualify.
function looksLikeToolCallAttempt(text) {
  const candidate = toolReplyCandidate(text);
  return /^\{\s*"kind"\s*:\s*"tool_calls"/.test(candidate)
    || /^\{\s*"tool_calls"\s*:/.test(candidate);
}

function jsonTypeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesDeclaredType(value, type) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return jsonTypeName(value) === type;
}

function argumentsMatchSchema(args, schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return true;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string' || !Object.hasOwn(args, key)) return false;
  }
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties : null;
  if (schema.additionalProperties === false && properties) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) return false;
    }
  }
  if (!properties) return true;
  for (const [key, spec] of Object.entries(properties)) {
    if (!Object.hasOwn(args, key) || !spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const value = args[key];
    if (typeof spec.type === 'string') {
      if (!matchesDeclaredType(value, spec.type)) return false;
    } else if (Array.isArray(spec.type) && spec.type.length &&
        !spec.type.some(type => typeof type === 'string' && matchesDeclaredType(value, type))) {
      return false;
    }
  }
  return true;
}

function extractBalancedJsonObject(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    const direct = JSON.parse(candidate);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      if (direct.kind === 'tool_calls' || direct.kind === 'message' || Array.isArray(direct.tool_calls)) {
        return direct;
      }
    }
  } catch { /* try balanced scan below */ }

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let j = i; j < text.length; j++) {
        const char = text[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
        } else {
          if (char === '"') inString = true;
          else if (char === '{') depth++;
          else if (char === '}') {
            depth--;
            if (depth === 0) {
              const slice = text.slice(i, j + 1);
              try {
                const parsed = JSON.parse(slice);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  if (parsed.kind === 'tool_calls' || parsed.kind === 'message' || Array.isArray(parsed.tool_calls)) {
                    return parsed;
                  }
                }
              } catch { /* ignore and continue scan */ }
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

function parseToolCalls(reply, tools, toolChoice, parallelToolCalls) {
  const requested = reply.tool_calls;
  if (!Array.isArray(requested) || !requested.length) {
    throw invalidToolCall('empty tool call list');
  }
  if (!parallelToolCalls && requested.length > 1) {
    throw invalidToolCall('parallel tool calls disabled');
  }
  const allowed = new Map(tools.map(tool => [tool.name, tool]));
  const validated = [];
  let sawUnknown = false;
  let sawInvalidArgs = false;
  for (const call of requested) {
    const name = call?.name;
    const tool = typeof name === 'string' ? allowed.get(name) : undefined;
    if (!tool || (typeof toolChoice === 'object' && name !== toolChoice.function.name)) {
      sawUnknown = true;
      continue;
    }
    let args = call.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch { sawInvalidArgs = true; continue; }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args) || !argumentsMatchSchema(args, tool.parameters)) {
      sawInvalidArgs = true;
      continue;
    }
    validated.push({ name, args });
  }
  if (sawUnknown || sawInvalidArgs || validated.length !== requested.length) {
    const reason = sawUnknown && sawInvalidArgs ? 'tool call list failed validation'
      : sawUnknown ? 'unknown tool'
        : sawInvalidArgs ? 'invalid arguments'
          : 'tool call list failed validation';
    throw invalidToolCall(reason);
  }
  const calls = validated.map(call => ({
    id: `call_${randomUUID().replaceAll('-', '')}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  return { content: null, toolCalls: calls, finishReason: 'tool_calls' };
}

function decodeToolReply(text, tools, toolChoice, parallelToolCalls, finishReason = 'stop') {
  // A document that starts as tool_calls must parse as a whole. Do not recover
  // a smaller object from broken quotes and do not return that text as a message.
  if (looksLikeToolCallAttempt(text)) {
    let parsed = null;
    try { parsed = JSON.parse(toolReplyCandidate(text)); }
    catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !(parsed.kind === 'tool_calls' || Array.isArray(parsed.tool_calls))) {
      throw invalidToolCall(finishReason === 'length' ? 'truncated tool call' : 'malformed tool call JSON');
    }
    return parseToolCalls(parsed, tools, toolChoice, parallelToolCalls);
  }

  if (finishReason === 'length') {
    const reply = extractBalancedJsonObject(text);
    if (reply && (reply.kind === 'tool_calls' || Array.isArray(reply.tool_calls))) {
      return parseToolCalls(reply, tools, toolChoice, parallelToolCalls);
    }
    if (toolChoice === 'required' || typeof toolChoice === 'object') {
      throw new ProxyError(502, 'Factory response was truncated due to length before tool call completed', 'upstream_error');
    }
    return { content: text, toolCalls: [], finishReason: 'length' };
  }

  const reply = extractBalancedJsonObject(text);
  if (!reply) {
    if (toolChoice === 'required' || typeof toolChoice === 'object') {
      throw new ProxyError(502, 'Factory did not return the required tool call', 'upstream_error');
    }
    return { content: text, toolCalls: [], finishReason: 'stop' };
  }

  if (reply.kind === 'tool_calls' || Array.isArray(reply.tool_calls)) {
    return parseToolCalls(reply, tools, toolChoice, parallelToolCalls);
  }
  if (toolChoice === 'required' || typeof toolChoice === 'object') {
    throw new ProxyError(502, 'Factory did not return the required tool call', 'upstream_error');
  }
  if (typeof reply.content === 'string') return { content: reply.content, toolCalls: [], finishReason: 'stop' };
  return { content: text, toolCalls: [], finishReason: 'stop' };
}

function invalidToolCallRepairPrompt(tools, toolChoice, parallelToolCalls) {
  const choice = typeof toolChoice === 'object'
    ? `Call only ${toolChoice.function?.name || 'the selected function'}.`
    : toolChoice === 'required'
      ? 'You must call at least one listed function.'
      : 'Call a function only when one is needed; otherwise return a message.';
  const names = tools.map(tool => tool.name).filter(name => typeof name === 'string' && name);
  return [
    'RETRY_AFTER_INVALID_TOOL_CALL: The previous assistant reply was not accepted.',
    'It looked like a tool call, but it was not strictly valid JSON, or a tool name or its arguments failed validation.',
    'The previous reply is already in this conversation. Use that context only to decide the next valid response.',
    'Do not execute, simulate, repair, or repeat the invalid command. Do not quote or reconstruct its text.',
    'Return exactly one JSON object and no other text.',
    'To call tools: {"kind":"tool_calls","tool_calls":[{"name":"function_name","arguments":{}}]}',
    'To answer without tools: {"kind":"message","content":"your answer"}',
    'Every element of tool_calls must be valid. Do not return a partial list.',
    names.length ? `Allowed functions: ${names.join(', ')}.` : '',
    'Arguments must match the function JSON schema.',
    choice,
    parallelToolCalls === false ? 'Return at most one tool call.' : '',
  ].filter(Boolean).join('\n\n');
}

function factoryHeaders(config, auth) {
  const headers = {
    accept: '*/*',
    'content-type': 'application/json',
    authorization: `Bearer ${auth?.accessToken || config.bearerToken}`,
    origin: 'https://factory.8090.ai',
    'x-sofa-active-org-id': config.orgId,
    'x-sofa-client-session-id': config.clientSessionId,
    'x-sofa-cognito-id-token': auth?.idToken || config.cognitoToken,
    'x-zed-token': config.zedToken,
    'x-web-client-version': config.webClientVersion,
  };
  if (config.cookie) headers.cookie = config.cookie;
  return headers;
}

async function postFactory(config, endpoint, payload, signal, fetchImpl) {
  let auth;
  if (config.authSession) {
    try { auth = await config.authSession.current(); }
    catch (error) { throw new ProxyError(502, error.message, 'authentication_error'); }
  }
  let response;
  try {
    response = await fetchImpl(
      `${config.apiBase}/v2/project/${encodeURIComponent(config.projectId)}/agents/chat-agent/${endpoint}`,
      { method: 'POST', headers: factoryHeaders(config, auth), body: JSON.stringify(payload), signal },
    );
  } catch (error) {
    if (signal.aborted && signal.reason === 'timeout') {
      throw new ProxyError(504, 'Factory request timed out', 'upstream_error');
    }
    if (signal.aborted) throw new ProxyError(499, 'Client disconnected', 'client_cancelled');
    const wrapped = new ProxyError(502, `Factory ${endpoint} request failed: ${error.cause?.code || error.name}`, 'upstream_error');
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProxyError(502, `Factory ${endpoint} returned HTTP ${response.status}`, 'upstream_error');
  }
  return response;
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
]);

function isTransientFactoryError(error) {
  if (error?.status === 502 || error?.status === 503 || error?.status === 504 || error?.status === 429) return true;
  const cause = error?.cause;
  if (cause instanceof TypeError) return true;
  return typeof cause?.code === 'string' && TRANSIENT_NETWORK_CODES.has(cause.code);
}

// Retry once after 2s when the input POST failed before the message was
// accepted. Never retry 'stream', and never retry an aborted request.
async function postFactoryInput(config, payload, signal, fetchImpl) {
  const attempt = () => postFactory(config, 'input', payload, signal, fetchImpl);
  try {
    return await attempt();
  } catch (error) {
    if (signal.aborted || !isTransientFactoryError(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (signal.aborted) throw error;
    return attempt();
  }
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let frameBytes = 0;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') {
        if (data.length) yield data.join('\n');
        data = [];
        frameBytes = 0;
      } else if (line.startsWith('data:')) {
        frameBytes += Buffer.byteLength(line);
        if (frameBytes > MAX_SSE_FRAME_BYTES) throw new ProxyError(502, 'Factory SSE frame is too large', 'upstream_error');
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    // A network chunk can contain many complete SSE frames. Limit only the
    // unfinished frame, not the whole chunk before its lines are consumed.
    if (frameBytes + Buffer.byteLength(buffer) > MAX_SSE_FRAME_BYTES) {
      throw new ProxyError(502, 'Factory SSE frame is too large', 'upstream_error');
    }
  }
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
  if (data.length) yield data.join('\n');
}

async function* factoryTextEvents(body) {
  for await (const raw of sseEvents(body)) {
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    if (event.type === 'content' && typeof event.delta === 'string') {
      yield { type: 'delta', text: event.delta };
    } else if (event.type === 'done') {
      yield { type: 'done', finishReason: event.finish_reason === 'length' ? 'length' : 'stop' };
      return;
    } else if (event.type === 'error' || event.type === 'turn_error') {
      throw new ProxyError(502, 'Factory agent reported an error', 'upstream_error');
    }
  }
  throw new ProxyError(502, 'Factory stream ended before a done event', 'upstream_error');
}

function startStreamKeepAlive(res) {
  const timer = setInterval(() => {
    if (!res.writableEnded) {
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
      }
      res.write(': keepalive\n\n');
    }
  }, 15_000);
  timer.unref();
  return timer;
}

function chunk(id, created, model, delta, finishReason = null) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function estimateUsage(promptText, completionText) {
  const promptTokens = Math.max(0, Math.ceil(promptText.length / 4));
  const completionTokens = Math.max(0, Math.ceil((completionText || '').length / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

async function openFactoryEvents(config, model, prompt, signal, fetchImpl, conversationId = randomUUID(), clientMessageId = randomUUID(), onInputAccepted = null, requestThinkingLevel = null) {
  const input = await postFactoryInput(config, {
    action: 'send_message',
    conversation_id: conversationId,
    content: [{ type: 'text', content: prompt }],
    client_state: {
      kind: 'platform', current_view: { kind: 'platform', view: 'settings' },
      focused_context: '', attached_artifact_ids: [], timezone: 'UTC',
    },
    model: {
      type: 'specific', model_key: model,
      configuration: {
        thinking_level: requestThinkingLevel || config.thinkingLevelOverride || config.modelSettings[model]?.thinkingLevel || config.thinkingLevel,
        context_window: config.contextWindow,
        generation_mode: config.generationMode,
        serving_source: config.servingSource,
      },
    },
    client_message_id: clientMessageId,
  }, signal, fetchImpl);
  let accepted;
  try { accepted = await input.json(); } catch { throw new ProxyError(502, 'Factory input returned invalid JSON', 'upstream_error'); }
  if (accepted.accepted !== true) throw new ProxyError(502, 'Factory did not accept the message', 'upstream_error');
  if (typeof onInputAccepted === 'function') onInputAccepted();

  const upstream = await postFactory(config, 'stream', {
    conversation_id: conversationId, tail_user_messages: 10,
  }, signal, fetchImpl);
  if (!upstream.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !upstream.body) {
    await upstream.body?.cancel();
    throw new ProxyError(502, 'Factory did not return an SSE stream', 'upstream_error');
  }

  return factoryTextEvents(upstream.body);
}

export function extractTaskId(req, body = {}) {
  const header = req?.headers;
  const taskId = header?.['x-roo-task-id'] ||
                 header?.['x-task-id'] ||
                 header?.['x-session-id'] ||
                 header?.['x-conversation-id'] ||
                 body?.user ||
                 body?.task_id ||
                 body?.metadata?.task_id ||
                 body?.metadata?.sessionId ||
                 null;
  return typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
}

export function extractRequestId(req, body = {}) {
  const header = req?.headers;
  const reqId = header?.['idempotency-key'] ||
                header?.['x-request-id'] ||
                header?.['x-client-request-id'] ||
                header?.['x-retry-id'] ||
                body?.request_id ||
                null;
  return typeof reqId === 'string' && reqId.trim() ? reqId.trim() : null;
}

async function handleCompletion(req, res, config, fetchImpl, conversations) {
  const body = await readJson(req);
  if (config.ready === false) {
    throw new ProxyError(503, `Proxy is waiting for Factory credentials. Open http://127.0.0.1:${config.port}/ and paste a HAR or request headers.`, 'not_ready_error');
  }
  const { model, messages, stream, tools, toolChoice, parallelToolCalls, thinkingLevel } = validateCompletion(body, config);
  const taskId = extractTaskId(req, body);
  const requestId = extractRequestId(req, body);
  const selection = conversations.select(model, messages, {
    taskId,
    requestId,
    tools,
    toolChoice,
    parallelToolCalls,
  });
  if (selection.decision?.reason === 'new-assistant-mismatch') {
    const decision = selection.decision;
    console.info(`conversation new-assistant-mismatch prefix=${decision.prefix} incoming=${decision.incomingLength} role=${decision.boundaryRole || '-'} stored=${decision.storedHash || '-'} incomingHash=${decision.incomingHash || '-'} turnToolCalls=${decision.turnToolCalls}`);
  }
  if (selection.mode === 'in_flight') {
    const completion = await selection.inFlightPromise;
    sendCompletion(res, completion, stream);
    return;
  }
  if (selection.mode === 'cached') {
    sendCompletion(res, selection.session.completion, stream);
    return;
  }

  let resolveInFlight;
  let rejectInFlight;
  const inFlightPromise = new Promise((resolve, reject) => {
    resolveInFlight = resolve;
    rejectInFlight = reject;
  });
  inFlightPromise.catch(() => {});
  if (selection.canDedupe) conversations.setInFlight(selection.requestHash, inFlightPromise);

  let session;
  let factoryInputAccepted = false;
  let isParseError = false;
  let lastFactoryText = '';
  let activeAborter = null;
  try {
    const targetConversationId = selection.session?.conversationId;
    await conversations.runExclusive(targetConversationId, async () => {
      // Recheck inside the lock ignoring our own in-flight hash/promise
      let activeSelection = conversations.select(model, messages, {
        taskId,
        requestId,
        tools,
        toolChoice,
        parallelToolCalls,
        ignoreInFlightPromise: inFlightPromise,
      });
      if (activeSelection.mode === 'cached') {
        resolveInFlight(activeSelection.completion);
        sendCompletion(res, activeSelection.completion, stream);
        return;
      }

      session = conversations.begin(activeSelection, model, { taskId });
      const incremental = activeSelection.mode === 'continue'
        ? (() => {
            const cut = Number.isInteger(activeSelection.resumeAt)
              ? activeSelection.resumeAt
              : activeSelection.session.expected.length;
            const newMessages = messages.slice(cut);
            if (!newMessages.length) {
              return 'Your previous response did not return a valid tool call or JSON object as requested. Return exactly one strictly valid JSON object now. Do not execute, repair, or repeat an invalid command from the previous reply.';
            }
            return `Continue the existing Factory conversation. The previous assistant answer is already in this conversation. Only these NEW client messages follow; do not replay previous tool calls or results.\n\n${factoryPrompt(newMessages, tools, toolChoice, parallelToolCalls)}`;
          })()
        : factoryPrompt(messages, tools, toolChoice, parallelToolCalls);

      const aborter = new AbortController();
      activeAborter = aborter;
      const timeout = setTimeout(() => aborter.abort('timeout'), 10 * 60 * 1000);
      timeout.unref();
      res.on('close', () => {
        if (!res.writableEnded) aborter.abort('client');
        clearTimeout(timeout);
      });

      const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
      const created = Math.floor(Date.now() / 1000);

      const events = await openFactoryEvents(
        config, model, incremental, aborter.signal, fetchImpl,
        session.conversationId, session.clientMessageId,
        () => { factoryInputAccepted = true; },
        thinkingLevel
      );

      if (tools.length) {
        let keepAliveTimer = null;
        if (stream) {
          keepAliveTimer = setInterval(() => {
            if (!res.writableEnded) {
              if (!res.headersSent) {
                res.writeHead(200, {
                  'content-type': 'text/event-stream; charset=utf-8',
                  'cache-control': 'no-cache, no-transform',
                  connection: 'keep-alive',
                });
              }
              res.write(': keepalive\n\n');
            }
          }, 15_000);
          keepAliveTimer.unref();
        }

        let factoryText = '';
        let finishReason = 'stop';
        try {
          for await (const event of events) {
            if (event.type === 'delta') factoryText += event.text;
            if (event.type === 'done') finishReason = event.finishReason;
          }
        } finally {
          if (keepAliveTimer) clearInterval(keepAliveTimer);
        }

        let reply;
        try {
          reply = decodeToolReply(factoryText, tools, toolChoice, parallelToolCalls, finishReason);
        } catch (error) {
          if (!error.repairable) {
            isParseError = true;
            lastFactoryText = factoryText;
            throw error;
          }
          let repairKeepAlive = null;
          if (stream) repairKeepAlive = startStreamKeepAlive(res);
          let retryText = '';
          let retryFinishReason = 'stop';
          try {
            const retryEvents = await openFactoryEvents(
              config, model,
              invalidToolCallRepairPrompt(tools, toolChoice, parallelToolCalls),
              aborter.signal, fetchImpl, session.conversationId,
            );
            for await (const event of retryEvents) {
              if (event.type === 'delta') retryText += event.text;
              if (event.type === 'done') retryFinishReason = event.finishReason;
            }
          } finally {
            if (repairKeepAlive) clearInterval(repairKeepAlive);
          }
          try {
            reply = decodeToolReply(retryText, tools, toolChoice, parallelToolCalls, retryFinishReason);
          } catch (retryError) {
            isParseError = true;
            lastFactoryText = retryText;
            const reason = retryError.reason || error.reason || 'invalid tool call';
            throw new ProxyError(502,
              `Factory tool call was invalid (${reason}) and the correction was also invalid. No tool was executed. Retry the request to ask for a valid tool call.`,
              'upstream_error');
          }
        }

        const repeated = call => isBlockedRepeat(call, messages, config.blockDuplicateTools);
        const stale = reply.toolCalls.filter(repeated);
        const fresh = reply.toolCalls.filter(call => !repeated(call));
        if (stale.length && fresh.length) {
          reply = { ...reply, content: null, toolCalls: fresh, finishReason: 'tool_calls' };
        } else if (stale.length) {
          const mustCall = toolChoice === 'required' || typeof toolChoice === 'object';
          const nextStep = mustCall
            ? 'A tool call is required. Choose an allowed tool call with new arguments that advances the task; do not return a text answer.'
            : 'Use the existing result to answer the user, or choose a different tool call that advances the task.';
          const retryPrompt = `RETRY_AFTER_DUPLICATE_TOOL_CALL: You requested a read or function call whose result is already in the client history. Do not read the same file range again unless a later edit changed that file. A different range is allowed. ${nextStep}`;

          if (stream) {
            keepAliveTimer = setInterval(() => {
              if (!res.writableEnded) {
                if (!res.headersSent) {
                  res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-transform',
                    connection: 'keep-alive',
                  });
                }
                res.write(': keepalive\n\n');
              }
            }, 15_000);
            keepAliveTimer.unref();
          }

          let retryText = '';
          let retryFinishReason = 'stop';
          try {
            const retryEvents = await openFactoryEvents(
              config, model, retryPrompt, aborter.signal, fetchImpl,
              session.conversationId
            );
            for await (const event of retryEvents) {
              if (event.type === 'delta') retryText += event.text;
              if (event.type === 'done') retryFinishReason = event.finishReason;
            }
          } finally {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
          }

          try {
            reply = decodeToolReply(retryText, tools, toolChoice, parallelToolCalls, retryFinishReason);
          } catch (err) {
            isParseError = true;
            lastFactoryText = retryText;
            throw err;
          }

          if (reply.toolCalls.some(repeated)) {
            throw new ProxyError(502,
              'Factory repeated a completed tool call after retry; no new tool result was produced',
              'upstream_error');
          }
        }

        const completionFinishReason = reply.finishReason || (reply.toolCalls.length ? 'tool_calls' : 'stop');
        const responseMessage = reply.toolCalls.length
          ? { role: 'assistant', content: null, tool_calls: reply.toolCalls }
          : { role: 'assistant', content: reply.content };
        const completion = {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: responseMessage, finish_reason: completionFinishReason }],
          usage: estimateUsage(incremental, reply.toolCalls.length ? JSON.stringify(reply.toolCalls) : reply.content || ''),
        };
        conversations.commit(session, normalizeMessages([responseMessage, { role: 'user', content: '' }])[0], completion);
        resolveInFlight(completion);
        sendCompletion(res, completion, stream);
        return;
      }

      if (stream) {
        let text = '';
        let finishReason = 'stop';
        let headersSent = false;
        const keepAliveTimer = startStreamKeepAlive(res);
        try {
          for await (const event of events) {
            if (event.type === 'delta') {
              if (!headersSent) {
                if (!res.headersSent) {
                  res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-transform',
                    connection: 'keep-alive',
                  });
                }
                res.write(`data: ${JSON.stringify(chunk(id, created, model, { role: 'assistant', content: '' }))}\n\n`);
                headersSent = true;
                clearInterval(keepAliveTimer);
              }
              text += event.text;
              res.write(`data: ${JSON.stringify(chunk(id, created, model, { content: event.text }))}\n\n`);
            }
            if (event.type === 'done') finishReason = event.finishReason;
          }
        } finally {
          clearInterval(keepAliveTimer);
        }
        const completion = {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
          usage: estimateUsage(incremental, text),
        };
        conversations.commit(session, { role: 'assistant', content: text }, completion);
        if (!headersSent) {
          if (!res.headersSent) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
            });
          }
          res.write(`data: ${JSON.stringify(chunk(id, created, model, { role: 'assistant', content: '' }))}\n\n`);
          headersSent = true;
        }
        res.write(`data: ${JSON.stringify(chunk(id, created, model, {}, finishReason))}\n\n`);
        res.end('data: [DONE]\n\n');
        resolveInFlight(completion);
        return;
      }

      let text = '';
      let finishReason = 'stop';
      for await (const event of events) {
        if (event.type === 'delta') text += event.text;
        if (event.type === 'done') finishReason = event.finishReason;
      }
      const completion = {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
        usage: estimateUsage(incremental, text),
      };
      conversations.commit(session, { role: 'assistant', content: text }, completion);
      resolveInFlight(completion);
      sendJson(res, 200, completion);
    });
  } catch (error) {
    if (activeAborter?.signal?.aborted) {
      if (activeAborter.signal.reason === 'timeout') {
        error = new ProxyError(504, 'Factory request timed out', 'upstream_error');
      } else {
        error = new ProxyError(499, 'Client disconnected', 'client_cancelled');
      }
    }
    if (session) {
      if (isParseError) {
        conversations.commitParseError(session, lastFactoryText);
      } else {
        conversations.fail(session, { revertParent: !factoryInputAccepted });
      }
    }
    rejectInFlight(error);
    throw error;
  } finally {
    if (selection.canDedupe) conversations.clearInFlight(selection.requestHash);
  }
}

function sendCompletion(res, completion, stream) {
  if (!stream) { sendJson(res, 200, completion); return; }
  const { id, created, model } = completion;
  const choice = completion.choices[0];
  if (!res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
  }
  res.write(`data: ${JSON.stringify(chunk(id, created, model, { role: 'assistant', content: '' }))}\n\n`);
  if (choice.message.tool_calls?.length) {
    choice.message.tool_calls.forEach((call, index) => {
      res.write(`data: ${JSON.stringify(chunk(id, created, model, { tool_calls: [{ index, ...call }] }))}\n\n`);
    });
  } else if (choice.message.content) {
    res.write(`data: ${JSON.stringify(chunk(id, created, model, { content: choice.message.content }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify(chunk(id, created, model, {}, choice.finish_reason))}\n\n`);
  res.end('data: [DONE]\n\n');
}

function isValidHost(hostHeader, expectedPort) {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.toLowerCase().trim();
  const allowed = [
    `127.0.0.1:${expectedPort}`,
    `localhost:${expectedPort}`,
    `[::1]:${expectedPort}`,
    '127.0.0.1',
    'localhost',
    '[::1]',
  ];
  return allowed.includes(host);
}

// Best-effort live model catalog refresh. Never throws: any failure keeps the
// HAR/env catalog and logs one info line. Called fire-and-forget at startup.
async function refreshModelCatalog(config, fetchImpl) {
  try {
    const auth = config.authInitial ? await config.authSession?.current() : null;
    const response = await fetchImpl(
      `${config.apiBase}/v2/project/${encodeURIComponent(config.projectId)}/agents/models`,
      { method: 'GET', headers: factoryHeaders(config, auth) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.models) || !body.models.length) throw new Error('no models in response');
    const models = body.models.filter(model => typeof model.key === 'string' && model.key.length > 0);
    if (!models.length) throw new Error('no named models in response');
    config.modelKeys = [...new Set([config.modelKey, ...models.map(model => model.key), ...config.modelKeys])];
    config.modelSettings = {
      ...config.modelSettings,
      ...Object.fromEntries(models.map(model => [model.key, {
        thinkingLevel: model.capabilities?.thinking?.choices?.default || model.capabilities?.thinking?.default || model.default_thinking_level || 'medium',
      }])),
    };
    console.info(`Factory model catalog refreshed: ${models.map(model => model.key).join(', ')}`);
  } catch (error) {
    console.info(`Factory model catalog refresh failed, keeping existing catalog: ${error?.message || error}`);
  }
}

// --- Live credential reload (HAR drop, dashboard paste, saved file) --------

const CREDENTIALS_FILE = 'factory-credentials.json';

function envOverlayFromHar(harPath, sessionPath) {
  const overlay = { ...settingsFromHar(harPath), FACTORY_HAR_PATH: harPath };
  try {
    authFromHar(harPath); // only set when this HAR carries a Cognito refresh token
    overlay.FACTORY_AUTH_HAR_PATH = harPath;
    overlay.FACTORY_SESSION_PATH = sessionPath;
  } catch { /* headers-only HAR: bearer from headers stays valid until it expires */ }
  return overlay;
}

function applyRuntimeConfig(target, fresh, fetchImpl) {
  for (const key of Object.keys(fresh)) {
    if (key === 'authSession' || key === 'modelCatalogRefresh' || key === 'conversationPath' || key === 'port') continue;
    target[key] = fresh[key];
  }
  target.authSession = fresh.authInitial
    ? createFactoryAuth(fresh.authInitial, fresh.authSessionPath, fetchImpl)
    : null;
  target.ready = true;
}

function loadFreshConfig(config, overlay, fetchImpl) {
  const env = { ...(config.watchEnv || process.env), ...overlay,
    PROXY_CONVERSATIONS_PATH: config.conversationPath };
  const fresh = loadConfig(env);
  applyRuntimeConfig(config, fresh, fetchImpl);
  config.modelCatalogRefresh = refreshModelCatalog(config, fetchImpl);
}

function probeHarFiles(config, fetchImpl) {
  const files = readdirSync(config.watchDir)
    .filter(name => name.endsWith('.har'))
    .map(name => join(config.watchDir, name))
    .filter(file => { try { return statSync(file).isFile(); } catch { return false; } })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const sessionPath = config.conversationPath
    ? join(dirname(config.conversationPath), 'factory-session.json')
    : join(config.watchDir, 'factory-session.json');
  for (const file of files) {
    try {
      loadFreshConfig(config, envOverlayFromHar(file, sessionPath), fetchImpl);
      console.log(`Factory credentials loaded from ${basename(file)}; proxy is live`);
      return true;
    } catch (error) {
      console.info(`Ignoring ${basename(file)}: ${error.message}`);
    }
  }
  return false;
}

function startHarWatcher(config, server, fetchImpl) {
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { try { probeHarFiles(config, fetchImpl); } catch { /* keep old config */ } }, 500);
  };
  try {
    const watcher = watch(config.watchDir, { persistent: false }, (event, filename) => {
      if (typeof filename === 'string' && !filename.toLowerCase().endsWith('.har')) return;
      trigger();
    });
    watcher.unref?.();
    server.on('close', () => { clearTimeout(timer); watcher.close(); });
  } catch { /* watching unavailable: manual dashboard paste still works */ }
}

function readSavedCredentials(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Writes the proxy provider into local CLI/IDE config files (one click from
// the dashboard). Always backs up the file first; JSON targets are merged,
// YAML targets only created or verified (no risky text surgery).
function installCliTarget(target, { base, apiKey, models }) {
  const stamp = '.bak-factory8090';
  const mergeJsonFile = (filePath, mutate) => {
    let data = {};
    if (existsSync(filePath)) {
      try { data = JSON.parse(readFileSync(filePath, 'utf8')); }
      catch (error) {
        return { ok: false, message: filePath + ' не парсится как JSON (' + error.message + ') — файл не тронут, вставь блок из карточки «Эндпоинт» вручную' };
      }
      copyFileSync(filePath, filePath + stamp);
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    const note = mutate(data) || 'ok';
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { ok: true, message: filePath + ' обновлён' + (existsSync(filePath + stamp) ? ' (бэкап: ' + filePath + stamp + ')' : '') + '. ' + note };
  };
  const vsSettings = join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
  switch (target) {
    case 'opencode':
      return mergeJsonFile(join(homedir(), '.config', 'opencode', 'opencode.json'), (data) => {
        data.provider = data.provider || {};
        data.provider.factory8090 = {
          npm: '@ai-sdk/openai-compatible',
          name: 'Factory 8090',
          options: { baseURL: base, apiKey },
          models: Object.fromEntries(models.map(m => [m, { name: m, limit: { context: 200000, output: 32000 } }])),
        };
        return 'провайдер factory8090 записан; выбери его в OpenCode (Models → Factory 8090)';
      });
    case 'cline':
      return mergeJsonFile(vsSettings, (data) => {
        data['cline.apiProvider'] = 'openai-compatible';
        data['cline.openAiBaseUrl'] = base;
        data['cline.openAiApiKey'] = apiKey;
        data['cline.openAiModelId'] = models[0];
        return 'ключи cline.* записаны в settings.json VS Code; перезапусти окно VS Code';
      });
    case 'roo':
      return mergeJsonFile(vsSettings, (data) => {
        data['roo-cline.apiProvider'] = 'openai-compatible';
        data['roo-cline.openAiBaseUrl'] = base;
        data['roo-cline.openAiApiKey'] = apiKey;
        data['roo-cline.openAiModelId'] = models[0];
        return 'ключи roo-cline.* записаны в settings.json VS Code; перезапусти окно VS Code';
      });
    case 'continue': {
      const filePath = join(homedir(), '.continue', 'config.yaml');
      const providerBlock = '\nproviders:\n  factory8090:\n    npm: \'@continuedev/openai\'\n    apiBase: ' + base + '\n    apiKey: ' + apiKey + '\n';
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf8');
        if (raw.includes('factory8090')) return { ok: true, message: filePath + ' уже содержит провайдер factory8090 — ничего не менял' };
        if (/^providers:/m.test(raw) || /^models:/m.test(raw)) {
          copyFileSync(filePath, filePath + stamp);
          writeFileSync(filePath, raw + '\n  # factory8090 — см. блок в дашборде, вставь в существующую секцию providers/models\n');
          return { ok: false, message: filePath + ' уже имеет секции providers/models — допиши блок из карточки «Эндпоинт» вручную (бэкап сделан)' };
        }
        copyFileSync(filePath, filePath + stamp);
        writeFileSync(filePath, raw + '\nmodels:\n' + models.map(m => '  - name: ' + m + '\n    provider: factory8090\n    roles: [chat, edit, apply]\n    model: ' + m + '\n    apiKey: ' + apiKey + '\n').join('') + providerBlock);
        return { ok: true, message: filePath + ' дополнен (бэкап: ' + filePath + stamp + ')' };
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, 'name: Factory 8090 Proxy\nversion: 1.0.0\nschema: v1\nmodels:\n' + models.map(m => '  - name: ' + m + '\n    provider: factory8090\n    roles: [chat, edit, apply]\n    model: ' + m + '\n    apiKey: ' + apiKey + '\n').join('') + providerBlock + '\n');
      return { ok: true, message: filePath + ' создан с нуля' };
    }
    case 'omp': {
      const filePath = join(homedir(), '.omp', 'agent', 'models.yml');
      if (!existsSync(filePath)) return { ok: false, message: filePath + ' не найден — OMP не установлен?' };
      const raw = readFileSync(filePath, 'utf8');
      return raw.includes('hermes-factory8090')
        ? { ok: true, message: 'OMP уже подключён (hermes-factory8090 в models.yml); проверь enabledModels в config.yml' }
        : { ok: false, message: 'hermes-factory8090 не найден в models.yml — вставь блок из карточки «Эндпоинт» (секция OMP models.yml)' };
    }
    default:
      throw new Error('Неизвестный target: ' + target);
  }
}

export function createProxyServer(config, fetchImpl = fetch) {
  const conversations = createConversationStore(config.conversationPath);
  if (config.authInitial && !config.authSession) {
    config.authSession = createFactoryAuth(config.authInitial, config.authSessionPath, fetchImpl);
  }
  if (config.ready !== false) config.modelCatalogRefresh = refreshModelCatalog(config, fetchImpl);
  const server = http.createServer(async (req, res) => {
    const serverPort = req.socket?.localPort || config.port;
    if (!isValidHost(req.headers.host, serverPort)) {
      sendJson(res, 403, { error: { message: 'Invalid Host header', type: 'access_denied' } });
      return;
    }
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { status: config.ready === false ? 'waiting_for_har' : 'ok' });
      return;
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderDashboardPage({ port: serverPort, apiKey: config.localApiKey, models: config.modelKeys }));
      return;
    }
    if (req.method === 'POST' && pathname === '/dashboard/credentials') {
      try {
        const body = await readJson(req);
        const parsed = parseCredentialPaste(body.text, body.url);
        if (parsed.kind === 'har') {
          const harPath = join(config.watchDir || process.cwd(), 'dashboard-credentials.har');
          writeFileSync(harPath, JSON.stringify(parsed.har));
          probeHarFiles(config, fetchImpl);
        } else {
          loadFreshConfig(config, envOverlayFromParsed(parsed), fetchImpl);
          try {
            writeFileSync(join(config.watchDir || process.cwd(), CREDENTIALS_FILE),
              JSON.stringify({ headers: parsed.headers, projectId: parsed.projectId, apiBase: parsed.apiBase }, null, 2));
          } catch { /* persistence optional */ }
        }
        sendJson(res, 200, { ready: config.ready !== false, models: config.modelKeys });
      } catch (error) {
        sendJson(res, 400, { error: { message: error.message, type: 'invalid_request_error' } });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/status') {
      const authState = config.authSession?.getState?.();
      sendJson(res, 200, {
        ready: config.ready !== false,
        models: config.modelKeys,
        sessions: conversations.activeLocksCount(),
        auth: authState?.expiresAt ? { expiresAt: authState.expiresAt } : null,
      });
      return;
    }
    if (!authorized(req, config.localApiKey)) {
      sendJson(res, 401, { error: { message: 'Invalid local API key', type: 'authentication_error' } });
      return;
    }

    if (req.method === 'POST' && pathname === '/dashboard/install') {
      try {
        const body = await readJson(req);
        const result = installCliTarget(body.target, {
          base: `http://127.0.0.1:${serverPort}/v1`,
          apiKey: config.localApiKey,
          models: (config.modelKeys?.length ? config.modelKeys : ['gpt-5.6-sol']),
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { ok: false, message: error.message });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/models') {
      if (config.ready === false) { sendJson(res, 200, { object: 'list', data: [] }); return; }
      sendJson(res, 200, { object: 'list', data: config.modelKeys.map(id => ({ id, object: 'model', created: 0, owned_by: 'factory-8090' })) });
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      try { await handleCompletion(req, res, config, fetchImpl, conversations); }
      catch (error) { if (!res.destroyed) sendError(res, error); }
      return;
    }
    sendJson(res, 404, { error: { message: 'Endpoint not found', type: 'invalid_request_error' } });
  });
  if (config.authSession) {
    const timer = setInterval(() => {
      config.authSession.current().catch(error => console.error(`Factory auth refresh: ${error.message}`));
    }, 60_000);
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  if (config.watchDir) startHarWatcher(config, server, fetchImpl);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const watchDir = process.env.PROXY_HAR_WATCH_DIR || scriptDir;
  const watchEnabled = process.env.PROXY_HAR_WATCH !== '0';
  let config = null;
  try {
    config = loadConfig();
    console.log(`Factory proxy configured from ${config.harPath ? basename(config.harPath) : 'environment'}`);
  } catch (error) {
    config = {
      port: Number(process.env.PROXY_PORT || 18090),
      localApiKey: process.env.PROXY_API_KEY || 'local-trial',
      conversationPath: process.env.PROXY_CONVERSATIONS_PATH || join(scriptDir, 'factory-conversations.json'),
      modelKey: null,
      modelKeys: [],
      modelSettings: {},
      thinkingLevel: 'medium',
      contextWindow: 'default',
      generationMode: 'standard',
      servingSource: 'platform',
      clientSessionId: randomUUID(),
      ready: false,
      watchEnv: process.env,
      watchDir: watchEnabled ? watchDir : null,
    };
    console.log(`Factory proxy starting without credentials: ${error.message}`);
  }
  if (watchEnabled && !config.watchDir) { config.watchEnv = config.watchEnv || process.env; config.watchDir = watchDir; }
  const server = createProxyServer(config);
  if (!config.ready) {
    const saved = readSavedCredentials(join(scriptDir, CREDENTIALS_FILE));
    if (saved?.projectId && saved?.headers) {
      try {
        loadFreshConfig(config, envOverlayFromParsed(saved), fetch);
        console.log('Factory credentials restored from factory-credentials.json');
      } catch (error) { console.info(`Saved credentials rejected: ${error.message}`); }
    }
    if (!config.ready && config.watchDir) probeHarFiles(config, fetch);
  }
  server.listen(config.port, '127.0.0.1', () => {
    const state = config.ready ? 'live' : 'waiting for credentials';
    console.log(`Factory proxy ${state} on http://127.0.0.1:${config.port}/ — dashboard`);
    console.log(`OpenAI endpoint: http://127.0.0.1:${config.port}/v1 (API key: ${config.localApiKey})`);
    if (!config.ready) console.log('Open the dashboard and paste a HAR export or request headers from factory.8090.ai');
  });
}
