// Lets the tests load every module without network-heavy npm dependencies
// (cycletls, puppeteer, axios …). Only pure logic is exercised.
const Module = require('module');
const STUBBED = new Set(['axios', 'axios-cookiejar-support', 'tough-cookie', 'https-proxy-agent', 'http-proxy-agent',
  'cycletls', 'puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth', 'ws']);
const stub = new Proxy(function () {}, { get: (t, k) => (k === '__esModule' ? false : stub), apply: () => stub, construct: () => stub });
const orig = Module._load;
Module._load = function (request, ...rest) {
  if (STUBBED.has(request)) return stub;
  return orig.call(this, request, ...rest);
};
