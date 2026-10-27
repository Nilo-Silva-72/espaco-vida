// Telas do gestor/administrador.
import {
  h, api, busy, toast, copy, field, txt, skeleton, errorBox, openModal, hoursEditor, brl, hh, brDate, brMonth, addDays, addMonths,
  weekdayOf, WEEKDAYS, statusBadge, fmtPhone, fmtDateTime, parseMoney, moneyInput,
} from './ui.js';

const btnAct = (label, cls, fn) => (close) => h('button', { class: `btn ${cls}`, type: 'button', onclick: (e) => fn(e.currentTarget, close) }, label);
const normPhone = (raw) => { let d = String(raw || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) d = '55' + d; return /^55\d{10,11}$/.test(d) ? d : null; };

// =====================================================================
// PAINEL
// =====================================================================
export function painelView(app) {
  const root = h('div', {}, h('h1', {}, 'Painel'), skeleton(3));
  (async () => {
    try {
      const d = await api('GET', '/api/admin/dashboard');
      const a = app.state.admin;
      const alerts = [];
      if (d.attention) alerts.push(h('a', { class: 'alert bad', href: '#/admin/reservas?attention=1', style: { display: 'block' } }, `⚠ ${d.attention} reserva(s) precisam da sua atenção (pedido de cancelamento ou pagamento a conferir).`));
      if (d.users_pending) alerts.push(h('a', { class: 'alert warn', href: '#/admin/profissionais', style: { display: 'block' } }, `${d.users_pending} cadastro(s) de profissionais aguardando aprovação.`));
      if (d.outbox_failed) alerts.push(h('a', { class: 'alert bad', href: '#/admin/whatsapp', style: { display: 'block' } }, `${d.outbox_failed} mensagem(ns) de WhatsApp falharam. Toque para ver.`));
      if (d.outbox_manual) alerts.push(h('a', { class: 'alert warn', href: '#/admin/whatsapp', style: { display: 'block' } }, `${d.outbox_manual} comprovante(s) aguardando envio manual por WhatsApp.`));
      if (a.payment.demo) alerts.push(h('div', { class: 'alert warn' }, 'Pagamentos em MODO DEMONSTRAÇÃO: nenhuma cobrança real é feita. Configure o Mercado Pago (veja o README) para cobrar de verdade.'));
      else if (!a.payment.configured) alerts.push(h('div', { class: 'alert bad' }, 'Mercado Pago selecionado, mas falta o MP_ACCESS_TOKEN. Os profissionais não conseguirão pagar.'));
      if (a.whatsapp.provider === 'manual') alerts.push(h('div', { class: 'alert' }, 'WhatsApp em modo manual: os comprovantes ficam na fila e você envia com 1 toque na aba WhatsApp. Para envio 100% automático, configure a WhatsApp Cloud API (README).'));
      root.replaceChildren(
        h('h1', {}, 'Painel'), alerts,
        h('div', { class: 'kpis' },
          h('div', { class: 'kpi' }, h('b', {}, brl(d.revenue_cents)), h('span', {}, 'Recebido no mês')),
          h('div', { class: 'kpi' }, h('b', {}, `${d.occupancy_pct}%`), h('span', {}, 'Ocupação do mês')),
          h('div', { class: 'kpi' }, h('b', {}, d.confirmed_upcoming), h('span', {}, 'Reservas futuras')),
          h('div', { class: 'kpi' }, h('b', {}, d.pending), h('span', {}, 'Aguardando pagamento')),
          h('div', { class: 'kpi' }, h('b', {}, d.users_active), h('span', {}, 'Profissionais ativos'))),
        h('div', { class: 'card' }, h('h2', {}, 'Hoje no Espaço'),
          d.today.length ? h('div', { class: 'list' }, d.today.map((t) => h('div', { class: 'item' },
            h('b', { style: { minWidth: '7.5rem' } }, `${hh(t.start)} – ${hh(t.end)}`),
            h('div', { class: 'grow' }, t.who, h('div', { class: 'muted small' }, t.room)),
            t.type === 'block' ? h('span', { class: 'badge' }, 'Bloqueio') : t.status === 'pending' ? h('span', { class: 'badge warn' }, 'Aguardando pgto') : h('span', { class: 'badge ok' }, 'Confirmado'))))
            : h('p', { class: 'muted' }, 'Nenhum atendimento agendado para hoje.')));
    } catch (e) { root.replaceChildren(errorBox(e)); }
  })();
  return root;
}

