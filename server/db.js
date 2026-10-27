'use strict';
// Banco SQLite embutido no Node (node:sqlite) — sem dependências externas.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'espaco-vida.db');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL,
  specialty TEXT,
  registry TEXT,
  document TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','blocked')),
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  type TEXT NOT NULL CHECK (type IN ('hourly','module4','module8','block')),
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','expired')),
  amount_cents INTEGER NOT NULL,
  month TEXT,
  weekday INTEGER,
  start_hour INTEGER,
  items TEXT NOT NULL,                 -- JSON: [{date, hour}]
  hold_expires_at TEXT,
  receipt_code TEXT UNIQUE,
  paid_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  origin TEXT NOT NULL DEFAULT 'app',  -- app | admin
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

-- Trava de horários: a chave primária impede dois agendamentos no mesmo horário/sala.
CREATE TABLE IF NOT EXISTS slots (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, date, hour)
);
CREATE INDEX IF NOT EXISTS idx_slots_booking ON slots(booking_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  method TEXT NOT NULL,                -- pix | card | manual_pix | cash | courtesy
  provider TEXT NOT NULL,              -- mock | mercadopago | manual
  provider_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','cancelled','failed')),
  amount_cents INTEGER NOT NULL,
  pix_code TEXT,
  pix_qr TEXT,
  checkout_url TEXT,
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  to_phone TEXT NOT NULL,
  to_label TEXT,
  kind TEXT NOT NULL,                  -- professional | admin
  body TEXT NOT NULL,
  params TEXT,                         -- JSON (variáveis do template do WhatsApp)
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','manual')),
  error TEXT,
  booking_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
`);

/** Executa fn dentro de uma transação exclusiva (síncrona). */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

const DEFAULTS = {
  setup_done: false,
  business_name: 'Espaço Vida',
  admin_whatsapp: '',
  // 0 = domingo ... 6 = sábado; [abre, fecha] em horas cheias; null = fechado
  hours: { 0: null, 1: [8, 20], 2: [8, 20], 3: [8, 20], 4: [8, 20], 5: [8, 20], 6: [9, 13] },
  price_hour_cents: 7000,
  price_module4_cents: 40000,
  price_module8_cents: 80000,
  hold_minutes: 20,
  max_advance_days: 60,
  require_approval: false,
  methods: { pix: true, card: true },
  invite_message:
    'Olá! Aqui é do {negocio}. Para agendar seu horário de atendimento no Espaço, acesse o nosso aplicativo: {link}\n\nLá você cria seu perfil, escolhe o horário, paga por Pix ou cartão e recebe o comprovante aqui no WhatsApp.',
};

function getSettings() {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* ignora valor corrompido */ }
  }
  return out;
}
function setSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
}

function audit(userId, action, detail) {
  db.prepare('INSERT INTO audit (user_id, action, detail, created_at) VALUES (?,?,?,?)')
    .run(userId ?? null, action, detail ? String(detail).slice(0, 500) : null, new Date().toISOString());
}

module.exports = { db, tx, getSettings, setSettings, audit, DEFAULTS, DB_FILE };
