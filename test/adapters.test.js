import assert from 'node:assert/strict';
import { test } from 'node:test';

import axios from 'axios';
import got from 'got';

import { createClient, memoryStore } from '../src/index.js';
import { attachX402 as attachAxios } from '../src/adapters/axios.js';
import { wrapFetch, x402Fetch } from '../src/adapters/fetch.js';
import { x402Hooks } from '../src/adapters/got.js';
import { attachX402 as attachPlaywright, gotoPaid as playwrightGoto } from '../src/adapters/playwright.js';
import { applyPass, attachX402 as attachPuppeteer, gotoPaid as puppeteerGoto } from '../src/adapters/puppeteer.js';
import { KEY_ONE, startGateway } from './helpers.js';

// ---------------------------------------------------------------- fetch

test('wrapFetch pays through the fetch it is given, and x402Fetch through the global', async () => {
  const gateway = await startGateway();
  try {
    let calls = 0;
    const counting = (input, init) => {
      calls++;
      return globalThis.fetch(input, init);
    };
    const paying = wrapFetch(counting, { key: KEY_ONE });
    const res = await paying(`${gateway.url}/page`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);
    assert.equal(calls, 3, 'the 402, the proof, and the page with the pass');

    const again = await paying(`${gateway.url}/other`);
    assert.equal(again.status, 200);
    assert.equal(gateway.state.payments.length, 1);

    const global = x402Fetch({ key: KEY_ONE, store: memoryStore() });
    assert.equal((await global(`${gateway.url}/page`)).status, 200);
    assert.equal(gateway.state.payments.length, 2);
  } finally {
    await gateway.close();
  }
});

test('wrapFetch can share a client, so two fetches share one pass file', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE });
    const a = wrapFetch(globalThis.fetch, { client });
    const b = wrapFetch(globalThis.fetch, { client });
    assert.equal((await a(`${gateway.url}/one`)).status, 200);
    assert.equal((await b(`${gateway.url}/two`)).status, 200);
    assert.equal(gateway.state.payments.length, 1);
    assert.ok(client.passFor(gateway.url));
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------- axios