// =====================================================================
// AGENDA (visão por dia/sala)
// =====================================================================
export function agendaView(app) {
  const st = { date: app.state.today };
  const root = h('div');
  const grid = h('div');

  async function load() {
    grid.replaceChildren(skeleton(3));
    try {
      const av = await api('GET', `/api/availability?date=${st.date}`);
      if (!av.open) { grid.replaceChildren(h('div', { class: 'alert warn' }, 'O Espaço não atende neste dia.')); return; }
      const hours = av.rooms[0]?.hours.map((c) => c.hour) || [];
      grid.replaceChildren(h('div', { class: 'card tablewrap' }, h('table', { class: 'agenda' },
        h('thead', {}, h('tr', {}, h('th', {}), av.rooms.map((r) => h('th', {}, r.name)))),
        h('tbody', {}, hours.map((hr) => h('tr', {}, h('td', { class: 'hr' }, hh(hr)),
          av.rooms.map((r) => {
            const c = r.hours.find((x) => x.hour === hr);
            if (c.state === 'free') return h('td', {}, h('button', { class: 'cell free', title: 'Agendar manualmente', onclick: () => newBookingModal(app, { type: 'hourly', date: st.date, room_id: r.id, hours: [hr] }, load) }, '+ livre'));
            if (c.state === 'past') return h('td', {}, h('button', { class: 'cell past', disabled: true }, '—'));
            const cls = c.btype === 'block' ? 'block' : c.bstatus === 'pending' ? 'pend' : 'busy';
            return h('td', {}, h('button', { class: `cell ${cls}`, onclick: () => bookingModal(app, c.booking_id, load) }, c.btype === 'block' ? 'Bloqueado' : c.who, c.bstatus === 'pending' ? ' (aguardando)' : ''));
          })))))));
    } catch (e) { grid.replaceChildren(errorBox(e)); }
  }
  const dateInput = h('input', { type: 'date', value: st.date, 'aria-label': 'Data', onchange: (e) => { if (e.target.value) { st.date = e.target.value; load(); } } });
  const go = (n) => { st.date = addDays(st.date, n); dateInput.value = st.date; load(); };
  root.append(
    h('div', { class: 'row between mb' }, h('h1', {}, 'Agenda'),
      h('button', { class: 'btn', onclick: () => newBookingModal(app, { type: 'hourly', date: st.date }, load) }, '+ Novo agendamento')),
    h('div', { class: 'row mb' },
      h('button', { class: 'btn ghost sm', onclick: () => go(-1), 'aria-label': 'Dia anterior' }, '‹'),
      h('div', { style: { width: '11rem' } }, dateInput),
      h('button', { class: 'btn ghost sm', onclick: () => go(1), 'aria-label': 'Próximo dia' }, '›'),
      h('button', { class: 'btn ghost sm', onclick: () => { st.date = app.state.today; dateInput.value = st.date; load(); } }, 'Hoje'),
      h('span', { class: 'muted small' }, 'Toque em um horário livre para agendar/bloquear, ou em um ocupado para ver detalhes.')),
    grid);
  load();
  return root;
}

// ----- detalhes da reserva (modal) -----
async function bookingModal(app, id, onDone) {
  try {
    const { booking: b } = await api('GET', `/api/bookings/${id}`);
    openModal(`Reserva #${b.id}`, bookingBody(b));
    const m = document.querySelector('.modal');
    m.append(h('div', { class: 'actions' }, bookingActions(app, b, () => { document.querySelector('.overlay')?.remove(); onDone?.(); })));
  } catch (e) { toast(e.message, 'bad'); }
}

function bookingBody(b) {
  return h('div', {},
    h('div', { class: 'row between' }, h('b', {}, b.type === 'block' ? 'Bloqueio' : b.user_name), statusBadge(b)),
    b.type !== 'block' ? h('div', { class: 'muted small' }, `${b.user_specialty || ''} ${b.user_specialty ? '· ' : ''}${fmtPhone(b.user_phone)} · ${b.user_email}`) : null,
    h('h3', { class: 'mt' }, b.title), b.lines.map((l) => h('div', {}, l)),
    h('div', { class: 'muted small' }, `${b.room_name} · ${brl(b.amount_cents)}${b.payment?.status === 'paid' ? ` · pago via ${b.payment.method_label}` : ''}${b.paid_at ? ' em ' + fmtDateTime(b.paid_at) : ''}`),
    b.cancel_requested ? h('div', { class: 'alert warn mt' }, 'O profissional solicitou o cancelamento desta reserva.') : null,
    b.needs_attention ? h('div', { class: 'alert bad mt' }, b.note || 'Requer conferência.') : (b.note ? h('div', { class: 'small muted mt' }, `Obs.: ${b.note}`) : null));
}

