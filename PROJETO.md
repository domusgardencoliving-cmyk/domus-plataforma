# PROJETO: DOMUS GARDEN — PLATAFORMA UNIFICADA

## Visão Geral

Criar uma plataforma web única que substitua o Wix (site institucional), o BRCondomínio (gestão do coliving) e eventualmente o Hospedin (gestão do hostel), unificando tudo num só lugar com domínio próprio (domusgardencoliving.com), hospedado na Vercel (gratuito), construído em React.

---

## Estrutura de Navegação

O site tem uma barra de navegação principal com:

- **Domus** (home institucional)
- **Unidades** (Rib + AP)
- **Acomodações**
- **Espaço Domus**
- **Portal Dominhas** (botão destacado)
- **Reserve seu Hostel** (botão destacado)
- 🔧 ícone de engrenagem discreto no footer → acesso ao **DG Gestão** (painel administrativo)

---

## Módulo 1 — Site Institucional

Migração completa do site Wix atual (domusgardencoliving.com) para React. Conteúdo:

- **Home**: missão, jeito Domus, diferenciais, CTA para reserva/coliving
- **Unidades**: Andrade Pertence (coliving feminino + hostel misto) e Ribeirão Claro (coliving exclusivamente feminino) — com fotos, endereços, detalhes
- **Acomodações**: galeria de quartos, estúdios, hostel
- **Espaço Domus**: áreas comuns, quintal, sala de TV, lavanderia, mini mercado
- **Fale Conosco**: WhatsApp, redes sociais, endereços
- Paleta terrosa/orgânica da marca (verde, bege, terra, areia)
- Logo e identidade visual Domus

---

## Módulo 2 — Portal Dominhas

Área logada para moradores do coliving. Funcionalidades:

- Login com e-mail e senha
- Visualização do contrato ativo (datas, valor, quarto)
- Boleto/cobrança do mês
- Histórico de pagamentos
- Comunicados da gestão
- Regulamento da casa
- Contato com a gestão via mensagem
- Mini mercado: ver histórico de consumo

---

## Módulo 3 — Reserve seu Hostel

Página pública de reservas para o hostel da Andrade Pertence. Funcionalidades:

- Apresentação do hostel (fotos, descrição, localização)
- Verificação de disponibilidade por data
- Seleção de cama/quarto
- Formulário de reserva com dados do hóspede
- Integração futura com Hospedin via API

---

## Módulo 4 — DG Gestão (painel administrativo)

Acesso via engrenagem discreta no footer. Login restrito (Gabi + Denilton).

### Financeiro

- Lançamento de receitas e despesas por unidade (Rib e AP separados)
- Dashboard com resultado x meta mensal
- Histórico mês a mês
- Relatório de inadimplência com cálculo automático de multa e juros
- Importação de extrato OFX (Banco Inter)
- **Lançamento por foto de nota/recibo (OCR com IA)**: aba dedicada "Notas" (📸) onde você tira a foto ou envia o PDF da nota direto pelo celular. A IA lê automaticamente valor, data, estabelecimento e forma de pagamento, categoriza a despesa (limpeza, energia, material, etc.), você seleciona a unidade (Rib ou AP) e o lançamento vai direto pro extrato mensal, aparecendo nos relatórios como qualquer outra despesa.

### Moradores

- Cadastro completo (nome, quarto, datas de contrato, valor, contato)
- Status: ativo, aviso dado, rescisão
- Geração de cobrança mensal
- Controle de penalidades por rescisão antecipada

### Hostel

- Calendário de reservas
- Check-in / check-out
- Reservas por plataforma (Hospedin, Airbnb, direto)

### Mini Mercado

- Lançamento de consumo por morador/hóspede
- Relatório de consumo mensal

### Comunicação

- Envio de comunicados para moradores (aparecem no Portal Dominhas)

---

## Módulo 5 — Limpeza (tela da arrumadeira — só AP)

Módulo separado com login próprio para a pessoa responsável pela limpeza. Foco: organizar o dia dela de forma prática, mostrando o que precisa ser feito e com checklist por ambiente.

