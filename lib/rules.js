'use strict';
// Regras de negócio: disponibilidade, cotação, reserva, confirmação de pagamento, cancelamento.
const { db, setting, tx, audit } = require('./db');
const U = require('./util');
const { HttpError } = U;

const TYPE_LABEL = { avulsa: 'Hora avulsa', mod4: 'Módulo 4 horas', mod8: 'Módulo 8 horas', bloqueio: 'Bloqueio' };
const MOD_HOURS = { mod4: 4, mod8: 8 };

function hoursOf(date) { // [início, fim) do dia, ou null se fechado
  const h = setting('hours')[U.weekdayOf(date)];
  return Array.isArray(h) ? h : null;
}
function isOpenHour(date, hour) { const h = hoursOf(date); return !!h && hour >= h[0] && hour < h[1]; }

// Libera reservas não pagas cujo prazo venceu
function purgeExpired() {
  const now = Date.now();
  tx(() => {
    const rows = db.prepare("SELECT id FROM bookings WHERE status='pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < ?").all(now);
    for (const r of rows) {
      db.prepare("UPDATE bookings SET status='expired' WHERE id=?").run(r.id);
      db.prepare('DELETE FROM slots WHERE booking_id=?').run(r.id);
    }
  });
}

function roomOrThrow(id) {
  const r = db.prepare('SELECT * FROM rooms WHERE id=? AND active=1').get(Number(id));
  if (!r) throw new HttpError(400, 'Sala não encontrada ou inativa.');
  return r;
}
function takenSet(roomId, from, to) {
  const rows = db.prepare('SELECT date,hour FROM slots WHERE room_id=? AND date>=? AND date<=?').all(roomId, from, to);
  return new Set(rows.map((r) => `${r.date}|${r.hour}`));
}
const nextMonthOf = (m) => { const [y, mm] = m.split('-').map(Number); return U.fmtDate(new Date(Date.UTC(y, mm, 1))).slice(0, 7); };

// Prioridade de renovação: até o dia `renewal_day`, os horários do mês seguinte que pertencem a módulos
// ainda não renovados ficam reservados aos titulares. Devolve fn(date,hour)=>true se estiver bloqueado para `userId`.
function renewalWindow() {
  const today = U.todayStr(); const day = Number(today.slice(8));
  if (day >= setting('renewal_day')) return null;
  return { cur: today.slice(0, 7), next: nextMonthOf(today.slice(0, 7)) };
}
function protector(roomId, userId) {
  const w = renewalWindow(); if (!w) return () => false;
  const rows = db.prepare("SELECT * FROM bookings WHERE room_id=? AND type IN ('mod4','mod8') AND status IN ('paid','pending')").all(roomId).map(parseBooking);
  const renewed = new Set(rows.filter((b) => b.meta.month === w.next).map((b) => `${b.user_id}|${b.meta.weekday}|${b.meta.start_hour}`));
  const pats = rows.filter((b) => b.status === 'paid' && b.meta.month === w.cur && b.user_id !== userId && !renewed.has(`${b.user_id}|${b.meta.weekday}|${b.meta.start_hour}`))
    .map((b) => ({ wd: b.meta.weekday, s: b.meta.start_hour, e: b.meta.start_hour + MOD_HOURS[b.type] }));
  return (date, hour) => date.slice(0, 7) === w.next && pats.some((p) => U.weekdayOf(date) === p.wd && hour >= p.s && hour < p.e);
}
const protectedMsg = (date, hour) => `${U.brDate(date)} ${U.hh(hour)} está reservado para a renovação de outro profissional até o dia ${setting('renewal_day')}. Depois dessa data, se não for renovado, ele é liberado.`;

function slotAllowedError(date, hour, taken, prot) { // retorna texto de erro ou null
  if (!U.isDate(date) || !Number.isInteger(hour)) return 'Horário inválido.';
  if (!isOpenHour(date, hour)) return `${U.brDate(date)} ${U.hh(hour)} está fora do horário de funcionamento.`;
  if (U.stamp(date, hour) < U.nowStamp(setting('min_notice_hours'))) return `${U.brDate(date)} ${U.hh(hour)} já passou ou está sem a antecedência mínima.`;
  if (date > U.addDays(U.todayStr(), setting('horizon_days'))) return `${U.brDate(date)} está além do prazo máximo de agendamento.`;
  if (taken.has(`${date}|${hour}`)) return `${U.brDate(date)} ${U.hh(hour)} já está ocupado.`;
  if (prot && prot(date, hour)) return protectedMsg(date, hour);
  return null;
}

