'use strict';
// Utilidades: datas no fuso do Espaço, dinheiro, telefone, erros HTTP.
const crypto = require('node:crypto');

const TZ = process.env.TZ_NAME || 'America/Sao_Paulo';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (m, x) => new HttpError(400, m, x);
const forbidden = (m = 'Sem permissão para esta ação.') => new HttpError(403, m);
const notFound = (m = 'Não encontrado.') => new HttpError(404, m);
const conflict = (m, x) => new HttpError(409, m, x);

const pad = (n) => String(n).padStart(2, '0');

/** Data/hora "de parede" no fuso do Espaço: { date:'YYYY-MM-DD', hour, minute, stamp:'YYYY-MM-DDTHH:mm' } */
function nowLocal(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  const date = `${g('year')}-${g('month')}-${g('day')}`;
  const hour = Number(g('hour'));
  const minute = Number(g('minute'));
  return { date, hour, minute, stamp: `${date}T${pad(hour)}:${pad(minute)}` };
}

const isoNow = () => new Date().toISOString();
const addMinutesISO = (min, from = new Date()) => new Date(from.getTime() + min * 60000).toISOString();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const weekdayOf = (date) => new Date(date + 'T12:00:00Z').getUTCDay(); // 0 = domingo
function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
function datesOfMonthWeekday(month, weekday) {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let day = 1; day <= last; day++) {
    const date = `${y}-${pad(m)}-${pad(day)}`;
    if (weekdayOf(date) === weekday) out.push(date);
  }
  return out;
}
/** O início do horário (date + hour) ainda está no futuro? */
function isFuture(date, hour, now = nowLocal()) {
  return `${date}T${pad(hour)}:00` > now.stamp;
}

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const WEEKDAYS_PL = ['Domingos', 'Segundas', 'Terças', 'Quartas', 'Quintas', 'Sextas', 'Sábados'];
const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const brDate = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
const brMonth = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]}/${month.slice(0, 4)}`;
const hh = (h) => `${pad(h)}h`;

/** [9,10,11,14] -> "09h às 12h, 14h às 15h" */
function hourRanges(hours) {
  const hs = [...hours].sort((a, b) => a - b);
  const out = [];
  let start = null;
  let prev = null;
  for (const h of hs) {
    if (start === null) { start = h; prev = h; continue; }
    if (h === prev + 1) { prev = h; continue; }
    out.push(`${hh(start)} às ${hh(prev + 1)}`);
    start = h; prev = h;
  }
  if (start !== null) out.push(`${hh(start)} às ${hh(prev + 1)}`);
  return out.join(', ');
}

const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Telefone BR -> só dígitos com DDI 55. Retorna null se inválido. */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!/^55\d{10,11}$/.test(d)) return null;
  return d;
}

const randomCode = (len = 10) => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem caracteres ambíguos
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = {
  TZ, HttpError, bad, forbidden, notFound, conflict, pad, nowLocal, isoNow, addMinutesISO,
  isValidDate, weekdayOf, addDays, addMonths, datesOfMonthWeekday, isFuture, MONTH_RE, DATE_RE,
  WEEKDAYS, WEEKDAYS_PL, MONTHS, brDate, brMonth, hh, hourRanges, brl, normalizePhone, randomCode, escapeHtml,
};
