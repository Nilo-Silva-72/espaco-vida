'use strict';
// Regras da agenda: disponibilidade, criação de reservas (hora avulsa / módulos), cancelamento,
// confirmação de pagamento e notificações.
const { db, tx, getSettings, audit } = require('./db');
const U = require('./util');
const wa = require('./whatsapp');

const { bad, conflict, notFound, forbidden } = U;
const MODULE_LEN = { module4: 4, module8: 8 };
const METHOD_LABEL = {
  pix: 'Pix', card: 'Cartão', manual_pix: 'Pix (confirmado pelo gestor)', cash: 'Dinheiro', courtesy: 'Cortesia',
};
const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ---------- Horários ----------
const windowFor = (settings, date) => settings.hours?.[U.weekdayOf(date)] || null;
const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);

function activeRoom(roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND active = 1').get(Number(roomId));
  if (!room) throw bad('Sala inválida ou desativada.');
  return room;
}

function expireHoldsInner() {
  const rows = db.prepare(
    `SELECT id FROM bookings WHERE status='pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < ?`,
  ).all(U.isoNow());
  for (const r of rows) {
    db.prepare(`UPDATE bookings SET status='expired' WHERE id=?`).run(r.id);
    db.prepare(`DELETE FROM slots WHERE booking_id=?`).run(r.id);
  }
  return rows.length;
}
const expireHolds = () => tx(expireHoldsInner);

// ---------- Planejamento / validação ----------
/** Converte o pedido em um plano (lista de horários + valor), validando todas as regras. */
function planBooking(payload, settings, { isAdmin = false } = {}) {
  const type = String(payload.type || '');
  const room = activeRoom(payload.room_id);
  const now = U.nowLocal();
  const plan = { type, room_id: room.id, month: null, weekday: null, start_hour: null, items: [], amount_cents: 0 };

  if (type === 'hourly' || type === 'block') {
    if (type === 'block' && !isAdmin) throw forbidden();
    const date = payload.date;
    if (!U.isValidDate(date)) throw bad('Data inválida.');
    if (!isAdmin && date > U.addDays(now.date, settings.max_advance_days)) {
      throw bad(`Só é possível agendar com até ${settings.max_advance_days} dias de antecedência.`);
    }
    const win = windowFor(settings, date);
    if (!win) throw bad('O Espaço não atende neste dia.');
    const hours = [...new Set((Array.isArray(payload.hours) ? payload.hours : []).map(Number))];
    if (!hours.length) throw bad('Selecione pelo menos um horário.');
    if (hours.length > 12) throw bad('Máximo de 12 horas por agendamento.');
    for (const h of hours) {
      if (!Number.isInteger(h) || h < win[0] || h >= win[1]) throw bad(`O horário ${U.hh(h)} está fora do funcionamento (${U.hh(win[0])} às ${U.hh(win[1])}).`);
      if (!U.isFuture(date, h, now)) throw bad(`O horário ${U.hh(h)} de ${U.brDate(date)} já passou.`);
    }
    plan.items = hours.sort((a, b) => a - b).map((hour) => ({ date, hour }));
    plan.amount_cents = type === 'block' ? 0 : hours.length * settings.price_hour_cents;
  } else if (type in MODULE_LEN) {
    const len = MODULE_LEN[type];
    const weekday = Number(payload.weekday);
    const start = Number(payload.start_hour);
    const month = String(payload.month || '');
    if (!U.MONTH_RE.test(month)) throw bad('Mês inválido.');
    const thisMonth = now.date.slice(0, 7);
    if (month < thisMonth || month > U.addMonths(thisMonth, 3)) throw bad('Escolha o mês atual ou um dos próximos 3 meses.');
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw bad('Dia da semana inválido.');
    const sample = U.datesOfMonthWeekday(month, weekday)[0];
    const win = windowFor(settings, sample);
    if (!win) throw bad('O Espaço não atende neste dia da semana.');
    if (!Number.isInteger(start) || start < win[0] || start + len > win[1]) {
      throw bad(`O módulo de ${len} horas precisa caber entre ${U.hh(win[0])} e ${U.hh(win[1])} neste dia.`);
    }
    const dates = U.datesOfMonthWeekday(month, weekday).filter((d) => U.isFuture(d, start, now));
    if (!dates.length) throw bad('Não restam datas deste dia/horário no mês escolhido. Escolha o próximo mês.');
    plan.month = month; plan.weekday = weekday; plan.start_hour = start;
    plan.items = dates.flatMap((date) => range(start, len).map((hour) => ({ date, hour })));
    plan.amount_cents = type === 'module4' ? settings.price_module4_cents : settings.price_module8_cents;
  } else {
    throw bad('Tipo de reserva inválido.');
  }

  if (isAdmin && payload.amount_cents !== undefined && payload.amount_cents !== null && payload.amount_cents !== '') {
    const a = Number(payload.amount_cents);
    if (!Number.isInteger(a) || a < 0) throw bad('Valor inválido.');
    plan.amount_cents = a;
  }
  return plan;
}

