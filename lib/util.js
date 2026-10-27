'use strict';
const crypto = require('node:crypto');

// Horário de Brasília (UTC-3, sem horário de verão desde 2019)
const TZ_OFFSET_H = -3;
const pad = (n) => String(n).padStart(2, '0');
function nowSP(offsetHours = 0) { return new Date(Date.now() + (TZ_OFFSET_H + offsetHours) * 3600e3); }
function fmtDate(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
const todayStr = () => fmtDate(nowSP());
const parseDate = (s) => new Date(s + 'T00:00:00Z');
const weekdayOf = (s) => parseDate(s).getUTCDay();
function addDays(s, n) { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return fmtDate(d); }
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtDate(parseDate(s)) === s;
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
// "AAAA-MM-DD HH" no relógio de Brasília para comparar horários como texto
const stamp = (date, hour) => `${date} ${pad(hour)}`;
function nowStamp(extraHours = 0) { const d = nowSP(extraHours); return stamp(fmtDate(d), d.getUTCHours()); }
function datesOfWeekdayInMonth(month, weekday) {
  const [y, m] = month.split('-').map(Number); const out = [];
  const d = new Date(Date.UTC(y, m - 1, 1));
  while (d.getUTCMonth() === m - 1) { if (d.getUTCDay() === weekday) out.push(fmtDate(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const WD_FULL = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const brDate = (s) => s.split('-').reverse().join('/');
const monthLabel = (m) => `${MONTHS[Number(m.slice(5)) - 1]}/${m.slice(0, 4)}`;
const hh = (h) => `${pad(h)}:00`;
const money = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function brDateTimeFromSql(s) { // 'YYYY-MM-DD HH:MM:SS' (UTC) -> horário de Brasília
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z'); const l = new Date(d.getTime() + TZ_OFFSET_H * 3600e3);
  return `${pad(l.getUTCDate())}/${pad(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

// ---- senhas e tokens ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [v, s, h] = stored.split('$'); if (v !== 's1') return false;
    const test = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
    return crypto.timingSafeEqual(test, Buffer.from(h, 'hex'));
  } catch { return false; }
}
const token = (n = 32) => crypto.randomBytes(n).toString('hex');
function receiptCode() { // 12 caracteres, sem letras ambíguas
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(12);
  return Array.from(b, (x) => A[x % A.length]).join('');
}

// ---- validações brasileiras ----
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) return d;
  if (d.length === 10 || d.length === 11) return '55' + d;
  return null;
}
function fmtPhone(p) {
  if (!p) return '';
  const d = p.replace(/^55/, '');
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : p;
}
function validCPF(c) {
  const d = String(c || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0; for (let i = 0; i < t; i++) s += Number(d[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 160;
const clean = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
module.exports = {
  pad, nowSP, fmtDate, todayStr, parseDate, weekdayOf, addDays, isDate, isMonth, stamp, nowStamp,
  datesOfWeekdayInMonth, WD, WD_FULL, MONTHS, brDate, monthLabel, hh, money, brDateTimeFromSql,
  hashPassword, verifyPassword, token, receiptCode, normPhone, fmtPhone, validCPF, validEmail, clean, HttpError,
};
