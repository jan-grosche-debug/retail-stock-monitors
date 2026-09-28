const axios = require('axios');
const http = require('http');
const https = require('https');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

// Keep-alive agents for direct (non-proxy) requests. Reusing the TCP/TLS
// connection on Shopify checkouts is the difference between ~100 ms and
// ~400 ms per hop on a slow link.
const KEEPALIVE_HTTP = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 32,
  scheduling: 'lifo'
});
const KEEPALIVE_HTTPS = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 32,
  scheduling: 'lifo'
});

const CHROME_HEADERS = {
  'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

let cyclePromise = null;
let cycleStatus = 'unknown'; // 'unknown' | 'ready' | 'broken'

async function getCycle() {
  if (cycleStatus === 'broken') throw new Error('TLS backend disabled');
  if (cyclePromise) return cyclePromise;
  cyclePromise = (async () => {
    try {
      const initCycleTLS = require('cycletls');
      const port = 9119 + Math.floor(Math.random() * 800);
      const instance = await initCycleTLS({ port });
      cycleStatus = 'ready';
      return instance;
    } catch (err) {
      cycleStatus = 'broken';
      cyclePromise = null;
      throw err;
    }
  })();
  return cyclePromise;
}

function isCycleAvailable() {
  return cycleStatus !== 'broken';
}

async function shutdownCycle() {
  if (!cyclePromise || cycleStatus !== 'ready') return;
  try {
    const inst = await cyclePromise;
    await inst.exit();
  } catch (_) { /* ignore */ }
  cyclePromise = null;
  cycleStatus = 'unknown';
}

function buildProxyAgents(proxyConfig) {
  if (!proxyConfig || !proxyConfig.server) return null;
  const url = proxyConfig.server;
  return { http: new HttpProxyAgent(url), https: new HttpsProxyAgent(url) };
}

function createAxiosBackend({ proxy, jar, baseHeaders = {}, timeout = 25000 }) {
  const agents = buildProxyAgents(proxy);
  const instance = wrapper(axios.create({
    timeout,
    withCredentials: true,
    jar,
    httpAgent: agents?.http || KEEPALIVE_HTTP,
    httpsAgent: agents?.https || KEEPALIVE_HTTPS,
    maxRedirects: 0,
    validateStatus: () => true,
    headers: { ...CHROME_HEADERS, ...baseHeaders }
  }));

  async function request(method, url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let currentUrl = url;
    let currentMethod = method;
    let currentData = opts.data; // carried across hops so 307/308 can re-POST the body
    const followRedirects = opts.followRedirects !== false;
    const maxRedirects = opts.maxRedirects ?? 8;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await instance.request({
        method: currentMethod,
        url: currentUrl,
        data: currentData,
        headers,
        responseType: opts.responseType || 'text'
      });

      if (!followRedirects || res.status < 300 || res.status >= 400 || !res.headers?.location) {
        return res;
      }
      const next = new URL(res.headers.location, currentUrl).toString();
      headers.referer = currentUrl; // the page that issued the redirect
      currentUrl = next;
      // 307/308 MUST preserve method AND body; 301/302/303 downgrade POST→GET and
      // drop the body (browser behavior). Previously the body was dropped after hop
      // 0 unconditionally, so a 307/308 re-POST sent an empty body.
      if (res.status !== 307 && res.status !== 308) {
        if (currentMethod !== 'GET') currentMethod = 'GET';
        currentData = undefined;
      }
    }
    throw new Error('Too many redirects (axios)');
  }

  return { request, get: (u, o) => request('GET', u, o), post: (u, o) => request('POST', u, o) };
}