function bookingActions(app, b, reload) {
  const out = [];
  if (b.receipt_url) out.push(h('a', { class: 'btn ghost sm', href: b.receipt_url, target: '_blank', rel: 'noopener' }, 'Comprovante'));
  if (b.status === 'pending') {
    out.push(h('button', { class: 'btn sm', onclick: () => confirmModal(b, reload) }, 'Confirmar pagamento manual'));
  }
  if ((b.needs_attention || b.cancel_requested) && b.status !== 'cancelled') {
    out.push(h('button', { class: 'btn ghost sm', onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/admin/bookings/${b.id}/resolve`, {}); toast('Alerta resolvido.', 'ok'); reload(); }) }, b.cancel_requested ? 'Recusar cancelamento' : 'Marcar como resolvido'));
  }
  if (b.status === 'pending' || b.status === 'confirmed') out.push(h('button', { class: 'btn danger sm', onclick: () => cancelModal(b, reload) }, 'Cancelar reserva'));
  return out;
}

function confirmModal(b, reload) {
  const sel = h('select', {}, h('option', { value: 'manual_pix' }, 'Pix recebido direto na conta'), h('option', { value: 'cash' }, 'Dinheiro / maquininha'), h('option', { value: 'courtesy' }, 'Cortesia (sem cobrança)'));
  openModal('Confirmar pagamento manual', h('div', {}, h('p', { class: 'muted' }, `Use apenas se você já recebeu ${brl(b.amount_cents)} fora do aplicativo. O horário será liberado e o comprovante enviado.`), field('Forma de pagamento', sel)),
    [btnAct('Voltar', 'ghost', (_, close) => close()), btnAct('Confirmar', '', (btn, close) => busy(btn, async () => {
      await api('POST', `/api/admin/bookings/${b.id}/confirm`, { method: sel.value }); close(); toast('Pagamento confirmado e comprovante gerado.', 'ok'); reload();
    }))]);
}

function cancelModal(b, reload) {
  const refunded = h('input', { type: 'checkbox' });
  const reason = txt({ placeholder: 'Motivo (opcional)' });
  const paid = b.status === 'confirmed';
  openModal('Cancelar reserva', h('div', {},
    h('p', {}, 'Os horários serão liberados na agenda.'),
    paid ? h('div', { class: 'alert warn' }, 'Esta reserva já foi paga. O aplicativo não devolve dinheiro automaticamente: faça o reembolso pelo seu banco/Mercado Pago e registre abaixo.') : null,
    field('Motivo', reason),
    paid ? h('label', { class: 'check mb' }, refunded, 'Reembolso já realizado') : null),
  [btnAct('Voltar', 'ghost', (_, close) => close()), btnAct('Cancelar reserva', 'danger', (btn, close) => busy(btn, async () => {
    await api('POST', `/api/admin/bookings/${b.id}/cancel`, { refunded: refunded.checked, reason: reason.value }); close(); toast('Reserva cancelada.', 'ok'); reload();
  }))]);
}

// ----- novo agendamento manual / bloqueio -----
async function newBookingModal(app, preset = {}, onDone) {
  let users = [];
  try { users = (await api('GET', '/api/admin/users')).users.filter((u) => u.role === 'user' && u.status === 'active'); } catch (e) { return toast(e.message, 'bad'); }
  const S = app.state.settings;
  const today = app.state.today;
  const st = { hours: new Set(preset.hours || []) };
  const type = h('select', {}, [['hourly', 'Hora avulsa'], ['module4', 'Módulo 4 horas'], ['module8', 'Módulo 8 horas'], ['block', 'Bloquear horário (manutenção, folga…)']].map(([v, t]) => h('option', { value: v, selected: v === preset.type }, t)));
  const user = h('select', {}, h('option', { value: '' }, 'Selecione…'), users.map((u) => h('option', { value: u.id }, `${u.name}${u.specialty ? ' — ' + u.specialty : ''}`)));
  const room = h('select', {}, app.state.rooms.map((r) => h('option', { value: r.id, selected: r.id === preset.room_id }, r.name)));
  const date = h('input', { type: 'date', value: preset.date || today, min: today, onchange: () => { st.hours = new Set(); paintHours(); } });
  const hoursBox = h('div', { class: 'hours' });
  const hourlyBox = h('div', {}, field('Data', date), h('div', { class: 'small', style: { fontWeight: 600 } }, 'Horários'), hoursBox);
  const month = h('select', {}, [0, 1, 2, 3].map((n) => { const m = addMonths(today.slice(0, 7), n); return h('option', { value: m }, brMonth(m)); }));
  const wd = h('select', { onchange: () => paintStarts() }, [1, 2, 3, 4, 5, 6].map((d) => h('option', { value: d }, WEEKDAYS[d])));
  const start = h('select', {});
  const moduleBox = h('div', { class: 'grid2' }, field('Mês', month), field('Dia da semana', wd), field('Horário inicial', start));
  const pay = h('select', {}, h('option', { value: 'cash' }, 'Já recebi em dinheiro/maquininha'), h('option', { value: 'manual_pix' }, 'Já recebi por Pix direto'), h('option', { value: 'courtesy' }, 'Cortesia (R$ 0)'), h('option', { value: 'pending' }, 'Aguardando — o profissional paga no app'));
  const amount = txt({ placeholder: 'Automático (tabela de preços)', inputmode: 'decimal' });
  const note = txt({ placeholder: 'Opcional' });
  const userField = field('Profissional', user);
  const payField = field('Pagamento', pay);
  const amountField = field('Valor (R$) — preencha só para alterar o valor da tabela', amount);

  function paintHours() {
    const d = date.value;
    const win = S.hours[weekdayOf(d)];
    hoursBox.replaceChildren(...(win ? Array.from({ length: win[1] - win[0] }, (_, i) => win[0] + i).map((hr) => h('button', {
      type: 'button', class: `chip ${st.hours.has(hr) ? 'sel' : ''}`, 'aria-pressed': st.hours.has(hr),
      onclick: () => { st.hours.has(hr) ? st.hours.delete(hr) : st.hours.add(hr); paintHours(); },
    }, hh(hr))) : [h('div', { class: 'alert warn' }, 'Fechado neste dia.')]));
  }
  function paintStarts() {
    const len = type.value === 'module8' ? 8 : 4;
    const win = S.hours[Number(wd.value)];
    start.replaceChildren(...(win ? Array.from({ length: Math.max(0, win[1] - win[0] - len + 1) }, (_, i) => win[0] + i).map((s) => h('option', { value: s }, `${hh(s)}–${hh(s + len)}`)) : []));
  }
  function sync() {
    const t = type.value;
    hourlyBox.classList.toggle('hidden', !(t === 'hourly' || t === 'block'));
    moduleBox.classList.toggle('hidden', !t.startsWith('module'));
    userField.classList.toggle('hidden', t === 'block');
    payField.classList.toggle('hidden', t === 'block');
    amountField.classList.toggle('hidden', t === 'block');
    if (t.startsWith('module')) paintStarts();
  }
  type.addEventListener('change', sync);
  paintHours(); sync();

  openModal('Novo agendamento', h('div', {}, field('Tipo', type), userField, field('Sala', room), hourlyBox, moduleBox, payField, amountField, field('Observação', note)),
    [btnAct('Cancelar', 'ghost', (_, close) => close()), btnAct('Salvar', '', (btn, close) => busy(btn, async () => {
      const t = type.value;
      const body = { type: t, room_id: Number(room.value), note: note.value };
      if (t !== 'block') { body.user_id = Number(user.value); body.payment = pay.value; if (amount.value.trim()) body.amount_cents = parseMoney(amount.value); }
      if (t === 'hourly' || t === 'block') { body.date = date.value; body.hours = [...st.hours].sort((a, b) => a - b); }
      else { body.month = month.value; body.weekday = Number(wd.value); body.start_hour = Number(start.value); }
      await api('POST', '/api/admin/bookings', body);
      close(); toast('Agendamento salvo.', 'ok'); onDone?.();
    }))]);
}

// =====================================================================
// RESERVAS
// =====================================================================
export function reservasAdminView(app) {
  const st = { status: '', q: '', attention: app.query.attention === '1' };
  const root = h('div');
  const list = h('div');
  const statusSel = h('select', { 'aria-label': 'Status', onchange: (e) => { st.status = e.target.value; load(); } },
    [['', 'Todos os status'], ['pending', 'Aguardando pagamento'], ['confirmed', 'Confirmadas'], ['cancelled', 'Canceladas'], ['expired', 'Expiradas']].map(([v, t]) => h('option', { value: v }, t)));
  const q = h('input', { type: 'text', placeholder: 'Buscar profissional…', 'aria-label': 'Buscar', value: st.q });
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { st.q = q.value; load(); }, 300); });
  const att = h('input', { type: 'checkbox', checked: st.attention, onchange: (e) => { st.attention = e.target.checked; load(); } });

  async function load() {
    list.replaceChildren(skeleton(3));
    try {
      const params = new URLSearchParams({ ...(st.status && { status: st.status }), ...(st.q && { q: st.q }), ...(st.attention && { attention: '1' }) });
      const { bookings } = await api('GET', `/api/admin/bookings?${params}`);
      list.replaceChildren(...(bookings.length ? bookings.map((b) => h('div', { class: 'card' },
        bookingBody(b), h('div', { class: 'row mt' }, bookingActions(app, b, load)),
        h('div', { class: 'small muted mt' }, `#${b.id} · criada em ${fmtDateTime(b.created_at)}${b.origin === 'admin' ? ' · lançada pelo gestor' : ''}`)))
        : [h('div', { class: 'card center muted' }, 'Nenhuma reserva encontrada.')]));
    } catch (e) { list.replaceChildren(errorBox(e)); }
  }
  root.append(
    h('div', { class: 'row between mb' }, h('h1', {}, 'Reservas'),
      h('div', { class: 'row' }, h('a', { class: 'btn ghost sm', href: '/api/admin/export.csv' }, 'Exportar planilha (CSV)'),
        h('button', { class: 'btn sm', onclick: () => newBookingModal(app, { type: 'hourly' }, load) }, '+ Novo agendamento'))),
    h('div', { class: 'row mb' }, h('div', { style: { width: '15rem' } }, statusSel), h('div', { class: 'grow' }, q), h('label', { class: 'check' }, att, 'Só com alertas')),
    list);
  load();
  return root;
}

