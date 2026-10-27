'use strict';
// ===== Núcleo =====
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WDF = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MON = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const hh = (h) => String(h).padStart(2, '0') + ':00';
const pd = (s) => new Date(s + 'T00:00:00Z');
const wdOf = (s) => pd(s).getUTCDay();
const addDays = (s, n) => { const d = pd(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const brDate = (s) => s.split('-').reverse().join('/');
const monthLabel = (m) => `${MON[+m.slice(5) - 1]}/${m.slice(0, 4)}`;
const fmtPhone = (p) => { if (!p) return ''; const d = p.replace(/^55/, ''); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : p; };
const sqlLocal = (s) => { if (!s) return ''; const d = new Date(new Date(s.replace(' ', 'T') + 'Z').getTime() - 3 * 3600e3); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const waLink = (phone, text) => `https://wa.me/${phone || ''}?text=${encodeURIComponent(text || '')}`;
const STATUS = { pending: ['Aguardando pagamento', 'pending'], paid: ['Pago', ''], cancelled: ['Cancelado', 'grey'], expired: ['Expirado', 'grey'], refund_needed: ['Reembolso necessário', 'bad'] };
const badge = (b) => { const s = STATUS[b.status] || [b.status, 'grey']; return `<span class="badge ${s[1]}">${s[0]}</span>`; };

const S = { info: null, user: null, wz: null };
let timers = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };

async function api(method, url, body) {
  let res; try { res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Sem conexão com o servidor. Verifique sua internet.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user && !url.includes('/auth/')) { S.user = null; render(); throw new Error('Sua sessão expirou. Entre novamente.'); }
  if (!res.ok) throw new Error(data.error || 'Algo deu errado.');
  return data;
}
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), err ? 4500 : 2600); }
const fail = (e) => toast(e.message || String(e), true);
function modal(html, onMount) {
  const root = $('#modal-root'); root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => (root.innerHTML = ''); root.firstChild.addEventListener('mousedown', (e) => { if (e.target === root.firstChild) close(); });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close)); if (onMount) onMount($('.modal', root), close); return close;
}
const busy = async (btn, fn) => { if (btn) btn.disabled = true; try { return await fn(); } catch (e) { fail(e); } finally { if (btn) btn.disabled = false; } };
const formData = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
const maskPhone = (el) => el.addEventListener('input', () => { const d = el.value.replace(/\D/g, '').slice(0, 11); el.value = d.length > 6 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length > 10 ? 7 : 6)}-${d.slice(d.length > 10 ? 7 : 6)}` : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d; });
const maskCpf = (el) => el.addEventListener('input', () => { const d = el.value.replace(/\D/g, '').slice(0, 11); el.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4'); });
const applyMasks = (root) => { root.querySelectorAll('[data-mask=phone]').forEach(maskPhone); root.querySelectorAll('[data-mask=cpf]').forEach(maskCpf); };
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copiado!'); } catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast('Copiado!'); } }

// ===== Roteamento =====
const route = () => (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

async function boot() {
  try {
    S.info = await api('GET', '/api/public/info');
    try { S.user = (await api('GET', '/api/me')).user; } catch { S.user = null; }
  } catch (e) { $('#app').innerHTML = `<p class="boot">${esc(e.message)}</p>`; return; }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
async function render() {
  clearTimers(); const app = $('#app');
  if (S.info.setup_needed) return viewSetup(app);
  if (!S.user) return viewAuth(app);
  const r = route(); const admin = S.user.role === 'admin';
  const nav = admin
    ? [['', 'Painel'], ['agenda', 'Agenda'], ['reservas', 'Reservas'], ['profissionais', 'Profissionais'], ['comprovantes', 'Comprovantes'], ['divulgar', 'Divulgar'], ['config', 'Configurações']].map(([k, l]) => [k ? '/admin/' + k : '/admin', l, k])
    : [['/', 'Início', ''], ['/agendar', 'Agendar', 'agendar'], ['/reservas', 'Minhas reservas', 'reservas'], ['/perfil', 'Meu perfil', 'perfil']];
  const cur = admin ? (r[0] === 'admin' ? r[1] || '' : null) : r[0] || '';
  if (admin && r[0] !== 'admin') { location.hash = '#/admin'; return; }
  if (!admin && r[0] === 'admin') { location.hash = '#/'; return; }
  app.innerHTML = `<header class="topbar"><div class="brand"><img src="/icon.svg" alt="">${esc(S.info.space_name)}${admin ? ' <span class="badge" style="background:#ffffff33;color:#fff">Gestão</span>' : ''}</div><button data-act="logout">Sair</button></header>
  <nav class="nav" aria-label="Menu">${nav.map(([h, l, k]) => `<a href="#${h}" class="${cur === k ? 'on' : ''}">${l}</a>`).join('')}</nav><main id="view"></main>`;
  const v = $('#view');
  try {
    if (admin) { const p = r[1] || ''; await ({ '': aDash, agenda: aAgenda, reservas: aBookings, profissionais: aUsers, comprovantes: aNotifs, divulgar: aShare, config: aConfig }[p] || aDash)(v); }
    else { const p = r[0] || ''; if (p === 'pagamento') await uPay(v, r[1]); else await ({ '': uHome, agendar: uBook, reservas: uBookings, perfil: uProfile }[p] || uHome)(v); }
  } catch (e) { v.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
}
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  if (a.dataset.act === 'logout') { await api('POST', '/api/auth/logout').catch(() => {}); S.user = null; S.wz = null; location.hash = '#/'; render(); }
});

// ===== Configuração inicial e login =====
function logoBlock() { return `<div class="logo"><img src="/icon.svg" alt=""><div><h1 style="margin:0">${esc(S.info.space_name)}</h1><div class="muted small">Agenda de salas e módulos</div></div></div>`; }
function viewSetup(app) {
  const defHours = { 0: null, 1: [8, 20], 2: [8, 20], 3: [8, 20], 4: [8, 20], 5: [8, 20], 6: [9, 13] };
  app.innerHTML = `<div class="auth" style="max-width:640px">${logoBlock()}<div class="alert ok" style="margin-top:14px"><b>Bem-vinda(o)!</b> Vamos configurar o aplicativo do zero. Leva 2 minutos e tudo pode ser alterado depois em <i>Configurações</i>.</div>
  <form id="f" class="card"><h2>1. Seu espaço</h2><label>Nome do espaço</label><input name="space_name" value="Espaço Vida" required>
  <label>Salas disponíveis para sublocação (uma por linha)</label><textarea name="rooms" required>Sala 1\nSala 2</textarea>
  <h2 style="margin-top:22px">2. Valores</h2><div class="grid g3"><div><label>Módulo 4 horas (por mês)</label><input name="p4" inputmode="decimal" value="400,00" required></div><div><label>Módulo 8 horas (por mês)</label><input name="p8" inputmode="decimal" value="800,00" required></div><div><label>Hora avulsa</label><input name="p1" inputmode="decimal" value="70,00" required></div></div>
  <p class="muted small">O valor do módulo de 8 horas foi sugerido (2× o de 4 horas). Ajuste ao valor que você praticar.</p>
  <h2 style="margin-top:22px">3. Horário de funcionamento</h2><div id="hrs"></div>
  <h2 style="margin-top:22px">4. Seu acesso de gestor</h2><label>Nome completo</label><input name="name" required autocomplete="name">
  <label>E-mail</label><input name="email" type="email" required autocomplete="email"><label>WhatsApp da administração (recebe os comprovantes)</label><input name="phone" data-mask="phone" inputmode="tel" required placeholder="(11) 99999-9999">
  <label>Senha (mínimo 8 caracteres)</label><input name="password" type="password" minlength="8" required autocomplete="new-password">
  <button class="btn block" style="margin-top:20px">Criar meu aplicativo</button></form></div>`;
  applyMasks(app); const hrs = $('#hrs');
  hrs.innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => `<div class="row" style="margin:6px 0"><div style="width:90px">${WDF[d]}</div><label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" data-open="${d}" ${defHours[d] ? 'checked' : ''}> aberto</label><select data-from="${d}" style="width:auto">${hourOpts(defHours[d] ? defHours[d][0] : 8, 0, 23)}</select> às <select data-to="${d}" style="width:auto">${hourOpts(defHours[d] ? defHours[d][1] : 18, 1, 24)}</select></div>`).join('');
  $('#f').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const f = formData(ev.target); const btn = ev.submitter;
    await busy(btn, async () => {
      const hours = {}; for (let d = 0; d <= 6; d++) hours[d] = $(`[data-open="${d}"]`).checked ? [+$(`[data-from="${d}"]`).value, +$(`[data-to="${d}"]`).value] : null;
      await api('POST', '/api/setup', { space_name: f.space_name, rooms: f.rooms.split('\n').map((n) => ({ name: n })), hours, prices: { mod4: toCents(f.p4), mod8: toCents(f.p8), hour: toCents(f.p1) }, admin: { name: f.name, email: f.email, phone: f.phone, password: f.password } });
      S.info = await api('GET', '/api/public/info'); S.user = (await api('GET', '/api/me')).user; location.hash = '#/admin'; render(); toast('Pronto! Seu aplicativo foi criado.');
    });
  });
}
const hourOpts = (sel, a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i).map((h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${hh(h)}</option>`).join('');
const toCents = (s) => Math.round(parseFloat(String(s).replace(/\./g, '').replace(',', '.')) * 100);
const fromCents = (c) => (c / 100).toFixed(2).replace('.', ',');

function viewAuth(app) {
  let tab = S.info.allow_signup && /cadastro/.test(location.hash) ? 'reg' : 'login';
  const draw = () => {
    app.innerHTML = `<div class="auth">${logoBlock()}<p class="muted">Reserve sua sala, pague por Pix ou cartão e receba o comprovante no WhatsApp.</p>
    <div class="tabs"><button data-t="login" class="${tab === 'login' ? 'on' : ''}">Entrar</button>${S.info.allow_signup ? `<button data-t="reg" class="${tab === 'reg' ? 'on' : ''}">Criar meu perfil</button>` : ''}</div>
    ${tab === 'login' ? `<form id="f" class="card"><label>E-mail</label><input name="email" type="email" required autocomplete="username"><label>Senha</label><input name="password" type="password" required autocomplete="current-password"><button class="btn block" style="margin-top:18px">Entrar</button></form>` :
      `<form id="f" class="card"><label>Nome completo</label><input name="name" required autocomplete="name"><label>E-mail</label><input name="email" type="email" required autocomplete="email">
      <label>WhatsApp (recebe seus comprovantes)</label><input name="phone" data-mask="phone" inputmode="tel" required placeholder="(11) 99999-9999"><label>CPF</label><input name="cpf" data-mask="cpf" inputmode="numeric" required placeholder="000.000.000-00">
      <label>Especialidade / área de atuação</label><input name="specialty" required placeholder="Ex.: Psicologia, Nutrição, Pilates…"><label>Registro profissional (opcional)</label><input name="registry" placeholder="Ex.: CRP 06/12345">
      <label>Senha (mínimo 8 caracteres)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"><button class="btn block" style="margin-top:18px">Criar perfil e entrar</button></form>`}
    <p class="muted small center">Funcionamento: ${hoursSummary(S.info.hours)}</p></div>`;
    applyMasks(app); app.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; draw(); }));
    $('#f').addEventListener('submit', (ev) => { ev.preventDefault(); busy(ev.submitter, async () => {
      const r = await api('POST', tab === 'login' ? '/api/auth/login' : '/api/auth/register', formData(ev.target)); S.user = r.user; location.hash = '#/'; render(); }); });
  }; draw();
}
function hoursSummary(h) {
  const grp = []; for (const d of [1, 2, 3, 4, 5, 6, 0]) { const v = h[d]; if (!v) continue; const k = `${hh(v[0])} às ${hh(v[1])}`; const last = grp[grp.length - 1]; if (last && last.k === k && last.end === (d === 0 ? 7 : d) - 1) { last.end = d === 0 ? 7 : d; } else grp.push({ k, start: d === 0 ? 7 : d, end: d === 0 ? 7 : d }); }
  const nm = (n) => WD[n % 7]; return grp.map((g) => `${g.start === g.end ? nm(g.start) : nm(g.start) + ' a ' + nm(g.end)}, ${g.k}`).join(' · ');
}

// ===== Profissional =====
const nextSlot = (b) => (b.slots || []).map((s) => `${s.date} ${String(s.hour).padStart(2, '0')}`).sort().find((s) => s >= S.info.today) || null;
const slotLabel = (s) => `${WD[wdOf(s.slice(0, 10))]} ${brDate(s.slice(0, 10)).slice(0, 5)} às ${s.slice(11)}:00`;
function bookingCard(b, { admin } = {}) {
  const n = b.status === 'paid' ? nextSlot(b) : null;
  return `<div class="card flat" style="margin:0 0 12px"><div class="row between"><div><b>${esc(b.title)}</b><div class="muted small">${esc(b.room)} · ${esc(b.detail)}</div>${n ? `<div class="small" style="margin-top:4px">Próximo: <b>${slotLabel(n)}</b></div>` : ''}</div><div class="right">${badge(b)}<div><b>${b.amount_cents ? brl(b.amount_cents) : ''}</b></div></div></div>
  <div class="row" style="margin-top:10px">${b.status === 'pending' ? `<a class="btn sm" href="#/pagamento/${b.id}">Pagar agora</a>` : ''}${b.receipt_code && b.status !== 'expired' ? `<a class="btn sm ghost" target="_blank" href="/r/${b.receipt_code}">Comprovante</a>` : ''}
  ${['pending', 'paid'].includes(b.status) && b.type !== 'bloqueio' ? `<button class="btn sm ghost" data-cancel="${b.id}" data-paid="${b.status === 'paid'}">Cancelar</button>` : ''}${b.refund_status === 'solicitado' ? '<span class="badge pending">Reembolso em análise</span>' : b.refund_status === 'concluido' ? '<span class="badge">Reembolsado</span>' : ''}</div></div>`;
}
function bindCancel(root, after) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cancel]'); if (!b) return; const paid = b.dataset.paid === 'true';
    modal(`<h3>Cancelar reserva?</h3><p class="muted">${paid ? `Reservas pagas podem ser canceladas até ${S.info.rules.cancel_hours}h antes do primeiro horário. O reembolso é feito pela administração.` : 'O horário será liberado para outras pessoas.'}</p><div class="row" style="margin-top:14px"><button class="btn danger grow" id="yes">Sim, cancelar</button><button class="btn ghost grow" data-close>Voltar</button></div>`,
      (m, close) => $('#yes', m).addEventListener('click', (ev) => busy(ev.target, async () => { await api('POST', `/api/bookings/${b.dataset.cancel}/cancel`, {}); close(); toast('Reserva cancelada.'); after(); })));
  });
}
async function uHome(v) {
  const { bookings } = await api('GET', '/api/bookings'); const up = bookings.filter((b) => b.status === 'paid' && nextSlot(b)).sort((a, b) => nextSlot(a).localeCompare(nextSlot(b)));
  const pend = bookings.filter((b) => b.status === 'pending'); const p = S.info.prices;
  v.innerHTML = `<div class="hero"><h1>Olá, ${esc(S.user.name.split(' ')[0])}!</h1><p>Reserve sua sala em poucos toques. Pagou, está confirmado — e o comprovante chega no seu WhatsApp.</p><a class="btn gold" href="#/agendar" style="margin-top:8px">Agendar horário</a></div>
  ${pend.length ? `<div class="alert">Você tem ${pend.length} reserva(s) aguardando pagamento. O horário só fica garantido após o pagamento.</div>${pend.map((b) => bookingCard(b)).join('')}` : ''}
  <h2>Próximos atendimentos</h2>${up.length ? up.slice(0, 6).map((b) => bookingCard(b)).join('') : '<div class="card flat muted">Você ainda não tem horários reservados.</div>'}
  <div class="card"><h3>Valores</h3><div class="price-row"><span>Hora avulsa</span><b>${brl(p.hour)}</b></div><div class="price-row"><span>Módulo 4 horas (1 dia/semana, por mês)</span><b>${brl(p.mod4)}</b></div><div class="price-row"><span>Módulo 8 horas (1 dia/semana, por mês)</span><b>${brl(p.mod8)}</b></div><p class="muted small">Funcionamento: ${hoursSummary(S.info.hours)}</p></div>`;
  bindCancel(v, render);
}
async function uBookings(v) {
  const { bookings } = await api('GET', '/api/bookings');
  v.innerHTML = `<h1>Minhas reservas</h1>${bookings.length ? bookings.map((b) => bookingCard(b)).join('') : '<div class="card flat muted">Nenhuma reserva ainda. <a href="#/agendar">Agendar agora</a></div>'}`;
  bindCancel(v, render);
}
async function uProfile(v) {
  const u = S.user;
  v.innerHTML = `<h1>Meu perfil</h1><form id="f" class="card"><label>Nome completo</label><input name="name" value="${esc(u.name)}" required><label>E-mail (não pode ser alterado)</label><input value="${esc(u.email)}" disabled>
  <label>WhatsApp</label><input name="phone" data-mask="phone" value="${esc(fmtPhone(u.phone))}" required><label>CPF</label><input name="cpf" data-mask="cpf" value="${esc(u.cpf || '')}" required>
  <label>Especialidade</label><input name="specialty" value="${esc(u.specialty || '')}" required><label>Registro profissional</label><input name="registry" value="${esc(u.registry || '')}">
  <h3 style="margin-top:22px">Trocar senha (opcional)</h3><label>Senha atual</label><input name="current_password" type="password" autocomplete="current-password"><label>Nova senha</label><input name="new_password" type="password" minlength="8" autocomplete="new-password">
  <button class="btn block" style="margin-top:18px">Salvar</button></form>`;
  applyMasks(v);
  $('#f').addEventListener('submit', (ev) => { ev.preventDefault(); busy(ev.submitter, async () => { const f = formData(ev.target); if (!f.new_password) { delete f.new_password; delete f.current_password; } S.user = (await api('PUT', '/api/me', f)).user; toast('Perfil atualizado.'); }); });
}

async function uBook(v) {
  const rooms = S.info.rooms; if (!rooms.length) { v.innerHTML = '<div class="alert">Nenhuma sala disponível no momento.</div>'; return; }
  const w = S.wz || (S.wz = { type: null, room_id: rooms[0].id, cart: [], date: null, month: null, weekday: null, start: null, opts: null });
  if (!rooms.find((r) => r.id === w.room_id)) w.room_id = rooms[0].id;
  const p = S.info.prices; const today = S.info.today;
  const months = [0, 1, 2].map((i) => { const [y, m] = today.slice(0, 7).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + i, 1)); return d.toISOString().slice(0, 7); });
  async function draw() {
    let body = '', bar = '';
    if (w.type === 'avulsa') {
      const n = Math.min(S.info.rules.horizon_days, 27); const dates = Array.from({ length: n + 1 }, (_, i) => addDays(today, i));
      if (!w.date) w.date = dates.find((d) => S.info.hours[wdOf(d)]) || today;
      const days = (await api('GET', `/api/availability?room_id=${w.room_id}&from=${w.date}&to=${w.date}`)).days; const day = days[w.date];
      body = `<h3>Escolha o dia</h3><div class="chips">${dates.map((d) => `<button class="chip ${d === w.date ? 'on' : ''}" data-date="${d}" ${S.info.hours[wdOf(d)] ? '' : 'disabled'}><small>${WD[wdOf(d)]}</small><b>${d.slice(8)}</b><small>${MON[+d.slice(5, 7) - 1].slice(0, 3)}</small></button>`).join('')}</div>
      <label>Ou outra data</label><input type="date" id="pick" value="${w.date}" min="${today}" max="${addDays(today, S.info.rules.horizon_days)}" style="max-width:220px">
      <h3 style="margin-top:16px">Horários de ${WDF[wdOf(w.date)].toLowerCase()}, ${brDate(w.date)}</h3>${day.open ? (day.free.length || day.busy.length ? `<div class="hours">${Array.from({ length: day.open[1] - day.open[0] }, (_, i) => day.open[0] + i).map((h) => { const free = day.free.includes(h); const on = w.cart.includes(`${w.date}|${h}`); return `<button class="hour ${on ? 'on' : ''}" data-hour="${h}" ${free || on ? '' : 'disabled'}>${hh(h)}</button>`; }).join('')}</div>` : '<p class="muted">Sem horários.</p>') : '<p class="muted">Fechado neste dia.</p>'}
      <p class="muted small">Você pode escolher horas de dias diferentes no mesmo pedido (máx. ${S.info.rules.max_hours}). Cada hora custa ${brl(p.hour)}.</p>`;
      if (w.cart.length) bar = `<div class="sticky"><div class="in"><div class="grow"><b>${w.cart.length} hora${w.cart.length > 1 ? 's' : ''}</b><div class="muted small">${brl(w.cart.length * p.hour)}</div></div><button class="btn ghost sm" data-clear>Limpar</button><button class="btn" data-go>Continuar</button></div></div>`;
    } else if (w.type === 'mod4' || w.type === 'mod8') {
      if (!w.month) w.month = months[0];
      const key = `${w.room_id}|${w.type}|${w.month}`; if (!w.opts || w.opts.key !== key) w.opts = { key, data: (await api('GET', `/api/module-options?room_id=${w.room_id}&type=${w.type}&month=${w.month}`)).options };
      const len = w.type === 'mod4' ? 4 : 8; const starts = (w.weekday && w.opts.data[w.weekday]) || [];
      body = `<h3>Mês</h3><div class="chips">${months.map((m) => `<button class="chip ${m === w.month ? 'on' : ''}" data-month="${m}"><b>${MON[+m.slice(5) - 1]}</b><small>${m.slice(0, 4)}</small></button>`).join('')}</div>
      <h3>Dia fixo da semana</h3><div class="chips">${[1, 2, 3, 4, 5, 6].map((d) => `<button class="chip ${d === w.weekday ? 'on' : ''}" data-wd="${d}" ${(w.opts.data[d] || []).length ? '' : 'disabled'}><small>${WD[d]}</small><b>${WDF[d].slice(0, 3)}</b></button>`).join('')}</div>
      ${w.weekday ? `<h3 style="margin-top:8px">Início do módulo (${len} horas seguidas)</h3>${starts.length ? `<div class="hours">${starts.map((h) => `<button class="hour ${h === w.start ? 'on' : ''}" data-start="${h}">${hh(h)}–${hh(h + len)}</button>`).join('')}</div>` : '<p class="muted">Nenhum bloco livre neste dia.</p>'}` : ''}
      <p class="muted small">O módulo vale para o mesmo dia e horário em todas as semanas do mês. Valor mensal: ${brl(w.type === 'mod4' ? p.mod4 : p.mod8)}.</p>`;
      if (w.start != null && w.weekday) bar = `<div class="sticky"><div class="in"><div class="grow"><b>${WDF[w.weekday]} ${hh(w.start)}–${hh(w.start + len)}</b><div class="muted small">${monthLabel(w.month)}</div></div><button class="btn" data-go>Continuar</button></div></div>`;
    }
    v.innerHTML = `<h1>Agendar</h1>${rooms.length > 1 ? `<label>Sala</label><select id="room">${rooms.map((r) => `<option value="${r.id}" ${r.id === w.room_id ? 'selected' : ''}>${esc(r.name)}${r.description ? ' – ' + esc(r.description) : ''}</option>`).join('')}</select>` : ''}
    <h3 style="margin-top:16px">O que você precisa?</h3><div class="types">
    <button class="type ${w.type === 'avulsa' ? 'on' : ''}" data-type="avulsa"><b>Hora avulsa</b><div class="p">${brl(p.hour)}<small class="muted"> / hora</small></div><span class="muted small">Escolha horas soltas, nos dias que quiser.</span></button>
    <button class="type ${w.type === 'mod4' ? 'on' : ''}" data-type="mod4"><b>Módulo 4 horas</b><div class="p">${brl(p.mod4)}<small class="muted"> / mês</small></div><span class="muted small">4 horas seguidas, 1 dia fixo por semana.</span></button>
    <button class="type ${w.type === 'mod8' ? 'on' : ''}" data-type="mod8"><b>Módulo 8 horas</b><div class="p">${brl(p.mod8)}<small class="muted"> / mês</small></div><span class="muted small">8 horas seguidas, 1 dia fixo por semana.</span></button></div>
    <div style="margin-top:18px">${body}</div>${bar}`;
  }
  const redraw = () => draw().catch(fail);
  v.addEventListener('change', (e) => { if (e.target.id === 'room') { w.room_id = +e.target.value; w.cart = []; w.opts = null; w.start = null; redraw(); } if (e.target.id === 'pick' && e.target.value) { w.date = e.target.value; redraw(); } });
  v.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return; const d = t.dataset;
    if (d.type) { w.type = d.type; w.start = null; w.weekday = null; redraw(); }
    else if (d.date) { w.date = d.date; redraw(); }
    else if (d.hour) { const k = `${w.date}|${d.hour}`; const i = w.cart.indexOf(k); if (i >= 0) w.cart.splice(i, 1); else if (w.cart.length >= S.info.rules.max_hours) return toast(`Máximo de ${S.info.rules.max_hours} horas por pedido.`, true); else w.cart.push(k); redraw(); }
    else if ('clear' in d) { w.cart = []; redraw(); }
    else if (d.month) { w.month = d.month; w.weekday = null; w.start = null; redraw(); }
    else if (d.wd) { w.weekday = +d.wd; w.start = null; redraw(); }
    else if (d.start) { w.start = +d.start; redraw(); }
    else if ('go' in d) busy(t, async () => {
      const input = w.type === 'avulsa' ? { type: 'avulsa', room_id: w.room_id, slots: w.cart.map((k) => ({ date: k.split('|')[0], hour: +k.split('|')[1] })) } : { type: w.type, room_id: w.room_id, month: w.month, weekday: w.weekday, start_hour: w.start };
      const { quote } = await api('POST', '/api/bookings/quote', input);
      modal(`<h2>Confirme seu pedido</h2><div class="card flat"><b>${esc(quote.title)}</b><div class="muted small">${esc(quote.room)}</div><p>${esc(quote.detail)}</p><div class="row between"><span>Total</span><b style="font-size:1.4rem;font-family:Georgia,serif">${brl(quote.amount)}</b></div></div>
      <p class="muted small">Seus horários ficam reservados por <b>${S.info.rules.hold_minutes} minutos</b> para você pagar. Depois disso, voltam a ficar livres.</p><div class="row"><button class="btn grow" id="ok">Reservar e pagar</button><button class="btn ghost" data-close>Voltar</button></div>`,
        (m) => $('#ok', m).addEventListener('click', (ev) => busy(ev.target, async () => { const { booking } = await api('POST', '/api/bookings', input); S.wz = null; $('#modal-root').innerHTML = ''; location.hash = `#/pagamento/${booking.id}`; })));
    });
  });
  redraw();
}

