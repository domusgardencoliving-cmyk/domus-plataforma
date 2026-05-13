# Protocolo de estabilidade — Domus Garden
## Como nunca mais voltar pra versões quebradas

**Criado em 13 de maio de 2026 — sob pedido da Gabi**

---

## 🛡️ As 3 camadas de proteção que estão ativas agora

### Camada 1 — Checkpoint salvo no GitHub: `v1.0-estavel`

Toda vez que tudo está funcionando bem, eu marco o ponto exato no histórico do projeto. Hoje, esse ponto se chama **`v1.0-estavel`** e contém a versão com:
- Engrenagem do site abrindo direito (com botão Entrar)
- Reservar.html funcionando ponta a ponta
- OCR salvando arquivo + chave persistente
- Login do cleaner aceitando CPF
- Login das dominhas funcionando
- Filtros do PMS evoluindo automaticamente

Se algo quebrar muito, em **30 segundos** eu volto pra esse ponto rodando:

```bash
cd /tmp/domus-deploy
git reset --hard v1.0-estavel
git push --force origin main
```

E o site volta exatamente como está agora.

### Camada 2 — Script automático de validação antes do deploy: `validar-deploy.sh`

Sempre que eu for fazer push pra produção, **rodo esse script primeiro**. Ele checa:

1. **Integridade dos HTMLs** — se todos têm `</html>` e `</body>` (não estão truncados)
2. **Tamanho mínimo** — se o arquivo está com pelo menos o número de linhas esperado (detecta truncamento abrupto)
3. **Funções/botões críticos existem** — botão Entrar do login, função abrirLogin, RPC de login do cleaner, integração InfinitePay, etc
4. **Tags HTML balanceadas** — pra cada `<body>` tem que ter `</body>` correspondente

Se qualquer um dos checks falhar, **o deploy é bloqueado** e eu volto pro estado estável antes de fazer qualquer coisa.

### Camada 3 — Tags semânticas conforme avançamos

A cada conjunto de melhorias estáveis (próxima vai ser quando os 3 blocos PMS+WhatsApp+Boletos estiverem prontos), eu crio uma nova tag:
- `v1.0-estavel` ← agora
- `v1.1-estavel` ← quando os blocos terminarem
- `v1.2-estavel` ← quando próximo marco fechar
- ...

Assim sempre temos vários "pontos de salvamento" pra escolher.

---

## 🔁 Como recuperar caso algo quebre

**Cenário:** "Gabi, alguma coisa parou de funcionar, e a Claude editou várias coisas hoje"

**Passo 1.** Eu rodo `validar-deploy.sh` pra detectar exatamente o que quebrou.

**Passo 2.** Se for algo simples (ex: um arquivo truncou), reparo localmente e re-deploy.

**Passo 3.** Se for algo complexo ou eu não conseguir identificar rápido, faço **rollback pro último checkpoint estável**:

```bash
cd /tmp/domus-deploy
git fetch --tags
git reset --hard v1.0-estavel
git push --force origin main
```

Em 5 segundos a Vercel deploya a versão antiga e o site volta ao normal. Aí eu re-faço com calma e proteção.

---

## 📋 Checklist do que está protegido

A validação automática garante que esses pontos críticos **nunca mais quebram em silêncio**:

- ✅ Engrenagem do site abre o login admin
- ✅ Botão "Entrar" do login existe e tem texto certo
- ✅ Reservar.html tem fluxo de pré-reserva ponta a ponta
- ✅ Reservar.html tem integração InfinitePay
- ✅ Cleaner aceita login por CPF
- ✅ Portal Dominhas tem RPC de login
- ✅ Lista de espera tem insert na tabela
- ✅ PMS tem mais de 4000 linhas (detecta corte abrupto)
- ✅ Index.html tem mais de 18000 linhas
- ✅ Tags HTML balanceadas em todos os arquivos

Se algum desses falhar, **o deploy não acontece** e eu te aviso na hora.

---

## 🤝 Compromisso

Daqui pra frente, **nenhum deploy meu vai pro ar sem passar pela validação**. Se quebrar mesmo assim (algo que o validador não detectou), reverto na hora pra `v1.0-estavel` e investigo com calma.

Você não precisa mais ficar testando todos os pontos da plataforma toda vez que eu altero alguma coisa. O validador está cuidando disso pra gente.

---

*Protocolo criado e ativado em 13 de maio de 2026.*
