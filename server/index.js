'use strict';
// Espaço Vida — servidor da agenda de sublocação.
const path = require('node:path');
const { db, tx, getSettings, setSettings, audit } = require('./db');
const U = require('./util');
const A = require('./auth');
const B = require('./bookings');
const P = require('./payments');
const wa = require('./whatsapp');
const { renderReceipt } = require('./receipts');
const { createApp, raw } = require('./http');

const { bad, notFound, forbidden, conflict, HttpError } = U;
const app = createApp({ publicDir: path.join(__dirname, '..', 'public') });
const { requireAuth, requireAdmin } = A;
const setupDone = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;

// ---------- validações de configuração ----------
function cleanSettings(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('business_name')) {
    const n = String(b.business_name || '').trim();
    if (n.length < 2 || n.length > 80) throw bad('Informe o nome do Espaço (2 a 80 caracteres).');
    out.business_name = n;
  }
  if (!partial || has('admin_whatsapp')) {
    const raw_ = String(b.admin_whatsapp || '').trim();
    if (!raw_) { if (!partial) throw bad('Informe o WhatsApp da administração.'); out.admin_whatsapp = ''; }
    else {
      const p = U.normalizePhone(raw_);
      if (!p) throw bad('WhatsApp da administração inválido (use DDD + número).');
      out.admin_whatsapp = p;
    }
  }
  if (!partial || has('hours')) {
    const hours = {};
    for (let d = 0; d <= 6; d++) {
      const v = b.hours?.[d];
      if (v === null || v === undefined) { hours[d] = null; continue; }
      const [o, c] = v.map(Number);
      if (!Number.isInteger(o) || !Number.isInteger(c) || o < 0 || c > 24 || o >= c) throw bad(`Horário de ${U.WEEKDAYS[d]} inválido.`);
      hours[d] = [o, c];
    }
    if (Object.values(hours).every((v) => v === null)) throw bad('Defina pelo menos um dia de funcionamento.');
    out.hours = hours;
  }
  for (const k of ['price_hour_cents', 'price_module4_cents', 'price_module8_cents']) {
    if (!partial || has(k)) {
      const v = Number(b[k]);
      if (!Number.isInteger(v) || v < 0 || v > 10_000_000) throw bad('Valor inválido.');
      out[k] = v;
    }
  }
  if (!partial || has('hold_minutes')) {
    const v = Number(b.hold_minutes ?? 20);
    if (!Number.isInteger(v) || v < 5 || v > 120) throw bad('Prazo de pagamento deve ficar entre 5 e 120 minutos.');
    out.hold_minutes = v;
  }
  if (!partial || has('max_advance_days')) {
    const v = Number(b.max_advance_days ?? 60);
    if (!Number.isInteger(v) || v < 1 || v > 365) throw bad('Antecedência máxima deve ficar entre 1 e 365 dias.');
    out.max_advance_days = v;
  }
  if (!partial || has('require_approval')) out.require_approval = !!b.require_approval;
  if (!partial || has('methods')) {
    const m = { pix: !!b.methods?.pix, card: !!b.methods?.card };
    if (!m.pix && !m.card) throw bad('Habilite pelo menos uma forma de pagamento.');
    out.methods = m;
  }
  if (has('invite_message')) out.invite_message = String(b.invite_message || '').slice(0, 1000);
  return out;
}

function cleanRoom(b) {
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 60) throw bad('Informe o nome da sala (2 a 60 caracteres).');
  return { name, description: String(b.description || '').trim().slice(0, 200) || null };
}

const publicRooms = () => db.prepare('SELECT id, name, description FROM rooms WHERE active = 1 ORDER BY id').all();

// ---------- estado inicial / setup ----------
app.get('/api/state', (ctx) => {
  A.loadUser(ctx);
  if (!setupDone()) return { setup_done: false, defaults: getSettings() };
  const s = getSettings();
  const out = {
    setup_done: true,
    business_name: s.business_name,
    user: A.publicUser(ctx.user),
    settings: {
      hours: s.hours, price_hour_cents: s.price_hour_cents, price_module4_cents: s.price_module4_cents,
      price_module8_cents: s.price_module8_cents, hold_minutes: s.hold_minutes, max_advance_days: s.max_advance_days,
      methods: s.methods, require_approval: s.require_approval,
    },
    rooms: publicRooms(),
    payment: { demo: P.status().demo },
    today: U.nowLocal().date,
    base_url: B.baseUrl(),
  };
  if (ctx.user?.role === 'admin') {
    out.admin = {
      admin_whatsapp: s.admin_whatsapp, invite_message: s.invite_message,
      whatsapp: wa.status(), payment: P.status(), all_rooms: db.prepare('SELECT * FROM rooms ORDER BY id').all(),
    };
  }
  return out;
});

