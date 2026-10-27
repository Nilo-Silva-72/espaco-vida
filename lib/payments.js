'use strict';
// Cobrança: Mercado Pago (Pix + cartão) ou modo simulado para testes.
const crypto = require('node:crypto');
const { setting } = require('./db');
const { HttpError, money } = require('./util');

const isSimulated = () => setting('payment_provider') !== 'mercadopago';
function baseUrl(req) {
  const b = (setting('base_url') || process.env.BASE_URL || '').replace(/\/+$/, '');
  if (b) return b;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

async function mp(path, method, body, idem) {
  const token = setting('mp_access_token');
  if (!token) throw new HttpError(500, 'Pagamento não configurado: falta o Access Token do Mercado Pago (Configurações).');
  const res = await fetch('https://api.mercadopago.com' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(idem ? { 'X-Idempotency-Key': idem } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Mercado Pago erro', res.status, JSON.stringify(data).slice(0, 500)); throw new HttpError(502, 'O provedor de pagamento recusou a operação. Verifique as credenciais em Configurações.'); }
  return data;
}

// Cria a cobrança. Retorna {method, ...dados para a tela}
async function createCharge(booking, user, method, req) {
  const amount = booking.amount_cents / 100; const desc = `${setting('space_name')} – ${booking.meta.title}`.slice(0, 250);
  if (isSimulated()) {
    if (method === 'pix') return { provider: 'simulado', method, pix_code: `00020126-SIMULADO-EV${booking.id}-${money(booking.amount_cents)}`, simulated: true };
    return { provider: 'simulado', method, simulated: true };
  }
  const notification_url = `${baseUrl(req)}/api/webhooks/mercadopago`;
  const ref = `EV-${booking.id}`;
  if (method === 'pix') {
    const [first, ...rest] = user.name.split(' ');
    const exp = new Date(Date.now() + Math.max(setting('hold_minutes'), 5) * 60e3).toISOString().replace('Z', '-00:00');
    const p = await mp('/v1/payments', 'POST', {
      transaction_amount: amount, description: desc, payment_method_id: 'pix', external_reference: ref, notification_url,
      date_of_expiration: exp,
      payer: { email: user.email, first_name: first, last_name: rest.join(' ') || first, identification: user.cpf ? { type: 'CPF', number: user.cpf } : undefined },
    }, crypto.randomUUID());
    const td = p.point_of_interaction && p.point_of_interaction.transaction_data || {};
    return { provider: 'mercadopago', method, provider_ref: String(p.id), pix_code: td.qr_code, pix_qr_base64: td.qr_code_base64, ticket_url: td.ticket_url };
  }
  const back = `${baseUrl(req)}/#/pagamento/${booking.id}`;
  const pref = await mp('/checkout/preferences', 'POST', {
    items: [{ title: desc, quantity: 1, unit_price: amount, currency_id: 'BRL' }],
    external_reference: ref, notification_url, payer: { email: user.email },
    back_urls: { success: back, pending: back, failure: back }, auto_return: 'approved',
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }], installments: 1 },
    expires: true, expiration_date_to: new Date(Date.now() + Math.max(setting('hold_minutes'), 5) * 60e3).toISOString().replace('Z', '-00:00'),
  });
  return { provider: 'mercadopago', method, checkout_url: pref.init_point, provider_ref: String(pref.id) };
}

// Webhook: nunca confiamos no corpo recebido; consultamos o pagamento direto no Mercado Pago.
async function verifyMpPayment(paymentId) {
  const p = await mp(`/v1/payments/${encodeURIComponent(paymentId)}`, 'GET');
  const m = /^EV-(\d+)$/.exec(p.external_reference || '');
  return { approved: p.status === 'approved', bookingId: m ? Number(m[1]) : null, ref: String(p.id), method: p.payment_type_id === 'credit_card' || p.payment_type_id === 'debit_card' ? 'card' : 'pix', amount: p.transaction_amount };
}
module.exports = { isSimulated, createCharge, verifyMpPayment, baseUrl };