### Quem usa

- Somente a arrumadeira (perfil `limpeza` no Supabase Auth)
- Gabi e Denilton acompanham pelo DG Gestão (view de tarefas concluídas)

### Funcionalidades

- **Painel do dia**: check-outs de hoje (puxados automaticamente da tabela `reservas` onde `checkout = data de hoje`) + tarefas de rotina
- **Cards por ambiente**: cada quarto/espaço aparece como card com status (pendente / em andamento / concluído)
- **Checklists por tipo de ambiente**: cada tipo tem checklist diferente, cadastrado pela Gabi uma vez no DG Gestão:
  - Quarto individual (trocar cama, limpar banheiro, repor toalhas, verificar frigobar...)
  - Quarto compartilhado (trocar beliche, limpar locker, banheiro compartilhado...)
  - Banheiro social
  - Cozinha (louça, bancada, fogão, chão, lixo)
  - Área comum / sala
  - Lavanderia
- **Fluxo**: arrumadeira abre o card, marca cada item do checklist → quando termina todos, o quarto fica "concluído"
- **Observações**: campo para anotar algo fora do padrão (ex: "chuveiro com goteira", "falta produto de limpeza")

### Banco de dados

Três tabelas novas no schema Supabase:
- `ambientes` — quartos e espaços físicos da AP
- `checklist_modelos` — template de checklist por tipo de ambiente
- `tarefas_limpeza` — tarefas do dia (geradas automaticamente ou manualmente)

### Segurança (RLS)

- Arrumadeira só vê tarefas do dia atual
- Arrumadeira só atualiza tarefas atribuídas a ela
- Arrumadeira pode ver check-outs do dia (nome do hóspede)
- Não tem acesso a financeiro, moradores, ou qualquer outro módulo

---

## Contexto: Ferramentas que o sistema substitui

### BRCondomínio
Usado hoje para gestão do coliving (Rib e AP). Funcionalidades a replicar:

- Cadastro de moradores e unidades
- Emissão de boletos com registro bancário
- Conciliação bancária via importação de extrato OFX
- Controle de inadimplência com cálculo automático de multa e juros
- Prestação de contas e relatórios para sócios
- Comunicação com moradores via portal

**Objetivo**: substituir completamente, eliminando esse custo mensal.

### Hospedin
Usado hoje para gestão do hostel na Andrade Pertence. Funcionalidades a replicar ou integrar:

- PMS: gestão de reservas, check-in e check-out
- Channel manager: sincronização de disponibilidade entre plataformas (Airbnb, Booking, direto)
- Calendário unificado de ocupação
- Fichas de hóspedes
- Relatórios de ocupação e receita por plataforma

**Objetivo a curto prazo**: replicar as funcionalidades de visualização e gestão manual no DG Gestão. O Hospedin continua rodando no início; integração via API é evolução futura.

---

## Tecnologia

- **Frontend**: React (com Tailwind ou CSS modules)
- **Hospedagem**: Vercel (gratuito)
- **Domínio**: domusgardencoliving.com (já existente — só redirecionar DNS do Wix para Vercel)
- **Banco de dados**: Supabase (gratuito na base) ou localStorage persistente para versão MVP
- **Autenticação**: Supabase Auth ou solução simples com JWT
- **OCR / IA**: API Claude (Anthropic) para leitura de notas e recibos

---

## Status Atual

O sistema **DG Gestão** já tinha uma primeira versão construída em React (artifact) com: login, dashboard financeiro de Rib e AP, gestão de moradores, calendário e aba de lançamento por foto de nota com OCR via API Claude. Precisa ser retomado e expandido com os demais módulos.

O **site institucional** foi prototipado parcialmente (home + navbar), ainda não finalizado.

### Próximos passos sugeridos

1. Finalizar o site institucional (migração do Wix)
2. Expandir o DG Gestão com financeiro completo e inadimplência
3. Construir o Portal Dominhas
4. Construir o módulo de reservas do hostel
5. Avaliar integração via API com Hospedin
