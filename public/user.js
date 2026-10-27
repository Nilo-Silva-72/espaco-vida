// Telas do profissional: agendar, pagar, minhas reservas, perfil.
import {
  h, api, busy, toast, copy, field, txt, skeleton, errorBox, brl, hh, brDate, brMonth, addDays, addMonths, weekdayOf,
  WEEKDAYS, WEEKDAYS_PL, statusBadge, fmtDateTime, fmtPhone,
} from './ui.js';

const pad = (n) => String(n).padStart(2, '0');

// =====================================================================
// AGENDAR
// =====================================================================
export function agendarView(app) {
  const { state } = app;
  const S = state.settings;
  const today = state.today;
  const thisMonth = today.slice(0, 7);
  const firstOpen = () => { let d = today; for (let i = 0; i < 14; i++, d = addDays(d, 1)) if (S.hours[weekdayOf(d)]) return d; return today; };
  const st = { mode: 'hourly', date: firstOpen(), roomId: state.rooms[0]?.id, hours: new Set(), month: thisMonth, pick: null };
  const root = h('div');
  const body = h('div');
  const bar = h('div');
  const modes = [
    ['hourly', 'Hora avulsa', `${brl(S.price_hour_cents)}/hora`],
    ['module4', 'Módulo 4h', `${brl(S.price_module4_cents)}/mês`],
    ['module8', 'Módulo 8h', `${brl(S.price_module8_cents)}/mês`],
  ];
  let seq = 0; // evita que uma resposta antiga sobrescreva a tela

  function seg() {
    return h('div', { class: 'seg', role: 'tablist' }, modes.map(([k, t, sub]) => h('button', {
      role: 'tab', 'aria-selected': st.mode === k, class: st.mode === k ? 'on' : '',
      onclick: () => { st.mode = k; st.hours = new Set(); st.pick = null; draw(); },
    }, t, h('small', {}, sub))));
  }
  function roomPills() {
    if (state.rooms.length < 2) return null;
    return h('div', { class: 'pills' }, state.rooms.map((r) => h('button', {
      class: `pill ${st.roomId === r.id ? 'on' : ''}`, title: r.description || '',
      onclick: () => { st.roomId = r.id; st.hours = new Set(); st.pick = null; draw(); },
    }, r.name)));
  }

  const avCache = new Map(); // data -> { at, av }
  async function getAvailability(date) {
    const hit = avCache.get(date);
    if (hit && Date.now() - hit.at < 20000) return hit.av;
    const av = await api('GET', `/api/availability?date=${date}`);
    avCache.set(date, { at: Date.now(), av });
    return av;
  }

  async function drawHourly() {
    const my = ++seq;
    const lastDay = addDays(today, Math.min(S.max_advance_days, 30) - 1);
    const strip = [];
    for (let d = today; d <= lastDay; d = addDays(d, 1)) {
      const wd = weekdayOf(d);
      strip.push(h('button', {
        class: `daychip ${st.date === d ? 'on' : ''}`, disabled: !S.hours[wd], title: S.hours[wd] ? '' : 'Fechado',
        onclick: () => { st.date = d; st.hours = new Set(); draw(); },
      }, h('span', {}, WEEKDAYS[wd].slice(0, 3)), h('b', {}, d.slice(8)), h('span', {}, d.slice(5, 7))));
    }
    const dateInput = h('input', {
      type: 'date', value: st.date, min: today, max: addDays(today, S.max_advance_days), 'aria-label': 'Escolher outra data',
      onchange: (e) => { if (e.target.value) { st.date = e.target.value; st.hours = new Set(); draw(); } },
    });
    const grid = h('div', {}, skeleton(2));
    body.replaceChildren(
      h('div', { class: 'scroller' }, strip), field('Ou escolha outra data', dateInput), roomPills(),
      h('h3', {}, `${WEEKDAYS[weekdayOf(st.date)]}, ${brDate(st.date)}`), grid,
      h('div', { class: 'legend' }, h('span', {}, h('i'), 'Livre'), h('span', {}, h('i', { class: 's' }), 'Selecionado'), h('span', {}, h('i', { class: 'b' }), 'Indisponível')),
    );
    body.querySelector('.daychip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    try {
      const av = await getAvailability(st.date);
      if (my !== seq) return;
      const room = av.rooms.find((r) => r.id === st.roomId) || av.rooms[0];
      if (!av.open) { grid.replaceChildren(h('div', { class: 'alert warn' }, 'O Espaço não atende neste dia. Escolha outra data.')); return; }
      const paint = () => grid.replaceChildren(h('div', { class: 'hours' }, room.hours.map((c) => {
        const sel = st.hours.has(c.hour);
        const disabled = c.state === 'busy' || c.state === 'past' || c.state === 'mine';
        return h('button', {
          class: `chip ${sel ? 'sel' : ''} ${c.state === 'free' ? '' : c.state}`, disabled,
          'aria-pressed': sel, title: c.state === 'mine' ? 'Já é seu' : c.state === 'busy' ? 'Ocupado' : '',
          onclick: () => { sel ? st.hours.delete(c.hour) : st.hours.add(c.hour); paint(); drawBar(); },
        }, hh(c.hour), h('small', {}, c.state === 'mine' ? 'seu' : c.state === 'busy' ? 'ocupado' : c.state === 'past' ? 'passou' : `até ${hh(c.hour + 1)}`));
      })));
      paint();
    } catch (e) { if (my === seq) grid.replaceChildren(errorBox(e)); }
  }

  async function drawModule() {
    const my = ++seq;
    const len = st.mode === 'module4' ? 4 : 8;
    const months = [0, 1, 2].map((n) => addMonths(thisMonth, n));
    const wrap = h('div', {}, skeleton(3));
    body.replaceChildren(
      h('div', { class: 'alert' }, `Módulo de ${len} horas seguidas, em um único dia da semana, durante o mês inteiro. Valor mensal: ${brl(len === 4 ? S.price_module4_cents : S.price_module8_cents)}.`),
      h('div', { class: 'pills' }, months.map((m) => h('button', { class: `pill ${st.month === m ? 'on' : ''}`, onclick: () => { st.month = m; st.pick = null; draw(); } }, brMonth(m)))),
      roomPills(), wrap,
    );
    try {
      const o = await api('GET', `/api/module-options?type=${st.mode}&month=${st.month}&room_id=${st.roomId}`);
      if (my !== seq) return;
      if (!o.days.length) { wrap.replaceChildren(h('div', { class: 'alert warn' }, `Não há horários de ${len} horas seguidas disponíveis.`)); return; }
      const paint = () => wrap.replaceChildren(...o.days.map((d) => h('div', { class: 'daycard' },
        h('h3', {}, d.name), h('div', { class: 'hours' }, d.starts.map((s) => {
          const key = `${d.weekday}-${s.start}`;
          const sel = st.pick?.key === key;
          return h('button', {
            class: `chip ${sel ? 'sel' : ''} ${s.free ? '' : 'busy'}`, disabled: !s.free, 'aria-pressed': sel,
            title: s.free ? '' : s.dates ? 'Há datas ocupadas neste horário' : 'Sem datas restantes neste mês',
            onclick: () => { st.pick = { key, weekday: d.weekday, start: s.start, end: s.end, dates: s.dates, price: o.price_cents }; paint(); drawBar(); },
          }, `${hh(s.start)}–${hh(s.end)}`, h('small', {}, s.free ? `${s.dates} ${s.dates === 1 ? 'data' : 'datas'}` : 'indisponível'));
        })))));
      paint();
    } catch (e) { if (my === seq) wrap.replaceChildren(errorBox(e)); }
  }

  function drawBar() {
    if (st.mode === 'hourly') {
      const n = st.hours.size;
      if (!n) return bar.replaceChildren();
      const hrs = [...st.hours].sort((a, b) => a - b);
      bar.replaceChildren(h('div', { class: 'sticky-bar' }, h('div', { class: 'in' },
        h('div', {}, h('div', { class: 'total' }, brl(n * S.price_hour_cents)), h('div', { class: 'small muted' }, `${n} ${n === 1 ? 'hora' : 'horas'} · ${hrs.map(hh).join(', ')}`)),
        h('button', { class: 'btn', onclick: (e) => submit(e.currentTarget, { type: 'hourly', room_id: st.roomId, date: st.date, hours: hrs }) }, 'Continuar para pagamento'))));
    } else {
      const p = st.pick;
      if (!p) return bar.replaceChildren();
      bar.replaceChildren(h('div', { class: 'sticky-bar' }, h('div', { class: 'in' },
        h('div', {}, h('div', { class: 'total' }, `${brl(p.price)}`), h('div', { class: 'small muted' }, `${WEEKDAYS_PL[p.weekday]}, ${hh(p.start)}–${hh(p.end)} · ${brMonth(st.month)} · ${p.dates} ${p.dates === 1 ? 'data' : 'datas'}`)),
        h('button', { class: 'btn', onclick: (e) => submit(e.currentTarget, { type: st.mode, room_id: st.roomId, month: st.month, weekday: p.weekday, start_hour: p.start }) }, 'Continuar para pagamento'))));
    }
  }

  async function submit(btn, payload) {
    await busy(btn, async () => {
      try {
        const { booking } = await api('POST', '/api/bookings', payload);
        location.hash = `#/pagar/${booking.id}`;
      } catch (e) {
        if (e.status === 409) { toast(e.message, 'bad'); avCache.clear(); st.hours = new Set(); st.pick = null; draw(); } else throw e;
      }
    });
  }

  function draw() {
    root.replaceChildren(
      h('h1', {}, 'Agendar atendimento'),
      h('p', { class: 'muted' }, 'Escolha o horário, pague por Pix ou cartão e o horário é liberado automaticamente.'),
      seg(), body, bar,
    );
    drawBar();
    st.mode === 'hourly' ? drawHourly() : drawModule();
  }
  if (!state.rooms.length) return h('div', { class: 'alert warn' }, 'Nenhuma sala disponível no momento. Fale com a administração.');
  draw();
  return root;
}

