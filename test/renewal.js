'use strict';
// Testes de renovação de módulos, com relógio simulado (dia 10/11/2026, 10h de Brasília).
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs'); const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evr-')); process.env.DB_FILE = path.join(tmp, 't.db'); process.env.DATA_DIR = tmp;
const FIXED = Date.UTC(2026, 10, 10, 13, 0, 0); const real = Date.now; const t0 = real(); Date.now = () => FIXED + (real() - t0);
const { server } = require('../server'); const { setSetting } = require('../lib/db');
let base; let pass = 0;
function client() { let cookie = ''; return async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }; }
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✔', n); } catch (e) { console.log('  ✘', n, '\n   ', e.message); process.exitCode = 1; } };
server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port; const adm = client(), ana = client(), bia = client();
  console.log('Testes de renovação (hoje simulado: 10/11/2026)');
  await adm('POST', '/api/setup', { admin: { name: 'Maria Gestora', email: 'g@ev.com', phone: '11988887777', password: 'senhaforte1' }, rooms: [{ name: 'Sala 1' }] });
  const reg = (c, n, e) => c('POST', '/api/auth/register', { name: n, email: e, phone: '11999990000', cpf: '52998224725', specialty: 'Psicologia', password: 'senha12345' });
  await reg(ana, 'Ana Souza', 'ana@x.com'); await reg(bia, 'Bia Lima', 'bia@x.com');
  let mod;
  await t('Ana contrata módulo de 4h na quarta, mês atual', async () => {
    const c = await ana('POST', '/api/bookings', { type: 'mod4', room_id: 1, month: '2026-11', weekday: 3, start_hour: 8 }); assert.equal(c.status, 200);
    const p = await ana('POST', `/api/bookings/${c.body.booking.id}/simulate-pay`, {}); assert.equal(p.body.booking.status, 'paid'); mod = p.body.booking;
    assert.equal(c.body.booking.amount_cents, 30000, 'proporcional: 3 de 4 quartas restantes (11, 18 e 25)');
  });
  await t('Ana vê opção de renovar para dezembro', async () => {
    const l = (await ana('GET', '/api/bookings')).body.bookings.find((b) => b.id === mod.id); assert.equal(l.renew.month, '2026-12');
  });
  await t('PRIORIDADE: até dia 20, Bia não pega a quarta 8h–12h de dezembro (módulo nem hora avulsa)', async () => {
    assert.equal((await bia('POST', '/api/bookings/quote', { type: 'mod4', room_id: 1, month: '2026-12', weekday: 3, start_hour: 8 })).status, 409);
    assert.equal((await bia('POST', '/api/bookings/quote', { type: 'mod4', room_id: 1, month: '2026-12', weekday: 3, start_hour: 10 })).status, 409, 'sobreposição parcial também');
    assert.equal((await bia('POST', '/api/bookings/quote', { type: 'avulsa', room_id: 1, slots: [{ date: '2026-12-02', hour: 9 }] })).status, 409);
    const av = (await bia('GET', '/api/availability?room_id=1&from=2026-12-02&to=2026-12-02')).body.days['2026-12-02']; assert.ok(!av.free.includes(8) && av.free.includes(12), 'aparece ocupado só dentro do módulo');
    const opts = (await bia('GET', '/api/module-options?room_id=1&type=mod4&month=2026-12')).body.options[3]; assert.ok(!opts.includes(8) && opts.includes(13));
    assert.equal((await bia('POST', '/api/bookings/quote', { type: 'mod4', room_id: 1, month: '2026-12', weekday: 4, start_hour: 8 })).status, 200, 'outro dia está livre');
    assert.equal((await bia('POST', '/api/bookings/quote', { type: 'avulsa', room_id: 1, slots: [{ date: '2026-12-02', hour: 12 }] })).status, 200);
  });
  await t('o titular consegue renovar com um clique, e a renovação some da lista', async () => {
    const r = await ana('POST', `/api/bookings/${mod.id}/renew`, {}); assert.equal(r.status, 200); assert.equal(r.body.booking.amount_cents, 40000);
    assert.match(r.body.booking.detail, /dezembro\/2026/);
    assert.equal((await ana('POST', `/api/bookings/${mod.id}/renew`, {})).status, 409, 'não renova duas vezes');
    assert.equal((await bia('POST', `/api/bookings/${mod.id}/renew`, {})).status, 404, 'só o titular');
    await ana('POST', `/api/bookings/${r.body.booking.id}/simulate-pay`, {});
    assert.equal((await ana('GET', '/api/bookings')).body.bookings.find((b) => b.id === mod.id).renew, null);
  });
  await t('gestor vê a lista de renovações e a mensagem pronta', async () => {
    const r = (await adm('GET', '/api/admin/renewals')).body; assert.equal(r.priority_open, true); assert.equal(r.renewal_day, 20); assert.equal(r.reminder_from, 13);
    assert.equal(r.items.length, 1); assert.equal(r.items[0].renewed, true);
  });
  await t('depois do dia 20 a prioridade acaba (horário não renovado é liberado)', async () => {
    const c = await bia('POST', '/api/bookings', { type: 'mod4', room_id: 1, month: '2026-12', weekday: 5, start_hour: 8 }); assert.equal(c.status, 200); await bia('POST', `/api/bookings/${c.body.booking.id}/simulate-pay`, {});
    await bia('POST', '/api/bookings', { type: 'mod4', room_id: 1, month: '2026-11', weekday: 5, start_hour: 14 }).then((x) => bia('POST', `/api/bookings/${x.body.booking.id}/simulate-pay`, {}));
    await adm('PUT', '/api/admin/settings', { renewal_day: 5 }); // hoje é 10 ≥ 5: prioridade encerrada
    const r = (await adm('GET', '/api/admin/renewals')).body; assert.equal(r.priority_open, false);
    assert.equal((await ana('POST', '/api/bookings/quote', { type: 'avulsa', room_id: 1, slots: [{ date: '2026-12-04', hour: 14 }] })).status, 200, 'sem prioridade, Ana pode pegar o horário que Bia não renovou');
    await adm('PUT', '/api/admin/settings', { renewal_day: 20 });
  });
  await t('só mês atual e o próximo são permitidos', async () => {
    assert.equal((await ana('POST', '/api/bookings/quote', { type: 'mod4', room_id: 1, month: '2027-01', weekday: 2, start_hour: 8 })).status, 400);
  });
  await t('próximos atendimentos agrupam horas seguidas', async () => {
    const u = (await adm('GET', '/api/admin/upcoming?days=30')).body; const d = u.days.find((x) => x.date === '2026-11-11'); assert.ok(d); assert.equal(d.items[0].start, 8); assert.equal(d.items[0].end, 12);
  });
  await t('Telegram: sem configuração não cria aviso; teste informa o erro', async () => {
    assert.equal((await adm('POST', '/api/admin/telegram-test', {})).status, 400);
    assert.equal((await adm('PUT', '/api/admin/settings', { telegram_chat_id: '12345', telegram_token: 'x:y' })).status, 200);
    const s = (await adm('GET', '/api/admin/settings')).body.settings; assert.equal(s.telegram_token, ''); assert.equal(s.has_telegram_token, true);
  });
  console.log(`\n${pass} testes passaram${process.exitCode ? ' — HÁ FALHAS' : ' ✔'}`); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
