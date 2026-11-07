// Isai podcast relay: a tiny Cloudflare Worker that fetches public podcast feeds
// and audio for the Isai app when a host blocks direct access from browsers.
// Only allows requests from your Isai site, and only http(s) GETs.
const ALLOWED_ORIGINS = ['https://capsaarang.github.io'];

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403, headers: cors });
    const target = new URL(req.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return new Response('Missing url', { status: 400, headers: cors });
    const upstream = await fetch(target, { headers: { 'User-Agent': 'Isai-Relay/1.0' }, redirect: 'follow' });
    const headers = new Headers(cors);
    for (const h of ['Content-Type', 'Content-Length', 'Last-Modified', 'ETag']) {
      const v = upstream.headers.get(h); if (v) headers.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