test('axios: a 402 is paid and replayed, and the pass rides on later requests', async () => {
  const gateway = await startGateway();
  try {
    const instance = axios.create();
    const detach = attachAxios(instance, createClient({ key: KEY_ONE }));

    const res = await instance.get(`${gateway.url}/page`);
    assert.equal(res.status, 200);
    assert.equal(res.data, '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);

    const again = await instance.get(`${gateway.url}/other`);
    assert.equal(again.status, 200);
    assert.equal(gateway.state.payments.length, 1);
    assert.match(gateway.state.hits.at(-1).headers['x-crawl-pass'], /^cp_test1/);

    detach();
    await assert.rejects(instance.get(`${gateway.url}/fresh`), (err) => err.response?.status === 402 || err.status === 402);
    assert.equal(gateway.state.payments.length, 1, 'detached: nothing pays');
  } finally {
    await gateway.close();
  }
});

test('axios: relative URLs resolve against baseURL, and a widened validateStatus is handled too', async () => {
  const gateway = await startGateway();
  try {
    const instance = axios.create({ baseURL: gateway.url, validateStatus: () => true });
    attachAxios(instance, createClient({ key: KEY_ONE }));
    const res = await instance.get('/page');
    assert.equal(res.status, 200);
    assert.equal(res.data, '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);
  } finally {
    await gateway.close();
  }
});

test('axios: a refused payment surfaces as the original 402 error, paid exactly once', async () => {
  const gateway = await startGateway({ mode: 'reject' });
  try {
    const instance = axios.create();
    attachAxios(instance, createClient({ key: KEY_ONE }));
    await assert.rejects(instance.get(`${gateway.url}/page`), (err) => {
      assert.equal(err.name, 'X402Error');
      assert.equal(err.code, 'rejected');
      return true;
    });
    assert.equal(gateway.state.payments.length, 1);
  } finally {
    await gateway.close();
  }
});

test('axios: a plain x402 resource comes back as data', async () => {
  const gateway = await startGateway({ mode: 'resource' });
  try {
    const instance = axios.create();
    attachAxios(instance, createClient({ key: KEY_ONE }));
    const res = await instance.get(`${gateway.url}/premium`);
    assert.equal(res.status, 200);
    assert.equal(res.data, 'the premium thing');
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------- got

test('got: hooks present the pass and retry a 402 with it', async () => {
  const gateway = await startGateway();
  try {
    const paying = got.extend(x402Hooks(createClient({ key: KEY_ONE })));
    const res = await paying(`${gateway.url}/page`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);

    const again = await paying(`${gateway.url}/other`);
    assert.equal(again.statusCode, 200);
    assert.equal(gateway.state.payments.length, 1);
    assert.match(gateway.state.hits.at(-1).headers['x-crawl-pass'], /^cp_test1/);
  } finally {
    await gateway.close();
  }
});

test('got: a plain x402 resource is returned as the body', async () => {
  const gateway = await startGateway({ mode: 'resource' });
  try {
    const paying = got.extend(x402Hooks(createClient({ key: KEY_ONE })));
    const res = await paying(`${gateway.url}/premium`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'the premium thing');
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------- playwright

/**
 * A Playwright-shaped route and request over a real HTTP request, so the
 * adapter's handling of `route.fetch` / `route.fulfill` / `route.continue`
 * is exercised without a browser.
 */
function fakePlaywright() {
  const routes = [];
  const fulfilled = [];
  const continued = [];
  const target = {
    route: async (pattern, handler) => {
      routes.push({ pattern, handler });
    },
    unroute: async (pattern, handler) => {
      const i = routes.findIndex((r) => r.pattern === pattern && r.handler === handler);
      if (i >= 0) routes.splice(i, 1);
    },
  };
  const request = (url, { method = 'GET', resourceType = 'document', headers = {} } = {}) => ({
    url: () => url,
    method: () => method,
    resourceType: () => resourceType,
    headers: () => ({ ...headers }),
  });
  const route = (req) => ({
    fetch: async ({ headers } = {}) => {
      const res = await globalThis.fetch(req.url(), { method: req.method(), headers });
      const text = await res.text();
      return {
        status: () => res.status,
        headers: () => Object.fromEntries(res.headers),
        text: async () => text,
      };
    },
    fulfill: async (args) => {
      fulfilled.push(args);
    },
    continue: async (args) => {
      continued.push(args);
    },
  });
  const drive = async (req) => {
    for (const r of routes) await r.handler(route(req), req);
  };
  return { target, request, drive, fulfilled, continued, routes };
}

test('playwright: a routed document request pays once and is fulfilled with the page', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE });
    const fake = fakePlaywright();
    const detach = await attachPlaywright(fake.target, client);
    assert.equal(fake.routes.length, 1);

    await fake.drive(fake.request(`${gateway.url}/page`));
    assert.equal(fake.fulfilled.length, 1);
    assert.equal(fake.fulfilled[0].response.status(), 200);
    assert.equal(await fake.fulfilled[0].response.text(), '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);

    // Second document: pass presented, nothing paid.
    await fake.drive(fake.request(`${gateway.url}/other`));
    assert.equal(fake.fulfilled[1].response.status(), 200);
    assert.equal(gateway.state.payments.length, 1);

    // An image is not fetched by us; it continues with the pass on it.
    await fake.drive(fake.request(`${gateway.url}/logo.png`, { resourceType: 'image' }));
    assert.equal(fake.continued.length, 1);
    assert.match(fake.continued[0].headers['x-crawl-pass'], /^cp_test1/);

    await detach();
    assert.equal(fake.routes.length, 0);
  } finally {
    await gateway.close();
  }
});

test('playwright: a 402 the client will not pay reaches the page as the 402', async () => {
  const gateway = await startGateway();
  try {
    const fake = fakePlaywright();
    await attachPlaywright(fake.target, createClient({ key: KEY_ONE, maxUsd: 0.1 }));
    await fake.drive(fake.request(`${gateway.url}/page`));
    assert.equal(fake.fulfilled[0].response.status(), 402);
    assert.match(fake.fulfilled[0].body, /accepts/);
    assert.equal(gateway.state.payments.length, 0);
  } finally {
    await gateway.close();
  }
});

test('playwright: gotoPaid navigates, pays, presents and navigates again', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE });
    let extra = {};
    const page = {
      setExtraHTTPHeaders: async (h) => {
        extra = h;
      },
      goto: async (url) => {
        const res = await globalThis.fetch(url, { headers: extra });
        return { status: () => res.status };
      },
    };
    const res = await playwrightGoto(page, `${gateway.url}/page`, client);
    assert.equal(res.status(), 200);
    assert.equal(gateway.state.payments.length, 1);
    assert.match(extra['x-crawl-pass'], /^cp_test1/);
  } finally {
    await gateway.close();
  }
});

test('playwright: a browser navigation gets the HTML sales page, and is still paid', async () => {
  // A real browser sends Accept: text/html, and a gateway answers that with
  // its sales page rather than the JSON offer. Found with real Playwright on
  // Chrome: the first version of this adapter handed the page the 402.
  const gateway = await startGateway();
  try {
    const fake = fakePlaywright();
    await attachPlaywright(fake.target, createClient({ key: KEY_ONE }));
    await fake.drive(fake.request(`${gateway.url}/page`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } }));
    assert.equal(fake.fulfilled[0].response.status(), 200);
    assert.equal(await fake.fulfilled[0].response.text(), '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);
  } finally {
    await gateway.close();
  }
});

