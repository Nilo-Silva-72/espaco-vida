# Espaço Vida – Agenda de Sublocação

Aplicativo web (funciona como app no celular) para profissionais reservarem salas **por hora avulsa** ou **módulos de 4h/8h**, pagarem por **Pix ou cartão** e receberem o **comprovante no WhatsApp** — com cópia automática para a administração.

Não tem dependências externas: só precisa do **Node.js 22.5 ou superior**.

## Rodar no seu computador (teste)
```
node server.js
```
Abra http://localhost:3000. No primeiro acesso aparece o assistente de configuração (salas, valores, horários, seu usuário de gestor).

## Colocar na internet (necessário para os profissionais usarem)
Qualquer hospedagem que rode Node 22 ou Docker serve (Railway, Render, Fly.io, VPS). Requisitos:
1. **HTTPS** com domínio, ex.: `agenda.espacovida.com.br`.
2. **Disco persistente** montado em `/data` (variável `DATA_DIR`) — é onde fica o banco (`espaco-vida.db`). Faça backup desse arquivo.
3. Com Docker: `docker build -t espaco-vida . && docker run -d -p 3000:3000 -v evdata:/data espaco-vida`
4. Em *Configurações*, preencha **Endereço público do aplicativo** (`https://agenda.espacovida.com.br`).

## Ativar a cobrança real (Mercado Pago)
1. Crie conta em mercadopago.com.br e gere as credenciais de produção (Seu negócio > Configurações > Credenciais).
2. Em *Configurações > Cobrança*, escolha **Mercado Pago** e cole o **Access Token**.
3. No painel de desenvolvedor do Mercado Pago, em **Webhooks**, cadastre `https://SEU-ENDEREÇO/api/webhooks/mercadopago` com o evento **Pagamentos**.
4. Faça um pagamento de teste (R$ 1,00 ajustando temporariamente o valor da hora) antes de divulgar.

O app só libera o horário após o Mercado Pago confirmar o pagamento; o webhook é sempre conferido consultando o próprio Mercado Pago. Até lá, o modo **teste** simula pagamentos (aparece aviso vermelho no painel).

## Ativar o WhatsApp automático (API oficial da Meta)
1. Crie um app em developers.facebook.com com o produto **WhatsApp** e registre o número do Espaço (use um número que não esteja em uso no WhatsApp comum).
2. Copie o **Phone Number ID** e um **Token permanente** (usuário do sistema) para *Configurações > WhatsApp automático*, modo "API oficial".
3. A Meta só permite mensagem iniciada pela empresa fora da janela de 24h usando **modelo aprovado**. Crie um modelo (categoria Utilidade) cujo corpo seja apenas `{{1}}` ou "Comprovante: {{1}}" e informe o nome dele em Configurações.
4. Sem isso, os comprovantes ficam registrados em *Comprovantes* e você pode enviá-los com um toque (botão "Abrir no WhatsApp").

## Link para os profissionais (início da conversa no WhatsApp)
Menu **Divulgar**: link, QR Code e mensagem pronta. No WhatsApp Business use *Mensagem de saudação* ou *Resposta rápida* (`/agenda`). O link também instala como app (Android: "Instalar aplicativo"; iPhone: "Adicionar à Tela de Início").

## Regras implementadas
- Funcionamento configurável (padrão: seg–sex 8–20h, sáb 9–13h; domingo fechado).
- Hora avulsa R$ 70 · Módulo 4h R$ 400/mês · Módulo 8h R$ 800/mês (**valor de 8h sugerido**, ajuste em Configurações).
- Módulo = blocos seguidos no mesmo dia da semana, em todas as semanas do mês. No mês corrente, o valor é **proporcional** às datas restantes. Módulo de 8h não cabe no sábado (4h de funcionamento).
- Horário fica **segurado por 15 min** para pagar; sem pagamento, volta a ficar livre. Reserva dupla é impossível (trava no banco).
- Profissional: cria perfil, vê horários livres, reserva, paga, vê/cancela as próprias reservas (hora avulsa paga: até 24h antes, gera pedido de reembolso; módulo pago: só a gestão cancela), edita o próprio perfil.
- Gestor: painel, agenda por sala, reservas (confirmar pagamento manual, cancelar, registrar reembolso), cadastro de profissionais e gestores, salas, valores, regras, bloqueio de horários, log de comprovantes.
- Reembolsos são feitos manualmente (no Mercado Pago) e registrados no app.

## Testes
`npm test` (regras de negócio, permissões, expiração, conflitos).

## Publicar no Railway
1. Código num repositório privado do GitHub.
2. railway.com > *New Project > Deploy from GitHub repo* > escolha o repositório (o `Dockerfile` é detectado sozinho).
3. No serviço: *Settings > Volumes > Add Volume*, caminho de montagem `/data`. Sem volume, os dados se perdem a cada novo deploy.
4. *Variables*: `DATA_DIR` = `/data`.
5. *Settings > Networking > Generate Domain* (ou *Custom Domain*). Copie o endereço gerado.
6. Abra o endereço, faça o assistente de configuração e informe o endereço público em Configurações.

## Renovação de módulos
- Cada módulo vale um mês. Em *Minhas reservas* (e na tela inicial) aparece o botão **Renovar para o próximo mês**, que cria a reserva no mesmo dia/horário e abre o pagamento.
- **Prioridade:** até o dia configurado (padrão 20), os horários do mês seguinte que pertencem a módulos ainda não renovados ficam reservados aos titulares (vale para módulos e horas avulsas). Depois do prazo, se não renovou, o horário é liberado a todos.
- **Lembrete:** o aviso aparece para o profissional no aplicativo a partir de 7 dias antes do prazo (dia 13). O gestor tem o menu **Renovações**, com quem ainda não renovou e um botão que abre o WhatsApp com a mensagem pronta.
- Módulos só podem ser reservados para o mês atual e o seguinte.

## Aviso no Telegram (para o gestor)
Em *Configurações > Aviso no Telegram*: crie um robô com @BotFather, informe o token e o seu ID (@userinfobot), salve e clique em "Enviar mensagem de teste". A cada pagamento aprovado você recebe a reserva no celular.

## Próximos atendimentos
Menu **Próximos**: lista por dia de todas as reservas pagas (7, 14 ou 30 dias), com botão de imprimir. O Painel mostra também "Hoje" e "Amanhã".
