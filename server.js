'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, setting, setSetting, allSettings, tx, audit } = require('./lib/db');
const U = require('./lib/util');
const R = require('./lib/rules');
const P = require('./lib/payments');
const N = require('./lib/notify');
const { HttpError } = U;

const PUBLIC = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------- mini roteador ----------
const routes = [];
const on = (method, p, auth, fn) => routes.push({ method, auth, keys: [...p.matchAll(/:(\w+)/g)].map((m) => m[1]), re: new RegExp('^' + p.replace(/:(\w+)/g, '([^/]+)') + '$'), fn });
const parseCookies = (h) => Object.fromEntries((h || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 200_000) { reject(new HttpError(413, 'Requisição muito grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); if (!t) return resolve({}); try { resolve(JSON.parse(t)); } catch { reject(new HttpError(400, 'JSON inválido.')); } });
    req.on('error', reject);
  });
}
const send = (res, status, body, headers = {}) => {
  const isObj = typeof body === 'object' && body !== null;
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };

// ---------- sessões ----------
const SESSION_MS = 30 * 864e5;
function startSession(req, res, userId) {
  const t = U.token(); db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(t, userId, Date.now() + SESSION_MS);
  const secure = (req.headers['x-forwarded-proto'] === 'https' || (setting('base_url') || '').startsWith('https')) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}
function sessionUser(req) {
  const t = parseCookies(req.headers.cookie).sid; if (!t) return null;
  const row = db.prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t);
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  return row;
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, cpf: u.cpf, specialty: u.specialty, registry: u.registry, role: u.role, active: !!u.active, created_at: u.created_at });

// limitador simples de tentativas de login
const attempts = new Map();
function throttle(key) {
  const now = Date.now(); const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60e3);
  if (a.length >= 10) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
  a.push(now); attempts.set(key, a);
}

// ---------- validação de perfil ----------
function profileFields(b, { requireAll }) {
  const out = {};
  out.name = U.clean(b.name, 100); if (out.name.length < 3 || !out.name.includes(' ')) throw new HttpError(400, 'Informe nome e sobrenome.');
  out.email = U.clean(b.email, 160).toLowerCase(); if (!U.validEmail(out.email)) throw new HttpError(400, 'E-mail inválido.');
  out.phone = U.normPhone(b.phone); if (!out.phone) throw new HttpError(400, 'WhatsApp inválido. Use DDD + número.');
  const cpf = String(b.cpf || '').replace(/\D/g, '');
  if (requireAll || cpf) { if (!U.validCPF(cpf)) throw new HttpError(400, 'CPF inválido.'); }
  out.cpf = cpf || null;
  out.specialty = U.clean(b.specialty, 80); out.registry = U.clean(b.registry, 40);
  if (requireAll && !out.specialty) throw new HttpError(400, 'Informe sua especialidade/área de atuação.');
  return out;
}
const checkPassword = (p) => { if (typeof p !== 'string' || p.length < 8 || p.length > 100) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.'); };
function insertUser(f, password, role) {
  try {
    const r = db.prepare('INSERT INTO users(name,email,phone,cpf,specialty,registry,password_hash,role) VALUES(?,?,?,?,?,?,?,?)')
      .run(f.name, f.email, f.phone, f.cpf, f.specialty, f.registry, U.hashPassword(password), role);
    return Number(r.lastInsertRowid);
  } catch (e) { if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Este e-mail já está cadastrado.'); throw e; }
}

// ---------- informação pública ----------
function roomsList(all) { return db.prepare(`SELECT id,name,description,active FROM rooms ${all ? '' : 'WHERE active=1'} ORDER BY id`).all(); }
on('GET', '/api/public/info', 'none', () => ({
  version: VERSION, setup_needed: !db.prepare("SELECT 1 FROM users WHERE role='admin'").get(),
  space_name: setting('space_name'), hours: setting('hours'), rooms: roomsList(false),
  prices: { mod4: setting('price_mod4'), mod8: setting('price_mod8'), hour: setting('price_hour') },
  rules: { renewal_day: setting('renewal_day'), reminder_days: setting('reminder_days'), hold_minutes: setting('hold_minutes'), cancel_hours: setting('cancel_hours'), min_notice_hours: setting('min_notice_hours'), horizon_days: setting('horizon_days'), max_hours: setting('max_hours_per_booking') },
  allow_signup: !!setting('allow_signup'), renewal_day: setting('renewal_day'), simulated_payments: P.isSimulated(), today: U.todayStr(),
}));

// ---------- configuração inicial (primeiro acesso) ----------
on('POST', '/api/setup', 'none', (req, res, { body }) => {
  if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) throw new HttpError(403, 'A configuração inicial já foi concluída.');
  const f = profileFields({ ...body.admin, specialty: 'Gestão' }, { requireAll: false }); checkPassword(body.admin && body.admin.password);
  const rooms = (Array.isArray(body.rooms) ? body.rooms : []).map((r) => ({ name: U.clean(r.name, 60), description: U.clean(r.description, 200) })).filter((r) => r.name);
  if (!rooms.length) throw new HttpError(400, 'Cadastre pelo menos uma sala.');
  const money = (v, k) => { const n = Math.round(Number(v)); if (!(n > 0 && n < 10_000_000)) throw new HttpError(400, `Valor inválido: ${k}.`); return n; };
  const id = tx(() => {
    const uid = insertUser(f, body.admin.password, 'admin');
    for (const r of rooms) db.prepare('INSERT INTO rooms(name,description) VALUES(?,?)').run(r.name, r.description);
    setSetting('space_name', U.clean(body.space_name, 80) || 'Espaço Vida');
    if (body.prices) { setSetting('price_mod4', money(body.prices.mod4, 'módulo 4h')); setSetting('price_mod8', money(body.prices.mod8, 'módulo 8h')); setSetting('price_hour', money(body.prices.hour, 'hora avulsa')); }
    if (body.hours) setSetting('hours', validHours(body.hours));
    setSetting('admin_whatsapp', f.phone); setSetting('setup_done', true);
    audit(uid, 'setup', 'configuração inicial');
    return uid;
  });
  startSession(req, res, id);
  return { ok: true };
});
function validHours(h) {
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const v = h[d]; if (v == null) { out[d] = null; continue; }
    const [a, b] = v.map(Number);
    if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b <= 24 && a < b)) throw new HttpError(400, 'Horário de funcionamento inválido.');
    out[d] = [a, b];
  }
  return out;
}