// =====================================================================
// PAGAR
// =====================================================================
export function pagarView(app, id) {
  const root = h('div', {}, skeleton(3));
  let timers = [];
  app.onCleanup(() => timers.forEach((t) => clearInterval(t)));
  const clear = () => { timers.forEach((t) => clearInterval(t)); timers = []; };

  function summary(b) {
    return h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, b.title), statusBadge(b)),
      b.lines.map((l) => h('div', {}, l)), h('div', { class: 'muted small' }, b.room_name),
      h('div', { class: 'row between mt' }, h('span', { class: 'muted' }, 'Total'), h('span', { class: 'total' }, brl(b.amount_cents))));
  }

  function success(b) {
    clear();
    root.replaceChildren(h('div', { class: 'card success' },
      h('div', { class: 'big', 'aria-hidden': 'true' }, '✓'), h('h1', {}, 'Pagamento confirmado!'),
      h('p', { class: 'muted' }, 'Seu horário está garantido.'),
      h('div', { class: 'stack center' }, b.lines.map((l) => h('div', {}, l)), h('div', { class: 'muted small' }, b.room_name)),
      h('p', { class: 'small muted mt' }, app.state.whatsapp_auto
        ? `Enviamos o comprovante para o seu WhatsApp (${fmtPhone(app.user.phone)}) e a administração também foi avisada.`
        : 'A administração foi avisada. Guarde o comprovante abaixo.'),
      h('div', { class: 'stack mt' },
        b.receipt_url ? h('a', { class: 'btn block', href: b.receipt_url, target: '_blank', rel: 'noopener' }, 'Abrir comprovante') : null,
        h('a', { class: 'btn ghost block', href: '#/reservas' }, 'Minhas reservas'),
        h('a', { class: 'btn ghost block', href: '#/agendar' }, 'Agendar outro horário'))));
  }

  function countdown(b) {
    const el = h('div', { class: 'alert warn center', role: 'timer' });
    const tick = () => {
      const left = Math.max(0, Math.floor((new Date(b.hold_expires_at) - Date.now()) / 1000));
      el.textContent = left > 0 ? `Horário reservado para você por ${Math.floor(left / 60)}:${pad(left % 60)} min` : 'O tempo acabou — recarregando…';
      if (!left) { clear(); setTimeout(load, 1500); }
    };
    tick(); timers.push(setInterval(tick, 1000));
    return el;
  }

  function payPanel(b) {
    const area = h('div', { class: 'mt' });
    const methods = app.state.settings.methods;
    const buttons = [];
    if (methods.pix) buttons.push(h('button', { class: 'btn block', onclick: (e) => start('pix', e.currentTarget) }, 'Pagar com Pix'));
    if (methods.card) buttons.push(h('button', { class: methods.pix ? 'btn ghost block' : 'btn block', onclick: (e) => start('card', e.currentTarget) }, 'Pagar com cartão'));

    async function start(method, btn) {
      await busy(btn, async () => {
        const { payment } = await api('POST', `/api/bookings/${b.id}/pay`, { method });
        showPayment(payment);
      });
    }
    function showPayment(p) {
      const demo = p.demo ? h('div', { class: 'alert warn' }, 'Modo demonstração: nenhuma cobrança real será feita.') : null;
      const simulate = p.demo ? h('button', { class: 'btn ghost block mt', onclick: (e) => busy(e.currentTarget, async () => { await api('POST', `/api/payments/${p.id}/mock-confirm`, {}); load(); }) }, 'Simular pagamento aprovado') : null;
      if (p.method === 'pix') {
        area.replaceChildren(h('div', { class: 'stack' }, demo,
          h('div', { class: 'pixbox' },
            p.pix_qr ? h('img', { src: p.pix_qr, alt: 'QR Code do Pix' }) : h('div', { class: 'muted small' }, 'Use o código “copia e cola” abaixo no app do seu banco.'),
            h('div', { class: 'pixcode', 'aria-label': 'Código Pix copia e cola' }, p.pix_code),
            h('button', { class: 'btn block', onclick: () => copy(p.pix_code, 'Código Pix copiado!') }, 'Copiar código Pix'),
            h('p', { class: 'small muted mt' }, 'Depois de pagar, esta tela confirma sozinha em alguns segundos.')),
          simulate));
      } else {
        area.replaceChildren(h('div', { class: 'stack' }, demo,
          p.checkout_url
            ? h('a', { class: 'btn block', href: p.checkout_url }, 'Ir para o pagamento seguro com cartão')
            : null,
          p.checkout_url ? h('p', { class: 'small muted' }, 'Você será levado ao ambiente seguro do provedor de pagamento. Ao concluir, volte aqui.') : null,
          simulate));
      }
      const poll = setInterval(async () => {
        try {
          const r = await api('GET', `/api/payments/${p.id}`);
          if (r.booking.status === 'confirmed') { clearInterval(poll); success(r.booking); }
          else if (r.booking.status !== 'pending') { clearInterval(poll); load(); }
        } catch { /* tenta de novo */ }
      }, 4000);
      timers.push(poll);
    }
    return h('div', {}, h('h3', { class: 'mt' }, 'Como você prefere pagar?'), h('div', { class: 'stack' }, buttons), area);
  }

  async function load() {
    clear();
    try {
      const { booking: b } = await api('GET', `/api/bookings/${id}`);
      if (b.status === 'confirmed') return success(b);
      if (b.status !== 'pending') {
        root.replaceChildren(h('div', { class: 'card' }, h('h2', {}, b.status === 'expired' ? 'O tempo para pagamento acabou' : 'Reserva cancelada'),
          h('p', { class: 'muted' }, 'O horário foi liberado. Escolha novamente para continuar.'), h('a', { class: 'btn', href: '#/agendar' }, 'Escolher outro horário')));
        return;
      }
      root.replaceChildren(h('h1', {}, 'Pagamento'), countdown(b), summary(b), payPanel(b),
        h('p', { class: 'center mt' }, h('button', {
          class: 'link muted small', onclick: async () => {
            if (!confirm('Cancelar esta reserva e liberar o horário?')) return;
            await busy(null, async () => { await api('POST', `/api/bookings/${b.id}/cancel`, {}); location.hash = '#/agendar'; });
          },
        }, 'Cancelar esta reserva')));
    } catch (e) { root.replaceChildren(errorBox(e)); }
  }
  load();
  return root;
}