test('playwright: a 402 that is not x402 reaches the page as itself', async () => {
  const gateway = await startGateway({ mode: 'bare-402' });
  try {
    const fake = fakePlaywright();
    await attachPlaywright(fake.target, createClient({ key: KEY_ONE }));
    await fake.drive(fake.request(`${gateway.url}/page`));
    assert.equal(fake.fulfilled[0].response.status(), 402);
    assert.equal(fake.fulfilled[0].body, 'Payment required, but not like that.');
    assert.equal(gateway.state.payments.length, 0);
  } finally {
    await gateway.close();
  }
});

test('axios and got: a scraper wearing a browser Accept header is still paid', async () => {
  const gateway = await startGateway();
  try {
    const instance = axios.create({ headers: { accept: 'text/html,*/*;q=0.8' } });
    attachAxios(instance, createClient({ key: KEY_ONE }));
    const res = await instance.get(`${gateway.url}/page`);
    assert.equal(res.status, 200);
    assert.equal(res.data, '<h1>the site</h1>');
    assert.equal(gateway.state.payments.length, 1);

    const paying = got.extend({ headers: { accept: 'text/html,*/*;q=0.8' }, ...x402Hooks(createClient({ key: KEY_ONE })) });
    const out = await paying(`${gateway.url}/other`);
    assert.equal(out.statusCode, 200);
    assert.equal(gateway.state.payments.length, 2);
  } finally {
    await gateway.close();
  }
});

test('axios and got: a 402 that is not x402 is left alone', async () => {
  const gateway = await startGateway({ mode: 'bare-402' });
  try {
    const instance = axios.create();
    attachAxios(instance, createClient({ key: KEY_ONE }));
    await assert.rejects(instance.get(`${gateway.url}/page`), (err) => err.response?.status === 402);

    const paying = got.extend({ throwHttpErrors: false, ...x402Hooks(createClient({ key: KEY_ONE })) });
    const out = await paying(`${gateway.url}/page`);
    assert.equal(out.statusCode, 402);
    assert.equal(gateway.state.payments.length, 0);
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------- puppeteer

function fakePage() {
  let extra = {};
  const gotos = [];
  const page = {
    setExtraHTTPHeaders: async (h) => {
      extra = h;
    },
    goto: async (url, options) => {
      gotos.push({ url, options, headers: { ...extra } });
      const res = await globalThis.fetch(url, { headers: extra });
      return { status: () => res.status, text: () => res.text() };
    },
  };
  return { page, gotos, extra: () => extra };
}

test('puppeteer: gotoPaid pays on a 402 and navigates again with the pass', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE });
    const { page, gotos, extra } = fakePage();
    const res = await puppeteerGoto(page, `${gateway.url}/page`, client, { waitUntil: 'load' });
    assert.equal(res.status(), 200);
    assert.equal(gotos.length, 2, 'the refused navigation and the paid one');
    assert.deepEqual(gotos[1].options, { waitUntil: 'load' });
    assert.match(gotos[1].headers['x-crawl-pass'], /^cp_test1/);
    assert.equal(gateway.state.payments.length, 1);
    assert.equal(await applyPass(page, `${gateway.url}/x`, client), true);
    assert.match(extra()['x-crawl-pass'], /^cp_test1/);
  } finally {
    await gateway.close();
  }
});

test('puppeteer: attachX402 makes page.goto pay, and detaches cleanly', async () => {
  const gateway = await startGateway();
  try {
    const client = createClient({ key: KEY_ONE });
    const { page, gotos } = fakePage();
    const original = page.goto;
    const detach = attachPuppeteer(page, client);
    const res = await page.goto(`${gateway.url}/page`);
    assert.equal(res.status(), 200);
    assert.equal(gateway.state.payments.length, 1);
    assert.equal(gotos.length, 2);

    const second = await page.goto(`${gateway.url}/other`);
    assert.equal(second.status(), 200);
    assert.equal(gateway.state.payments.length, 1);
    assert.equal(gotos.length, 3);

    detach();
    assert.equal(page.goto, original);
  } finally {
    await gateway.close();
  }
});