// Disponibilidade por dia (para a tela de agendamento)
function availability(roomId, from, to, userId) {
  purgeExpired(); roomOrThrow(roomId); const prot = protector(Number(roomId), userId);
  if (!U.isDate(from) || !U.isDate(to) || to < from || U.parseDate(to) - U.parseDate(from) > 93 * 864e5) throw new HttpError(400, 'Período inválido.');
  const taken = takenSet(roomId, from, to); const days = {};
  for (let d = from; d <= to; d = U.addDays(d, 1)) {
    const open = hoursOf(d); const free = []; const busy = [];
    if (open) for (let h = open[0]; h < open[1]; h++) (slotAllowedError(d, h, taken, prot) ? busy : free).push(h);
    days[d] = { open, free, busy };
  }
  return days;
}

// Cotação de uma reserva. Devolve {type,amount,slots,summary,...} sem gravar nada.
function quote(input, userId) {
  const type = input.type; const room = roomOrThrow(input.room_id); const prot = protector(room.id, userId);
  const taken = takenSet(room.id, U.todayStr(), U.addDays(U.todayStr(), 400));
  const errors = []; let slots = [];
  if (type === 'avulsa') {
    const list = Array.isArray(input.slots) ? input.slots : [];
    if (!list.length) throw new HttpError(400, 'Escolha pelo menos um horário.');
    const max = setting('max_hours_per_booking');
    if (list.length > max) throw new HttpError(400, `Máximo de ${max} horas por pedido.`);
    const seen = new Set();
    for (const s of list) {
      const date = s && s.date; const hour = Number(s && s.hour); const key = `${date}|${hour}`;
      if (seen.has(key)) continue; seen.add(key);
      const e = slotAllowedError(date, hour, taken, prot); if (e) errors.push(e); else slots.push({ date, hour });
    }
    slots.sort((a, b) => U.stamp(a.date, a.hour).localeCompare(U.stamp(b.date, b.hour)));
    const amount = slots.length * setting('price_hour');
    if (errors.length) throw new HttpError(409, errors[0]);
    return { type, room, amount, slots, title: `${slots.length}h avulsa${slots.length > 1 ? 's' : ''}`,
      detail: slots.map((s) => `${U.brDate(s.date)} ${U.hh(s.hour)}`).join(' · ') };
  }
  if (type === 'mod4' || type === 'mod8') {
    const len = MOD_HOURS[type]; const month = input.month; const wd = Number(input.weekday); const start = Number(input.start_hour);
    if (!U.isMonth(month)) throw new HttpError(400, 'Mês inválido.');
    const thisMonth = U.todayStr().slice(0, 7);
    const maxMonth = nextMonthOf(thisMonth);
    if (month < thisMonth || month > maxMonth) throw new HttpError(400, 'Escolha o mês atual ou o próximo.');
    if (!(wd >= 1 && wd <= 6) || !Number.isInteger(start)) throw new HttpError(400, 'Escolha o dia da semana e o horário inicial.');
    const all = U.datesOfWeekdayInMonth(month, wd);
    const dates = all.filter((d) => U.stamp(d, start) >= U.nowStamp(setting('min_notice_hours')));
    if (!dates.length) throw new HttpError(409, 'Não restam datas disponíveis para esse dia da semana neste mês.');
    for (const d of dates) {
      for (let h = start; h < start + len; h++) {
        if (!isOpenHour(d, h)) throw new HttpError(409, `${U.WD_FULL[wd]} não comporta ${len} horas seguidas a partir de ${U.hh(start)} (funcionamento ${hoursOf(d) ? U.hh(hoursOf(d)[0]) + ' às ' + U.hh(hoursOf(d)[1]) : 'fechado'}).`);
        if (taken.has(`${d}|${h}`)) throw new HttpError(409, `${U.brDate(d)} ${U.hh(h)} já está ocupado. Escolha outro dia/horário.`);
        if (prot(d, h)) throw new HttpError(409, protectedMsg(d, h));
        slots.push({ date: d, hour: h });
      }
    }
    const full = setting(type === 'mod4' ? 'price_mod4' : 'price_mod8');
    const amount = dates.length === all.length ? full : Math.round(full * dates.length / all.length);
    return { type, room, amount, slots, month, weekday: wd, start_hour: start, dates, total_dates: all.length, full_price: full,
      title: `${TYPE_LABEL[type]} · ${U.WD[wd]} ${U.hh(start)}–${U.hh(start + len)}`,
      detail: `${U.monthLabel(month)} · ${dates.length} data${dates.length > 1 ? 's' : ''}: ${dates.map((d) => d.slice(8) + '/' + d.slice(5, 7)).join(', ')}` +
        (dates.length !== all.length ? ` (valor proporcional: ${dates.length} de ${all.length} datas do mês)` : '') };
  }
  throw new HttpError(400, 'Tipo de serviço inválido.');
}

