// Utilitários de interface: criação segura de elementos (sem innerHTML), API, formatação, modal, toast.
export const $ = (s, r = document) => r.querySelector(s);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let deferredValue;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') deferredValue = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
}

export const handlers = { onUnauthorized: () => {} };
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique sua internet e tente de novo.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/login')) handlers.onUnauthorized();
    const e = new Error(data?.error || `Erro ${res.status}`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

// ----- formatação -----
export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
export const WEEKDAYS_PL = ['Domingos', 'Segundas', 'Terças', 'Quartas', 'Quintas', 'Sextas', 'Sábados'];
export const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const pad = (n) => String(n).padStart(2, '0');
export const hh = (n) => `${pad(n)}h`;
export const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const brDate = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
export const brMonth = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]}/${m.slice(0, 4)}`;
export const weekdayOf = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
export function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
export function addMonths(m, n) { const [y, mo] = m.split('-').map(Number); const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; }
export const parseMoney = (s) => {
  const n = Number(String(s).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
export const moneyInput = (c) => (c / 100).toFixed(2).replace('.', ',');
export const fmtPhone = (p) => { const d = String(p || ''); return d.length >= 12 ? `(${d.slice(2, 4)}) ${d.slice(4, d.length - 4)}-${d.slice(-4)}` : d; };
export const fmtDateTime = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export const STATUS = {
  pending: ['Aguardando pagamento', 'warn'], confirmed: ['Confirmado', 'ok'], cancelled: ['Cancelado', 'bad'], expired: ['Expirado', ''],
};
export const statusBadge = (b) => {
  if (b.cancel_requested && b.status === 'confirmed') return h('span', { class: 'badge warn' }, 'Cancelamento solicitado');
  const [t, c] = STATUS[b.status] || [b.status, ''];
  return h('span', { class: `badge ${c}` }, t);
};

// ----- feedback -----
let toastTimer;
export function toast(msg, type = '') {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: `toast ${type}`, role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4200);
}

export function openModal(title, body, actions = []) {
  const prevFocus = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title), body,
      actions.length ? h('div', { class: 'actions' }, actions.map((a) => a(close))) : null));
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  overlay.querySelector('input,select,textarea,button')?.focus();
  return { close };
}

/** Desabilita o botão durante a chamada assíncrona e mostra erros como toast. */
export async function busy(btn, fn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; }
  try { return await fn(); } catch (e) { toast(e.message, 'bad'); return undefined; } finally { if (btn) { btn.disabled = false; if (old !== undefined && btn.isConnected) btn.textContent = old; } }
}

export async function copy(text, okMsg = 'Copiado!') {
  try { await navigator.clipboard.writeText(text); toast(okMsg, 'ok'); } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast(okMsg, 'ok'); } catch { toast('Não foi possível copiar. Selecione e copie manualmente.', 'bad'); }
    ta.remove();
  }
}

// ----- formulários -----
export const field = (label, input, hint) => h('label', { class: 'f' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
export const txt = (props = {}) => h('input', { type: 'text', ...props });
export const skeleton = (n = 3) => h('div', {}, Array.from({ length: n }, () => h('div', { class: 'skel' })));
export const errorBox = (e) => h('div', { class: 'alert bad' }, e.message || String(e));

/** Editor de horário de funcionamento por dia da semana. get() → { 0: null | [abre, fecha], ... } */
export function hoursEditor(hours) {
  const rows = [];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const node = h('div', {}, order.map((d) => {
    const cur = hours?.[d];
    const open = h('input', { type: 'checkbox', checked: !!cur });
    const from = h('select', { 'aria-label': `Abertura ${WEEKDAYS[d]}` }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: (cur?.[0] ?? 8) === i }, hh(i))));
    const to = h('select', { 'aria-label': `Fechamento ${WEEKDAYS[d]}` }, Array.from({ length: 24 }, (_, i) => h('option', { value: i + 1, selected: (cur?.[1] ?? 20) === i + 1 }, hh(i + 1))));
    const sync = () => { from.disabled = to.disabled = !open.checked; };
    open.addEventListener('change', sync); sync();
    rows.push({ d, open, from, to });
    return h('div', { class: 'hoursrow' }, h('label', { class: 'check' }, open, WEEKDAYS[d]), from, to);
  }));
  return {
    node,
    get: () => Object.fromEntries(rows.map((r) => [r.d, r.open.checked ? [Number(r.from.value), Number(r.to.value)] : null])),
  };
}
