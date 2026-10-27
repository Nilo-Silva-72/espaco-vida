'use strict';
// Comprovante público (acessível apenas por quem tem o link com código aleatório) — imprimível / salvar em PDF.
const { db, getSettings } = require('./db');
const U = require('./util');
const B = require('./bookings');

const e = U.escapeHtml;

function renderReceipt(code) {
  const row = db.prepare('SELECT id FROM bookings WHERE receipt_code = ?').get(String(code || ''));
  if (!row) return null;
  const b = B.getBookingRow(row.id);
  const s = getSettings();
  const d = B.describe(b);
  const pay = db.prepare(`SELECT * FROM payments WHERE booking_id=? AND status='paid' ORDER BY id DESC LIMIT 1`).get(b.id);
  const paidAt = b.paid_at ? new Date(b.paid_at).toLocaleString('pt-BR', { timeZone: U.TZ, dateStyle: 'short', timeStyle: 'short' }) : '—';
  const num = String(b.id).padStart(6, '0');
  const cancelled = b.status === 'cancelled';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Comprovante ${num} — ${e(s.business_name)}</title>
<link rel="stylesheet" href="/receipt.css"></head><body>
<main class="receipt">
  <header><div class="logo">${e(s.business_name)}</div><div class="sub">Comprovante de pagamento — sublocação de espaço</div></header>
  ${cancelled ? '<div class="warn">Esta reserva foi CANCELADA.</div>' : ''}
  <div class="amount">${U.brl(pay?.amount_cents ?? b.amount_cents)}</div>
  <div class="status">${cancelled ? 'Cancelado' : 'Pagamento confirmado'}</div>
  <dl>
    <dt>Comprovante nº</dt><dd>${num}</dd>
    <dt>Profissional</dt><dd>${e(b.user_name)}${b.user_specialty ? ' · ' + e(b.user_specialty) : ''}</dd>
    <dt>Serviço</dt><dd>${e(d.title)}</dd>
    <dt>Agenda</dt><dd>${d.lines.map(e).join('<br>')}</dd>
    <dt>Sala</dt><dd>${e(b.room_name)}</dd>
    <dt>Forma de pagamento</dt><dd>${e(B.METHOD_LABEL[pay?.method] || '—')}</dd>
    <dt>Pago em</dt><dd>${e(paidAt)}</dd>
    ${pay?.provider_ref && pay.provider !== 'manual' && pay.provider !== 'mock' ? `<dt>ID da transação</dt><dd>${e(pay.provider_ref)}</dd>` : ''}
  </dl>
  <p class="note">Documento de controle interno do Espaço. Não substitui nota fiscal.</p>
  <button id="print" type="button">Imprimir / salvar em PDF</button>
</main>
<script src="/print.js"></script>
</body></html>`;
}

module.exports = { renderReceipt };