// Quais horários iniciais de módulo estão livres em cada dia da semana (para a tela)
function moduleOptions(roomId, type, month, userId) {
  purgeExpired(); const len = MOD_HOURS[type]; if (!len) throw new HttpError(400, 'Tipo inválido.');
  const out = {};
  for (let wd = 1; wd <= 6; wd++) {
    out[wd] = [];
    const sample = U.datesOfWeekdayInMonth(month, wd)[0]; const open = sample && hoursOf(sample);
    if (!open) continue;
    for (let start = open[0]; start + len <= open[1]; start++) {
      try { quote({ type, room_id: roomId, month, weekday: wd, start_hour: start }, userId); out[wd].push(start); } catch {}
    }
  }
  return out;
}

// Cria a reserva "pendente" segurando os horários até o prazo de pagamento
function createBooking(userId, input) {
  purgeExpired();
  return tx(() => {
    const q = quote(input, userId);
    const hold = Date.now() + setting('hold_minutes') * 60e3;
    const meta = { title: q.title, detail: q.detail, slots: q.slots, month: q.month, weekday: q.weekday, start_hour: q.start_hour };
    const r = db.prepare('INSERT INTO bookings(user_id,room_id,type,amount_cents,status,hold_expires_at,meta) VALUES(?,?,?,?,?,?,?)')
      .run(userId, q.room.id, q.type, q.amount, 'pending', hold, JSON.stringify(meta));
    const id = Number(r.lastInsertRowid); const ins = db.prepare('INSERT INTO slots(booking_id,room_id,date,hour) VALUES(?,?,?,?)');
    try { for (const s of q.slots) ins.run(id, q.room.id, s.date, s.hour); }
    catch (e) { if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Alguém acabou de reservar um desses horários. Escolha outro.'); throw e; }
    return getBooking(id);
  });
}

function parseBooking(b) { if (!b) return null; return { ...b, meta: JSON.parse(b.meta || '{}') }; }
function getBooking(id) { return parseBooking(db.prepare('SELECT * FROM bookings WHERE id=?').get(id)); }

// Confirma pagamento (idempotente). Se a reserva já expirou, tenta reaver os horários.
function confirmPayment(id, { method, ref, by } = {}) {
  const res = tx(() => {
    const b = getBooking(id); if (!b) throw new HttpError(404, 'Reserva não encontrada.');
    if (b.status === 'paid') return { booking: b, already: true };
    if (b.status === 'cancelled') { db.prepare("UPDATE bookings SET status='refund_needed', pay_method=?, provider_ref=? WHERE id=?").run(method || null, ref || null, id); return { booking: getBooking(id), conflict: true }; }
    if (b.status === 'refund_needed') return { booking: b, already: true };
    if (b.status === 'expired') {
      try { const ins = db.prepare('INSERT INTO slots(booking_id,room_id,date,hour) VALUES(?,?,?,?)'); for (const s of b.meta.slots) ins.run(id, b.room_id, s.date, s.hour); }
      catch (e) {
        db.prepare('DELETE FROM slots WHERE booking_id=?').run(id);
        db.prepare("UPDATE bookings SET status='refund_needed', pay_method=?, provider_ref=?, paid_at=datetime('now') WHERE id=?").run(method || null, ref || null, id);
        audit(by, 'payment_conflict', `reserva ${id}`);
        return { booking: getBooking(id), conflict: true };
      }
    }
    db.prepare("UPDATE bookings SET status='paid', paid_at=datetime('now'), hold_expires_at=NULL, pay_method=?, provider_ref=?, receipt_code=? WHERE id=?")
      .run(method || null, ref || null, U.receiptCode(), id);
    audit(by, 'payment_confirmed', `reserva ${id} via ${method || '?'}`);
    return { booking: getBooking(id) };
  });
  return res;
}

function cancelBooking(id, { by, reason, byAdmin }) {
  return tx(() => {
    const b = getBooking(id); if (!b) throw new HttpError(404, 'Reserva não encontrada.');
    if (['cancelled', 'expired'].includes(b.status)) throw new HttpError(400, 'Esta reserva já está encerrada.');
    let refund = null;
    if (b.status === 'paid' && b.amount_cents > 0) {
      if (!byAdmin) {
        if (b.type !== 'avulsa') throw new HttpError(403, 'Módulos só podem ser cancelados pela administração. Fale com o Espaço.');
        const first = b.meta.slots.map((s) => U.stamp(s.date, s.hour)).sort()[0];
        if (first < U.nowStamp(setting('cancel_hours'))) throw new HttpError(403, `Cancelamento permitido até ${setting('cancel_hours')}h antes do primeiro horário. Fale com o Espaço.`);
      }
      refund = 'solicitado';
    }
    db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=datetime('now'), cancel_reason=?, refund_status=?, hold_expires_at=NULL WHERE id=?")
      .run(U.clean(reason, 200) || null, refund, id);
    db.prepare('DELETE FROM slots WHERE booking_id=?').run(id);
    audit(by, 'booking_cancelled', `reserva ${id}${byAdmin ? ' (gestor)' : ''}`);
    return getBooking(id);
  });
}

// ---- Renovação de módulos ----
// Informa se um módulo pago pode ser renovado agora (e para qual mês).
function renewInfo(b) {
  if (!['mod4', 'mod8'].includes(b.type) || b.status !== 'paid' || !b.meta.month) return null;
  const cur = U.todayStr().slice(0, 7); const next = nextMonthOf(cur); const target = nextMonthOf(b.meta.month);
  if (target < cur || target > next) return null;
  const done = db.prepare("SELECT * FROM bookings WHERE user_id=? AND room_id=? AND type=? AND status IN ('pending','paid')").all(b.user_id, b.room_id, b.type).map(parseBooking)
    .some((x) => x.meta.month === target && x.meta.weekday === b.meta.weekday && x.meta.start_hour === b.meta.start_hour);
  if (done) return null;
  return { month: target, label: U.monthLabel(target) };
}
function renewBooking(userId, bookingId) {
  const b = getBooking(bookingId); if (!b || b.user_id !== userId) throw new HttpError(404, 'Reserva não encontrada.');
  const info = renewInfo(b); if (!info) throw new HttpError(409, 'Este módulo já foi renovado ou não pode ser renovado agora.');
  return createBooking(userId, { type: b.type, room_id: b.room_id, month: info.month, weekday: b.meta.weekday, start_hour: b.meta.start_hour });
}
// Lista para a gestão: módulos do mês atual e se já foram renovados
function renewalsList() {
  const cur = U.todayStr().slice(0, 7); const next = nextMonthOf(cur); const day = Number(U.todayStr().slice(8)); const rd = setting('renewal_day');
  const rows = db.prepare("SELECT * FROM bookings WHERE type IN ('mod4','mod8') AND status IN ('paid','pending')").all().map(parseBooking);
  const items = rows.filter((b) => b.status === 'paid' && b.meta.month === cur).map((b) => {
    const r = rows.find((x) => x.user_id === b.user_id && x.room_id === b.room_id && x.type === b.type && x.meta.month === next && x.meta.weekday === b.meta.weekday && x.meta.start_hour === b.meta.start_hour);
    const u = db.prepare('SELECT name,phone,specialty FROM users WHERE id=?').get(b.user_id); const room = db.prepare('SELECT name FROM rooms WHERE id=?').get(b.room_id);
    return { booking_id: b.id, user_id: b.user_id, user_name: u.name, user_phone: u.phone, specialty: u.specialty, room: room.name, title: b.meta.title,
      renewed: !!r && r.status === 'paid', awaiting_payment: !!r && r.status === 'pending', month: cur, next_month: next };
  }).sort((a, b) => Number(a.renewed) - Number(b.renewed) || a.user_name.localeCompare(b.user_name));
  return { items, cur, next, day, renewal_day: rd, priority_open: day < rd, reminder_from: Math.max(1, rd - setting('reminder_days')),
    deadline: `${cur}-${U.pad(rd)}`, pending_count: items.filter((i) => !i.renewed).length };
}

module.exports = { renewInfo, renewBooking, renewalsList, nextMonthOf, TYPE_LABEL, hoursOf, availability, quote, moduleOptions, createBooking, getBooking, parseBooking, confirmPayment, cancelBooking, purgeExpired, roomOrThrow };