async function uPay(v, id) {
  let b = (await api('GET', `/api/bookings/${id}`)).booking; let charge = null; let leftTimer = null;
  const summary = () => `<div class="card flat"><b>${esc(b.title)}</b><div class="muted small">${esc(b.room)}</div><p>${esc(b.detail)}</p><div class="row between"><span>Total</span><b style="font-size:1.4rem;font-family:Georgia,serif">${brl(b.amount_cents)}</b></div></div>`;
  function draw() {
    if (b.status === 'paid') {
      v.innerHTML = `<div class="card center"><div style="font-size:3rem">✅</div><h1>Pagamento confirmado!</h1><p class="muted">Seu horário está garantido. Enviamos o comprovante para o seu WhatsApp (${esc(fmtPhone(S.user.phone))}) e para a administração.</p>${summary()}
      <div class="row" style="justify-content:center"><a class="btn" target="_blank" href="/r/${b.receipt_code}">Ver comprovante</a><a class="btn ghost" href="#/reservas">Minhas reservas</a></div></div>`; return;
    }
    if (b.status !== 'pending') { v.innerHTML = `<div class="card center"><h2>Esta reserva ${b.status === 'expired' ? 'expirou' : 'foi encerrada'}</h2><p class="muted">Os horários voltaram a ficar disponíveis.</p><a class="btn" href="#/agendar">Fazer novo agendamento</a></div>`; return; }
    v.innerHTML = `<h1>Pagamento</h1>${summary()}<div class="alert" id="left"></div>
    ${S.info.simulated_payments ? '<div class="alert bad"><b>Modo de teste:</b> nenhuma cobrança real será feita. Configure o Mercado Pago em Configurações para cobrar de verdade.</div>' : ''}
    <div id="method"><h3>Como prefere pagar?</h3><div class="grid g2"><button class="btn" data-m="pix">Pix (instantâneo)</button><button class="btn ghost" data-m="card">Cartão de crédito/débito</button></div></div><div id="charge"></div>`;
    const left = () => { const s = Math.max(0, Math.floor((b.hold_expires_at - Date.now()) / 1000)); $('#left') && ($('#left').innerHTML = `Horário reservado para você por mais <b>${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</b>. Pague para confirmar.`); if (!s) { b.status = 'expired'; draw(); } };
    left(); timers.push(setInterval(left, 1000));
    v.querySelectorAll('[data-m]').forEach((btn) => btn.addEventListener('click', () => busy(btn, async () => {
      charge = (await api('POST', `/api/bookings/${b.id}/pay`, { method: btn.dataset.m })).charge; drawCharge();
    })));
  }
  function drawCharge() {
    const c = charge; let h = '';
    if (c.method === 'pix') h = `<div class="card"><h3>Pague com Pix</h3>${c.pix_qr_base64 ? `<img class="qr" alt="QR Code Pix" src="data:image/png;base64,${c.pix_qr_base64}">` : ''}<p class="muted small center">Abra o app do seu banco, escolha <b>Pix &gt; Copia e Cola</b> ou leia o QR Code.</p><div class="pix">${esc(c.pix_code || '')}</div><button class="btn block" style="margin-top:10px" data-copy>Copiar código Pix</button>${c.ticket_url ? `<p class="center"><a href="${esc(c.ticket_url)}" target="_blank" rel="noopener">Abrir página do Pix</a></p>` : ''}<p class="muted small center">Assim que o pagamento for aprovado, esta tela atualiza sozinha.</p></div>`;
    else h = c.checkout_url ? `<div class="card center"><h3>Pagamento com cartão</h3><p class="muted">Você será levada(o) ao ambiente seguro do Mercado Pago. Ao terminar, volte para cá.</p><a class="btn" href="${esc(c.checkout_url)}">Ir para o pagamento seguro</a></div>` : `<div class="card"><h3>Cartão (modo de teste)</h3><p class="muted">Em produção você será levada(o) a um ambiente seguro para digitar o cartão.</p></div>`;
    if (c.simulated) h += `<button class="btn gold block" data-sim>Simular pagamento aprovado (teste)</button>`;
    $('#charge').innerHTML = h; $('#method').style.display = 'none';
    const cp = $('[data-copy]'); if (cp) cp.addEventListener('click', () => copy(c.pix_code));
    const sim = $('[data-sim]'); if (sim) sim.addEventListener('click', () => busy(sim, async () => { b = (await api('POST', `/api/bookings/${b.id}/simulate-pay`, { method: c.method })).booking; draw(); }));
  }
  draw();
  timers.push(setInterval(async () => { if (b.status !== 'pending') return; try { const n = (await api('GET', `/api/bookings/${b.id}`)).booking; if (n.status !== 'pending') { b = n; draw(); } } catch {} }, 4000));
}

