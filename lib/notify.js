'use strict';
// Comprovantes e mensagens de WhatsApp (profissional + administração).
const { db, setting } = require('./db');
const U = require('./util');
const { TYPE_LABEL } = require('./rules');

const METHOD = { pix: 'Pix', card: 'Cartão', manual: 'Pagamento direto (registrado pela gestão)' };

function receiptText(b, user, room, audience, base) {
  const link = `${base}/r/${b.receipt_code}`;
  const lines = [
    `✅ *${setting('space_name')}* — Comprovante de pagamento`,
    `Nº *${b.receipt_code}*`,
    audience === 'admin' ? `👤 ${user.name}${user.specialty ? ' (' + user.specialty + ')' : ''} — ${U.fmtPhone(user.phone)}` : `👤 ${user.name}`,
    `🏠 ${room.name}`,
    `🗓️ ${b.meta.title}`,
    b.meta.detail,
    `💰 ${U.money(b.amount_cents)} · ${METHOD[b.pay_method] || b.pay_method || ''}`,
    `🕒 Pago em ${U.brDateTimeFromSql(b.paid_at)}`,
    `🔗 ${link}`,
  ];
  if (audience === 'user') lines.push('', 'Obrigado por escolher o Espaço Vida! Para alterar um agendamento, acesse o aplicativo ou fale conosco.');
  return lines.join('\n');
}

async function sendWhatsApp(phone, body) {
  const provider = setting('wa_provider');
  if (provider !== 'cloud') return { status: 'simulated' };
  const id = setting('wa_phone_id'); const tok = setting('wa_token');
  if (!id || !tok) throw new Error('WhatsApp não configurado (faltam Phone Number ID / Token).');
  const tpl = setting('wa_template');
  const payload = tpl
    ? { messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: tpl, language: { code: setting('wa_template_lang') || 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: body.replace(/\n+/g, ' | ').slice(0, 1000) }] }] } }
    : { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body, preview_url: true } };
  const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(id)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  return { status: 'sent' };
}

async function deliver(notifId) {
  const n = db.prepare('SELECT * FROM notifications WHERE id=?').get(notifId); if (!n) return;
  try {
    if (!n.to_phone) throw new Error('Sem telefone de destino.');
    const r = await sendWhatsApp(n.to_phone, n.body);
    db.prepare("UPDATE notifications SET status=?, error=NULL, sent_at=datetime('now') WHERE id=?").run(r.status, n.id);
  } catch (e) {
    db.prepare("UPDATE notifications SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), n.id);
  }
}

// Gera e envia os dois comprovantes: profissional e administração
async function sendReceipts(bookingId, base) {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId); if (!b) return [];
  b.meta = JSON.parse(b.meta);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(b.user_id);
  const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(b.room_id);
  const ins = db.prepare('INSERT INTO notifications(booking_id,audience,to_phone,body) VALUES(?,?,?,?)');
  const ids = [];
  ids.push(Number(ins.run(b.id, 'user', user.phone, receiptText(b, user, room, 'user', base)).lastInsertRowid));
  ids.push(Number(ins.run(b.id, 'admin', setting('admin_whatsapp') || null, receiptText(b, user, room, 'admin', base)).lastInsertRowid));
  for (const id of ids) await deliver(id);
  return ids;
}

async function sendAdminAlert(bookingId, text) {
  const r = db.prepare('INSERT INTO notifications(booking_id,audience,to_phone,body) VALUES(?,?,?,?)').run(bookingId, 'admin', setting('admin_whatsapp') || null, text);
  await deliver(Number(r.lastInsertRowid));
}

function receiptHtml(code) {
  const b = db.prepare('SELECT * FROM bookings WHERE receipt_code=?').get(code); if (!b) return null;
  b.meta = JSON.parse(b.meta);
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id);
  const room = db.prepare('SELECT name FROM rooms WHERE id=?').get(b.room_id);
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cancelled = b.status === 'cancelled' || b.status === 'refund_needed';
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comprovante ${e(code)}</title><style>
body{font-family:system-ui,sans-serif;background:#f3efe7;margin:0;padding:24px;color:#23332e}
.c{max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 6px 30px #0001}
h1{font-family:Georgia,serif;font-size:22px;margin:0 0 4px}.ok{color:#1f7a5a;font-weight:600}.bad{color:#b3412f;font-weight:600}
dl{margin:20px 0}dt{font-size:12px;color:#6b7a74;text-transform:uppercase;letter-spacing:.06em;margin-top:14px}dd{margin:2px 0 0;font-size:16px}
.v{font-size:28px;font-family:Georgia,serif}button{margin-top:10px;padding:10px 18px;border:0;border-radius:10px;background:#1f5d4c;color:#fff;font-size:15px;cursor:pointer}
@media print{button{display:none}body{background:#fff}.c{box-shadow:none}}</style>
<div class="c"><h1>${e(setting('space_name'))}</h1><div class="${cancelled ? 'bad' : 'ok'}">${cancelled ? 'Reserva cancelada' : '✔ Pagamento confirmado'}</div>
<dl><dt>Comprovante</dt><dd>${e(code)}</dd><dt>Profissional</dt><dd>${e(user.name)}</dd><dt>Sala</dt><dd>${e(room.name)}</dd>
<dt>Serviço</dt><dd>${e(b.meta.title)}</dd><dt>Datas e horários</dt><dd>${e(b.meta.detail)}</dd>
<dt>Valor</dt><dd class="v">${e(U.money(b.amount_cents))}</dd><dt>Forma de pagamento</dt><dd>${e(METHOD[b.pay_method] || '')}</dd>
<dt>Pago em</dt><dd>${e(U.brDateTimeFromSql(b.paid_at))}</dd></dl><button onclick="print()">Imprimir / salvar PDF</button></div></html>`;
}
module.exports = { sendReceipts, sendAdminAlert, deliver, receiptHtml, receiptText };
