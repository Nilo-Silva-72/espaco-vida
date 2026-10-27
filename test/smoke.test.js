'use strict';
// Teste de ponta a ponta (sem navegador): sobe o servidor em memória e percorre os fluxos principais.
process.env.DB_FILE = ':memory:';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.WHATSAPP_PROVIDER = 'manual';
process.env.BASE_URL = 'https://agenda.exemplo.com.br';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listen } = require('../server/index');
const { db } = require('../server/db');
const U = require('../server/util');

let base;
let server;
const jar = (name) => ({ name, cookie: '' });
async function api(client, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(client?.cookie ? { Cookie: client.cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.getSetCookie?.() || [];
  if (client && set.length) {
    const c = set.map((s) => s.split(';')[0]).find((s) => s.startsWith('ev_session='));
    if (c) client.cookie = c.endsWith('=') ? '' : c;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html/csv */ }
  return { status: res.status, json, text, headers: res.headers };
}

const admin = jar('admin');
const ana = jar('ana');
const bia = jar('bia');
let today;
let tuesday; // uma terça futura (pelo menos 3 dias à frente)
let nextMonth;

test.before(async () => {
  server = await listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server.closeAllConnections?.(); server.close(); });

test('estado inicial pede configuração', async () => {
  const r = await api(null, 'GET', '/api/state');
  assert.equal(r.json.setup_done, false);
});

test('configuração inicial do zero cria gestor, preços, horários e salas', async () => {
  const hours = { 0: null, 1: [8, 20], 2: [8, 20], 3: [8, 20], 4: [8, 20], 5: [8, 20], 6: [9, 13] };
  const bad = await api(admin, 'POST', '/api/setup', { settings: { business_name: 'Espaço Vida', admin_whatsapp: '21999990000', hours, price_hour_cents: 7000, price_module4_cents: 40000, price_module8_cents: 80000 }, admin: { name: 'Gestora Vida', email: 'gestor@vida.com', phone: '21999990000', password: 'curta' }, rooms: [{ name: 'Sala 1' }] });
  assert.equal(bad.status, 400); // senha curta
  const r = await api(admin, 'POST', '/api/setup', {
    settings: { business_name: 'Espaço Vida', admin_whatsapp: '(21) 99999-0000', hours, price_hour_cents: 7000, price_module4_cents: 40000, price_module8_cents: 80000, hold_minutes: 20, max_advance_days: 60, methods: { pix: true, card: true } },
    admin: { name: 'Gestora Vida', email: 'gestor@vida.com', phone: '21999990000', password: 'senhaforte123' },
    rooms: [{ name: 'Sala 1', description: 'Consultório' }, { name: 'Sala 2' }],
  });
  assert.equal(r.status, 200);
  const st = await api(admin, 'GET', '/api/state');
  assert.equal(st.json.setup_done, true);
  assert.equal(st.json.user.role, 'admin');
  assert.equal(st.json.rooms.length, 2);
  assert.equal(st.json.settings.price_hour_cents, 7000);
  today = st.json.today;
  let d = U.addDays(today, 3);
  while (U.weekdayOf(d) !== 2) d = U.addDays(d, 1);
  tuesday = d;
  nextMonth = U.addMonths(today.slice(0, 7), 1);
  const again = await api(null, 'POST', '/api/setup', {});
  assert.equal(again.status, 403); // não pode refazer
});

test('profissional se cadastra e só enxerga o básico', async () => {
  let r = await api(ana, 'POST', '/api/register', { name: 'Ana Souza', email: 'ana@x.com', phone: '21988887777', password: 'senhaana123', specialty: 'Psicóloga', registry: 'CRP 05/1234' });
  assert.equal(r.status, 200);
  r = await api(bia, 'POST', '/api/register', { name: 'Bia Lima', email: 'bia@x.com', phone: '21977776666', password: 'senhabia123' });
  assert.equal(r.status, 200);
  assert.equal((await api(ana, 'GET', '/api/admin/dashboard')).status, 403);
  assert.equal((await api(ana, 'GET', '/api/admin/users')).status, 403);
  assert.equal((await api(ana, 'PUT', '/api/admin/settings', { price_hour_cents: 1 })).status, 403);
  assert.equal((await api(null, 'GET', '/api/bookings')).status, 401);
  assert.equal((await api(null, 'POST', '/api/login', { email: 'ana@x.com', password: 'errada123' })).status, 401);
  const dup = await api(null, 'POST', '/api/register', { name: 'Ana 2', email: 'ANA@x.com', phone: '21988887777', password: 'senhaana123' });
  assert.equal(dup.status, 409);
});

test('disponibilidade respeita o horário de funcionamento', async () => {
  const av = await api(ana, 'GET', `/api/availability?date=${tuesday}`);
  assert.equal(av.json.open, 8);
  assert.equal(av.json.close, 20);
  assert.equal(av.json.rooms[0].hours.length, 12);
  let sat = U.addDays(today, 1);
  while (U.weekdayOf(sat) !== 6) sat = U.addDays(sat, 1);
  const s = await api(ana, 'GET', `/api/availability?date=${sat}`);
  assert.equal(s.json.rooms[0].hours.length, 4);
  assert.equal(s.json.rooms[0].hours[0].hour, 9);
  let sun = U.addDays(today, 1);
  while (U.weekdayOf(sun) !== 0) sun = U.addDays(sun, 1);
  const z = await api(ana, 'GET', `/api/availability?date=${sun}`);
  assert.equal(z.json.open, null);
  const rej = await api(ana, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: sun, hours: [10] });
  assert.equal(rej.status, 400);
  const early = await api(ana, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: tuesday, hours: [7] });
  assert.equal(early.status, 400);
  const past = await api(ana, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: U.addDays(today, -1), hours: [10] });
  assert.equal(past.status, 400);
});