function findConflicts(roomId, items) {
  const stmt = db.prepare('SELECT 1 FROM slots WHERE room_id=? AND date=? AND hour=?');
  return items.filter((i) => stmt.get(roomId, i.date, i.hour));
}

/** Cria a reserva e trava os horários de forma atômica. */
function createBooking(userId, plan, { origin = 'app', holdMinutes = 20, note = null } = {}) {
  return tx(() => {
    expireHoldsInner();
    const taken = findConflicts(plan.room_id, plan.items);
    if (taken.length) {
      const sample = taken.slice(0, 6).map((i) => `${U.brDate(i.date)} ${U.hh(i.hour)}`);
      throw conflict(
        plan.type.startsWith('module')
          ? 'Algumas datas deste módulo já estão ocupadas. Escolha outro dia/horário ou outra sala.'
          : 'Um ou mais horários acabaram de ser ocupados. Escolha outros horários.',
        { conflicts: sample },
      );
    }
    const now = U.isoNow();
    const status = plan.type === 'block' ? 'confirmed' : 'pending';
    const r = db.prepare(
      `INSERT INTO bookings (user_id, room_id, type, status, amount_cents, month, weekday, start_hour, items, hold_expires_at, note, origin, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      userId, plan.room_id, plan.type, status, plan.amount_cents, plan.month, plan.weekday, plan.start_hour,
      JSON.stringify(plan.items), status === 'pending' ? U.addMinutesISO(holdMinutes) : null, note, origin, now,
    );
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO slots (room_id, date, hour, booking_id) VALUES (?,?,?,?)');
    for (const i of plan.items) ins.run(plan.room_id, i.date, i.hour, id);
    return id;
  });
}

// ---------- Leitura / serialização ----------
const BOOKING_SELECT = `
  SELECT b.*, r.name AS room_name, u.name AS user_name, u.phone AS user_phone, u.email AS user_email, u.specialty AS user_specialty
  FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN users u ON u.id = b.user_id`;

const getBookingRow = (id) => db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id);

function describe(b) {
  const items = typeof b.items === 'string' ? JSON.parse(b.items) : b.items;
  const byDate = new Map();
  for (const i of items) byDate.set(i.date, [...(byDate.get(i.date) || []), i.hour]);
  if (b.type === 'hourly' || b.type === 'block') {
    const lines = [...byDate].map(([d, hs]) => `${U.WEEKDAYS[U.weekdayOf(d)].slice(0, 3)} ${U.brDate(d)} · ${U.hourRanges(hs)}`);
    return { title: b.type === 'hourly' ? `Hora avulsa (${items.length}h)` : 'Bloqueio', lines };
  }
  const len = MODULE_LEN[b.type];
  const days = [...byDate.keys()].map((d) => Number(d.slice(8)));
  return {
    title: `Módulo ${len} horas`,
    lines: [
      `${U.WEEKDAYS_PL[b.weekday]}, ${U.hh(b.start_hour)} às ${U.hh(b.start_hour + len)} · ${U.brMonth(b.month)}`,
      `Dias: ${days.join(', ')} (${days.length} ${days.length === 1 ? 'data' : 'datas'})`,
    ],
  };
}

function serialize(b, { admin = false } = {}) {
  const d = describe(b);
  const pay = db.prepare(`SELECT id, method, provider, status FROM payments WHERE booking_id=? ORDER BY (status='paid') DESC, id DESC LIMIT 1`).get(b.id);
  const out = {
    id: b.id, type: b.type, status: b.status, amount_cents: b.amount_cents, month: b.month, weekday: b.weekday,
    start_hour: b.start_hour, room_id: b.room_id, room_name: b.room_name, items: JSON.parse(b.items),
    title: d.title, lines: d.lines, hold_expires_at: b.hold_expires_at, paid_at: b.paid_at,
    receipt_url: b.status === 'confirmed' && b.receipt_code ? `/r/${b.receipt_code}` : null,
    cancel_requested: !!b.cancel_requested, created_at: b.created_at,
    payment: pay ? { id: pay.id, method: pay.method, method_label: METHOD_LABEL[pay.method] || pay.method, status: pay.status } : null,
  };
  if (admin) {
    Object.assign(out, {
      user_id: b.user_id, user_name: b.user_name, user_phone: b.user_phone, user_email: b.user_email,
      user_specialty: b.user_specialty, needs_attention: !!b.needs_attention, note: b.note, origin: b.origin,
    });
  }
  return out;
}

function listBookings({ userId, status, from, to, q, attention, limit = 300 } = {}) {
  const where = [];
  const args = [];
  if (userId) { where.push('b.user_id = ?'); args.push(userId); }
  if (status) { where.push('b.status = ?'); args.push(status); }
  if (attention) where.push('(b.needs_attention = 1 OR b.cancel_requested = 1)');
  if (q) { where.push('(u.name LIKE ? OR u.email LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  if (from) { where.push('b.id IN (SELECT booking_id FROM slots WHERE date >= ?) OR (b.status != \'confirmed\' AND b.created_at >= ?)'); args.push(from, from); }
  const sql = `${BOOKING_SELECT} ${where.length ? 'WHERE ' + where.map((w) => `(${w})`).join(' AND ') : ''} ORDER BY b.id DESC LIMIT ${Number(limit)}`;
  let rows = db.prepare(sql).all(...args);
  if (to) rows = rows.filter((b) => JSON.parse(b.items).some((i) => i.date <= to));
  return rows;
}

// ---------- Disponibilidade ----------
function availability(date, viewer) {
  expireHolds();
  const settings = getSettings();
  const win = windowFor(settings, date);
  const rooms = db.prepare('SELECT id, name, description FROM rooms WHERE active = 1 ORDER BY id').all();
  const taken = db.prepare(
    `SELECT sl.room_id, sl.hour, b.id AS bid, b.user_id, b.status, b.type, u.name
     FROM slots sl JOIN bookings b ON b.id = sl.booking_id JOIN users u ON u.id = b.user_id WHERE sl.date = ?`,
  ).all(date);
  const now = U.nowLocal();
  const isAdmin = viewer?.role === 'admin';
  const out = { date, weekday: U.weekdayOf(date), open: win?.[0] ?? null, close: win?.[1] ?? null, rooms: [] };
  for (const room of rooms) {
    const hours = [];
    if (win) {
      for (let h = win[0]; h < win[1]; h++) {
        const t = taken.find((x) => x.room_id === room.id && x.hour === h);
        const cell = { hour: h };
        if (t) {
          cell.state = t.user_id === viewer?.id ? 'mine' : 'busy';
          if (isAdmin) Object.assign(cell, { who: t.name, booking_id: t.bid, btype: t.type, bstatus: t.status });
        } else cell.state = U.isFuture(date, h, now) ? 'free' : 'past';
        hours.push(cell);
      }
    }
    out.rooms.push({ ...room, hours });
  }
  return out;
}

/** Para o módulo: quais combinações dia da semana × horário inicial estão livres no mês inteiro. */
function moduleOptions(type, month, roomId) {
  expireHolds();
  if (!(type in MODULE_LEN)) throw bad('Tipo de módulo inválido.');
  if (!U.MONTH_RE.test(String(month))) throw bad('Mês inválido.');
  const settings = getSettings();
  const room = activeRoom(roomId);
  const len = MODULE_LEN[type];
  const now = U.nowLocal();
  const days = [];
  for (let wd = 0; wd <= 6; wd++) {
    const dates = U.datesOfMonthWeekday(month, wd);
    const win = windowFor(settings, dates[0]);
    if (!win) continue;
    const starts = [];
    for (let s = win[0]; s + len <= win[1]; s++) {
      const future = dates.filter((d) => U.isFuture(d, s, now));
      const items = future.flatMap((date) => range(s, len).map((hour) => ({ date, hour })));
      const busy = future.length ? findConflicts(room.id, items) : [];
      starts.push({ start: s, end: s + len, dates: future.length, free: future.length > 0 && busy.length === 0, busy_dates: [...new Set(busy.map((i) => i.date))].length });
    }
    if (starts.length) days.push({ weekday: wd, name: U.WEEKDAYS[wd], starts });
  }
  return {
    type, month, room_id: room.id, price_cents: type === 'module4' ? settings.price_module4_cents : settings.price_module8_cents, days,
  };
}

// ---------- Cancelamento ----------
function cancelBooking(id, actor, { refunded = false, reason = '' } = {}) {
  const b = getBookingRow(id);
  if (!b) throw notFound('Reserva não encontrada.');
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && b.user_id !== actor.id) throw forbidden();
  if (b.status === 'cancelled' || b.status === 'expired') throw bad('Esta reserva já está encerrada.');

  if (!isAdmin && b.status === 'confirmed') {
    // Profissional só solicita; o gestor decide (reembolsos são feitos manualmente).
    if (b.cancel_requested) throw bad('O cancelamento já foi solicitado. Aguarde o retorno da administração.');
    db.prepare('UPDATE bookings SET cancel_requested = 1 WHERE id = ?').run(id);
    const s = getSettings();
    const d = describe(b);
    wa.enqueue({
      to: U.normalizePhone(s.admin_whatsapp), label: 'Administração', kind: 'admin', bookingId: id,
      body: `⚠️ *Pedido de cancelamento — ${s.business_name}*\n👤 ${b.user_name} (${fmtPhone(b.user_phone)})\n📌 ${d.title}\n${d.lines.join('\n')}\n🏠 ${b.room_name}\nAbra o painel para aprovar ou recusar.`,
      params: [b.user_name, `Pedido de cancelamento: ${d.title} — ${d.lines.join(' | ')}`, baseUrl()],
    });
    wa.dispatchQueued().catch(() => {});
    audit(actor.id, 'booking.cancel_request', `#${id}`);
    return { requested: true };
  }

  tx(() => {
    db.prepare(`UPDATE bookings SET status='cancelled', cancel_requested=0, needs_attention=0, hold_expires_at=NULL, note=? WHERE id=?`)
      .run(
        [b.note, isAdmin && b.status === 'confirmed' ? `Cancelado pelo gestor${reason ? ': ' + reason : ''}. ${refunded ? 'Reembolso realizado.' : 'Reembolso pendente/não aplicável.'}` : null]
          .filter(Boolean).join(' | ') || null,
        id,
      );
    db.prepare('DELETE FROM slots WHERE booking_id = ?').run(id);
    db.prepare(`UPDATE payments SET status='cancelled' WHERE booking_id = ? AND status='pending'`).run(id);
  });
  audit(actor.id, 'booking.cancel', `#${id}`);
  return { cancelled: true };
}

// ---------- Pagamento confirmado ----------
const fmtPhone = (p) => {
  const d = String(p || '');
  return d.length >= 12 ? `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, d.length - 4)}-${d.slice(-4)}` : d;
};

/** Marca o pagamento como pago e confirma a reserva. Idempotente e seguro contra pagamento tardio/duplicado. */
function markPaid(paymentId, { providerRef } = {}) {
  const result = tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p) throw notFound('Pagamento não encontrado.');
    if (p.status === 'paid') return { kind: 'already', bookingId: p.booking_id };
    const now = U.isoNow();
    db.prepare(`UPDATE payments SET status='paid', paid_at=?, provider_ref=COALESCE(?, provider_ref) WHERE id=?`).run(now, providerRef ?? null, p.id);
    db.prepare(`UPDATE payments SET status='cancelled' WHERE booking_id=? AND id<>? AND status='pending'`).run(p.booking_id, p.id);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(p.booking_id);

    const flag = (msg) => db.prepare(`UPDATE bookings SET needs_attention=1, note=? WHERE id=?`).run([b.note, msg].filter(Boolean).join(' | '), b.id);
    if (b.status === 'confirmed') {
      flag(`Pagamento duplicado recebido (#${p.id}) — reembolsar.`);
      return { kind: 'duplicate', bookingId: b.id, paymentId: p.id };
    }
    if (b.status !== 'pending') {
      // Pagamento chegou depois de expirar/cancelar: tenta recuperar os horários.
      const items = JSON.parse(b.items);
      if (findConflicts(b.room_id, items).length) {
        flag(`Pagamento recebido (#${p.id}) após a reserva expirar e os horários já foram ocupados — reembolsar.`);
        return { kind: 'late_conflict', bookingId: b.id, paymentId: p.id };
      }
      const ins = db.prepare('INSERT INTO slots (room_id, date, hour, booking_id) VALUES (?,?,?,?)');
      for (const i of items) ins.run(b.room_id, i.date, i.hour, b.id);
    }
    db.prepare(`UPDATE bookings SET status='confirmed', paid_at=?, hold_expires_at=NULL, needs_attention=0,
                receipt_code=COALESCE(receipt_code, ?) WHERE id=?`).run(now, U.randomCode(10), b.id);
    return { kind: 'confirmed', bookingId: b.id, paymentId: p.id };
  });

  if (result.kind !== 'already') notifyPayment(result);
  return result;
}

