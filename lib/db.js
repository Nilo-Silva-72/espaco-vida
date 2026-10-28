'use strict';
// Banco de dados SQLite nativo do Node (node:sqlite). Um único arquivo: data/espaco-vida.db
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'espaco-vida.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT, cpf TEXT,
  specialty TEXT, registry TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  type TEXT NOT NULL CHECK (type IN ('avulsa','mod4','mod8','bloqueio')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','cancelled','expired','refund_needed')),
  hold_expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT, cancelled_at TEXT, cancel_reason TEXT,
  pay_method TEXT, provider_ref TEXT, receipt_code TEXT,
  refund_status TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_receipt ON bookings(receipt_code) WHERE receipt_code IS NOT NULL;
-- Um horário só pode existir uma vez por sala: isto impede reserva dupla no nível do banco.
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL, date TEXT NOT NULL, hour INTEGER NOT NULL,
  UNIQUE (room_id, date, hour)
);
CREATE INDEX IF NOT EXISTS idx_slots_date ON slots(date);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  audience TEXT NOT NULL, to_phone TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
  detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- Configurações (chave/valor) ----
const DEFAULTS = {
  space_name: 'Espaço Vida',
  hours: { 0: null, 1: [8, 20], 2: [8, 20], 3: [8, 20], 4: [8, 20], 5: [8, 20], 6: [9, 13] },
  price_mod4: 40000,   // R$ 400,00 por mês
  price_mod8: 80000,   // R$ 800,00 por mês (valor sugerido: ajuste em Configurações)
  price_hour: 7000,    // R$ 70,00 por hora avulsa
  hold_minutes: 15,    // tempo para pagar antes de o horário voltar a ficar livre
  min_notice_hours: 2, // antecedência mínima para agendar
  cancel_hours: 24,    // limite para o profissional cancelar sozinho (avulsa paga)
  horizon_days: 60,    // até quantos dias à frente se pode agendar hora avulsa
  max_hours_per_booking: 12,
  renewal_day: 20,      // até este dia do mês, o mês seguinte é só para renovação de quem já tem módulo
  reminder_days: 7,     // o lembrete de renovação começa X dias antes do prazo
  telegram_token: '', telegram_chat_id: '',
  allow_signup: true,
  admin_whatsapp: '',
  base_url: '',
  payment_provider: 'simulado', // 'simulado' | 'mercadopago'
  mp_access_token: '',
  wa_provider: 'log',           // 'log' (não envia, só registra) | 'cloud' (API oficial do WhatsApp)
  wa_phone_id: '', wa_token: '', wa_template: '', wa_template_lang: 'pt_BR',
  setup_done: false,
};
const getS = db.prepare('SELECT value FROM settings WHERE key=?');
const putS = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
function setting(key) {
  const r = getS.get(key);
  return r ? JSON.parse(r.value) : DEFAULTS[key];
}
function setSetting(key, value) { putS.run(key, JSON.stringify(value)); }
function allSettings() { const o = {}; for (const k of Object.keys(DEFAULTS)) o[k] = setting(k); return o; }

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
function audit(userId, action, detail) {
  db.prepare('INSERT INTO audit(user_id,action,detail) VALUES(?,?,?)').run(userId ?? null, action, detail ? String(detail) : null);
}
module.exports = { db, setting, setSetting, allSettings, DEFAULTS, tx, audit };
