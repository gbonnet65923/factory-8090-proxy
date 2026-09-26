import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';

const MAX_SESSIONS = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function messageHashes(messages) {
  return messages.map(digest);
}

export function normalizeTool(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters || {},
  };
}

export function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];
  return tools.map(normalizeTool).sort((a, b) => a.name.localeCompare(b.name));
}

export function normalizeToolChoice(choice) {
  if (!choice) return 'auto';
  if (typeof choice === 'string') return choice.toLowerCase();
  if (typeof choice === 'object' && choice?.type === 'function') {
    return { type: 'function', name: choice.function?.name || '' };
  }
  return choice;
}

export function computeOperationKey(options) {
  const {
    model,
    hashes,
    tools = [],
    toolChoice = 'auto',
    parallelToolCalls = true,
    taskId = null,
    requestId = null,
  } = options;

  return digest({
    model,
    hashes,
    tools: normalizeTools(tools),
    toolChoice: normalizeToolChoice(toolChoice),
    parallelToolCalls: parallelToolCalls !== false,
    taskId: taskId || null,
    requestId: requestId || null,
  });
}

function turnIdsOf(item) {
  if (Array.isArray(item?.turnToolCallIds)) return item.turnToolCallIds.filter(id => typeof id === 'string' && id);
  const lineage = new Set(Array.isArray(item?.lineageToolCallIds) ? item.lineageToolCallIds : []);
  return (Array.isArray(item?.issuedToolCallIds) ? item.issuedToolCallIds : [])
    .filter(id => typeof id === 'string' && id && !lineage.has(id));
}

function boundaryToolIds(messages, start) {
  const ids = new Set();
  const assistant = messages[start];
  if (!assistant || assistant.role !== 'assistant') return ids;
  for (const call of assistant.tool_calls || []) {
    if (typeof call?.id === 'string' && call.id) ids.add(call.id);
  }
  for (let index = start + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== 'tool') break;
    if (typeof message.tool_call_id === 'string' && message.tool_call_id) ids.add(message.tool_call_id);
  }
  return ids;
}

function readSaved(path) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed.version === 1 && Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