// =====================================================================
// PROFISSIONAIS
// =====================================================================
export function profissionaisView(app) {
  const root = h('div');
  const list = h('div');
  const STAT = { active: ['Ativo', 'ok'], pending: ['Aguardando aprovação', 'warn'], blocked: ['Bloqueado', 'bad'] };

  async function load() {
    list.replaceChildren(skeleton(3));
    try {
      const { users } = await api('GET', '/api/admin/users');
      list.replaceChildren(...users.map((u) => h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('b', {}, u.name), h('span', { class: 'row' }, u.role === 'admin' ? h('span', { class: 'badge info' }, 'Gestor') : null, h('span', { class: `badge ${STAT[u.status][1]}` }, STAT[u.status][0]))),
        h('div', { class: 'muted small' }, [u.specialty, u.registry].filter(Boolean).join(' · ') || 'Sem especialidade informada'),
        h('div', { class: 'small' }, `${fmtPhone(u.phone)} · ${u.email}`),
        h('div', { class: 'small muted' }, `${u.bookings} reserva(s) confirmada(s)${u.notes ? ' · ' + u.notes : ''}`),
        h('div', { class: 'row mt' },
          u.status === 'pending' ? h('button', { class: 'btn sm', onclick: (e) => busy(e.currentTarget, async () => { await api('PUT', `/api/admin/users/${u.id}`, { ...u, status: 'active' }); toast('Profissional aprovado.', 'ok'); load(); }) }, 'Aprovar') : null,
          h('button', { class: 'btn ghost sm', onclick: () => userModal(u) }, 'Editar'),
          h('button', { class: 'btn ghost sm', onclick: () => passModal(u) }, 'Redefinir senha')))));
    } catch (e) { list.replaceChildren(errorBox(e)); }
  }

  function userModal(u) {
    const f = {
      name: txt({ value: u?.name || '' }), email: h('input', { type: 'email', value: u?.email || '' }), phone: h('input', { type: 'tel', value: u ? fmtPhone(u.phone) : '' }),
      specialty: txt({ value: u?.specialty || '' }), registry: txt({ value: u?.registry || '' }), document: txt({ value: u?.document || '', inputmode: 'numeric' }), notes: txt({ value: u?.notes || '' }),
      password: h('input', { type: 'text', autocomplete: 'off', placeholder: 'Mínimo 8 caracteres' }),
      role: h('select', {}, h('option', { value: 'user', selected: u?.role !== 'admin' }, 'Profissional (acesso básico)'), h('option', { value: 'admin', selected: u?.role === 'admin' }, 'Gestor / Administrador')),
      status: h('select', {}, [['active', 'Ativo'], ['pending', 'Aguardando aprovação'], ['blocked', 'Bloqueado']].map(([v, t]) => h('option', { value: v, selected: (u?.status || 'active') === v }, t))),
    };
    openModal(u ? 'Editar profissional' : 'Novo profissional', h('div', {},
      field('Nome completo', f.name), h('div', { class: 'grid2' }, field('E-mail', f.email), field('WhatsApp', f.phone)),
      h('div', { class: 'grid2' }, field('Especialidade', f.specialty), field('Registro profissional', f.registry)),
      field('CPF (opcional)', f.document), field('Perfil de acesso', f.role), u ? field('Situação', f.status) : field('Senha inicial', f.password, 'Combine com o profissional; ele pode trocar depois em Perfil.'),
      field('Observações internas', f.notes)),
    [btnAct('Cancelar', 'ghost', (_, close) => close()), btnAct('Salvar', '', (btn, close) => busy(btn, async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
      if (u) await api('PUT', `/api/admin/users/${u.id}`, body); else await api('POST', '/api/admin/users', body);
      close(); toast('Salvo.', 'ok'); load();
    }))]);
  }
  function passModal(u) {
    const p = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Nova senha (mínimo 8 caracteres)' });
    openModal(`Redefinir senha — ${u.name}`, h('div', {}, field('Nova senha', p), h('p', { class: 'small muted' }, 'O profissional será desconectado e deverá entrar com a nova senha.')),
      [btnAct('Cancelar', 'ghost', (_, close) => close()), btnAct('Redefinir', '', (btn, close) => busy(btn, async () => { await api('POST', `/api/admin/users/${u.id}/reset-password`, { password: p.value }); close(); toast('Senha redefinida.', 'ok'); }))]);
  }

  root.append(h('div', { class: 'row between mb' }, h('h1', {}, 'Profissionais'), h('button', { class: 'btn', onclick: () => userModal(null) }, '+ Novo profissional')), list);
  load();
  return root;
}