// =====================================================================
// MINHAS RESERVAS
// =====================================================================
export function reservasView(app) {
  const root = h('div', {}, h('h1', {}, 'Minhas reservas'), skeleton(3));
  const thisMonth = app.state.today.slice(0, 7);

  async function load() {
    try {
      const { bookings } = await api('GET', '/api/bookings');
      const cards = bookings.map((b) => h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, b.title), statusBadge(b)),
        b.lines.map((l) => h('div', {}, l)),
        h('div', { class: 'muted small' }, `${b.room_name} · ${brl(b.amount_cents)}${b.payment?.status === 'paid' ? ` · ${b.payment.method_label}` : ''}`),
        b.status === 'pending' ? h('div', { class: 'small muted' }, 'Aguardando pagamento — o horário só é garantido após pagar.') : null,
        h('div', { class: 'row mt' },
          b.status === 'pending' ? h('a', { class: 'btn sm', href: `#/pagar/${b.id}` }, 'Pagar agora') : null,
          b.status === 'pending' ? h('button', { class: 'btn sm danger', onclick: (e) => cancel(e.currentTarget, b, 'Cancelar esta reserva?') }, 'Cancelar') : null,
          b.receipt_url ? h('a', { class: 'btn sm ghost', href: b.receipt_url, target: '_blank', rel: 'noopener' }, 'Comprovante') : null,
          b.status === 'confirmed' && b.type.startsWith('module') && b.month >= thisMonth
            ? h('button', { class: 'btn sm ghost', onclick: (e) => renew(e.currentTarget, b) }, `Renovar ${brMonth(addMonths(b.month, 1))}`) : null,
          b.status === 'confirmed' && !b.cancel_requested
            ? h('button', { class: 'btn sm danger', onclick: (e) => cancel(e.currentTarget, b, 'Solicitar o cancelamento à administração? O reembolso, se houver, é combinado com o Espaço.') }, 'Solicitar cancelamento') : null)));
      root.replaceChildren(h('h1', {}, 'Minhas reservas'),
        cards.length ? cards : h('div', { class: 'card center' }, h('p', { class: 'muted' }, 'Você ainda não tem reservas.'), h('a', { class: 'btn', href: '#/agendar' }, 'Agendar agora')));
    } catch (e) { root.replaceChildren(errorBox(e)); }
  }
  async function cancel(btn, b, msg) {
    if (!confirm(msg)) return;
    await busy(btn, async () => {
      const r = await api('POST', `/api/bookings/${b.id}/cancel`, {});
      toast(r.requested ? 'Pedido enviado à administração.' : 'Reserva cancelada.', 'ok');
      load();
    });
  }
  async function renew(btn, b) {
    await busy(btn, async () => {
      const { booking } = await api('POST', '/api/bookings', { type: b.type, room_id: b.room_id, month: addMonths(b.month, 1), weekday: b.weekday, start_hour: b.start_hour });
      location.hash = `#/pagar/${booking.id}`;
    });
  }
  load();
  return root;
}