app.post('/api/setup', (ctx) => {
  if (setupDone()) throw forbidden('A configuração inicial já foi concluída.');
  A.throttle(`setup:${ctx.ip}`, 10);
  const b = ctx.body;
  const settings = cleanSettings(b.settings || {});
  const profile = A.cleanProfile(b.admin || {});
  const rooms = (Array.isArray(b.rooms) ? b.rooms : []).map(cleanRoom);
  if (!rooms.length) throw bad('Cadastre pelo menos uma sala.');
  const userId = tx(() => {
    const id = A.createUser(profile, b.admin?.password, 'admin');
    setSettings({ ...settings, setup_done: true });
    const ins = db.prepare('INSERT INTO rooms (name, description) VALUES (?, ?)');
    for (const r of rooms) ins.run(r.name, r.description);
    return id;
  });
  A.startSession(ctx, userId);
  audit(userId, 'setup', 'Configuração inicial concluída');
  return { ok: true };
});

// ---------- autenticação ----------
const DUMMY_HASH = A.hashPassword('dummy-password-for-timing');
app.post('/api/login', (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  A.throttle(`login:${ctx.ip}:${email}`, 8);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = A.verifyPassword(String(ctx.body.password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
  if (u.status === 'pending') throw forbidden('Seu cadastro está aguardando aprovação da administração.');
  if (u.status === 'blocked') throw forbidden('Seu acesso está bloqueado. Fale com a administração.');
  A.startSession(ctx, u.id);
  return { user: A.publicUser(u) };
});

app.post('/api/register', (ctx) => {
  if (!setupDone()) throw forbidden('O sistema ainda não foi configurado.');
  A.throttle(`register:${ctx.ip}`, 10);
  const s = getSettings();
  const profile = A.cleanProfile(ctx.body);
  const status = s.require_approval ? 'pending' : 'active';
  const id = A.createUser(profile, ctx.body.password, 'user', status);
  if (status === 'pending') {
    wa.enqueue({
      to: U.normalizePhone(s.admin_whatsapp), label: 'Administração', kind: 'admin',
      body: `👤 *Novo cadastro aguardando aprovação — ${s.business_name}*\n${profile.name} · ${profile.specialty || 'sem especialidade'}\n📱 ${B.fmtPhone(profile.phone)}\nAprove no painel (Profissionais).`,
      params: [profile.name, `Novo cadastro aguardando aprovação (${profile.specialty || 'sem especialidade'})`, B.baseUrl()],
    });
    wa.dispatchQueued().catch(() => {});
    return { pending: true };
  }
  A.startSession(ctx, id);
  return { user: A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
});

app.post('/api/logout', (ctx) => { A.endSession(ctx); return { ok: true }; });

app.put('/api/me', requireAuth, (ctx) => {
  const p = A.cleanProfile({ ...ctx.body, email: ctx.user.email });
  db.prepare('UPDATE users SET name=?, phone=?, specialty=?, registry=?, document=? WHERE id=?')
    .run(p.name, p.phone, p.specialty, p.registry, p.document, ctx.user.id);
  return { user: A.publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.id)) };
});

app.post('/api/me/password', requireAuth, (ctx) => {
  A.throttle(`pwd:${ctx.user.id}`, 8);
  if (!A.verifyPassword(String(ctx.body.current || ''), ctx.user.password_hash)) throw bad('Senha atual incorreta.');
  A.validatePassword(ctx.body.next);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(A.hashPassword(ctx.body.next), ctx.user.id);
  return { ok: true };
});

// ---------- agenda (profissional) ----------
app.get('/api/availability', requireAuth, (ctx) => {
  if (!U.isValidDate(ctx.query.date)) throw bad('Data inválida.');
  return B.availability(ctx.query.date, ctx.user);
});

app.get('/api/module-options', requireAuth, (ctx) => B.moduleOptions(ctx.query.type, ctx.query.month, ctx.query.room_id));

app.get('/api/bookings', requireAuth, (ctx) => {
  B.expireHolds();
  return { bookings: B.listBookings({ userId: ctx.user.id }).map((b) => B.serialize(b)) };
});

app.get('/api/bookings/:id', requireAuth, (ctx) => {
  B.expireHolds();
  const b = B.getBookingRow(Number(ctx.params.id));
  if (!b || (b.user_id !== ctx.user.id && ctx.user.role !== 'admin')) throw notFound('Reserva não encontrada.');
  return { booking: B.serialize(b, { admin: ctx.user.role === 'admin' }) };
});

app.post('/api/bookings', requireAuth, (ctx) => {
  const s = getSettings();
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id=? AND status='pending'`).get(ctx.user.id).n;
  B.expireHolds();
  if (pending >= 5) throw bad('Você tem muitas reservas aguardando pagamento. Pague ou cancele alguma antes de continuar.');
  const plan = B.planBooking({ ...ctx.body, amount_cents: undefined }, s); // usuário nunca define valor
  const id = B.createBooking(ctx.user.id, plan, { holdMinutes: s.hold_minutes });
  return { booking: B.serialize(B.getBookingRow(id)) };
});

app.post('/api/bookings/:id/cancel', requireAuth, (ctx) => B.cancelBooking(Number(ctx.params.id), ctx.user, { reason: String(ctx.body.reason || '').slice(0, 200) }));

// ---------- pagamentos ----------
app.post('/api/bookings/:id/pay', requireAuth, async (ctx) => ({ payment: await P.startPayment(Number(ctx.params.id), ctx.user, String(ctx.body.method || '')) }));

app.get('/api/payments/:id', requireAuth, async (ctx) => {
  const id = Number(ctx.params.id);
  const p0 = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  if (!p0) throw notFound();
  const b0 = B.getBookingRow(p0.booking_id);
  if (b0.user_id !== ctx.user.id && ctx.user.role !== 'admin') throw notFound();
  const p = await P.refreshPayment(id);
  B.expireHolds();
  const b = B.getBookingRow(p.booking_id);
  return { payment: P.publicPayment(p), booking: B.serialize(b, { admin: ctx.user.role === 'admin' }) };
});

app.post('/api/payments/:id/mock-confirm', requireAuth, (ctx) => { P.mockConfirm(Number(ctx.params.id), ctx.user); return { ok: true }; });

app.post('/api/webhooks/mercadopago', async (ctx) => { await P.handleMercadoPagoWebhook(ctx.query, ctx.body); return { ok: true }; });

app.get('/r/:code', (ctx) => {
  const html = renderReceipt(ctx.params.code);
  if (!html) return raw(404, 'text/plain; charset=utf-8', 'Comprovante não encontrado.');
  return raw(200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-store' });
});

// ---------- gestor ----------
app.get('/api/admin/dashboard', requireAdmin, () => B.dashboard());

app.get('/api/admin/bookings', requireAdmin, (ctx) => {
  B.expireHolds();
  const q = ctx.query;
  return {
    bookings: B.listBookings({
      status: q.status || undefined, userId: q.user_id ? Number(q.user_id) : undefined, from: q.from || undefined, to: q.to || undefined,
      q: q.q || undefined, attention: q.attention === '1',
    }).map((b) => B.serialize(b, { admin: true })),
  };
});

app.post('/api/admin/bookings', requireAdmin, (ctx) => {
  const b = ctx.body;
  const s = getSettings();
  const isBlock = b.type === 'block';
  let userId = ctx.user.id;
  if (!isBlock) {
    const u = db.prepare(`SELECT id FROM users WHERE id=? AND role='user'`).get(Number(b.user_id));
    if (!u) throw bad('Selecione o profissional.');
    userId = u.id;
  }
  const plan = B.planBooking(b, s, { isAdmin: true });
  const method = isBlock ? null : String(b.payment || 'pending');
  if (!isBlock && !['pending', 'manual_pix', 'cash', 'courtesy'].includes(method)) throw bad('Forma de pagamento inválida.');
  const id = B.createBooking(userId, plan, {
    origin: 'admin', holdMinutes: method === 'pending' ? s.hold_minutes : 5, note: String(b.note || '').slice(0, 200) || null,
  });
  if (!isBlock && method !== 'pending') B.confirmManually(id, method, ctx.user);
  audit(ctx.user.id, 'admin.booking.create', `#${id} ${plan.type}`);
  return { booking: B.serialize(B.getBookingRow(id), { admin: true }) };
});

app.post('/api/admin/bookings/:id/confirm', requireAdmin, (ctx) => {
  B.confirmManually(Number(ctx.params.id), String(ctx.body.method || ''), ctx.user);
  return { booking: B.serialize(B.getBookingRow(Number(ctx.params.id)), { admin: true }) };
});

app.post('/api/admin/bookings/:id/cancel', requireAdmin, (ctx) => {
  B.cancelBooking(Number(ctx.params.id), ctx.user, { refunded: !!ctx.body.refunded, reason: String(ctx.body.reason || '').slice(0, 200) });
  return { booking: B.serialize(B.getBookingRow(Number(ctx.params.id)), { admin: true }) };
});

app.post('/api/admin/bookings/:id/resolve', requireAdmin, (ctx) => {
  // Gestor trata o alerta (ex.: pagamento duplicado reembolsado / recusa de cancelamento)
  const id = Number(ctx.params.id);
  if (!B.getBookingRow(id)) throw notFound();
  db.prepare('UPDATE bookings SET needs_attention=0, cancel_requested=0 WHERE id=?').run(id);
  audit(ctx.user.id, 'admin.booking.resolve', `#${id}`);
  return { booking: B.serialize(B.getBookingRow(id), { admin: true }) };
});

app.get('/api/admin/users', requireAdmin, () => ({
  users: db.prepare(`SELECT * FROM users ORDER BY (role='admin') DESC, name COLLATE NOCASE`).all().map((u) => ({
    ...A.publicUser(u),
    bookings: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id=? AND status='confirmed'`).get(u.id).n,
  })),
}));

app.post('/api/admin/users', requireAdmin, (ctx) => {
  const role = ctx.body.role === 'admin' ? 'admin' : 'user';
  const id = A.createUser(A.cleanProfile(ctx.body), ctx.body.password, role, 'active');
  audit(ctx.user.id, 'admin.user.create', `#${id}`);
  return { user: A.publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) };
});

app.put('/api/admin/users/:id', requireAdmin, (ctx) => {
  const id = Number(ctx.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw notFound('Usuário não encontrado.');
  const p = A.cleanProfile({ ...ctx.body, email: ctx.body.email ?? u.email });
  const role = ctx.body.role === 'admin' ? 'admin' : 'user';
  const status = ['active', 'pending', 'blocked'].includes(ctx.body.status) ? ctx.body.status : u.status;
  if (id === ctx.user.id && (role !== 'admin' || status !== 'active')) throw bad('Você não pode remover o seu próprio acesso de gestor.');
  if (p.email !== u.email && db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(p.email, id)) throw conflict('Já existe um cadastro com este e-mail.');
  db.prepare('UPDATE users SET name=?, email=?, phone=?, specialty=?, registry=?, document=?, role=?, status=?, notes=? WHERE id=?')
    .run(p.name, p.email, p.phone, p.specialty, p.registry, p.document, role, status, String(ctx.body.notes || '').slice(0, 300) || null, id);
  if (status === 'blocked') db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(ctx.user.id, 'admin.user.update', `#${id}`);
  return { user: A.publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) };
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, (ctx) => {
  const id = Number(ctx.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) throw notFound();
  A.validatePassword(ctx.body.password);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(A.hashPassword(ctx.body.password), id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(ctx.user.id, 'admin.user.reset_password', `#${id}`);
  return { ok: true };
});

app.post('/api/admin/rooms', requireAdmin, (ctx) => {
  const r = cleanRoom(ctx.body);
  const id = Number(db.prepare('INSERT INTO rooms (name, description) VALUES (?,?)').run(r.name, r.description).lastInsertRowid);
  return { room: db.prepare('SELECT * FROM rooms WHERE id=?').get(id) };
});

app.put('/api/admin/rooms/:id', requireAdmin, (ctx) => {
  const id = Number(ctx.params.id);
  if (!db.prepare('SELECT 1 FROM rooms WHERE id=?').get(id)) throw notFound();
  const r = cleanRoom(ctx.body);
  const active = ctx.body.active === false || ctx.body.active === 0 ? 0 : 1;
  if (!active) {
    const future = db.prepare(`SELECT COUNT(*) AS n FROM slots sl JOIN bookings b ON b.id=sl.booking_id WHERE sl.room_id=? AND sl.date>=? AND b.status IN ('confirmed','pending')`).get(id, U.nowLocal().date).n;
    if (future) throw conflict('Esta sala tem reservas futuras. Cancele ou mova as reservas antes de desativá-la.');
    if (db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE active=1 AND id<>?').get(id).n === 0) throw bad('Mantenha pelo menos uma sala ativa.');
  }
  db.prepare('UPDATE rooms SET name=?, description=?, active=? WHERE id=?').run(r.name, r.description, active, id);
  return { room: db.prepare('SELECT * FROM rooms WHERE id=?').get(id) };
});

app.put('/api/admin/settings', requireAdmin, (ctx) => {
  const clean = cleanSettings(ctx.body, { partial: true });
  setSettings(clean);
  audit(ctx.user.id, 'admin.settings', Object.keys(clean).join(','));
  return { ok: true };
});

app.get('/api/admin/outbox', requireAdmin, () => ({
  messages: db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 100').all().map((m) => ({
    ...m, params: undefined, link: wa.waLink(m.to_phone, m.body),
  })),
}));

app.post('/api/admin/outbox/:id/retry', requireAdmin, async (ctx) => {
  db.prepare(`UPDATE outbox SET status=?, attempts=0, error=NULL WHERE id=? AND status IN ('failed','manual','queued')`)
    .run(wa.provider() === 'cloud' ? 'queued' : 'manual', Number(ctx.params.id));
  await wa.dispatchQueued();
  return { ok: true };
});

app.post('/api/admin/outbox/:id/mark-sent', requireAdmin, (ctx) => {
  db.prepare(`UPDATE outbox SET status='sent', sent_at=? WHERE id=?`).run(U.isoNow(), Number(ctx.params.id));
  return { ok: true };
});

app.get('/api/admin/export.csv', requireAdmin, () => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Reserva', 'Status', 'Profissional', 'E-mail', 'WhatsApp', 'Tipo', 'Sala', 'Agenda', 'Valor (R$)', 'Forma de pagamento', 'Pago em', 'Criado em'].map(esc).join(';')];
  for (const b of B.listBookings({ limit: 5000 })) {
    const s = B.serialize(b, { admin: true });
    lines.push([
      s.id, s.status, s.user_name, s.user_email, s.user_phone, s.title, s.room_name, s.lines.join(' / '),
      (s.amount_cents / 100).toFixed(2).replace('.', ','), s.payment?.status === 'paid' ? s.payment.method_label : '',
      s.paid_at ? new Date(s.paid_at).toLocaleString('pt-BR', { timeZone: U.TZ }) : '', new Date(s.created_at).toLocaleString('pt-BR', { timeZone: U.TZ }),
    ].map(esc).join(';'));
  }
  return raw(200, 'text/csv; charset=utf-8', '﻿' + lines.join('\r\n'), { 'Content-Disposition': 'attachment; filename="reservas-espaco-vida.csv"', 'Cache-Control': 'no-store' });
});

// ---------- rotinas em segundo plano ----------
function startJobs() {
  setInterval(() => { try { B.expireHolds(); } catch (e) { console.error(e); } }, 60000).unref();
  setInterval(() => { wa.dispatchQueued().catch((e) => console.error('WhatsApp:', e.message)); }, 60000).unref();
  setInterval(() => { try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(U.isoNow()); } catch (e) { console.error(e); } }, 3600000).unref();
}

function listen(port = Number(process.env.PORT) || 3000) {
  return new Promise((resolve) => {
    const server = app.server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

if (require.main === module) {
  startJobs();
  listen().then((server) => {
    const ps = P.status();
    const ws = wa.status();
    console.log(`\n  Espaço Vida — agenda rodando em http://localhost:${server.address().port}`);
    console.log(`  Pagamentos: ${ps.provider}${ps.demo ? '  (DEMONSTRAÇÃO — nenhuma cobrança real)' : ps.configured ? '' : '  (FALTA MP_ACCESS_TOKEN)'}`);
    console.log(`  WhatsApp:   ${ws.provider}${ws.provider === 'manual' ? '  (fila + envio com 1 clique no painel)' : ws.configured ? '' : '  (FALTAM WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)'}`);
    if (!process.env.BASE_URL) console.log('  Dica: defina BASE_URL (ex.: https://agenda.seudominio.com.br) para links corretos nas mensagens.\n');
  });
}

module.exports = { app, listen, startJobs };
