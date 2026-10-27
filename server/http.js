'use strict';
// Mini-framework HTTP (sem dependências): rotas, JSON, cookies, arquivos estáticos, cabeçalhos de segurança.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
};

/** Resposta "crua" (HTML, CSV, etc.) devolvida por um handler. */
const raw = (status, type, body, headers = {}) => ({ __raw: true, status, type, body, headers });

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
}

function createApp({ publicDir, trustProxy = true }) {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => routes.push({ method, ...compile(pattern), handlers });
  const app = { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw new HttpError(413, 'Requisição grande demais.');
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'JSON inválido.'); }
  }

  function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...headers });
    res.end(body);
  }
  const sendJson = (res, status, data, headers) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data), { 'Cache-Control': 'no-store', ...headers });

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return sendJson(res, 403, { error: 'Acesso negado.' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendJson(res, 404, { error: 'Não encontrado.' });
      const ext = path.extname(file);
      const cache = ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache';
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
      fs.createReadStream(file).pipe(res);
    });
  }

  app.server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const pathname = url.pathname;
      const fwd = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
      const ctx = {
        req, res, url, query: Object.fromEntries(url.searchParams), params: {}, body: {},
        ip: fwd || req.socket.remoteAddress || '', cookies: parseCookies(req.headers.cookie), user: null, setCookies: [],
      };

      const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!route) {
        if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
        return sendJson(res, 404, { error: 'Rota não encontrada.' });
      }
      const m = route.re.exec(pathname);
      route.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });

      if (req.method !== 'GET') {
        const ct = String(req.headers['content-type'] || '');
        if (req.headers['content-length'] !== '0' && ct && !ct.includes('application/json')) throw new HttpError(415, 'Use application/json.');
        ctx.body = await readBody(req);
      }

      let result;
      for (const h of route.handlers) {
        result = await h(ctx);
        if (result !== undefined) break; // middlewares retornam undefined para seguir
      }
      const extra = ctx.setCookies.length ? { 'Set-Cookie': ctx.setCookies } : {};
      if (result && result.__raw) return send(res, result.status, result.type, result.body, { ...result.headers, ...extra });
      return sendJson(res, 200, result ?? { ok: true }, extra);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error('Erro inesperado:', e);
      return sendJson(res, 500, { error: 'Erro interno. Tente novamente em instantes.' });
    }
  });

  return app;
}

module.exports = { createApp, raw };