// =====================================================================
// SALAS
// =====================================================================
export function salasView(app) {
  const root = h('div');
  const list = h('div');
  async function load() {
    await app.refreshState();
    list.replaceChildren(...app.state.admin.all_rooms.map((r) => h('div', { class: 'card row between' },
      h('div', {}, h('b', {}, r.name), h('div', { class: 'muted small' }, r.description || 'Sem descrição')),
      h('div', { class: 'row' }, r.active ? h('span', { class: 'badge ok' }, 'Ativa') : h('span', { class: 'badge' }, 'Desativada'), h('button', { class: 'btn ghost sm', onclick: () => roomModal(r) }, 'Editar')))));
  }
  function roomModal(r) {
    const name = txt({ value: r?.name || '' });
    const desc = txt({ value: r?.description || '', placeholder: 'Ex.: Consultório com maca, 12 m²' });
    const active = h('input', { type: 'checkbox', checked: r ? !!r.active : true });
    openModal(r ? 'Editar sala' : 'Nova sala', h('div', {}, field('Nome', name), field('Descrição', desc), r ? h('label', { class: 'check' }, active, 'Sala ativa (disponível para agendamento)') : null),
      [btnAct('Cancelar', 'ghost', (_, close) => close()), btnAct('Salvar', '', (btn, close) => busy(btn, async () => {
        const body = { name: name.value, description: desc.value, active: active.checked };
        if (r) await api('PUT', `/api/admin/rooms/${r.id}`, body); else await api('POST', '/api/admin/rooms', body);
        close(); toast('Sala salva.', 'ok'); load();
      }))]);
  }
  root.append(h('div', { class: 'row between mb' }, h('h1', {}, 'Salas'), h('button', { class: 'btn', onclick: () => roomModal(null) }, '+ Nova sala')), list);
  load();
  return root;
}