// =====================================================================
// PERFIL
// =====================================================================
export function perfilView(app) {
  const u = app.user;
  const f = {
    name: txt({ value: u.name, autocomplete: 'name', required: true }),
    phone: h('input', { type: 'tel', value: fmtPhone(u.phone), autocomplete: 'tel', inputmode: 'tel' }),
    specialty: txt({ value: u.specialty || '', placeholder: 'Ex.: Psicóloga, Nutricionista, Fisioterapeuta' }),
    registry: txt({ value: u.registry || '', placeholder: 'Ex.: CRP 05/12345' }),
    document: txt({ value: u.document || '', inputmode: 'numeric', placeholder: 'Somente números' }),
  };
  const pw = { cur: h('input', { type: 'password', autocomplete: 'current-password' }), next: h('input', { type: 'password', autocomplete: 'new-password' }) };
  return h('div', {},
    h('h1', {}, 'Meu perfil'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      await busy(e.submitter, async () => {
        const r = await api('PUT', '/api/me', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
        app.user = r.user; app.state.user = r.user; toast('Perfil atualizado!', 'ok');
      });
    } },
    field('Nome completo', f.name), field('WhatsApp (com DDD)', f.phone, 'Os comprovantes são enviados para este número.'),
    h('div', { class: 'grid2' }, field('Especialidade', f.specialty), field('Registro profissional', f.registry)),
    field('CPF (opcional)', f.document, 'Alguns meios de pagamento pedem o CPF para gerar o Pix.'),
    h('p', { class: 'small muted' }, `E-mail de acesso: ${u.email}`),
    h('button', { class: 'btn block', type: 'submit' }, 'Salvar perfil')),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      await busy(e.submitter, async () => {
        await api('POST', '/api/me/password', { current: pw.cur.value, next: pw.next.value });
        pw.cur.value = pw.next.value = ''; toast('Senha alterada!', 'ok');
      });
    } },
    h('h2', {}, 'Trocar senha'), field('Senha atual', pw.cur), field('Nova senha (mínimo 8 caracteres)', pw.next),
    h('button', { class: 'btn ghost block', type: 'submit' }, 'Alterar senha')),
    h('p', { class: 'center mt' }, h('button', { class: 'btn danger', onclick: () => app.logout() }, 'Sair da conta')));
}