function notifyPayment(result) {
  const s = getSettings();
  const b = getBookingRow(result.bookingId);
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(result.paymentId);
  const d = describe(b);
  const link = b.receipt_code ? `${baseUrl()}/r/${b.receipt_code}` : baseUrl();
  const adminPhone = U.normalizePhone(s.admin_whatsapp);
  const value = U.brl(pay?.amount_cents ?? b.amount_cents);
  const method = METHOD_LABEL[pay?.method] || '—';

  if (result.kind === 'confirmed') {
    const first = b.user_name.split(' ')[0];
    wa.enqueue({
      to: b.user_phone, label: b.user_name, kind: 'professional', bookingId: b.id,
      body: `✅ *Pagamento confirmado — ${s.business_name}*\nOlá, ${first}! Recebemos o seu pagamento de *${value}*.\n\n📌 ${d.title}\n${d.lines.join('\n')}\n🏠 ${b.room_name}\n💳 ${method}\n\n🧾 Comprovante: ${link}\nQualquer dúvida, é só responder esta mensagem.`,
      params: [first, `${d.title} — ${d.lines.join(' | ')} — ${b.room_name} — ${value}`, link],
    });
    wa.enqueue({
      to: adminPhone, label: 'Administração', kind: 'admin', bookingId: b.id,
      body: `💰 *Novo pagamento recebido — ${s.business_name}*\n👤 ${b.user_name}${b.user_specialty ? ' · ' + b.user_specialty : ''}\n📱 ${fmtPhone(b.user_phone)}\n📌 ${d.title}\n${d.lines.join('\n')}\n🏠 ${b.room_name}\n💳 ${method} — *${value}*\n\n🧾 Comprovante: ${link}`,
      params: [`${b.user_name} (${fmtPhone(b.user_phone)})`, `${d.title} — ${d.lines.join(' | ')} — ${b.room_name} — ${value} (${method})`, link],
    });
  } else {
    const why = result.kind === 'duplicate' ? 'Pagamento DUPLICADO' : 'Pagamento recebido com horários indisponíveis';
    wa.enqueue({
      to: adminPhone, label: 'Administração', kind: 'admin', bookingId: b.id,
      body: `🚨 *${why} — ${s.business_name}*\n👤 ${b.user_name} (${fmtPhone(b.user_phone)})\n📌 ${d.title}\n${d.lines.join('\n')}\n💳 ${method} — ${value}\nÉ necessário reembolsar/resolver manualmente no painel.`,
      params: [b.user_name, `${why}: ${d.title} — ${value}`, baseUrl()],
    });
  }
  wa.dispatchQueued().catch((e) => console.error('WhatsApp:', e.message));
}

