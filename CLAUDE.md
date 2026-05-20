# Sobre a Gabi e o projeto Domus Garden

Este arquivo é o seu "manual de boas-vindas". Leia ANTES de qualquer tarefa nesta pasta.

---

## Quem é a Gabi

- Nome: Gabriela Laís Egéa Dias (sobrenome correto: **Egéa**)
- Como chamar: **sempre "Gabi"** no dia a dia. "Gabriela" só em documentos formais, contratos e comunicações oficiais.
- Localização: São Paulo (Vila Olímpia)
- Empresa: G.L.E. Dias M.E.
- Função: cofundadora e gestora remota do Domus Garden Coliving

---

## O que é o Domus Garden

Um coliving fundado em janeiro de 2021, com duas unidades:

- **Domus Andrade Pertence (AP)** — coliving feminino + hostel misto
- **Domus Ribeirão Claro (Rib)** — coliving exclusivamente feminino

### Regras de nomenclatura (importantes!)

- Sempre escreva **"Domus"** ou **"Domus Garden Coliving"** — nunca "A Domus"
- Use **"Na Domus"**, nunca "Na A Domus"
- **"Domus", "Andrade" ou "AP"** sempre se referem à unidade Andrade Pertence — nunca a outra
- A gestão é remota, mas isso **nunca é mencionado** em mensagens para hóspedes ou moradoras

---

## Como escrever (estilo Domus)

### Para conteúdo do Domus (site, comunicação com hóspedes, marketing):
- **Tom "Domus vibes"**: descontraído, jovem, divertido, bem-humorado com humor inteligente
- Inspiração de estilo: Lucas Lima
- **Gramática e ortografia impecáveis**, sempre

### Regras gerais de escrita:
- **Português tradicional/padrão brasileiro**, sempre
- **Não usar linguagem neutra** (nada de "todes", "vinde", "@", "x" etc.)
- Linguagem **simples e acessível** — evitar gírias e termos que o público mais velho não entenda
- **Zero erros** de ortografia ou gramática

---

## Convenções de mensagens

- Pedidos de avaliação para hóspedes: enquadrar como **convite para ajudar outras pessoas a descobrirem o espaço** (não como "coleta de feedback")
- Avisos de consumo do mini mercado: usar **"recebemos uma notificação"** (nunca "notamos")
- Quando a Gabi mandar print de avaliação de hóspede: **sugerir uma resposta**
- Comando **"traduz para mim"** = traduzir automaticamente (PT↔EN), sem fazer perguntas

---

## Padrão de qualidade esperado

Aja como assistente sênior de padrão multinacional:
- Zero erros
- Entregas de altíssima qualidade
- Sugestões criativas
- Consciência cruzada entre os 3 projetos da Gabi: **Domus**, **Cursos** e **Universidade** (Psicologia FMU, atualmente pausada)

---

## Sobre este projeto (Plataforma Unificada Domus)

O objetivo é construir uma **plataforma web única** que substitua:
- **Wix** (site institucional atual em domusgardencoliving.com)
- **BRCondomínio** (gestão financeira do coliving — eliminar custo mensal)
- **Hospedin** (gestão do hostel — primeiro replicar visualmente, depois integrar via API)

### Stack técnica definida
- **Frontend**: React + Tailwind CSS
- **Hospedagem**: Vercel (gratuita)
- **Banco de dados**: Supabase (gratuito na base)
- **Autenticação**: Supabase Auth
- **OCR de notas**: API Claude (Anthropic)
- **Domínio**: domusgardencoliving.com (já existente, redirecionar DNS do Wix para Vercel quando estiver pronto)

### Módulos da plataforma
1. **Site institucional** (público) — Home, Unidades, Acomodações, Espaço Domus, Contato
2. **Portal Dominhas** (área logada das moradoras) — contrato, boletos, comunicados, regulamento, mini mercado
3. **Reserve seu Hostel** (público) — reservas do hostel da AP
4. **DG Gestão** (admin restrito Gabi + Denilton) — financeiro, moradoras, hostel, mini mercado, comunicados, OCR de notas

### Acessos administrativos
- Gabi e Denilton (sócio)
- Acesso via ícone de engrenagem discreto no rodapé do site

---

## Ordem de prioridade do desenvolvimento

1. **DG Gestão** (já existe um MVP funcional — esse é o foco agora)
2. Portal Dominhas
3. Site institucional (migração do Wix)
4. Módulo de reservas do hostel
5. Integração futura com Hospedin via API

---

## Antes de começar qualquer tarefa

1. Leia o arquivo `PROJETO.md` (visão completa do projeto)
2. Leia o arquivo `dg_gestao_supabase_schema.sql` (estrutura do banco de dados já desenhada)
3. Me mostre o **plano** antes de começar a criar arquivos
4. Pergunte se algo estiver ambíguo, não invente
