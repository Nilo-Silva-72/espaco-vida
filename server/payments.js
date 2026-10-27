'use strict';
// Cobrança. PAYMENT_PROVIDER=mock (demonstração, padrão) | mercadopago (Pix + cartão reais).
// O horário só é liberado (reserva "confirmed") depois que o pagamento é confirmado — ver bookings.markPaid().
const crypto = require('node:crypto');
const { db, getSettings } = require('./db');
const U = require('./util');
const B = require('./bookings');

const { HttpError, bad, conflict, notFound, forbidden } = U;
const provider = () => (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
const MAX_ATTEMPTS = 4;

function status() {
  const p = provider();
  return {
    provider: p,
    demo: p === 'mock',
    configured: p === 'mock' || (p === 'mercadopago' && !!process.env.MP_ACCESS_TOKEN),
    webhook_url: `${B.baseUrl()}/api/webhooks/mercadopago`,
  };
}

// ---------- Mercado Pago ----------
async function mp(path, { method = 'GET', body, idempotency } = {}) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado.');
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      ...(idempotency ? { 'X-Idempotency-Key': idempotency } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `Mercado Pago HTTP ${res.status}`);
  return data;
}
const isHttps = () => B.baseUrl().startsWith('https://');

async function mpCreatePix(booking, user, payment, expiresAt) {
  const [first, ...rest] = user.name.split(' ');
  const data = await mp('/v1/payments', {
    method: 'POST', idempotency: `ev-pay-${payment.id}`,
    body: {
      transaction_amount: payment.amount_cents / 100,
      description: `${getSettings().business_name} — reserva #${booking.id}`.slice(0, 200),
      payment_method_id: 'pix',
      external_reference: String(payment.id),
      date_of_expiration: expiresAt.replace('Z', '+00:00'),
      ...(isHttps() ? { notification_url: `${B.baseUrl()}/api/webhooks/mercadopago` } : {}),
      payer: {
        email: user.email, first_name: first, last_name: rest.join(' ') || first,
        ...(user.document ? { identification: { type: 'CPF', number: user.document } } : {}),
      },
    },
  });
  const t = data.point_of_interaction?.transaction_data;
  if (!t?.qr_code) throw new Error('Mercado Pago não retornou o código Pix.');
  return { providerRef: String(data.id), pixCode: t.qr_code, pixQr: t.qr_code_base64 ? `data:image/png;base64,${t.qr_code_base64}` : null };
}

async function mpCreateCardCheckout(booking, user, payment, expiresAt) {
  const back = `${B.baseUrl()}/#/reservas`;
  const data = await mp('/checkout/preferences', {
    method: 'POST',
    body: {
      items: [{ title: `${getSettings().business_name} — ${B.describe(booking).title}`.slice(0, 250), quantity: 1, currency_id: 'BRL', unit_price: payment.amount_cents / 100 }],
      payer: { email: user.email, name: user.name },
      external_reference: String(payment.id),
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'bank_transfer' }] }, // só cartão
      expires: true, expiration_date_to: expiresAt.replace('Z', '+00:00'),
      ...(isHttps() ? { notification_url: `${B.baseUrl()}/api/webhooks/mercadopago`, back_urls: { success: back, pending: back, failure: back }, auto_return: 'approved' } : {}),
    },
  });
  if (!data.init_point) throw new Error('Mercado Pago não retornou o link de pagamento.');
  return { providerRef: String(data.id), checkoutUrl: data.init_point };
}

