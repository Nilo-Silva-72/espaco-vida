'use strict';
// Testes automáticos das regras principais. Rodar: npm test
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs'); const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')); process.env.DB_FILE = path.join(tmp, 't.db'); process.env.DATA_DIR = tmp;
const { server } = require('../server'); const U = require('../lib/util'); const { db } = require('../lib/db');
let base; let pass = 0;
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; } return { status: r.status, body: j };
  };
}
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✔', name); } catch (e) { console.log('  ✘', name, '\n   ', e.message); process.exitCode = 1; } };
const nextWeekday = (wd, minDays = 3) => { let d = U.addDays(U.todayStr(), minDays); while (U.weekdayOf(d) !== wd) d = U.addDays(d, 1); return d; };

server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  const adm = client(), ana = client(), bia = client(), anon = client();
  console.log('Testes Espaço Vida');
  await t('primeiro acesso exige configuração', async () => { assert.equal((await anon('GET', '/api/public/info')).body.setup_needed, true); });
  await t('configuração inicial cria gestor, salas e preços', async () => {
    const r = await adm('POST', '/api/setup', { space_name: 'Espaço Vida', admin: { name: 'Maria Gestora', email: 'gestor@ev.com', phone: '(11) 98888-7777', password: 'senhaforte1' },
      rooms: [{ name: 'Sala 1' }, { name: 'Sala 2' }], prices: { mod4: 40000, mod8: 80000, hour: 7000 } });
    assert.equal(r.status, 200); assert.equal((await adm('GET', '/api/me')).body.user.role, 'admin');
    assert.equal((await anon('POST', '/api/setup', {})).status, 403);
  });
  await t('cadastro valida CPF e senha', async () => {
    const base = { name: 'Ana Souza', email: 'ana@x.com', phone: '11999990000', specialty: 'Psicologia', password: 'senha12345' };
    assert.equal((await anon('POST', '/api/auth/register', { ...base, cpf: '111.111.111-11' })).status, 400);
    assert.equal((await anon('POST', '/api/auth/register', { ...base, cpf: '529.982.247-25', password: '123' })).status, 400);
    assert.equal((await ana('POST', '/api/auth/register', { ...base, cpf: '529.982.247-25' })).status, 200);
    assert.equal((await bia('POST', '/api/auth/register', { ...base, name: 'Bia Lima', email: 'bia@x.com', cpf: '529.982.247-25' })).status, 200);
    assert.equal((await anon('POST', '/api/auth/register', { ...base, cpf: '529.982.247-25' })).status, 409);
  });
  await t('profissional não acessa área do gestor', async () => {
    assert.equal((await ana('GET', '/api/admin/users')).status, 403); assert.equal((await anon('GET', '/api/admin/users')).status, 401);
    assert.equal((await ana('PUT', '/api/admin/settings', { price_hour: 1 })).status, 403);
  });
  const mon = nextWeekday(1, 3); const sun = nextWeekday(0, 3); const sat = nextWeekday(6, 3);
  let b1;
  await t('recusa domingo, fora do horário e passado', async () => {
    const q = (date, hour) => ana('POST', '/api/bookings/quote', { type: 'avulsa', room_id: 1, slots: [{ date, hour }] });
    assert.equal((await q(sun, 10)).status, 409); assert.equal((await q(mon, 7)).status, 409); assert.equal((await q(mon, 20)).status, 409);
    assert.equal((await q(sat, 13)).status, 409); assert.equal((await q(sat, 12)).status, 200); assert.equal((await q(U.addDays(U.todayStr(), -1), 10)).status, 409);
  });
  await t('hora avulsa: R$ 70 por hora, segura o horário', async () => {
    const r = await ana('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: mon, hour: 9 }, { date: mon, hour: 10 }] });
    assert.equal(r.status, 200); assert.equal(r.body.booking.amount_cents, 14000); assert.equal(r.body.booking.status, 'pending'); b1 = r.body.booking;
    const dup = await bia('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: mon, hour: 10 }] });
    assert.equal(dup.status, 409);
    assert.equal((await bia('POST', '/api/bookings', { type: 'avulsa', room_id: 2, slots: [{ date: mon, hour: 10 }] })).status, 200, 'outra sala deve estar livre');
  });
  await t('pagamento libera comprovantes (profissional + administração) e página pública', async () => {
    assert.equal((await bia('POST', `/api/bookings/${b1.id}/simulate-pay`, {})).status, 404, 'outro usuário não pode mexer');
    assert.equal((await ana('POST', `/api/bookings/${b1.id}/pay`, { method: 'pix' })).body.charge.pix_code.length > 10, true);
    const r = await ana('POST', `/api/bookings/${b1.id}/simulate-pay`, { method: 'pix' }); assert.equal(r.body.booking.status, 'paid');
    const code = r.body.booking.receipt_code; assert.match(code, /^[A-Z2-9]{12}$/);
    const n = db.prepare('SELECT * FROM notifications WHERE booking_id=?').all(b1.id); assert.equal(n.length, 2); assert.deepEqual(n.map((x) => x.audience).sort(), ['admin', 'user']);
    assert.ok(n.find((x) => x.audience === 'user').to_phone === '5511999990000');
    const again = await ana('POST', `/api/bookings/${b1.id}/simulate-pay`, {}); assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE booking_id=?').get(b1.id).n, 2, 'não duplica comprovante');
    const page = await anon('GET', `/r/${code}`); assert.equal(page.status, 200); assert.match(page.body, /R\$\s?140,00/);
  });
  await t('módulo 4h: R$ 400 no mês cheio, um dia por semana', async () => {
    assert.equal((await ana('POST', '/api/bookings/quote', { type: 'mod8', room_id: 2, month: U.todayStr().slice(0, 7), weekday: 3, start_hour: 8 })).status, 400, 'módulo 8h vem desligado');
    await adm('PUT', '/api/admin/settings', { mod8_enabled: true });
    const month = U.fmtDate(new Date(Date.UTC(+U.todayStr().slice(0, 4), +U.todayStr().slice(5, 7), 1))).slice(0, 7); // próximo mês
    const q = await ana('POST', '/api/bookings/quote', { type: 'mod4', room_id: 2, month, weekday: 3, start_hour: 8 });
    assert.equal(q.status, 200); assert.equal(q.body.quote.amount, 40000); assert.equal(q.body.quote.slots, 4 * U.datesOfWeekdayInMonth(month, 3).length);
    const sat8 = await ana('POST', '/api/bookings/quote', { type: 'mod8', room_id: 2, month, weekday: 6, start_hour: 9 }); assert.equal(sat8.status, 409, '8h não cabe no sábado');
    const late = await ana('POST', '/api/bookings/quote', { type: 'mod4', room_id: 2, month, weekday: 3, start_hour: 18 }); assert.equal(late.status, 409, '18h–22h passa do fechamento');
    const ok8 = await ana('POST', '/api/bookings/quote', { type: 'mod8', room_id: 2, month, weekday: 3, start_hour: 12 }); assert.equal(ok8.status, 200); assert.equal(ok8.body.quote.amount, 80000);
    const c = await ana('POST', '/api/bookings', { type: 'mod4', room_id: 2, month, weekday: 3, start_hour: 8 }); assert.equal(c.status, 200);
    await ana('POST', `/api/bookings/${c.body.booking.id}/simulate-pay`, {});
    assert.equal((await bia('POST', '/api/bookings/quote', { type: 'mod4', room_id: 2, month, weekday: 3, start_hour: 10 })).status, 409, 'sobrepõe módulo já pago');
    const opts = await bia('GET', `/api/module-options?room_id=2&type=mod4&month=${month}`); assert.ok(!opts.body.options[3].includes(8) && !opts.body.options[3].includes(10) && opts.body.options[3].includes(12));
    assert.equal((await ana('POST', `/api/bookings/${c.body.booking.id}/cancel`, {})).status, 403, 'módulo pago: só gestor cancela');
  });
  await t('cancelamento de hora avulsa paga gera reembolso pendente e libera horário', async () => {
    const far = nextWeekday(2, 4);
    const c = await ana('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: far, hour: 14 }] }); await ana('POST', `/api/bookings/${c.body.booking.id}/simulate-pay`, {});
    const x = await ana('POST', `/api/bookings/${c.body.booking.id}/cancel`, {}); assert.equal(x.status, 200); assert.equal(x.body.booking.refund_status, 'solicitado');
    assert.equal((await bia('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: far, hour: 14 }] })).status, 200);
    assert.equal((await adm('POST', `/api/admin/bookings/${c.body.booking.id}/refund-done`, {})).status, 200);
  });
  await t('reserva não paga expira e libera o horário; pagamento tardio re-reserva ou pede reembolso', async () => {
    const d = nextWeekday(4, 3);
    const a = await ana('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: d, hour: 15 }] });
    db.prepare('UPDATE bookings SET hold_expires_at=1 WHERE id=?').run(a.body.booking.id);
    const b = await bia('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: d, hour: 15 }] }); assert.equal(b.status, 200, 'horário liberado após expirar');
    assert.equal((await ana('GET', `/api/bookings/${a.body.booking.id}`)).body.booking.status, 'expired');
    const late = await adm('POST', `/api/admin/bookings/${a.body.booking.id}/confirm`, {}); assert.equal(late.status, 409, 'conflito: outro já segurou');
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(a.body.booking.id).status, 'refund_needed');
    const d2 = nextWeekday(4, 10); const c = await ana('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: d2, hour: 15 }] });
    db.prepare('UPDATE bookings SET hold_expires_at=1 WHERE id=?').run(c.body.booking.id); (await ana('GET', '/api/bookings'));
    assert.equal((await ana('POST', `/api/bookings/${c.body.booking.id}/simulate-pay`, {})).body.booking.status, 'paid', 'horário ainda livre: confirma');
  });
  await t('gestor: bloqueio, agenda, dashboard, usuários e configurações', async () => {
    const d = nextWeekday(5, 5); assert.equal((await adm('POST', '/api/admin/blocks', { room_ids: [1], date_from: d, date_to: d, hour_from: 8, hour_to: 10, reason: 'Manutenção' })).status, 200);
    assert.equal((await ana('POST', '/api/bookings/quote', { type: 'avulsa', room_id: 1, slots: [{ date: d, hour: 8 }] })).status, 409);
    assert.equal((await adm('GET', `/api/admin/agenda?date=${d}`)).body.slots.length, 2);
    const dash = (await adm('GET', '/api/admin/dashboard')).body; assert.ok(dash.revenue >= 14000 + 40000);
    const users = (await adm('GET', '/api/admin/users')).body.users; assert.equal(users.length, 3);
    const bia2 = users.find((u) => u.email === 'bia@x.com');
    assert.equal((await adm('PUT', `/api/admin/users/${bia2.id}`, { ...bia2, active: false })).status, 200);
    assert.equal((await bia('GET', '/api/me')).status, 401, 'desativado perde acesso na hora');
    assert.equal((await adm('PUT', '/api/admin/settings', { price_hour: 8000 })).status, 200); assert.equal((await anon('GET', '/api/public/info')).body.prices.hour, 8000);
    assert.equal((await adm('PUT', '/api/admin/settings', { payment_provider: 'mercadopago' })).status, 400, 'exige token');
    const s = (await adm('GET', '/api/admin/settings')).body.settings; assert.equal(s.mp_access_token, '');
  });
  await t('segurança básica: JSON inválido, rota inexistente, caminho fora de public', async () => {
    assert.equal((await anon('GET', '/api/nada')).status, 404);
    const r = await fetch(base + '/..%2f..%2fserver.js'); assert.equal(r.status, 404);
    assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', body: '{x' })).status, 400);
  });
  console.log(`\n${pass} testes passaram${process.exitCode ? ' — HÁ FALHAS' : ' ✔'}`); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