// =====================================================================
// CONFIGURAÇÕES
// =====================================================================
export function configView(app) {
  const s = app.state.settings;
  const a = app.state.admin;
  const he = hoursEditor(s.hours);
  const f = {
    name: txt({ value: app.state.business_name }), wa: h('input', { type: 'tel', value: fmtPhone(a.admin_whatsapp) }),
    ph: txt({ value: moneyInput(s.price_hour_cents), inputmode: 'decimal' }), p4: txt({ value: moneyInput(s.price_module4_cents), inputmode: 'decimal' }), p8: txt({ value: moneyInput(s.price_module8_cents), inputmode: 'decimal' }),
    hold: h('input', { type: 'number', min: 5, max: 120, value: s.hold_minutes }), adv: h('input', { type: 'number', min: 1, max: 365, value: s.max_advance_days }),
    appr: h('input', { type: 'checkbox', checked: s.require_approval }), pix: h('input', { type: 'checkbox', checked: s.methods.pix }), card: h('input', { type: 'checkbox', checked: s.methods.card }),
  };
  return h('form', { onsubmit: async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      await api('PUT', '/api/admin/settings', {
        business_name: f.name.value, admin_whatsapp: f.wa.value, hours: he.get(),
        price_hour_cents: parseMoney(f.ph.value), price_module4_cents: parseMoney(f.p4.value), price_module8_cents: parseMoney(f.p8.value),
        hold_minutes: Number(f.hold.value), max_advance_days: Number(f.adv.value), require_approval: f.appr.checked, methods: { pix: f.pix.checked, card: f.card.checked },
      });
      await app.refreshState(); toast('Configurações salvas.', 'ok');
    });
  } },
  h('h1', {}, 'Configurações'),
  h('div', { class: 'card' }, h('h2', {}, 'Dados do Espaço'), field('Nome do Espaço', f.name),
    field('WhatsApp da administração', f.wa, 'Recebe automaticamente o comprovante de cada pagamento.')),
  h('div', { class: 'card' }, h('h2', {}, 'Horário de atendimento'), h('p', { class: 'small muted' }, 'Desmarque os dias em que o Espaço não abre. Módulos só aceitam horários que caibam dentro do expediente do dia.'), he.node),
  h('div', { class: 'card' }, h('h2', {}, 'Valores'), h('div', { class: 'grid2' }, field('Hora avulsa (R$)', f.ph), field('Módulo 4 horas — mensal (R$)', f.p4)), field('Módulo 8 horas — mensal (R$)', f.p8)),
  h('div', { class: 'card' }, h('h2', {}, 'Regras'), h('div', { class: 'grid2' },
    field('Prazo para pagar (minutos)', f.hold, 'Tempo que o horário fica reservado aguardando pagamento.'), field('Antecedência máxima (dias)', f.adv, 'Para hora avulsa.')),
  h('label', { class: 'check mb' }, f.appr, 'Aprovar manualmente novos profissionais antes de liberar o acesso'),
  h('div', { class: 'small', style: { fontWeight: 600 } }, 'Formas de pagamento aceitas'),
  h('label', { class: 'check' }, f.pix, 'Pix'), h('label', { class: 'check' }, f.card, 'Cartão')),
  h('button', { class: 'btn block', type: 'submit' }, 'Salvar configurações'));
}