// ---------- autenticação ----------
on('POST', '/api/auth/login', 'none', (req, res, { body }) => {
  const email = U.clean(body.email, 160).toLowerCase(); throttle(`${req.socket.remoteAddress}|${email}`);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !U.verifyPassword(String(body.password || ''), u.password_hash)) throw new HttpError(401, 'E-mail ou senha incorretos.');
  if (!u.active) throw new HttpError(403, 'Cadastro desativado. Fale com a administração do Espaço.');
  startSession(req, res, u.id); return { user: publicUser(u) };
});
on('POST', '/api/auth/register', 'none', (req, res, { body }) => {
  if (!setting('allow_signup')) throw new HttpError(403, 'Cadastros novos estão fechados. Fale com a administração.');
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) throw new HttpError(403, 'Sistema ainda não configurado.');
  throttle(`reg|${req.socket.remoteAddress}`);
  const f = profileFields(body, { requireAll: true }); checkPassword(body.password);
  const id = insertUser(f, body.password, 'user'); startSession(req, res, id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) };
});
on('POST', '/api/auth/logout', 'none', (req, res) => {
  const t = parseCookies(req.headers.cookie).sid; if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); return { ok: true };
});
on('GET', '/api/me', 'user', (req, res, { user }) => ({ user: publicUser(user) }));
on('PUT', '/api/me', 'user', (req, res, { user, body }) => {
  const f = profileFields({ ...body, email: user.email }, { requireAll: user.role !== 'admin' });
  if (body.new_password) {
    if (!U.verifyPassword(String(body.current_password || ''), user.password_hash)) throw new HttpError(403, 'Senha atual incorreta.');
    checkPassword(body.new_password); db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(U.hashPassword(body.new_password), user.id);
  }
  db.prepare('UPDATE users SET name=?,phone=?,cpf=?,specialty=?,registry=? WHERE id=?').run(f.name, f.phone, f.cpf, f.specialty, f.registry, user.id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) };
});

