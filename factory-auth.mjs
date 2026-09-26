import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function jwtExpiry(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000; }
  catch { return 0; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

export function authFromHar(path) {
  const har = readJson(path);
  if (!har?.log?.entries) throw new Error('FACTORY_AUTH_HAR_PATH is not a readable HAR');
  let configEntry;
  let cognito;
  for (const e of har.log.entries) {
    try {
      if (new URL(e.request.url).pathname === '/config.json') {
        configEntry = e;
        cognito = JSON.parse(configEntry.response?.content?.text || '{}').cognito;
      }
    } catch { /* ignore malformed HAR entries */ }
  }
  const entry = har.log.entries.findLast(e => {
    try {
      if (!cognito?.region || new URL(e.request.url).hostname !== `cognito-idp.${cognito.region}.amazonaws.com`) return false;
      return Boolean(JSON.parse(e.response.content.text).AuthenticationResult?.RefreshToken);
    } catch { return false; }
  });
  if (!entry || !cognito?.userPoolClientId || !cognito?.region) {
    throw new Error('HAR has no Cognito refresh token or public client configuration');
  }
  let result;
  try {
    result = JSON.parse(entry.response.content.text).AuthenticationResult;
  } catch {
    throw new Error('HAR contains unreadable Cognito AuthenticationResult');
  }
  return {
    clientId: cognito.userPoolClientId, region: cognito.region,
    accessToken: result.AccessToken, idToken: result.IdToken,
    refreshToken: result.RefreshToken, expiresAt: jwtExpiry(result.AccessToken),
  };
}

export function createFactoryAuth(initial, sessionPath, fetchImpl = fetch, now = Date.now) {
  const saved = sessionPath && readJson(sessionPath);
  // A saved session can contain a rotated refresh token that the HAR no longer has.
  let state = saved?.clientId === initial.clientId && saved?.region === initial.region &&
    saved?.refreshToken && saved?.accessToken && saved?.idToken &&
    jwtExpiry(saved.accessToken) >= initial.expiresAt ? saved : initial;
  let pending;
  let persistenceError = null;

  function persistState() {
    if (!sessionPath) return;
    const temp = `${sessionPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      renameSync(temp, sessionPath);
      try { chmodSync(sessionPath, 0o600); } catch { /* Windows compatibility */ }
      persistenceError = null;
    } catch (err) {
      try { unlinkSync(temp); } catch { /* ignore */ }
      persistenceError = new Error(`Could not save the refreshed Factory session to ${sessionPath}: ${err.message}`);
      throw persistenceError;
    }
  }

  async function refresh() {
    const response = await fetchImpl(`https://cognito-idp.${state.region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken' },
      body: JSON.stringify({ ClientId: state.clientId, RefreshToken: state.refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cognito token refresh failed (HTTP ${response.status})`);
    let result;
    try {
      result = (await response.json()).AuthenticationResult;
    } catch {
      throw new Error('Cognito token refresh returned invalid JSON');
    }
    if (!result?.AccessToken || !result?.IdToken) throw new Error('Cognito token refresh returned no access or ID token');
    const next = {
      ...state, accessToken: result.AccessToken, idToken: result.IdToken,
      refreshToken: result.RefreshToken || state.refreshToken,
      expiresAt: jwtExpiry(result.AccessToken),
    };
    state = next;
    persistState();
    return state;
  }

  return {
    async current() {
      if (persistenceError) {
        persistState();
      }
      if (state.expiresAt > now() + 5 * 60_000) return state;
      if (!pending) pending = refresh().finally(() => { pending = null; });
      return pending;
    },
    getState() {
      return state;
    },
  };
}