// ===== Gestor =====
const TYPE = { avulsa: 'Hora avulsa', mod4: 'Módulo 4h', mod8: 'Módulo 8h', bloqueio: 'Bloqueio' };
async function aDash(v) {
  const d = await api('GET', '/api/admin/dashboard'); const alerts = [];
  if (d.simulated_payments) alerts.push(['bad', '<b>Cobrança em modo de teste.</b> Nenhum pagamento real está sendo processado. Ative o Mercado Pago em <a href="#/admin/config">Configurações</a>.']);
  if (d.wa_mode !== 'cloud') alerts.push(['', '<b>WhatsApp automático desligado.</b> Os comprovantes são registrados, mas não enviados sozinhos. Você pode enviá-los manualmente em <a href="#/admin/comprovantes">Comprovantes</a> ou ativar a API em Configurações.']);
  if (!d.admin_whatsapp) alerts.push(['bad', 'Informe o WhatsApp da administração em <a href="#/admin/config">Configurações</a> para receber os comprovantes.']);
  if (d.failed_msgs) alerts.push(['bad', `${d.failed_msgs} mensagem(ns) de WhatsApp falharam. <a href="#/admin/comprovantes">Reenviar</a>`]);
  if (d.refunds) alerts.push(['', `${d.refunds} reembolso(s) para fazer. <a href="#/admin/reservas">Ver reservas</a>`]);
  v.innerHTML = `<h1>Painel</h1>${alerts.map(([c, t]) => `<div class="alert ${c}">${t}</div>`).join('')}
  <div class="grid g3"><div class="card stat"><div class="l">Recebido em ${monthLabel(d.month)}</div><div class="n">${brl(d.revenue)}</div></div><div class="card stat"><div class="l">Reservas pagas no mês</div><div class="n">${d.paid}</div></div><div class="card stat"><div class="l">Aguardando pagamento</div><div class="n">${d.pending}</div></div><div class="card stat"><div class="l">Profissionais ativos</div><div class="n">${d.users}</div></div></div>
  <div class="grid g2"><div class="card"><h3>Hoje, ${brDate(S.info.today)}</h3><div id="today" class="list"></div></div>
  <div class="card"><h3>Ocupação dos próximos 7 dias</h3>${d.capacity.map((c) => `<div class="dayrow"><span>${WD[wdOf(c.date)]} ${brDate(c.date).slice(0, 5)}</span><div class="bar"><i style="width:${c.total ? Math.round((100 * c.used) / c.total) : 0}%"></i></div><span class="muted small">${c.total ? Math.round((100 * c.used) / c.total) + '%' : 'fechado'}</span></div>`).join('')}</div></div>`;
  const ag = await api('GET', `/api/admin/agenda?date=${S.info.today}`); const rooms = Object.fromEntries(ag.rooms.map((r) => [r.id, r.name]));
  const rows = ag.slots.filter((s) => s.status === 'paid').sort((a, b) => a.hour - b.hour);
  $('#today').innerHTML = rows.length ? rows.map((s) => `<div class="row between"><span><b>${hh(s.hour)}</b> · ${esc(rooms[s.room_id])}</span><span>${esc(s.user_name)}${s.type === 'bloqueio' ? ' (bloqueio)' : ''}</span></div>`).join('') : '<p class="muted">Nenhum atendimento hoje.</p>';
}
async function aAgenda(v) {
  let date = S.info.today; const sel = {};
  async function draw() {
    const ag = await api('GET', `/api/admin/agenda?date=${date}`); const rooms = ag.rooms;
    const map = {}; for (const s of ag.slots) map[`${s.room_id}|${s.hour}`] = s;
    v.innerHTML = `<h1>Agenda</h1><div class="row" style="margin-bottom:12px"><button class="btn sm ghost" data-d="-1">‹</button><input type="date" id="dt" value="${date}" style="max-width:170px"><button class="btn sm ghost" data-d="1">›</button><button class="btn sm ghost" data-d="0">Hoje</button><span class="muted">${WDF[wdOf(date)]}</span></div>
    ${ag.open ? `<div class="agenda" style="grid-template-columns:62px repeat(${rooms.length},1fr)"><div class="h">Hora</div>${rooms.map((r) => `<div class="h">${esc(r.name)}</div>`).join('')}${Array.from({ length: ag.open[1] - ag.open[0] }, (_, i) => ag.open[0] + i).map((h) => `<div class="t">${hh(h)}</div>${rooms.map((r) => { const s = map[`${r.id}|${h}`]; return s ? `<button class="c ${s.type === 'bloqueio' ? 'block' : s.status === 'pending' ? 'pend' : 'busy'}" data-b="${s.booking_id}" data-n="${esc(s.user_name)}" data-t="${esc(s.title)}" data-s="${s.status}">${esc(s.user_name.split(' ')[0])}${s.status === 'pending' ? ' ⏳' : ''}<br><span class="muted">${esc(s.title.replace('Módulo ', 'Mód. ').slice(0, 22))}</span></button>` : `<button class="c free" data-free="${r.id}|${h}" aria-label="Horário livre"></button>`; }).join('')}`).join('')}</div>
    <p class="muted small">Verde: pago · Amarelo: aguardando pagamento · Cinza: bloqueado · Toque num horário livre para bloquear.</p>` : '<div class="card muted">Espaço fechado neste dia.</div>'}`;
  }
  v.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return; const d = t.dataset;
    if (d.d !== undefined) { date = d.d === '0' ? S.info.today : addDays(date, +d.d); draw().catch(fail); }
    else if (d.b) modal(`<h3>${esc(d.n)}</h3><p>${esc(d.t)}</p><p>${badge({ status: d.s })}</p><div class="row"><a class="btn sm ghost" href="#/admin/reservas" data-close>Ver em Reservas</a><button class="btn sm danger" id="cx">Cancelar reserva</button><button class="btn sm ghost" data-close>Fechar</button></div>`,
      (m, close) => $('#cx', m).addEventListener('click', (ev) => { if (!confirm('Cancelar esta reserva? Se estiver paga, ficará um reembolso pendente.')) return; busy(ev.target, async () => { await api('POST', `/api/bookings/${d.b}/cancel`, { reason: 'Cancelado pela gestão' }); close(); toast('Reserva cancelada.'); draw(); }); }));
    else if (d.free) { const [room, hour] = d.free.split('|'); modal(`<h3>Bloquear ${brDate(date)} às ${hh(+hour)}</h3><p class="muted small">Impede agendamentos neste horário (manutenção, uso próprio, etc.).</p><label>Motivo</label><input id="why" placeholder="Ex.: manutenção"><div class="row" style="margin-top:14px"><button class="btn grow" id="bk">Bloquear</button><button class="btn ghost" data-close>Voltar</button></div>`,
      (m, close) => $('#bk', m).addEventListener('click', (ev) => busy(ev.target, async () => { await api('POST', '/api/admin/blocks', { room_id: +room, date, hours: [+hour], reason: $('#why', m).value }); close(); toast('Horário bloqueado.'); draw(); }))); }
  });
  v.addEventListener('change', (e) => { if (e.target.id === 'dt' && e.target.value) { date = e.target.value; draw().catch(fail); } });
  await draw();
}
async function aBookings(v) {
  const f = { status: '', type: '', month: '' };
  async function draw() {
    const qs = new URLSearchParams(Object.entries(f).filter(([, x]) => x)).toString(); const { bookings } = await api('GET', '/api/admin/bookings?' + qs);
    $('#tbl').innerHTML = bookings.length ? `<div class="tablewrap"><table><thead><tr><th>#</th><th>Profissional</th><th>Serviço</th><th>Valor</th><th>Status</th><th>Ações</th></tr></thead><tbody>${bookings.map((b) => `<tr><td>${b.id}</td><td><b>${esc(b.user_name)}</b><div class="muted small">${esc(b.user_specialty || '')}<br>${esc(fmtPhone(b.user_phone))}</div></td>
      <td>${esc(b.title)}<div class="muted small">${esc(b.room)} · ${esc(b.detail)}</div></td><td>${b.amount_cents ? brl(b.amount_cents) : '—'}<div class="muted small">${b.pay_method === 'manual' ? 'direto' : b.pay_method || ''}</div></td><td>${badge(b)}${b.refund_status === 'solicitado' ? '<br><span class="badge bad">Reembolsar</span>' : ''}<div class="muted small">${sqlLocal(b.paid_at)}</div></td>
      <td><div class="row" style="gap:6px">${['pending', 'expired'].includes(b.status) ? `<button class="btn sm" data-confirm="${b.id}">Confirmar pgto</button>` : ''}${['pending', 'paid'].includes(b.status) ? `<button class="btn sm ghost" data-cx="${b.id}">Cancelar</button>` : ''}${b.refund_status === 'solicitado' || b.status === 'refund_needed' ? `<button class="btn sm gold" data-refund="${b.id}">Reembolso feito</button>` : ''}${b.receipt_code ? `<a class="btn sm ghost" target="_blank" href="/r/${b.receipt_code}">Comprovante</a>` : ''}<a class="btn sm ghost" target="_blank" href="${waLink(b.user_phone, 'Olá ' + b.user_name.split(' ')[0] + '! ')}">WhatsApp</a></div></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhuma reserva encontrada.</p>';
  }
  const months = Array.from({ length: 6 }, (_, i) => { const [y, m] = S.info.today.slice(0, 7).split('-').map(Number); return new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7); });
  v.innerHTML = `<h1>Reservas</h1><div class="card"><div class="grid g3"><div><label>Status</label><select data-f="status"><option value="">Todos</option>${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
  <div><label>Tipo</label><select data-f="type"><option value="">Todos</option>${['avulsa', 'mod4', 'mod8', 'bloqueio'].map((k) => `<option value="${k}">${TYPE[k]}</option>`).join('')}</select></div>
  <div><label>Mês do pagamento</label><select data-f="month"><option value="">Todos</option>${months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('')}</select></div></div></div><div class="card" id="tbl"></div>`;
  v.addEventListener('change', (e) => { if (e.target.dataset.f) { f[e.target.dataset.f] = e.target.value; draw().catch(fail); } });
  v.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return; const d = t.dataset;
    const act = (url, msg, ask) => { if (ask && !confirm(ask)) return; busy(t, async () => { await api('POST', url, {}); toast(msg); draw(); }); };
    if (d.confirm) act(`/api/admin/bookings/${d.confirm}/confirm`, 'Pagamento confirmado e comprovantes enviados.', 'Confirmar que o pagamento foi recebido fora do aplicativo? Os comprovantes serão enviados.');
    else if (d.cx) act(`/api/bookings/${d.cx}/cancel`, 'Reserva cancelada.', 'Cancelar esta reserva? Se estiver paga, ficará marcada para reembolso.');
    else if (d.refund) act(`/api/admin/bookings/${d.refund}/refund-done`, 'Reembolso registrado.', 'Confirmar que o reembolso foi feito ao cliente?');
  });
  await draw();
}
const userForm = (u = {}) => `<form id="uf"><label>Nome completo</label><input name="name" value="${esc(u.name || '')}" required><label>E-mail</label><input name="email" type="email" value="${esc(u.email || '')}" required>
  <div class="grid g2"><div><label>WhatsApp</label><input name="phone" data-mask="phone" value="${esc(fmtPhone(u.phone))}" required></div><div><label>CPF</label><input name="cpf" data-mask="cpf" value="${esc(u.cpf || '')}"></div></div>
  <div class="grid g2"><div><label>Especialidade</label><input name="specialty" value="${esc(u.specialty || '')}"></div><div><label>Registro profissional</label><input name="registry" value="${esc(u.registry || '')}"></div></div>
  <div class="grid g2"><div><label>Perfil de acesso</label><select name="role"><option value="user" ${u.role !== 'admin' ? 'selected' : ''}>Profissional (usuário)</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Gestor/Administrador</option></select></div>
  ${u.id ? `<div><label>Situação</label><select name="active"><option value="1" ${u.active ? 'selected' : ''}>Ativo</option><option value="0" ${!u.active ? 'selected' : ''}>Desativado (sem acesso)</option></select></div>` : ''}</div>
  <label>${u.id ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial (mín. 8 caracteres)'}</label><input name="password" type="password" minlength="8" ${u.id ? '' : 'required'} autocomplete="new-password">
  <div class="row" style="margin-top:16px"><button class="btn grow">Salvar</button><button type="button" class="btn ghost" data-close>Cancelar</button></div></form>`;
