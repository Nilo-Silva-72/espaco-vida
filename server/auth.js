'use strict';
// Autenticação: senhas com scrypt, sessões em cookie HttpOnly, limite de tentativas.
const crypto = require('node:crypto');
const { db, audit } = require('./db');
const { HttpError, bad, forbidden, normalizePhone, isoNow } = require('./util');

const COOKIE = 'ev_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw bad('A senha deve ter pelo menos 8 caracteres.');
  if (p.length > 200) throw bad('Senha muito longa.');
}

function secureCookies() {
  return (process.env.BASE_URL || '').startsWith('https://') || process.env.NODE_ENV === 'production';
}
function cookieString(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookies() ? '; Secure' : ''}`;
}

function startSession(ctx, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
  ctx.setCookies.push(cookieString(token, SESSION_DAYS * 86400));
}
function endSession(ctx) {
  const token = ctx.cookies[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  ctx.setCookies.push(cookieString('', 0));
}

/** Preenche ctx.user se houver sessão válida (não bloqueia). */
function loadUser(ctx) {
  const token = ctx.cookies[COOKIE];
  if (!token) return;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(sha(token), isoNow());
  if (row && row.status === 'active') ctx.user = row;
}
function requireAuth(ctx) {
  loadUser(ctx);
  if (!ctx.user) throw new HttpError(401, 'Faça login para continuar.');
}
function requireAdmin(ctx) {
  requireAuth(ctx);
  if (ctx.user.role !== 'admin') throw forbidden('Apenas o gestor pode acessar esta área.');
}

// Limite simples de tentativas (memória do processo)
const attempts = new Map();
function throttle(key, max = 10, windowMs = 15 * 60000) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  rec.n += 1;
  attempts.set(key, rec);
  if (rec.n > max) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (now > v.reset) attempts.delete(k); }, 10 * 60000).unref();

function cleanProfile(b, { requirePhone = true } = {}) {
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  if (name.length < 3) throw bad('Informe o nome completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('E-mail inválido.');
  const phone = normalizePhone(b.phone);
  if (requirePhone && !phone) throw bad('Informe um WhatsApp válido com DDD (ex.: 21 99999-9999).');
  const document = String(b.document || '').replace(/\D/g, '');
  if (document && document.length !== 11) throw bad('CPF deve ter 11 dígitos (ou deixe em branco).');
  return {
    name: name.slice(0, 120), email, phone,
    specialty: String(b.specialty || '').trim().slice(0, 80) || null,
    registry: String(b.registry || '').trim().slice(0, 40) || null,
    document: document || null,
  };
}

function createUser(profile, password, role = 'user', status = 'active') {
  validatePassword(password);
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(profile.email);
  if (exists) throw new HttpError(409, 'Já existe um cadastro com este e-mail.');
  const r = db.prepare(
    `INSERT INTO users (name,email,phone,specialty,registry,document,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(profile.name, profile.email, profile.phone, profile.specialty, profile.registry, profile.document, hashPassword(password), role, status, isoNow());
  audit(null, 'user.create', `${profile.email} (${role})`);
  return Number(r.lastInsertRowid);
}

const publicUser = (u) => u && ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, specialty: u.specialty, registry: u.registry,
  document: u.document, role: u.role, status: u.status, notes: u.notes ?? null, created_at: u.created_at,
});

module.exports = {
  hashPassword, verifyPassword, validatePassword, startSession, endSession, loadUser, requireAuth, requireAdmin,
  throttle, cleanProfile, createUser, publicUser,
};
