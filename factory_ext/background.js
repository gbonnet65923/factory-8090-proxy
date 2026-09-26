// Factory 8090 Credential Collector — MV3 service worker.
// Watches outgoing requests to api.factory.8090.dev; when it sees a
// chat-agent/input request with an authorization header, it formats the
// headers and POSTs them to the local proxy dashboard endpoint.
// Read-only: never modifies or blocks requests.

const PROXY_ENDPOINT = 'http://127.0.0.1:18090/dashboard/credentials';
const TARGET = /api\.factory\.8090\.dev\/v2\/project\/[0-9a-f-]+\/agents\/chat-agent\/input/i;

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      if (details.method !== 'POST' || !TARGET.test(details.url)) return;
      const headers = {};
      for (const h of details.requestHeaders || []) {
        headers[h.name.toLowerCase()] = h.value || '';
      }
      if (!headers.authorization) return;
      const text = Object.keys(headers)
        .map((k) => k + ': ' + headers[k])
        .join('\n');
      chrome.storage.local.get({ lastSent: 0 }, ({ lastSent }) => {
        // Debounce: the site sends several requests per message.
        if (Date.now() - lastSent < 2000) return;
        chrome.storage.local.set({ lastSent: Date.now(), lastText: text, lastUrl: details.url });
        fetch(PROXY_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, url: details.url }),
        })
          .then((r) => r.text())
          .then((t) => console.log('[factory-collector] proxy response:', t))
          .catch((e) => console.warn('[factory-collector] proxy unreachable:', e.message));
      });
    } catch (e) {
      console.warn('[factory-collector] error:', e);
    }
  },
  { urls: ['https://api.factory.8090.dev/*'] },
  ['requestHeaders']
);
