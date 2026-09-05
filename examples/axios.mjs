/**
 * axios through a paid site.
 *
 *   npm i axios @profullstack/x402-client
 *   X402_PRIVATE_KEY=0x… node examples/axios.mjs https://site/page
 */

import axios from 'axios';

import { createClient } from '@profullstack/x402-client';
import { attachX402 } from '@profullstack/x402-client/axios';

const [url = 'https://rssamplifier.com/'] = process.argv.slice(2);

const http = axios.create({ headers: { 'user-agent': 'MyAgent/1.0 (+https://example.test/bot)' } });
attachX402(http, createClient({ key: process.env.X402_PRIVATE_KEY, store: 'file', maxUsd: 2 }));

const res = await http.get(url);
console.log(res.status, String(res.data).slice(0, 500));