// ---------- agenda e reservas (profissional) ----------
on('GET', '/api/availability', 'user', (req, res, { user, query }) => ({ days: R.availability(query.room_id, query.from, query.to, user.id) }));
on('GET', '/api/module-options', 'user', (req, res, { user, query }) => ({ options: R.moduleOptions(Number(query.room_id), query.type, query.month, user.id) }));
const quoteOut = (q) => ({ type: q.type, amount: q.amount, title: q.title, detail: q.detail, slots: q.slots.length, room: q.room.name });
on('POST', '/api/bookings/quote', 'user', (req, res, { user, body }) => ({ quote: quoteOut(R.quote(body, user.id)) }));
on('POST', '/api/bookings', 'user', (req, res, { user, body }) => {
  const mine = db.prepare("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND status='pending'").get(user.id).n;
  if (mine >= 5) throw new HttpError(429, 'Você tem reservas aguardando pagamento. Pague ou cancele antes de criar novas.');
  return { booking: bookingOut(R.createBooking(user.id, body)) };
});
function bookingOut(b, extra = {}) {
  const room = db.prepare('SELECT name FROM rooms WHERE id=?').get(b.room_id);
  return { id: b.id, type: b.type, type_label: R.TYPE_LABEL[b.type], status: b.status, amount_cents: b.amount_cents, title: b.meta.title, detail: b.meta.detail,
    room: room && room.name, room_id: b.room_id, hold_expires_at: b.hold_expires_at, created_at: b.created_at, paid_at: b.paid_at, pay_method: b.pay_method,
    receipt_code: b.receipt_code, refund_status: b.refund_status, renew: R.renewInfo(b), slots: b.meta.slots, first_date: b.meta.slots[0] && b.meta.slots[0].date, ...extra };
}
function ownBooking(user, id) {
  R.purgeExpired(); const b = R.getBooking(Number(id));
  if (!b || (b.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Reserva não encontrada.');
  return b;
}
on('GET', '/api/bookings', 'user', (req, res, { user }) => {
  R.purgeExpired();
  const rows = db.prepare("SELECT * FROM bookings WHERE user_id=? AND type!='bloqueio' ORDER BY id DESC LIMIT 200").all(user.id).map(R.parseBooking);
  return { bookings: rows.map((b) => bookingOut(b)) };
});
on('POST', '/api/bookings/:id/renew', 'user', (req, res, { user, params }) => {
  const mine = db.prepare("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND status='pending'").get(user.id).n;
  if (mine >= 5) throw new HttpError(429, 'Você tem reservas aguardando pagamento. Pague ou cancele antes de criar novas.');
  return { booking: bookingOut(R.renewBooking(user.id, Number(params.id))) };
});
on('GET', '/api/bookings/:id', 'user', (req, res, { user, params }) => ({ booking: bookingOut(ownBooking(user, params.id)) }));
on('POST', '/api/bookings/:id/pay', 'user', async (req, res, { user, params, body }) => {
  const b = ownBooking(user, params.id); const method = body.method;
  if (!['pix', 'card'].includes(method)) throw new HttpError(400, 'Escolha Pix ou cartão.');
  if (b.status !== 'pending') throw new HttpError(409, b.status === 'paid' ? 'Esta reserva já foi paga.' : 'Esta reserva expirou. Faça um novo agendamento.');
  if (b.user_id !== user.id) throw new HttpError(403, 'Apenas o titular da reserva pode pagar.');
  const owner = db.prepare('SELECT * FROM users WHERE id=?').get(b.user_id);
  const charge = await P.createCharge(b, owner, method, req);
  if (charge.provider_ref) db.prepare('UPDATE bookings SET provider_ref=?, pay_method=? WHERE id=?').run(charge.provider_ref, method, b.id);
  else db.prepare('UPDATE bookings SET pay_method=? WHERE id=?').run(method, b.id);
  return { charge };
});
async function finishPayment(id, opts, req) {
  const r = R.confirmPayment(id, opts);
  if (r.conflict) { await N.sendAdminAlert(id, `⚠️ Pagamento recebido para a reserva #${id}, mas os horários já foram ocupados. É preciso reembolsar o cliente. Veja em Reservas > Reembolsos.`); return r; }
  if (!r.already) await N.sendReceipts(id, P.baseUrl(req));
  return r;
}
// Somente no modo simulado: confirma pagamento sem cobrar (para testar o fluxo)
on('POST', '/api/bookings/:id/simulate-pay', 'user', async (req, res, { user, params, body }) => {
  if (!P.isSimulated()) throw new HttpError(403, 'Disponível apenas no modo de teste.');
  const b = ownBooking(user, params.id); const r = await finishPayment(b.id, { method: body.method === 'card' ? 'card' : 'pix', ref: 'SIM-' + Date.now(), by: user.id }, req);
  return { booking: bookingOut(R.getBooking(b.id)), conflict: !!r.conflict };
});
on('POST', '/api/bookings/:id/cancel', 'user', (req, res, { user, params, body }) => {
  const b = ownBooking(user, params.id); if (b.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Sem permissão.');
  const out = R.cancelBooking(b.id, { by: user.id, reason: body.reason, byAdmin: user.role === 'admin' });
  if (out.refund_status === 'solicitado') N.sendAdminAlert(out.id, `↩️ Cancelamento com reembolso a fazer: reserva #${out.id} de ${user.name} — ${U.money(out.amount_cents)} (${out.meta.title}).`).catch(() => {});
  return { booking: bookingOut(out) };
});

// ---------- webhook Mercado Pago ----------
on('POST', '/api/webhooks/mercadopago', 'none', async (req, res, { body, query }) => {
  const id = (body.data && body.data.id) || query['data.id'] || query.id; const type = body.type || body.topic || query.type || query.topic;
  if (!id || (type && !String(type).includes('payment'))) return { ok: true };
  try {
    const v = await P.verifyMpPayment(id);
    if (v.approved && v.bookingId) {
      const b = R.getBooking(v.bookingId);
      if (b && Math.abs(b.amount_cents - Math.round(v.amount * 100)) <= 1) await finishPayment(b.id, { method: v.method, ref: v.ref }, req);
      else console.error('Webhook: valor divergente para reserva', v.bookingId);
    }
  } catch (e) { console.error('Webhook erro:', e.message); throw new HttpError(500, 'erro'); } // MP tentará novamente
  return { ok: true };
});

// ---------- comprovante público ----------
on('GET', '/r/:code', 'none', (req, res, { params }) => {
  const html = N.receiptHtml(String(params.code).toUpperCase()); if (!html) return [404, 'Comprovante não encontrado.'];
  return html;
});

// ================== GESTOR ==================
const SECRET_KEYS = ['mp_access_token', 'wa_token', 'telegram_token'];
on('GET', '/api/admin/settings', 'admin', () => {
  const s = allSettings(); for (const k of SECRET_KEYS) { s['has_' + k] = !!s[k]; s[k] = ''; } delete s.setup_done; return { settings: s, rooms: roomsList(true) };
});
on('PUT', '/api/admin/settings', 'admin', (req, res, { user, body }) => {
  const n = (v, min, max, label) => { const x = Math.round(Number(v)); if (!(x >= min && x <= max)) throw new HttpError(400, `Valor inválido: ${label}.`); return x; };
  tx(() => {
    if ('space_name' in body) setSetting('space_name', U.clean(body.space_name, 80) || 'Espaço Vida');
    if ('hours' in body) setSetting('hours', validHours(body.hours));
    if ('price_mod4' in body) setSetting('price_mod4', n(body.price_mod4, 100, 10_000_000, 'módulo 4h'));
    if ('price_mod8' in body) setSetting('price_mod8', n(body.price_mod8, 100, 10_000_000, 'módulo 8h'));
    if ('price_hour' in body) setSetting('price_hour', n(body.price_hour, 100, 10_000_000, 'hora avulsa'));
    if ('hold_minutes' in body) setSetting('hold_minutes', n(body.hold_minutes, 5, 120, 'prazo de pagamento'));
    if ('min_notice_hours' in body) setSetting('min_notice_hours', n(body.min_notice_hours, 0, 168, 'antecedência'));
    if ('cancel_hours' in body) setSetting('cancel_hours', n(body.cancel_hours, 0, 720, 'prazo de cancelamento'));
    if ('horizon_days' in body) setSetting('horizon_days', n(body.horizon_days, 7, 365, 'dias à frente'));
    if ('max_hours_per_booking' in body) setSetting('max_hours_per_booking', n(body.max_hours_per_booking, 1, 40, 'máx. horas'));
    if ('renewal_day' in body) setSetting('renewal_day', n(body.renewal_day, 1, 28, 'dia limite de renovação'));
    if ('reminder_days' in body) setSetting('reminder_days', n(body.reminder_days, 0, 20, 'dias de lembrete'));
    if ('telegram_chat_id' in body) setSetting('telegram_chat_id', U.clean(body.telegram_chat_id, 40));
    if ('allow_signup' in body) setSetting('allow_signup', !!body.allow_signup);
    if ('admin_whatsapp' in body) { const p = body.admin_whatsapp ? U.normPhone(body.admin_whatsapp) : ''; if (body.admin_whatsapp && !p) throw new HttpError(400, 'WhatsApp da administração inválido.'); setSetting('admin_whatsapp', p || ''); }
    if ('base_url' in body) { const u = U.clean(body.base_url, 200).replace(/\/+$/, ''); if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw new HttpError(400, 'Endereço (URL) inválido.'); setSetting('base_url', u); }
    if ('payment_provider' in body) { if (!['simulado', 'mercadopago'].includes(body.payment_provider)) throw new HttpError(400, 'Provedor inválido.'); setSetting('payment_provider', body.payment_provider); }
    if ('wa_provider' in body) { if (!['log', 'cloud'].includes(body.wa_provider)) throw new HttpError(400, 'Provedor de WhatsApp inválido.'); setSetting('wa_provider', body.wa_provider); }
    for (const k of ['wa_phone_id', 'wa_template', 'wa_template_lang']) if (k in body) setSetting(k, U.clean(body[k], 100));
    for (const k of SECRET_KEYS) if (body[k]) setSetting(k, U.clean(body[k], 400));
    if (setting('payment_provider') === 'mercadopago' && !setting('mp_access_token')) throw new HttpError(400, 'Informe o Access Token do Mercado Pago para ativar a cobrança real.');
    audit(user.id, 'settings', Object.keys(body).filter((k) => !SECRET_KEYS.includes(k)).join(','));
  });
  return { ok: true };
});
on('POST', '/api/admin/rooms', 'admin', (req, res, { user, body }) => {
  const name = U.clean(body.name, 60); if (!name) throw new HttpError(400, 'Informe o nome da sala.');
  const r = db.prepare('INSERT INTO rooms(name,description) VALUES(?,?)').run(name, U.clean(body.description, 200)); audit(user.id, 'room_new', name); return { id: Number(r.lastInsertRowid) };
});
on('PUT', '/api/admin/rooms/:id', 'admin', (req, res, { user, params, body }) => {
  const id = Number(params.id); const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(id); if (!room) throw new HttpError(404, 'Sala não encontrada.');
  const active = body.active === undefined ? room.active : body.active ? 1 : 0;
  if (!active && room.active) {
    const fut = db.prepare("SELECT COUNT(*) n FROM slots s JOIN bookings b ON b.id=s.booking_id WHERE s.room_id=? AND s.date>=? AND b.status='paid'").get(id, U.todayStr()).n;
    if (fut) throw new HttpError(409, `Há ${fut} horários pagos futuros nesta sala. Cancele-os antes de desativar.`);
  }
  db.prepare('UPDATE rooms SET name=?,description=?,active=? WHERE id=?').run(U.clean(body.name, 60) || room.name, body.description === undefined ? room.description : U.clean(body.description, 200), active, id);
  audit(user.id, 'room_edit', id); return { ok: true };
});
on('GET', '/api/admin/users', 'admin', () => {
  const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id AND b.status='paid') paid_count,
    (SELECT COALESCE(SUM(amount_cents),0) FROM bookings b WHERE b.user_id=u.id AND b.status='paid') paid_total FROM users u ORDER BY u.role, u.name`).all();
  return { users: rows.map((u) => ({ ...publicUser(u), paid_count: u.paid_count, paid_total: u.paid_total })) };
});
on('POST', '/api/admin/users', 'admin', (req, res, { user, body }) => {
  const f = profileFields(body, { requireAll: false }); checkPassword(body.password);
  const role = body.role === 'admin' ? 'admin' : 'user'; const id = insertUser(f, body.password, role); audit(user.id, 'user_new', `${f.email} (${role})`); return { id };
});
on('PUT', '/api/admin/users/:id', 'admin', (req, res, { user, params, body }) => {
  const id = Number(params.id); const t = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!t) throw new HttpError(404, 'Usuário não encontrado.');
  const f = profileFields({ ...body, email: body.email || t.email }, { requireAll: false });
  const role = body.role === 'admin' ? 'admin' : 'user'; const active = body.active === false ? 0 : 1;
  if (id === user.id && (role !== 'admin' || !active)) throw new HttpError(400, 'Você não pode remover seu próprio acesso de gestor.');
  try { db.prepare('UPDATE users SET name=?,email=?,phone=?,cpf=?,specialty=?,registry=?,role=?,active=? WHERE id=?').run(f.name, f.email, f.phone, f.cpf, f.specialty, f.registry, role, active, id); }
  catch (e) { if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Este e-mail já está em uso.'); throw e; }
  if (body.password) { checkPassword(body.password); db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(U.hashPassword(body.password), id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(user.id, 'user_edit', id); return { ok: true };
});
function adminBookingOut(b) {
  const u = db.prepare('SELECT name,phone,specialty FROM users WHERE id=?').get(b.user_id);
  return bookingOut(b, { user_id: b.user_id, user_name: u.name, user_phone: u.phone, user_specialty: u.specialty, meta_block_reason: b.meta.reason });
}
on('GET', '/api/admin/bookings', 'admin', (req, res, { query }) => {
  R.purgeExpired(); const where = []; const args = [];
  if (query.status) { where.push('status=?'); args.push(query.status); }
  if (query.user_id) { where.push('user_id=?'); args.push(Number(query.user_id)); }
  if (query.type) { where.push('type=?'); args.push(query.type); }
  if (query.month && U.isMonth(query.month)) { where.push("substr(COALESCE(paid_at,created_at),1,7)=?"); args.push(query.month); }
  const rows = db.prepare(`SELECT * FROM bookings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).all(...args).map(R.parseBooking);
  return { bookings: rows.map(adminBookingOut) };
});
on('POST', '/api/admin/bookings/:id/confirm', 'admin', async (req, res, { user, params }) => {
  const b = R.getBooking(Number(params.id)); if (!b) throw new HttpError(404, 'Reserva não encontrada.');
  if (!['pending', 'expired'].includes(b.status)) throw new HttpError(409, 'Só é possível confirmar reservas pendentes ou expiradas.');
  const r = await finishPayment(b.id, { method: 'manual', ref: 'ADM-' + user.id, by: user.id }, req);
  if (r.conflict) throw new HttpError(409, 'Os horários já foram ocupados por outra reserva.');
  return { booking: adminBookingOut(R.getBooking(b.id)) };
});
on('POST', '/api/admin/bookings/:id/refund-done', 'admin', (req, res, { user, params }) => {
  const b = R.getBooking(Number(params.id)); if (!b || !(b.refund_status === 'solicitado' || b.status === 'refund_needed')) throw new HttpError(409, 'Não há reembolso pendente nesta reserva.');
  db.prepare("UPDATE bookings SET refund_status='concluido', status=CASE WHEN status='refund_needed' THEN 'cancelled' ELSE status END, cancelled_at=COALESCE(cancelled_at,datetime('now')) WHERE id=?").run(b.id);
  audit(user.id, 'refund_done', b.id); return { ok: true };
});
on('POST', '/api/admin/blocks', 'admin', (req, res, { user, body }) => {
  R.purgeExpired(); const room = R.roomOrThrow(body.room_id); const date = body.date; const hours = (Array.isArray(body.hours) ? body.hours : []).map(Number);
  if (!U.isDate(date) || !hours.length) throw new HttpError(400, 'Escolha a data e os horários a bloquear.');
  for (const h of hours) if (!R.hoursOf(date) || h < R.hoursOf(date)[0] || h >= R.hoursOf(date)[1]) throw new HttpError(400, 'Horário fora do funcionamento.');
  const id = tx(() => {
    const r = db.prepare("INSERT INTO bookings(user_id,room_id,type,amount_cents,status,meta) VALUES(?,?,'bloqueio',0,'paid',?)").run(user.id, room.id, JSON.stringify({ title: 'Bloqueio', detail: U.clean(body.reason, 100) || 'Horário bloqueado', reason: U.clean(body.reason, 100), slots: hours.map((h) => ({ date, hour: h })) }));
    try { for (const h of hours) db.prepare('INSERT INTO slots(booking_id,room_id,date,hour) VALUES(?,?,?,?)').run(Number(r.lastInsertRowid), room.id, date, h); }
    catch (e) { if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Algum desses horários já está ocupado. Cancele a reserva antes.'); throw e; }
    return Number(r.lastInsertRowid);
  });
  audit(user.id, 'block', `${date} ${hours.join(',')}`); return { id };
});
on('GET', '/api/admin/agenda', 'admin', (req, res, { query }) => {
  R.purgeExpired(); const date = query.date; if (!U.isDate(date)) throw new HttpError(400, 'Data inválida.');
  const rows = db.prepare(`SELECT s.room_id, s.hour, b.id booking_id, b.type, b.status, u.name user_name, u.specialty, b.meta
    FROM slots s JOIN bookings b ON b.id=s.booking_id JOIN users u ON u.id=b.user_id WHERE s.date=?`).all(date);
  return { date, open: R.hoursOf(date), rooms: roomsList(false), slots: rows.map((r) => ({ ...r, meta: undefined, title: JSON.parse(r.meta).title })) };
});
on('GET', '/api/admin/dashboard', 'admin', () => {
  R.purgeExpired(); const month = U.todayStr().slice(0, 7);
  const rev = db.prepare("SELECT COALESCE(SUM(amount_cents),0) t, COUNT(*) n FROM bookings WHERE status='paid' AND type!='bloqueio' AND substr(paid_at,1,7)=?").get(month);
  const byType = db.prepare("SELECT type, COUNT(*) n, COALESCE(SUM(amount_cents),0) t FROM bookings WHERE status='paid' AND type!='bloqueio' AND substr(paid_at,1,7)=? GROUP BY type").all(month);
  const q = (sql, ...a) => db.prepare(sql).get(...a).n;
  const today = db.prepare(`SELECT s.room_id, s.hour, u.name user_name, b.type, r.name room FROM slots s JOIN bookings b ON b.id=s.booking_id JOIN users u ON u.id=b.user_id JOIN rooms r ON r.id=s.room_id WHERE s.date=? AND b.status='paid' ORDER BY s.hour, r.name`).all(U.todayStr());
  const capacity = Array.from({ length: 7 }, (_, i) => U.addDays(U.todayStr(), i)).map((d) => ({ date: d, used: db.prepare('SELECT COUNT(*) n FROM slots WHERE date=?').get(d).n, total: (R.hoursOf(d) ? R.hoursOf(d)[1] - R.hoursOf(d)[0] : 0) * roomsList(false).length }));
  return { month, revenue: rev.t, paid: rev.n, byType,
    pending: q("SELECT COUNT(*) n FROM bookings WHERE status='pending'"), refunds: q("SELECT COUNT(*) n FROM bookings WHERE refund_status='solicitado' OR status='refund_needed'"),
    users: q("SELECT COUNT(*) n FROM users WHERE role='user' AND active=1"), failed_msgs: q("SELECT COUNT(*) n FROM notifications WHERE status='failed'"),
    renewals_pending: (() => { const r = R.renewalsList(); return r.day >= r.reminder_from ? r.pending_count : 0; })(), telegram: N.telegramOn(),
    capacity, simulated_payments: P.isSimulated(), wa_mode: setting('wa_provider'), admin_whatsapp: setting('admin_whatsapp') };
});
on('GET', '/api/admin/renewals', 'admin', (req) => {
  const r = R.renewalsList(); const link = P.baseUrl(req) + '/'; const nm = U.monthLabel(r.next); const dl = `${U.pad(r.renewal_day)}/${r.cur.slice(5)}`;
  r.items = r.items.map((i) => ({ ...i, message: r.priority_open
    ? `Olá, ${i.user_name.split(' ')[0]}! Aqui é do ${setting('space_name')}. Seu módulo (${i.title}) vai até o fim do mês. Para garantir o mesmo horário em ${nm}, renove até ${dl} pelo aplicativo (botão "Renovar" em Minhas reservas): ${link} Depois dessa data o horário é liberado para outros profissionais.`
    : `Olá, ${i.user_name.split(' ')[0]}! Aqui é do ${setting('space_name')}. O prazo de prioridade para renovar seu módulo (${i.title}) já passou (${dl}). Se quiser manter o horário em ${nm}, renove o quanto antes pelo aplicativo, antes que outro profissional reserve: ${link}` }));
  return r;
});
on('GET', '/api/admin/upcoming', 'admin', (req, res, { query }) => {
  R.purgeExpired(); const days = Math.min(60, Math.max(1, Number(query.days) || 14)); const from = U.todayStr(); const to = U.addDays(from, days - 1);
  const rows = db.prepare(`SELECT s.date, s.hour, s.room_id, b.id booking_id, b.type, b.meta, u.name user_name, u.specialty, u.phone, r.name room
    FROM slots s JOIN bookings b ON b.id=s.booking_id JOIN users u ON u.id=b.user_id JOIN rooms r ON r.id=s.room_id
    WHERE s.date>=? AND s.date<=? AND b.status='paid' AND b.type!='bloqueio' ORDER BY s.date, s.hour, r.name`).all(from, to);
  const byKey = new Map();
  for (const r of rows) { const k = `${r.date}|${r.booking_id}`; if (!byKey.has(k)) byKey.set(k, { ...r, hours: [] }); byKey.get(k).hours.push(r.hour); }
  const out = {};
  for (const g of byKey.values()) {
    const hs = g.hours.sort((a, b) => a - b); let start = hs[0]; let prev = hs[0]; const runs = [];
    for (const h of hs.slice(1)) { if (h !== prev + 1) { runs.push([start, prev + 1]); start = h; } prev = h; } runs.push([start, prev + 1]);
    for (const [s, e] of runs) (out[g.date] ||= []).push({ start: s, end: e, room: g.room, user_name: g.user_name, specialty: g.specialty, phone: g.phone, type: g.type, title: JSON.parse(g.meta).title, booking_id: g.booking_id });
  }
  return { days: Object.keys(out).sort().map((d) => ({ date: d, items: out[d].sort((a, b) => a.start - b.start || a.room.localeCompare(b.room)) })), from, to };
});
on('POST', '/api/admin/telegram-test', 'admin', async () => {
  try { await N.sendTelegram('✅ Espaço Vida: o aviso no Telegram está funcionando! Você receberá uma mensagem a cada nova reserva paga.'); }
  catch (e) { throw new HttpError(400, 'Não foi possível enviar: ' + e.message); }
  return { ok: true };
});
on('GET', '/api/admin/notifications', 'admin', () => ({
  notifications: db.prepare(`SELECT n.*, b.receipt_code, u.name user_name FROM notifications n LEFT JOIN bookings b ON b.id=n.booking_id LEFT JOIN users u ON u.id=b.user_id ORDER BY n.id DESC LIMIT 200`).all(),
}));
on('POST', '/api/admin/notifications/:id/resend', 'admin', async (req, res, { params }) => { await N.deliver(Number(params.id)); return { ok: true }; });
on('GET', '/api/admin/share', 'admin', (req) => {
  const link = P.baseUrl(req) + '/'; const name = setting('space_name');
  return { link, message: `Olá! 👋 Aqui é do ${name}. Para reservar uma sala por hora ou em módulos, acesse nosso agendamento online, crie seu perfil e pague por Pix ou cartão. O comprovante chega no seu WhatsApp:\n${link}` };
});

// ---------- servidor HTTP ----------
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname; rel = path.normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=86400', ...SEC });
  fs.createReadStream(file).pipe(res);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const pathname = url.pathname; const query = Object.fromEntries(url.searchParams);
  try {
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/r/')) { if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.'); return serveStatic(req, res, pathname); }
    const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
    if (!route) throw new HttpError(404, 'Rota não encontrada.');
    const m = route.re.exec(pathname); const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let user = null;
    if (route.auth !== 'none') {
      user = sessionUser(req); if (!user) throw new HttpError(401, 'Faça login para continuar.');
      if (route.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Acesso restrito à gestão.');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    let out = await route.fn(req, res, { user, params, query, body });
    for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
    if (Array.isArray(out)) return send(res, out[0], out[1]);
    send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Erro interno. Tente novamente.' });
  }
});
// limpeza periódica de reservas vencidas e sessões velhas
setInterval(() => { try { R.purgeExpired(); db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now()); } catch (e) { console.error(e); } }, 60e3).unref();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Espaço Vida – agenda rodando em http://localhost:${port}`));
}
module.exports = { server };