let hourlyBooking;
test('hora avulsa: reserva fica pendente, trava horário e só confirma após pagamento', async () => {
  const r = await api(ana, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: tuesday, hours: [10, 11, 14], amount_cents: 1 });
  assert.equal(r.status, 200);
  hourlyBooking = r.json.booking;
  assert.equal(hourlyBooking.status, 'pending');
  assert.equal(hourlyBooking.amount_cents, 21000); // 3 × R$ 70, valor enviado pelo cliente é ignorado
  assert.equal(hourlyBooking.receipt_url, null);

  const clash = await api(bia, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: tuesday, hours: [11, 12] });
  assert.equal(clash.status, 409);
  const otherRoom = await api(bia, 'POST', '/api/bookings', { type: 'hourly', room_id: 2, date: tuesday, hours: [11] });
  assert.equal(otherRoom.status, 200);

  const av = await api(bia, 'GET', `/api/availability?date=${tuesday}`);
  const h10 = av.json.rooms[0].hours.find((h) => h.hour === 10);
  assert.equal(h10.state, 'busy');
  assert.equal(h10.who, undefined); // profissional não vê quem ocupou

  assert.equal((await api(bia, 'POST', `/api/bookings/${hourlyBooking.id}/pay`, { method: 'pix' })).status, 403); // não paga reserva alheia
  const pay = await api(ana, 'POST', `/api/bookings/${hourlyBooking.id}/pay`, { method: 'pix' });
  assert.equal(pay.status, 200);
  assert.ok(pay.json.payment.pix_code.startsWith('DEMO-PIX-'));
  assert.equal(pay.json.payment.demo, true);
  const same = await api(ana, 'POST', `/api/bookings/${hourlyBooking.id}/pay`, { method: 'pix' });
  assert.equal(same.json.payment.id, pay.json.payment.id); // reaproveita a cobrança aberta

  const poll = await api(ana, 'GET', `/api/payments/${pay.json.payment.id}`);
  assert.equal(poll.json.booking.status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0); // nada enviado antes do pagamento

  assert.equal((await api(bia, 'POST', `/api/payments/${pay.json.payment.id}/mock-confirm`, {})).status, 403);
  assert.equal((await api(ana, 'POST', `/api/payments/${pay.json.payment.id}/mock-confirm`, {})).status, 200);
  const after = await api(ana, 'GET', `/api/bookings/${hourlyBooking.id}`);
  assert.equal(after.json.booking.status, 'confirmed');
  assert.match(after.json.booking.receipt_url, /^\/r\//);
  // confirmar de novo não duplica nada
  await api(ana, 'POST', `/api/payments/${pay.json.payment.id}/mock-confirm`, {});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 2);
});