/** Confirmação manual feita pelo gestor (dinheiro, Pix direto na conta, cortesia). */
function confirmManually(bookingId, method, actor) {
  const b = getBookingRow(bookingId);
  if (!b) throw notFound('Reserva não encontrada.');
  if (!['manual_pix', 'cash', 'courtesy'].includes(method)) throw bad('Forma de pagamento inválida.');
  if (b.status === 'confirmed') throw bad('Esta reserva já está confirmada.');
  const r = db.prepare(
    `INSERT INTO payments (booking_id, method, provider, status, amount_cents, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(b.id, method, 'manual', 'pending', method === 'courtesy' ? 0 : b.amount_cents, U.isoNow());
  const res = markPaid(Number(r.lastInsertRowid));
  audit(actor.id, 'booking.confirm_manual', `#${b.id} ${method}`);
  return res;
}

// ---------- Painel do gestor ----------
function dashboard() {
  expireHolds();
  const settings = getSettings();
  const now = U.nowLocal();
  const month = now.date.slice(0, 7);

  const paid = db.prepare(`SELECT amount_cents, paid_at FROM payments WHERE status='paid' AND paid_at >= ?`).all(U.addMinutesISO(-62 * 1440));
  const revenue = paid.filter((p) => U.nowLocal(new Date(p.paid_at)).date.startsWith(month)).reduce((a, p) => a + p.amount_cents, 0);

  let capacity = 0;
  const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE active=1').get().n;
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    const win = windowFor(settings, `${month}-${U.pad(d)}`);
    if (win) capacity += (win[1] - win[0]) * roomCount;
  }
  const booked = db.prepare(
    `SELECT COUNT(*) AS n FROM slots sl JOIN bookings b ON b.id=sl.booking_id WHERE sl.date LIKE ? AND b.status='confirmed' AND b.type != 'block'`,
  ).get(`${month}-%`).n;

  const today = db.prepare(
    `SELECT sl.room_id, r.name AS room, sl.hour, b.type, b.status, u.name AS who
     FROM slots sl JOIN bookings b ON b.id=sl.booking_id JOIN rooms r ON r.id=sl.room_id JOIN users u ON u.id=b.user_id
     WHERE sl.date = ? ORDER BY sl.room_id, sl.hour`,
  ).all(now.date);
  const grouped = [];
  for (const t of today) {
    const last = grouped[grouped.length - 1];
    if (last && last.room_id === t.room_id && last.booking_key === `${t.who}|${t.type}|${t.status}` && last.end === t.hour) last.end = t.hour + 1;
    else grouped.push({ room_id: t.room_id, room: t.room, who: t.who, type: t.type, status: t.status, start: t.hour, end: t.hour + 1, booking_key: `${t.who}|${t.type}|${t.status}` });
  }
  grouped.sort((a, b) => a.start - b.start);

  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    month, revenue_cents: revenue,
    occupancy_pct: capacity ? Math.round((booked / capacity) * 100) : 0,
    confirmed_upcoming: count(`SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed' AND type!='block' AND id IN (SELECT booking_id FROM slots WHERE date >= ?)`, now.date),
    pending: count(`SELECT COUNT(*) AS n FROM bookings WHERE status='pending'`),
    attention: count(`SELECT COUNT(*) AS n FROM bookings WHERE needs_attention=1 OR cancel_requested=1`),
    users_active: count(`SELECT COUNT(*) AS n FROM users WHERE role='user' AND status='active'`),
    users_pending: count(`SELECT COUNT(*) AS n FROM users WHERE status='pending'`),
    outbox_failed: count(`SELECT COUNT(*) AS n FROM outbox WHERE status='failed'`),
    outbox_manual: count(`SELECT COUNT(*) AS n FROM outbox WHERE status='manual'`),
    today: grouped.map(({ booking_key, ...g }) => g),
  };
}

module.exports = {
  MODULE_LEN, METHOD_LABEL, baseUrl, fmtPhone, windowFor, expireHolds, planBooking, createBooking, getBookingRow, listBookings,
  serialize, describe, availability, moduleOptions, cancelBooking, markPaid, confirmManually, dashboard,
};