// =====================================================================
// WHATSAPP (convite + fila de comprovantes + integrações)
// =====================================================================
export function whatsappView(app) {
  const a = app.state.admin;
  const link = app.state.base_url;
  const root = h('div');
  const resolve = (t) => t.replaceAll('{negocio}', app.state.business_name).replaceAll('{link}', link);

  // convite
  const tpl = h('textarea', { rows: 6, 'aria-label': 'Modelo da mensagem' }); tpl.value = a.invite_message;
  const phone = h('input', { type: 'tel', placeholder: '(21) 99999-9999', inputmode: 'tel' });
  const preview = h('div', { class: 'pixcode', style: { whiteSpace: 'pre-wrap' } });
  const paint = () => { preview.textContent = resolve(tpl.value); };
  tpl.addEventListener('input', paint); paint();
  const waUrl = () => { const p = normPhone(phone.value); return `https://wa.me/${p || ''}?text=${encodeURIComponent(resolve(tpl.value))}`; };

  const invite = h('div', { class: 'card' },
    h('h2', {}, 'Convite para novos profissionais'),
    h('p', { class: 'muted small' }, 'Envie este link no início da conversa com o profissional: ele cria o perfil, escolhe o horário e paga sozinho.'),
    field('Link do aplicativo', h('div', { class: 'row' }, h('input', { type: 'text', value: link, readonly: true, class: 'grow' }), h('button', { type: 'button', class: 'btn ghost sm', onclick: () => copy(link, 'Link copiado!') }, 'Copiar'))),
    field('Mensagem (use {negocio} e {link})', tpl), h('div', { class: 'small muted' }, 'Pré-visualização:'), preview,
    field('WhatsApp do profissional (opcional)', phone, 'Deixe em branco para escolher o contato dentro do WhatsApp.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => window.open(waUrl(), '_blank', 'noopener') }, 'Abrir no WhatsApp'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => copy(resolve(tpl.value), 'Mensagem copiada!') }, 'Copiar mensagem'),
      h('button', { type: 'button', class: 'btn ghost', onclick: (e) => busy(e.currentTarget, async () => { await api('PUT', '/api/admin/settings', { invite_message: tpl.value }); toast('Modelo salvo.', 'ok'); }) }, 'Salvar modelo')),
    h('p', { class: 'small muted mt' }, 'Dica: no celular do profissional, abra o link e use “Adicionar à tela inicial” (Chrome: menu ⋮ → Instalar app; iPhone: Compartilhar → Adicionar à Tela de Início) para ter o app como ícone.'));

  // integrações
  const pay = a.payment; const w = a.whatsapp;
  const integ = h('div', { class: 'card' }, h('h2', {}, 'Integrações'),
    h('div', { class: 'row between' }, h('span', {}, 'Pagamentos'), h('span', { class: `badge ${pay.demo ? 'warn' : pay.configured ? 'ok' : 'bad'}` }, pay.demo ? 'Demonstração' : pay.configured ? `${pay.provider} ativo` : 'Falta configurar')),
    !pay.demo ? h('div', { class: 'small muted' }, 'URL do webhook (cadastre no painel do provedor): ', h('button', { class: 'link', onclick: () => copy(pay.webhook_url) }, pay.webhook_url)) : null,
    h('div', { class: 'row between mt' }, h('span', {}, 'Envio de comprovantes'), h('span', { class: `badge ${w.provider === 'cloud' ? (w.configured ? 'ok' : 'bad') : 'warn'}` }, w.provider === 'cloud' ? (w.configured ? 'Automático (Cloud API)' : 'Falta configurar') : 'Manual (1 toque)')));

  // fila
  const queue = h('div', { class: 'card' }, h('h2', {}, 'Comprovantes e avisos enviados'), skeleton(2));
  const KIND = { professional: 'Profissional', admin: 'Administração' };
  const ST = { queued: ['Na fila', 'warn'], sent: ['Enviado', 'ok'], failed: ['Falhou', 'bad'], manual: ['Aguardando envio', 'warn'] };
  async function loadQueue() {
    try {
      const { messages } = await api('GET', '/api/admin/outbox');
      queue.replaceChildren(h('h2', {}, 'Comprovantes e avisos'), ...(messages.length ? [h('div', { class: 'list' }, messages.map((m) => h('div', { class: 'item' },
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('b', {}, `${KIND[m.kind]}${m.to_label && m.kind === 'professional' ? ' — ' + m.to_label : ''}`), h('span', { class: `badge ${ST[m.status][1]}` }, ST[m.status][0])),
          h('div', { class: 'small muted' }, `${fmtPhone(m.to_phone)} · ${fmtDateTime(m.created_at)}`),
          h('div', { class: 'small', style: { whiteSpace: 'pre-wrap', margin: '.35rem 0' } }, m.body.split('\n').slice(0, 4).join('\n')),
          m.error ? h('div', { class: 'small', style: { color: 'var(--bad)' } }, `Erro: ${m.error}`) : null,
          m.status !== 'sent' ? h('div', { class: 'row' },
            h('a', { class: 'btn sm', href: m.link, target: '_blank', rel: 'noopener', onclick: () => setTimeout(() => api('POST', `/api/admin/outbox/${m.id}/mark-sent`, {}).then(loadQueue), 800) }, 'Enviar no WhatsApp'),
            m.status === 'failed' ? h('button', { class: 'btn ghost sm', onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/admin/outbox/${m.id}/retry`, {}); loadQueue(); }) }, 'Tentar de novo') : null,
            h('button', { class: 'btn ghost sm', onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/admin/outbox/${m.id}/mark-sent`, {}); loadQueue(); }) }, 'Marcar como enviado')) : null))))]
        : [h('p', { class: 'muted' }, 'Nenhuma mensagem ainda. Elas aparecem aqui assim que um pagamento for confirmado.')]));
    } catch (e) { queue.replaceChildren(errorBox(e)); }
  }
  root.append(h('h1', {}, 'WhatsApp'), invite, integ, queue);
  loadQueue();
  return root;
}