export function createConversationStore(path, now = Date.now) {
  // On startup, any session loaded from disk that had status === 'pending'
  // was interrupted by process termination. Mark it uncertain so it cannot
  // be confused with an in-flight or completed turn.
  let sessions = readSaved(path).map(item => {
    if (!item) return item;
    const base = {
      ...item,
      issuedToolCallIds: Array.isArray(item.issuedToolCallIds) ? item.issuedToolCallIds : [],
      lineageToolCallIds: Array.isArray(item.lineageToolCallIds) ? item.lineageToolCallIds : [],
      turnToolCallIds: turnIdsOf(item),
    };
    if (base.status === 'pending') {
      return { ...base, status: 'uncertain' };
    }
    return base;
  }).filter(item =>
    item && typeof item.id === 'string' && typeof item.conversationId === 'string' &&
    Array.isArray(item.expected) && now() - item.updatedAt < MAX_AGE_MS
  ).slice(-MAX_SESSIONS);

  const inFlightRequests = new Map(); // requestHash -> Promise<completion>
  const conversationLocks = new Map(); // conversationId -> Promise

  function pruneSessions() {
    const cutoff = now() - MAX_AGE_MS;
    sessions = sessions.filter(s => s && s.updatedAt >= cutoff);
    if (sessions.length > MAX_SESSIONS) {
      // Prioritize preserving active done uncontinued sessions so parent tasks are not evicted
      const uncontinued = sessions.filter(s => !s.continuedBy && s.status === 'done');
      const others = sessions.filter(s => s.continuedBy || s.status !== 'done');
      const keptOthers = others.slice(-Math.max(0, MAX_SESSIONS - uncontinued.length));
      sessions = [...keptOthers, ...uncontinued].sort((a, b) => a.updatedAt - b.updatedAt);
    }
  }

  function save() {
    if (!path) return;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
      renameSync(temp, path);
      try { chmodSync(path, 0o600); } catch { /* Windows compatibility */ }
    } catch (err) {
      try { unlinkSync(temp); } catch { /* ignore */ }
      throw new Error(`Failed to persist conversation store to ${path}: ${err.message}`);
    }
  }

  function exactPrefix(hashes, prefix) {
    return prefix.length <= hashes.length && prefix.every((part, index) => part === hashes[index]);
  }

  function select(model, messages, options = {}) {
    const taskId = options.taskId || null;
    const requestId = options.requestId || null;
    const tools = options.tools || [];
    const toolChoice = options.toolChoice || 'auto';
    const parallelToolCalls = options.parallelToolCalls !== false;
    const hashes = messageHashes(messages);
    const requestHash = computeOperationKey({
      model,
      hashes,
      tools,
      toolChoice,
      parallelToolCalls,
      taskId,
      requestId,
    });
    // A byte-identical body is not an identity. Cache and in-flight merging are
    // enabled only when the client supplied a task id or an idempotency key.
    // Without either, a retry and a new identical task cannot be told apart,
    // so the safe choice is a fresh Factory conversation.
    const canDedupe = Boolean(taskId || requestId);
    const finish = fields => ({
      session: null,
      hashes,
      requestHash,
      taskId,
      requestId,
      canDedupe,
      ...fields,
    });

    if (canDedupe && inFlightRequests.has(requestHash)) {
      const activePromise = inFlightRequests.get(requestHash);
      if (options.ignoreInFlightPromise !== activePromise && options.ignoreInFlightHash !== requestHash) {
        return finish({
          mode: 'in_flight',
          inFlightPromise: activePromise,
        });
      }
    }

    if (canDedupe) {
      const exact = sessions.findLast(s =>
        s.model === model &&
        (taskId ? s.taskId === taskId : !s.taskId) &&
        s.requestHash === requestHash
      );
      if (exact) {
        if (exact.status === 'done') {
          if (exact.completion) {
            // A turn already extended by a later request is not an active replay.
            if (exact.continuedBy) return finish({ mode: 'new' });
            return finish({ session: exact, mode: 'cached', completion: exact.completion });
          }
          // Parse error on a completed upstream turn: retry inside the same conversation.
          return finish({ session: exact, mode: 'continue' });
        }
        if (exact.status === 'pending') {
          const activePromise = inFlightRequests.get(requestHash);
          if (activePromise && options.ignoreInFlightPromise !== activePromise && options.ignoreInFlightHash !== requestHash) {
            return finish({
              session: exact,
              mode: 'in_flight',
              inFlightPromise: activePromise,
            });
          }
        }
        // uncertain, or a pending turn whose in-flight promise is gone:
        // do not send the same turn into that Factory conversation again.
        return finish({ mode: 'new' });
      }
    }

    // Roo rewrites the assistant message before the next request: content ""
    // instead of null, and JSON.stringify of the parsed tool arguments. That
    // changes the message hash at the boundary even when the tool call ids are
    // the same. Match the client prefix exactly, then accept the boundary
    // assistant message only when it carries ids this turn issued.
    const aligned = sessions.filter(session => {
      if (session.model !== model || session.status !== 'done' || session.continuedBy) return false;
      if (taskId ? session.taskId !== taskId : session.taskId) return false;
      if (!Array.isArray(session.request) || !(session.request.length < hashes.length)) return false;
      return exactPrefix(hashes, session.request);
    }).sort((a, b) => b.request.length - a.request.length || b.updatedAt - a.updatedAt);

    const links = session => {
      const start = session.request.length;
      const turnIds = Array.isArray(session.turnToolCallIds) ? session.turnToolCallIds : [];
      if (!turnIds.length) {
        if (!taskId) return false;
        return session.expected.length === start + 1 && hashes[start] === session.expected[start];
      }
      const present = boundaryToolIds(messages, start);
      return turnIds.some(id => present.has(id));
    };
    const longest = aligned[0]?.request.length ?? -1;
    const frontier = aligned.filter(session => session.request.length === longest);
    const linked = frontier.filter(links);
    const describe = (session, reason) => {
      const start = session?.request?.length ?? 0;
      return {
        reason,
        prefix: start,
        incomingLength: hashes.length,
        boundaryRole: messages[start]?.role || null,
        storedHash: typeof session?.expected?.[start] === 'string' ? session.expected[start].slice(0, 12) : null,
        incomingHash: typeof hashes[start] === 'string' ? hashes[start].slice(0, 12) : null,
        turnToolCalls: session?.turnToolCallIds?.length || 0,
      };
    };

    if (!linked.length) {
      const candidate = aligned[0];
      let reason = 'new-no-prefix';
      if (candidate) {
        const start = candidate.request.length;
        const turnIds = Array.isArray(candidate.turnToolCallIds) ? candidate.turnToolCallIds : [];
        const hashMatches = candidate.expected.length === start + 1 && hashes[start] === candidate.expected[start];
        reason = !turnIds.length && !taskId && hashMatches ? 'new-anonymous-text' : 'new-assistant-mismatch';
      }
      return finish({ mode: 'new', decision: describe(candidate, reason) });
    }
    if (linked.length > 1 && linked[0].request.length === linked[1].request.length) {
      return finish({ mode: 'new', decision: describe(linked[0], 'new-ambiguous') });
    }
    const parent = linked[0];
    return finish({
      session: parent,
      mode: 'continue',
      resumeAt: parent.request.length + 1,
      decision: describe(parent, parent.turnToolCallIds?.length ? 'continue-tool-boundary' : 'continue-text'),
    });
  }

  function begin(selection, model, options = {}) {
    if (selection.session) selection.session.continuedBy = true;
    const parent = selection.session || null;
    const session = {
      id: randomUUID(),
      parentSession: parent,
      conversationId: parent?.conversationId || randomUUID(),
      clientMessageId: randomUUID(),
      model,
      taskId: options.taskId || selection.taskId || parent?.taskId || null,
      requestHash: selection.requestHash,
      request: selection.hashes,
      expected: [],
      issuedToolCallIds: [],
      turnToolCallIds: [],
      lineageToolCallIds: [
        ...(parent?.lineageToolCallIds || []),
        ...(parent?.issuedToolCallIds || []),
      ],
      status: 'pending',
      updatedAt: now(),
    };
    sessions.push(session);
    pruneSessions();
    try {
      save();
    } catch (err) {
      const idx = sessions.indexOf(session);
      if (idx !== -1) sessions.splice(idx, 1);
      if (selection.session) selection.session.continuedBy = false;
      throw err;
    }
    return session;
  }

  function commit(session, responseMessage, completion) {
    session.expected = [...session.request, digest(responseMessage)];
    session.completion = completion;
    session.status = 'done';
    session.updatedAt = now();

    const toolCalls = completion?.choices?.[0]?.message?.tool_calls || responseMessage?.tool_calls;
    const newlyIssued = Array.isArray(toolCalls)
      ? toolCalls.map(c => c.id).filter(Boolean)
      : [];
    session.turnToolCallIds = newlyIssued;
    session.issuedToolCallIds = [
      ...new Set([...(session.lineageToolCallIds || []), ...newlyIssued]),
    ];

    try {
      save();
    } catch (err) {
      session.status = 'uncertain';
      throw err;
    }
  }

  function commitParseError(session, rawAssistantText) {
    session.expected = [...session.request];
    session.rawResponse = rawAssistantText;
    session.completion = null;
    session.status = 'done';
    session.updatedAt = now();
    session.issuedToolCallIds = [...(session.lineageToolCallIds || [])];
    try {
      save();
    } catch (err) {
      session.status = 'uncertain';
      throw err;
    }
  }

  function fail(session, options = {}) {
    if (options.revertParent && session.parentSession) {
      session.parentSession.continuedBy = false;
    }
    // An accepted Factory input may have completed despite a lost stream.
    // Mark uncertain so it cannot be reused, and retries will start a clean new conversation.
    session.status = 'uncertain';
    session.updatedAt = now();
    try {
      save();
    } catch (err) {
      console.error(`Warning: failed to persist session failure state: ${err.message}`);
    }
  }

  function setInFlight(requestHash, promise) {
    inFlightRequests.set(requestHash, promise);
  }

  function clearInFlight(requestHash) {
    inFlightRequests.delete(requestHash);
  }

  async function runExclusive(conversationId, fn) {
    if (!conversationId) return fn();
    const prev = conversationLocks.get(conversationId) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    const chained = prev.then(() => next, () => next);
    conversationLocks.set(conversationId, chained);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (conversationLocks.get(conversationId) === chained) {
        conversationLocks.delete(conversationId);
      }
    }
  }

  return {
    select,
    begin,
    commit,
    commitParseError,
    fail,
    setInFlight,
    clearInFlight,
    runExclusive,
    activeLocksCount: () => conversationLocks.size,
    getSessions: () => [...sessions],
  };
}