// ---------- Fluxo comum ----------
async function startPayment(bookingId, user, method) {
  const settings = getSettings();
  if (!['pix', 'card'].includes(method) || !settings.methods?.[method]) throw bad('Forma de pagamento indisponível.');
  const booking = B.getBookingRow(bookingId);
  if (!booking) throw notFound('Reserva não encontrada.');
  if (booking.user_id !== user.id) throw forbidden();
  B.expireHolds();
  const fresh = B.getBookingRow(bookingId);
  if (fresh.status === 'confirmed') throw bad('Esta reserva já foi paga.');
  if (fresh.status !== 'pending') throw conflict('O tempo para pagamento expirou. Escolha o horário novamente.');
  if (fresh.amount_cents <= 0) throw bad('Reserva sem valor a cobrar.');

  // Reaproveita cobrança em aberto do mesmo tipo (ex.: recarregou a página)
  const existing = db.prepare(`SELECT * FROM payments WHERE booking_id=? AND method=? AND status='pending' ORDER BY id DESC LIMIT 1`).get(bookingId, method);
  if (existing && (!existing.expires_at || existing.expires_at > U.isoNow())) return publicPayment(existing);
  const attempts = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE booking_id=?').get(bookingId).n;
  if (attempts >= MAX_ATTEMPTS) throw bad('Muitas tentativas de pagamento. Refaça o agendamento.');

  // Estende o prazo da reserva para dar tempo de pagar
  const expiresAt = U.addMinutesISO(settings.hold_minutes);
  db.prepare('UPDATE bookings SET hold_expires_at = ? WHERE id = ?').run(expiresAt, bookingId);
  const ins = db.prepare(
    `INSERT INTO payments (booking_id, method, provider, status, amount_cents, expires_at, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(bookingId, method, provider(), 'pending', fresh.amount_cents, expiresAt, U.isoNow());
  const paymentId = Number(ins.lastInsertRowid);
  const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);

  try {
    let info;
    if (provider() === 'mercadopago') {
      info = method === 'pix' ? await mpCreatePix(fresh, user, payment, expiresAt) : await mpCreateCardCheckout(fresh, user, payment, expiresAt);
    } else if (method === 'pix') {
      info = { providerRef: `mock-${paymentId}`, pixCode: `DEMO-PIX-${crypto.randomBytes(8).toString('hex').toUpperCase()}-NAO-PAGAVEL`, pixQr: null };
    } else {
      info = { providerRef: `mock-${paymentId}`, checkoutUrl: null };
    }
    db.prepare('UPDATE payments SET provider_ref=?, pix_code=?, pix_qr=?, checkout_url=? WHERE id=?')
      .run(info.providerRef ?? null, info.pixCode ?? null, info.pixQr ?? null, info.checkoutUrl ?? null, paymentId);
  } catch (e) {
    console.error('Falha ao criar cobrança:', e.message);
    db.prepare(`UPDATE payments SET status='failed' WHERE id=?`).run(paymentId);
    throw new HttpError(502, 'Não foi possível gerar a cobrança agora. Tente novamente em instantes.');
  }
  return publicPayment(db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId));
}

function publicPayment(p) {
  return {
    id: p.id, booking_id: p.booking_id, method: p.method, status: p.status, amount_cents: p.amount_cents,
    pix_code: p.pix_code, pix_qr: p.pix_qr, checkout_url: p.checkout_url, expires_at: p.expires_at, demo: p.provider === 'mock',
  };
}

const lastCheck = new Map();
/** Consulta o gateway (alternativa ao webhook) e confirma se já foi pago. */
async function refreshPayment(paymentId) {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  if (!p) throw notFound();
  if (p.status !== 'pending' || p.provider !== 'mercadopago') return p;
  const last = lastCheck.get(paymentId) || 0;
  if (Date.now() - last < 4000) return p;
  lastCheck.set(paymentId, Date.now());
  try {
    let found = null;
    if (p.method === 'pix' && p.provider_ref) found = await mp(`/v1/payments/${p.provider_ref}`);
    else {
      const r = await mp(`/v1/payments/search?external_reference=${p.id}&sort=date_created&criteria=desc`);
      found = (r.results || []).find((x) => x.status === 'approved') || null;
    }
    if (found && found.status === 'approved' && Math.round(found.transaction_amount * 100) === p.amount_cents) {
      B.markPaid(p.id, { providerRef: String(found.id) });
    }
  } catch (e) {
    console.error('Consulta de pagamento falhou:', e.message);
  }
  return db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
}

/** Webhook do Mercado Pago: nunca confia no corpo — sempre reconsulta o pagamento na API. */
async function handleMercadoPagoWebhook(query, body) {
  if (provider() !== 'mercadopago') return;
  const type = query.type || query.topic || body?.type;
  if (type && type !== 'payment') return;
  const id = query['data.id'] || body?.data?.id || query.id;
  if (!id) return;
  const found = await mp(`/v1/payments/${encodeURIComponent(id)}`);
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(found.external_reference));
  if (!payment) return;
  if (found.status === 'approved' && Math.round(found.transaction_amount * 100) === payment.amount_cents) {
    B.markPaid(payment.id, { providerRef: String(found.id) });
  }
}

/** Somente modo demonstração: simula a confirmação do pagamento. */
function mockConfirm(paymentId, user) {
  if (provider() !== 'mock') throw forbidden('Disponível apenas no modo demonstração.');
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  if (!p) throw notFound();
  const b = B.getBookingRow(p.booking_id);
  if (b.user_id !== user.id && user.role !== 'admin') throw forbidden();
  return B.markPaid(paymentId);
}

module.exports = { status, startPayment, publicPayment, refreshPayment, handleMercadoPagoWebhook, mockConfirm, provider };