function createTlsBackend({ proxy, jar, baseHeaders = {}, timeout = 25000 }) {
  async function readCookies(url) {
    try { return await jar.getCookieString(url); } catch (_) { return ''; }
  }
  async function writeCookies(url, setCookieField) {
    if (!setCookieField) return;
    const list = Array.isArray(setCookieField) ? setCookieField : [setCookieField];
    for (const sc of list) {
      try { await jar.setCookie(sc, url); } catch (_) { /* ignore bad cookie */ }
    }
  }

  const proxyUri = proxy?.server || '';

  async function request(method, url, opts = {}) {
    const cycle = await getCycle();
    let currentUrl = url;
    let currentMethod = String(method).toUpperCase();
    const followRedirects = opts.followRedirects !== false;
    const maxRedirects = opts.maxRedirects ?? 8;
    // [FIX #8] Klonen: das vom Aufrufer übergebene opts.headers-Objekt wird über
    // withHttpRetry-Versuche hinweg wiederverwendet und ist für den Aufrufer sichtbar
    // — hineinschreiben würde über Hops aliasen. Der axios-Backend klont bereits
    // (s. o.); hier zog der TLS-Pfad nach.
    const reqHeaderOverrides = { ...(opts.headers || {}) };
    // Referer läuft deshalb als lokale Variable statt als Mutation an
    // reqHeaderOverrides — dasselbe Ziel wie FIX #8, eine Ebene sauberer.
    let referer = reqHeaderOverrides.referer || null;
    let currentBody = opts.data || ''; // carried across hops so 307/308 re-POSTs the body

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const cookieHeader = await readCookies(currentUrl);
      const merged = {
        ...CHROME_HEADERS,
        ...baseHeaders,
        ...reqHeaderOverrides,
        ...(referer ? { referer } : {}),
        ...(cookieHeader ? { cookie: cookieHeader } : {})
      };
      // Let Go layer negotiate encoding; cycletls does not decompress when this is set explicitly.
      delete merged['accept-encoding'];
      const headers = merged;
      const body = currentBody;

      const res = await cycle(
        currentUrl,
        {
          body,
          ja3: CHROME_JA3,
          userAgent: CHROME_HEADERS['user-agent'],
          headers,
          timeout: Math.ceil(timeout / 1000),
          proxy: proxyUri,
          disableRedirect: true
        },
        currentMethod.toLowerCase()
      );

      const sc = res?.headers && (res.headers['set-cookie'] || res.headers['Set-Cookie']);
      if (sc) await writeCookies(currentUrl, sc);

      const headerObj = res?.headers || {};
      const location = headerObj.location || headerObj.Location;
      const status = res?.status ?? 0;
      const finalUrl = res?.finalUrl || currentUrl;

      let bodyText = '';
      if (typeof res?.text === 'function') {
        try { bodyText = await res.text(); } catch (_) { bodyText = ''; }
      } else if (typeof res?.body === 'string') {
        bodyText = res.body;
      } else if (typeof res?.data === 'string') {
        bodyText = res.data;
      } else if (res?.body && typeof res.body === 'object') {
        // cycletls 1.x auto-parses JSON bodies into objects — turn them back into text
        // so callers can always JSON.parse(res.data) regardless of the cycletls version.
        bodyText = JSON.stringify(res.body);
      }

      const normalized = {
        status,
        data: bodyText,
        headers: headerObj,
        config: { url: currentUrl },
        request: { res: { responseUrl: finalUrl } }
      };

      if (!followRedirects || status < 300 || status >= 400 || !location) {
        return normalized;
      }

      // Referer is the page that issued the redirect (the current page), not the
      // original request URL.
      referer = currentUrl;
      currentUrl = new URL(location, currentUrl).toString();
      // 307/308 preserve method + body; 301/302/303 downgrade POST→GET and drop body.
      if (status !== 307 && status !== 308) {
        if (currentMethod !== 'GET') currentMethod = 'GET';
        currentBody = '';
      }
    }
    throw new Error('Too many redirects (tls)');
  }

  return { request, get: (u, o) => request('GET', u, o), post: (u, o) => request('POST', u, o) };
}

function createRequestClient({ proxy, jar, baseHeaders = {}, timeout = 25000, useTls = true } = {}) {
  const cookieJar = jar || new CookieJar();
  const axiosBackend = createAxiosBackend({ proxy, jar: cookieJar, baseHeaders, timeout });
  let tlsBackend = (useTls && isCycleAvailable()) ? createTlsBackend({ proxy, jar: cookieJar, baseHeaders, timeout }) : null;

  async function request(method, url, opts = {}) {
    if (tlsBackend) {
      try {
        return await tlsBackend.request(method, url, opts);
      } catch (err) {
        const msg = String(err?.message || '');
        const transportFail = /TLS backend disabled|ECONNREFUSED|ENOENT|spawn|EPIPE/i.test(msg) || cycleStatus === 'broken';
        if (transportFail) {
          tlsBackend = null;
        } else {
          throw err;
        }
      }
    }
    return axiosBackend.request(method, url, opts);
  }

  return {
    request,
    get: (u, o) => request('GET', u, o),
    post: (u, o) => request('POST', u, o),
    jar: cookieJar,
    get backend() { return tlsBackend ? 'tls' : 'axios'; }
  };
}

async function withHttpRetry(action, { retries = 2, delayMs = 800, runtime } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (runtime) runtime.throwIfStopped();
    try { return await action(attempt); }
    catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      if (runtime) await runtime.sleep(delayMs);
      else await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError || new Error('HTTP retry exhausted');
}

module.exports = {
  createRequestClient,
  withHttpRetry,
  shutdownCycle,
  isCycleAvailable,
  CHROME_HEADERS,
  CHROME_JA3
};
