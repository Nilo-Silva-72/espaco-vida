'use strict';
// Fila de mensagens do WhatsApp (outbox).
//  - WHATSAPP_PROVIDER=cloud  → envia automaticamente pela WhatsApp Business Cloud API (Meta)
//  - WHATSAPP_PROVIDER=manual → (padrão) guarda na fila e o gestor envia com 1 clique (link wa.me)
const { db } = require('./db');
const { isoNow } = require('./util');

const provider = () => (process.env.WHATSAPP_PROVIDER || 'manual').toLowerCase();

function status() {
  const cloud = provider() === 'cloud';
  const configured = cloud && !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_ID;
  return {
    provider: provider(),
    configured,
    templates: {
      professional: !!process.env.WHATSAPP_TEMPLATE_PROFESSIONAL,
      admin: !!process.env.WHATSAPP_TEMPLATE_ADMIN,
    },
  };
}

function enqueue({ to, label, kind, body, params, bookingId }) {
  if (!to) return null;
  const st = provider() === 'cloud' ? 'queued' : 'manual';
  const r = db.prepare(
    `INSERT INTO outbox (to_phone, to_label, kind, body, params, status, booking_id, created_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(to, label ?? null, kind, body, params ? JSON.stringify(params) : null, st, bookingId ?? null, isoNow());
  return Number(r.lastInsertRowid);
}

async function sendCloud(row) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_ID não configurados.');
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const tpl = process.env[row.kind === 'admin' ? 'WHATSAPP_TEMPLATE_ADMIN' : 'WHATSAPP_TEMPLATE_PROFESSIONAL'];
  const params = row.params ? JSON.parse(row.params) : [];
  const payload = tpl
    ? {
      messaging_product: 'whatsapp', to: row.to_phone, type: 'template',
      template: {
        name: tpl, language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR' },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text).slice(0, 1000) })) }],
      },
    }
    : { messaging_product: 'whatsapp', to: row.to_phone, type: 'text', text: { preview_url: true, body: row.body } };
  const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

let dispatching = false;
async function dispatchQueued() {
  if (dispatching || provider() !== 'cloud') return;
  dispatching = true;
  try {
    const rows = db.prepare(`SELECT * FROM outbox WHERE status = 'queued' ORDER BY id LIMIT 20`).all();
    for (const row of rows) {
      try {
        await sendCloud(row);
        db.prepare(`UPDATE outbox SET status='sent', sent_at=?, attempts=attempts+1, error=NULL WHERE id=?`).run(isoNow(), row.id);
      } catch (e) {
        const attempts = row.attempts + 1;
        db.prepare(`UPDATE outbox SET status=?, attempts=?, error=? WHERE id=?`)
          .run(attempts >= 3 ? 'failed' : 'queued', attempts, String(e.message).slice(0, 300), row.id);
      }
    }
  } finally {
    dispatching = false;
  }
}

/** Link "clique para enviar" (usado no modo manual e como alternativa). */
const waLink = (phone, text) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;

module.exports = { enqueue, dispatchQueued, status, waLink, provider };