async function aUsers(v) {
  async function draw() {
    const { users } = await api('GET', '/api/admin/users'); window._users = users;
    v.innerHTML = `<div class="row between"><h1>Profissionais</h1><button class="btn" data-new>+ Novo cadastro</button></div><div class="card"><div class="tablewrap"><table><thead><tr><th>Nome</th><th>Contato</th><th>Perfil</th><th>Pagos</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="muted small">${esc(u.specialty || '')} ${esc(u.registry || '')}</div></td><td class="small">${esc(u.email)}<br>${esc(fmtPhone(u.phone))}</td><td>${u.role === 'admin' ? '<span class="badge">Gestor</span>' : 'Profissional'}${u.active ? '' : ' <span class="badge bad">Desativado</span>'}</td><td>${u.paid_count} · ${brl(u.paid_total)}</td><td><button class="btn sm ghost" data-edit="${u.id}">Editar</button></td></tr>`).join('')}</tbody></table></div></div>`;
  }
  v.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return; const isNew = 'new' in t.dataset; if (!isNew && !t.dataset.edit) return;
    const u = isNew ? {} : window._users.find((x) => x.id === +t.dataset.edit);
    modal(`<h2>${isNew ? 'Novo cadastro' : 'Editar cadastro'}</h2>${userForm(u)}`, (m, close) => { applyMasks(m); $('#uf', m).addEventListener('submit', (ev) => { ev.preventDefault(); busy(ev.submitter, async () => {
      const f = formData(ev.target); if (!f.password) delete f.password; if (f.active !== undefined) f.active = f.active === '1';
      if (isNew) await api('POST', '/api/admin/users', f); else await api('PUT', `/api/admin/users/${u.id}`, f); close(); toast('Cadastro salvo.'); draw(); }); }); });
  });
  await draw();
}
async function aNotifs(v) {
  const { notifications } = await api('GET', '/api/admin/notifications');
  const st = { sent: ['Enviado', ''], simulated: ['Registrado (WhatsApp automático desligado)', 'pending'], failed: ['Falhou', 'bad'], pending: ['Na fila', 'pending'] };
  v.innerHTML = `<h1>Comprovantes enviados</h1><p class="muted">Registro de todas as mensagens geradas após cada pagamento — para o profissional e para a administração.</p><div class="card"><div class="tablewrap"><table><thead><tr><th>Quando</th><th>Para</th><th>Reserva</th><th>Status</th><th></th></tr></thead><tbody>${notifications.map((n) => `<tr><td class="small">${sqlLocal(n.created_at)}</td><td>${n.audience === 'admin' ? 'Administração' : esc(n.user_name || 'Profissional')}<div class="muted small">${esc(fmtPhone(n.to_phone))}</div></td><td>#${n.booking_id || ''}${n.receipt_code ? ` · <a target="_blank" href="/r/${n.receipt_code}">${n.receipt_code}</a>` : ''}</td><td><span class="badge ${(st[n.status] || [])[1] || ''}">${(st[n.status] || [n.status])[0]}</span>${n.error ? `<div class="small" style="color:var(--bad)">${esc(n.error)}</div>` : ''}</td>
  <td><div class="row" style="gap:6px"><button class="btn sm ghost" data-resend="${n.id}">Reenviar</button><a class="btn sm ghost" target="_blank" rel="noopener" href="${waLink(n.to_phone, n.body)}">Abrir no WhatsApp</a></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nada por aqui ainda.</td></tr>'}</tbody></table></div></div>`;
  v.addEventListener('click', (e) => { const t = e.target.closest('[data-resend]'); if (t) busy(t, async () => { await api('POST', `/api/admin/notifications/${t.dataset.resend}/resend`, {}); toast('Reenvio solicitado.'); render(); }); });
}
async function aShare(v) {
  const s = await api('GET', '/api/admin/share'); const warn = /localhost|127\.0\.0\.1|192\.168\./.test(s.link);
  v.innerHTML = `<h1>Divulgar para os profissionais</h1>${warn ? '<div class="alert bad">Este endereço só funciona neste computador/rede. Ao publicar o aplicativo na internet, informe o endereço público em <a href="#/admin/config">Configurações</a>.</div>' : ''}
  <div class="grid g2"><div class="card"><h3>Link do aplicativo</h3><input id="lnk" value="${esc(s.link)}" readonly><div class="row" style="margin-top:10px"><button class="btn sm" data-copy="#lnk">Copiar link</button><a class="btn sm ghost" target="_blank" rel="noopener" href="${waLink('', s.message)}">Enviar no WhatsApp</a></div>
  <h3 style="margin-top:20px">QR Code</h3><p class="muted small">Imprima e deixe na recepção.</p><img class="qr" alt="QR Code do aplicativo" src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(s.link)}"></div>
  <div class="card"><h3>Mensagem pronta para o WhatsApp</h3><textarea id="msg" style="min-height:190px">${esc(s.message)}</textarea><div class="row" style="margin-top:10px"><button class="btn sm" data-copy="#msg">Copiar mensagem</button><a class="btn sm ghost" id="wa" target="_blank" rel="noopener" href="${waLink('', s.message)}">Abrir no WhatsApp</a></div>
  <div class="alert ok" style="margin-top:16px"><b>Dica:</b> no WhatsApp Business, cadastre esta mensagem em <i>Ferramentas &gt; Mensagem de saudação</i> ou como <i>Resposta rápida</i> (ex.: <b>/agenda</b>). Assim, todo profissional novo recebe o link no início da conversa.</div></div></div>
  <div class="card"><h3>Instalar como aplicativo no celular</h3><p><b>Android (Chrome):</b> abra o link &gt; menu ⋮ &gt; <i>Instalar aplicativo</i>.<br><b>iPhone (Safari):</b> abra o link &gt; botão Compartilhar &gt; <i>Adicionar à Tela de Início</i>.</p></div>`;
  $('#msg').addEventListener('input', (e) => ($('#wa').href = waLink('', e.target.value)));
  v.addEventListener('click', (e) => { const t = e.target.closest('[data-copy]'); if (t) copy($(t.dataset.copy).value); });
}
async function aConfig(v) {
  const { settings: s, rooms } = await api('GET', '/api/admin/settings');
  const hrow = (d) => `<div class="row" style="margin:6px 0"><div style="width:90px">${WDF[d]}</div><label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" data-open="${d}" ${s.hours[d] ? 'checked' : ''}> aberto</label><select data-from="${d}" style="width:auto">${hourOpts(s.hours[d] ? s.hours[d][0] : 8, 0, 23)}</select> às <select data-to="${d}" style="width:auto">${hourOpts(s.hours[d] ? s.hours[d][1] : 18, 1, 24)}</select></div>`;
  v.innerHTML = `<h1>Configurações</h1>
  <form id="cf"><div class="card"><h2>Espaço</h2><label>Nome do espaço</label><input name="space_name" value="${esc(s.space_name)}" required>
  <label>WhatsApp da administração (recebe todos os comprovantes)</label><input name="admin_whatsapp" data-mask="phone" value="${esc(fmtPhone(s.admin_whatsapp))}" placeholder="(11) 99999-9999">
  <label>Endereço público do aplicativo (usado nos links dos comprovantes)</label><input name="base_url" value="${esc(s.base_url)}" placeholder="https://agenda.seudominio.com.br">
  <label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" name="allow_signup" ${s.allow_signup ? 'checked' : ''}> Permitir que novos profissionais criem o próprio perfil</label></div>
  <div class="card"><h2>Horário de funcionamento</h2>${[1, 2, 3, 4, 5, 6, 0].map(hrow).join('')}</div>
  <div class="card"><h2>Valores</h2><div class="grid g3"><div><label>Módulo 4 horas (mês)</label><input name="price_mod4" inputmode="decimal" value="${fromCents(s.price_mod4)}"></div><div><label>Módulo 8 horas (mês)</label><input name="price_mod8" inputmode="decimal" value="${fromCents(s.price_mod8)}"></div><div><label>Hora avulsa</label><input name="price_hour" inputmode="decimal" value="${fromCents(s.price_hour)}"></div></div></div>
  <div class="card"><h2>Regras para o profissional</h2><div class="grid g2"><div><label>Prazo para pagar (minutos)</label><input type="number" name="hold_minutes" value="${s.hold_minutes}"></div><div><label>Antecedência mínima para agendar (horas)</label><input type="number" name="min_notice_hours" value="${s.min_notice_hours}"></div><div><label>Cancelamento de hora avulsa até (horas antes)</label><input type="number" name="cancel_hours" value="${s.cancel_hours}"></div><div><label>Agendar até (dias à frente)</label><input type="number" name="horizon_days" value="${s.horizon_days}"></div><div><label>Máximo de horas avulsas por pedido</label><input type="number" name="max_hours_per_booking" value="${s.max_hours_per_booking}"></div></div>
  <p class="muted small">O profissional só consegue: ver horários livres, reservar, pagar, ver/cancelar as próprias reservas (módulos pagos só a gestão cancela) e editar o próprio perfil.</p></div>
  <div class="card"><h2>Cobrança (Pix e cartão)</h2><label>Provedor</label><select name="payment_provider"><option value="simulado" ${s.payment_provider === 'simulado' ? 'selected' : ''}>Modo de teste (não cobra de verdade)</option><option value="mercadopago" ${s.payment_provider === 'mercadopago' ? 'selected' : ''}>Mercado Pago (Pix + cartão)</option></select>
  <label>Access Token do Mercado Pago ${s.has_mp_access_token ? '<span class="badge">já informado</span>' : ''}</label><input name="mp_access_token" type="password" placeholder="${s.has_mp_access_token ? 'deixe em branco para manter' : 'APP_USR-…'}" autocomplete="off">
  <p class="muted small">No Mercado Pago: Seu negócio &gt; Configurações &gt; Credenciais. No painel de Webhooks, aponte para <b>${esc((s.base_url || 'https://SEU-ENDEREÇO') + '/api/webhooks/mercadopago')}</b> (evento: Pagamentos).</p></div>
  <div class="card"><h2>WhatsApp automático</h2><label>Modo</label><select name="wa_provider"><option value="log" ${s.wa_provider === 'log' ? 'selected' : ''}>Desligado (só registra; envio manual em Comprovantes)</option><option value="cloud" ${s.wa_provider === 'cloud' ? 'selected' : ''}>API oficial do WhatsApp (Meta Cloud API)</option></select>
  <div class="grid g2"><div><label>Phone Number ID</label><input name="wa_phone_id" value="${esc(s.wa_phone_id)}"></div><div><label>Token de acesso ${s.has_wa_token ? '<span class="badge">já informado</span>' : ''}</label><input name="wa_token" type="password" autocomplete="off" placeholder="${s.has_wa_token ? 'deixe em branco para manter' : ''}"></div>
  <div><label>Nome do modelo de mensagem (opcional)</label><input name="wa_template" value="${esc(s.wa_template)}" placeholder="comprovante_pagamento"></div><div><label>Idioma do modelo</label><input name="wa_template_lang" value="${esc(s.wa_template_lang)}"></div></div>
  <p class="muted small">Mensagens enviadas fora da janela de 24h exigem um modelo aprovado pela Meta (com 1 variável no corpo). Veja o passo a passo no README.</p></div>
  <button class="btn block" style="margin-bottom:24px">Salvar configurações</button></form>
  <div class="card"><div class="row between"><h2>Salas</h2><button class="btn sm" data-room="new">+ Nova sala</button></div><div class="list">${rooms.map((r) => `<div class="row between"><span><b>${esc(r.name)}</b> ${r.active ? '' : '<span class="badge grey">inativa</span>'}<div class="muted small">${esc(r.description || '')}</div></span><button class="btn sm ghost" data-room="${r.id}">Editar</button></div>`).join('')}</div></div>`;
  applyMasks(v);
  $('#cf').addEventListener('submit', (ev) => { ev.preventDefault(); busy(ev.submitter, async () => {
    const f = formData(ev.target); const hours = {}; for (let d = 0; d <= 6; d++) hours[d] = $(`[data-open="${d}"]`).checked ? [+$(`[data-from="${d}"]`).value, +$(`[data-to="${d}"]`).value] : null;
    const body = { ...f, hours, allow_signup: $('[name=allow_signup]').checked, price_mod4: toCents(f.price_mod4), price_mod8: toCents(f.price_mod8), price_hour: toCents(f.price_hour) };
    ['hold_minutes', 'min_notice_hours', 'cancel_hours', 'horizon_days', 'max_hours_per_booking'].forEach((k) => (body[k] = +body[k]));
    await api('PUT', '/api/admin/settings', body); S.info = await api('GET', '/api/public/info'); toast('Configurações salvas.'); render(); }); });
  v.addEventListener('click', (e) => { const t = e.target.closest('[data-room]'); if (!t) return; const r = rooms.find((x) => x.id === +t.dataset.room) || {};
    modal(`<h2>${r.id ? 'Editar sala' : 'Nova sala'}</h2><form id="rf"><label>Nome</label><input name="name" value="${esc(r.name || '')}" required><label>Descrição (opcional)</label><input name="description" value="${esc(r.description || '')}" placeholder="Ex.: maca, 2 poltronas">
    ${r.id ? `<label>Situação</label><select name="active"><option value="1" ${r.active ? 'selected' : ''}>Ativa</option><option value="0" ${!r.active ? 'selected' : ''}>Inativa (não aparece para agendamento)</option></select>` : ''}<div class="row" style="margin-top:16px"><button class="btn grow">Salvar</button><button type="button" class="btn ghost" data-close>Cancelar</button></div></form>`,
      (m, close) => $('#rf', m).addEventListener('submit', (ev) => { ev.preventDefault(); busy(ev.submitter, async () => { const f = formData(ev.target); if (f.active !== undefined) f.active = f.active === '1';
        if (r.id) await api('PUT', `/api/admin/rooms/${r.id}`, f); else await api('POST', '/api/admin/rooms', f); S.info = await api('GET', '/api/public/info'); close(); toast('Sala salva.'); render(); }); })); });
}
boot();