test('comprovantes: enviados automaticamente ao profissional e à administração', async () => {
  const msgs = db.prepare('SELECT * FROM outbox ORDER BY id').all();
  const prof = msgs.find((m) => m.kind === 'professional');
  const adm = msgs.find((m) => m.kind === 'admin');
  assert.equal(prof.to_phone, '5521988887777');
  assert.equal(adm.to_phone, '5521999990000');
  assert.match(prof.body, /R\$\s?210,00/);
  assert.match(prof.body, /https:\/\/agenda\.exemplo\.com\.br\/r\//);
  assert.match(adm.body, /Ana Souza/);
  assert.match(prof.body, /10h às 12h, 14h às 15h/);
  const code = prof.body.match(/\/r\/([A-Z0-9]+)/)[1];
  const page = await api(null, 'GET', `/r/${code}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ana Souza/);
  assert.match(page.text, /Pagamento confirmado/);
  assert.equal((await api(null, 'GET', '/r/INEXISTENTE')).status, 404);
});

test('módulo de 4 horas: 1 dia por semana no mês inteiro, R$ 400', async () => {
  const opts = await api(ana, 'GET', `/api/module-options?type=module4&month=${nextMonth}&room_id=1`);
  assert.equal(opts.status, 200);
  assert.equal(opts.json.price_cents, 40000);
  const wed = opts.json.days.find((d) => d.weekday === 3);
  assert.equal(wed.starts.length, 9); // 8h..16h
  const sat = opts.json.days.find((d) => d.weekday === 6);
  assert.deepEqual(sat.starts.map((s) => s.start), [9]);
  assert.equal(opts.json.days.find((d) => d.weekday === 0), undefined);

  const r = await api(ana, 'POST', '/api/bookings', { type: 'module4', room_id: 1, month: nextMonth, weekday: 3, start_hour: 8 });
  assert.equal(r.status, 200);
  assert.equal(r.json.booking.amount_cents, 40000);
  const nWed = U.datesOfMonthWeekday(nextMonth, 3).length;
  assert.equal(r.json.booking.items.length, nWed * 4);
  const pay = await api(ana, 'POST', `/api/bookings/${r.json.booking.id}/pay`, { method: 'card' });
  assert.equal(pay.status, 200);
  await api(ana, 'POST', `/api/payments/${pay.json.payment.id}/mock-confirm`, {});
  assert.equal((await api(ana, 'GET', `/api/bookings/${r.json.booking.id}`)).json.booking.status, 'confirmed');

  const overlap = await api(bia, 'POST', '/api/bookings', { type: 'module4', room_id: 1, month: nextMonth, weekday: 3, start_hour: 10 });
  assert.equal(overlap.status, 409);
  const adjacent = await api(bia, 'POST', '/api/bookings', { type: 'module4', room_id: 1, month: nextMonth, weekday: 3, start_hour: 12 });
  assert.equal(adjacent.status, 200);
  const opts2 = await api(bia, 'GET', `/api/module-options?type=module4&month=${nextMonth}&room_id=1`);
  const w2 = opts2.json.days.find((d) => d.weekday === 3).starts;
  assert.equal(w2.find((s) => s.start === 8).free, false);
  assert.equal(w2.find((s) => s.start === 16).free, true);
});

test('módulo de 8 horas só cabe onde há 8h seguidas; sábado só 9h–13h', async () => {
  const sat8 = await api(bia, 'POST', '/api/bookings', { type: 'module8', room_id: 2, month: nextMonth, weekday: 6, start_hour: 9 });
  assert.equal(sat8.status, 400);
  const late = await api(bia, 'POST', '/api/bookings', { type: 'module8', room_id: 2, month: nextMonth, weekday: 2, start_hour: 13 });
  assert.equal(late.status, 400); // 13h + 8h = 21h > 20h
  const ok = await api(bia, 'POST', '/api/bookings', { type: 'module8', room_id: 2, month: nextMonth, weekday: 2, start_hour: 12 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.booking.amount_cents, 80000);
  const sat4 = await api(bia, 'POST', '/api/bookings', { type: 'module4', room_id: 2, month: nextMonth, weekday: 6, start_hour: 9 });
  assert.equal(sat4.status, 200);
  const old = await api(bia, 'POST', '/api/bookings', { type: 'module4', room_id: 2, month: U.addMonths(today.slice(0, 7), -1), weekday: 2, start_hour: 8 });
  assert.equal(old.status, 400);
});

test('reserva não paga expira e libera o horário; pagamento tardio recupera se ainda livre', async () => {
  const r = await api(bia, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: tuesday, hours: [17] });
  const id = r.json.booking.id;
  const pay = await api(bia, 'POST', `/api/bookings/${id}/pay`, { method: 'pix' });
  db.prepare(`UPDATE bookings SET hold_expires_at = ? WHERE id = ?`).run(U.addMinutesISO(-1), id);
  const av = await api(ana, 'GET', `/api/availability?date=${tuesday}`);
  assert.equal(av.json.rooms[0].hours.find((h) => h.hour === 17).state, 'free');
  assert.equal((await api(bia, 'GET', `/api/bookings/${id}`)).json.booking.status, 'expired');
  assert.equal((await api(bia, 'POST', `/api/bookings/${id}/pay`, { method: 'card' })).status, 409);

  // pagamento tardio, horário ainda livre → confirma
  await api(bia, 'POST', `/api/payments/${pay.json.payment.id}/mock-confirm`, {});
  assert.equal((await api(bia, 'GET', `/api/bookings/${id}`)).json.booking.status, 'confirmed');

  // pagamento tardio, horário já ocupado por outra pessoa → alerta para o gestor
  const r2 = await api(bia, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: tuesday, hours: [18] });
  const pay2 = await api(bia, 'POST', `/api/bookings/${r2.json.booking.id}/pay`, { method: 'pix' });
  db.prepare(`UPDATE bookings SET hold_expires_at = ? WHERE id = ?`).run(U.addMinutesISO(-1), r2.json.booking.id);
  const taker = await api(ana, 'POST', '/api/bookings', { type: 'hourly', room_id: 1, date: tuesday, hours: [18] });
  assert.equal(taker.status, 200);
  await api(bia, 'POST', `/api/payments/${pay2.json.payment.id}/mock-confirm`, {});
  const b2 = await api(admin, 'GET', `/api/bookings/${r2.json.booking.id}`);
  assert.equal(b2.json.booking.status, 'expired');
  assert.equal(b2.json.booking.needs_attention, true);
});

test('cancelamento: pendente cancela direto; pago vira solicitação para o gestor', async () => {
  const r = await api(bia, 'POST', '/api/bookings', { type: 'hourly', room_id: 2, date: tuesday, hours: [9] });
  assert.equal((await api(ana, 'POST', `/api/bookings/${r.json.booking.id}/cancel`, {})).status, 403);
  assert.equal((await api(bia, 'POST', `/api/bookings/${r.json.booking.id}/cancel`, {})).status, 200);
  const av = await api(ana, 'GET', `/api/availability?date=${tuesday}`);
  assert.equal(av.json.rooms[1].hours.find((h) => h.hour === 9).state, 'free');

  const req = await api(ana, 'POST', `/api/bookings/${hourlyBooking.id}/cancel`, {});
  assert.equal(req.json.requested, true);
  assert.equal((await api(ana, 'GET', `/api/bookings/${hourlyBooking.id}`)).json.booking.status, 'confirmed');
  const list = await api(admin, 'GET', '/api/admin/bookings?attention=1');
  assert.ok(list.json.bookings.some((b) => b.id === hourlyBooking.id && b.cancel_requested));
  const adm = await api(admin, 'POST', `/api/admin/bookings/${hourlyBooking.id}/cancel`, { refunded: true });
  assert.equal(adm.json.booking.status, 'cancelled');
  const av2 = await api(ana, 'GET', `/api/availability?date=${tuesday}`);
  assert.equal(av2.json.rooms[0].hours.find((h) => h.hour === 10).state, 'free');
});

test('gestor: agendamento manual (dinheiro), bloqueio, cortesia e visão completa da agenda', async () => {
  let friday = U.addDays(today, 3);
  while (U.weekdayOf(friday) !== 5) friday = U.addDays(friday, 1);
  const users = await api(admin, 'GET', '/api/admin/users');
  const bia_ = users.json.users.find((u) => u.email === 'bia@x.com');
  const cash = await api(admin, 'POST', '/api/admin/bookings', { type: 'hourly', user_id: bia_.id, room_id: 2, date: friday, hours: [15], payment: 'cash' });
  assert.equal(cash.status, 200);
  assert.equal(cash.json.booking.status, 'confirmed');
  assert.equal(cash.json.booking.payment.method, 'cash');
  const free = await api(admin, 'POST', '/api/admin/bookings', { type: 'hourly', user_id: bia_.id, room_id: 2, date: friday, hours: [16], payment: 'courtesy' });
  assert.equal(free.json.booking.status, 'confirmed');
  const block = await api(admin, 'POST', '/api/admin/bookings', { type: 'block', room_id: 2, date: friday, hours: [19], note: 'Manutenção' });
  assert.equal(block.json.booking.type, 'block');
  const av = await api(admin, 'GET', `/api/availability?date=${friday}`);
  const cell = av.json.rooms[1].hours.find((h) => h.hour === 15);
  assert.equal(cell.who, 'Bia Lima');
  assert.equal(av.json.rooms[1].hours.find((h) => h.hour === 19).btype, 'block');
  const tryBlock = await api(ana, 'POST', '/api/bookings', { type: 'block', room_id: 1, date: friday, hours: [9] });
  assert.equal(tryBlock.status, 403);
  const dash = await api(admin, 'GET', '/api/admin/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.json.revenue_cents >= 0);
  const csv = await api(admin, 'GET', '/api/admin/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Ana Souza/);
});

test('gestor: edita preços/horários e cadastra profissionais; bloqueio impede login', async () => {
  assert.equal((await api(admin, 'PUT', '/api/admin/settings', { price_hour_cents: 8000 })).status, 200);
  assert.equal((await api(ana, 'GET', '/api/state')).json.settings.price_hour_cents, 8000);
  assert.equal((await api(admin, 'PUT', '/api/admin/settings', { hours: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } })).status, 400);
  const c = await api(admin, 'POST', '/api/admin/users', { name: 'Carlos Dias', email: 'carlos@x.com', phone: '21955554444', password: 'senhacarlos1' });
  assert.equal(c.status, 200);
  const blocked = await api(admin, 'PUT', `/api/admin/users/${c.json.user.id}`, { ...c.json.user, status: 'blocked' });
  assert.equal(blocked.json.user.status, 'blocked');
  assert.equal((await api(null, 'POST', '/api/login', { email: 'carlos@x.com', password: 'senhacarlos1' })).status, 403);
  const self = await api(admin, 'PUT', '/api/admin/users/1', { name: 'Gestora Vida', email: 'gestor@vida.com', phone: '21999990000', role: 'user', status: 'active' });
  assert.equal(self.status, 400); // não rebaixa a si mesmo
  const room = await api(admin, 'POST', '/api/admin/rooms', { name: 'Sala 3' });
  assert.equal(room.status, 200);
});

test('perfil: profissional edita os próprios dados e troca a senha', async () => {
  const r = await api(ana, 'PUT', '/api/me', { name: 'Ana Souza Lima', phone: '21 98888-7777', specialty: 'Nutricionista' });
  assert.equal(r.json.user.name, 'Ana Souza Lima');
  assert.equal((await api(ana, 'POST', '/api/me/password', { current: 'errada', next: 'novasenha123' })).status, 400);
  assert.equal((await api(ana, 'POST', '/api/me/password', { current: 'senhaana123', next: 'novasenha123' })).status, 200);
  const again = jar('ana2');
  assert.equal((await api(again, 'POST', '/api/login', { email: 'ana@x.com', password: 'novasenha123' })).status, 200);
});

test('limite de tentativas de login', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await api(null, 'POST', '/api/login', { email: 'alvo@x.com', password: 'xxxxxxxx' });
  assert.equal(last.status, 429);
});

test('proteções básicas: CSRF por content-type e cabeçalhos de segurança', async () => {
  const res = await fetch(base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(res.status, 415);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const trav = await fetch(base + '/..%2f..%2fetc/passwd');
  assert.notEqual(trav.status, 200);
});
