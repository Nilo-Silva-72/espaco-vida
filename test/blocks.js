'use strict';
// Testes de bloqueios em lote e do módulo de 8h desligável (hoje simulado: 02/11/2026, segunda, 9h).
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs'); const assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evb-')); process.env.DB_FILE = path.join(tmp, 't.db'); process.env.DATA_DIR = tmp;
const FIXED = Date.UTC(2026, 10, 2, 12, 0, 0); const real = Date.now; const t0 = real(); Date.now = () => FIXED + (real() - t0);
const { server } = require('../server');
let base; let pass = 0;
function client() { let cookie = ''; return async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; }; }
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✔', n); } catch (e) { console.log('  ✘', n, '\n   ', e.message); process.exitCode = 1; } };
server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port; const adm = client(), ana = client();
  console.log('Testes de bloqueios e módulo de 8h');
  await adm('POST', '/api/setup', { admin: { name: 'Maria Gestora', email: 'g@ev.com', phone: '11988887777', password: 'senhaforte1' }, rooms: [{ name: 'Sala 1' }, { name: 'Sala 2' }] });
  await ana('POST', '/api/auth/register', { name: 'Ana Souza', email: 'ana@x.com', phone: '11999990000', cpf: '52998224725', specialty: 'Psicologia', password: 'senha12345' });
  const q = (date, hour, room = 1) => ana('POST', '/api/bookings/quote', { type: 'avulsa', room_id: room, slots: [{ date, hour }] });
  await t('módulo de 8h vem desligado: some da tela e não pode ser contratado', async () => {
    assert.equal((await ana('GET', '/api/public/info')).body.mod8_enabled, false);
    assert.equal((await ana('POST', '/api/bookings/quote', { type: 'mod8', room_id: 1, month: '2026-11', weekday: 3, start_hour: 8 })).status, 400);
    await adm('PUT', '/api/admin/settings', { mod8_enabled: true });
    assert.equal((await ana('POST', '/api/bookings/quote', { type: 'mod8', room_id: 1, month: '2026-11', weekday: 3, start_hour: 8 })).status, 200, 'religado pelo gestor');
    await adm('PUT', '/api/admin/settings', { mod8_enabled: false });
  });
  await t('bloqueio em lote: várias salas, vários dias, só segundas e quartas, 12h–14h', async () => {
    const r = await adm('POST', '/api/admin/blocks', { room_ids: 'all', date_from: '2026-11-02', date_to: '2026-11-11', weekdays: [1, 3], hour_from: 12, hour_to: 14, reason: 'Limpeza' });
    assert.equal(r.status, 200); assert.equal(r.body.created, 16, '2 salas × 4 dias (2, 4, 9 e 11/nov) × 2 horas');
  });
  await t('bloqueio vale só para os dias e horas escolhidos', async () => {
    assert.equal((await q('2026-11-02', 12)).status, 409); assert.equal((await q('2026-11-04', 13, 2)).status, 409);
    assert.equal((await q('2026-11-03', 12)).status, 200, 'terça não foi bloqueada'); assert.equal((await q('2026-11-02', 14)).status, 200, '14h fica livre');
  });
  await t('horários que já têm reserva são pulados e informados', async () => {
    const c = await ana('POST', '/api/bookings', { type: 'avulsa', room_id: 1, slots: [{ date: '2026-11-05', hour: 10 }] }); assert.equal(c.status, 200);
    const r = await adm('POST', '/api/admin/blocks', { room_ids: [1], date_from: '2026-11-05', date_to: '2026-11-05', hour_from: 9, hour_to: 12, reason: 'Teste' });
    assert.equal(r.body.created, 2); assert.equal(r.body.skipped_count, 1); assert.match(r.body.skipped[0], /10:00/);
  });
  await t('lista de bloqueios e desbloqueio libera os horários', async () => {
    const l = (await adm('GET', '/api/admin/blocks')).body.blocks; const g = l.find((b) => b.reason === 'Limpeza'); assert.ok(g); assert.deepEqual(g.rooms.sort(), ['Sala 1', 'Sala 2']);
    assert.equal((await adm('POST', `/api/admin/blocks/${g.group}/remove`, {})).status, 200);
    assert.equal((await q('2026-11-02', 12)).status, 200); assert.equal((await adm('POST', `/api/admin/blocks/${g.group}/remove`, {})).status, 404);
    assert.equal((await ana('POST', '/api/admin/blocks', {})).status, 403, 'profissional não bloqueia');
  });
  await t('validações: período invertido, horas inválidas, sem horário de funcionamento', async () => {
    const b = { room_ids: 'all', hour_from: 8, hour_to: 10 };
    assert.equal((await adm('POST', '/api/admin/blocks', { ...b, date_from: '2026-11-10', date_to: '2026-11-02' })).status, 400);
    assert.equal((await adm('POST', '/api/admin/blocks', { ...b, hour_from: 10, hour_to: 8, date_from: '2026-11-10' })).status, 400);
    assert.equal((await adm('POST', '/api/admin/blocks', { ...b, date_from: '2026-11-08' })).status, 400, 'domingo: fechado');
  });
  console.log(`\n${pass} testes passaram${process.exitCode ? ' — HÁ FALHAS' : ' ✔'}`); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
