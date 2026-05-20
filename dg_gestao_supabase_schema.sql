-- =========================================================
-- DG GESTÃO — SCHEMA SUPABASE (Domus Garden Coliving)
-- Rodar no SQL Editor do Supabase, na ordem.
-- =========================================================

-- 1) USUÁRIOS ADMIN
-- O Supabase já tem auth.users nativo. Esta tabela complementa
-- com o perfil interno (Gabi, Denilton).
create table if not exists public.usuarios (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  perfil text not null check (perfil in ('admin', 'morador', 'limpeza')),
  unidade text check (unidade in ('Rib', 'AP')), -- só preenchido para moradores
  morador_id uuid, -- FK para public.moradores quando perfil='morador'
  criado_em timestamptz default now()
);

-- 2) MORADORES
create table if not exists public.moradores (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  unidade text not null check (unidade in ('Rib', 'AP')),
  quarto text,
  valor numeric(10,2) not null,
  inicio_contrato date not null,
  fim_contrato date,
  dia_vencimento int not null default 15 check (dia_vencimento between 1 and 28),
  contato text,
  email text, -- usado para login no Portal Dominhas
  status text not null default 'ativo' check (status in ('ativo', 'aviso', 'rescisao')),
  observacoes text,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create index idx_moradores_unidade on public.moradores(unidade);
create index idx_moradores_status on public.moradores(status);

-- 3) LANÇAMENTOS FINANCEIROS (receitas e despesas)
create table if not exists public.lancamentos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('receita', 'despesa')),
  unidade text not null check (unidade in ('Rib', 'AP')),
  categoria text not null,
  descricao text not null,
  valor numeric(10,2) not null,
  data date not null,
  morador_id uuid references public.moradores(id) on delete set null,
  reserva_id uuid, -- FK para reservas (definida abaixo)
  consumo_id uuid, -- FK para consumos (definida abaixo)
  origem text default 'manual' check (origem in ('manual', 'ocr', 'ofx', 'cobranca', 'hostel', 'mercado')),
  comprovante_url text, -- link pro storage do Supabase quando vier de OCR
  criado_em timestamptz default now()
);

create index idx_lanc_unidade_data on public.lancamentos(unidade, data desc);
create index idx_lanc_morador on public.lancamentos(morador_id);
create index idx_lanc_data on public.lancamentos(data desc);

-- 4) METAS MENSAIS POR UNIDADE
create table if not exists public.metas (
  id uuid primary key default gen_random_uuid(),
  unidade text not null check (unidade in ('Rib', 'AP')),
  mes date not null, -- usar dia 01 (ex: 2026-04-01)
  meta_liquida numeric(10,2) not null,
  unique (unidade, mes)
);

-- 5) RESERVAS DO HOSTEL
create table if not exists public.reservas (
  id uuid primary key default gen_random_uuid(),
  hospede_nome text not null,
  hospede_documento text,
  hospede_contato text,
  cama text,
  checkin date not null,
  checkout date not null,
  plataforma text not null default 'Direto' check (plataforma in ('Direto', 'Airbnb', 'Booking', 'Hospedin', 'Outro')),
  valor_total numeric(10,2) not null default 0,
  status text not null default 'confirmada' check (status in ('em_espera', 'pre_reserva', 'confirmada', 'check-in', 'check-out', 'cancelada')),
  observacoes text,
  criado_em timestamptz default now()
);

create index idx_reservas_periodo on public.reservas(checkin, checkout);

alter table public.lancamentos
  add constraint fk_lanc_reserva foreign key (reserva_id) references public.reservas(id) on delete set null;

-- 6) MINI MERCADO — CONSUMOS
create table if not exists public.consumos (
  id uuid primary key default gen_random_uuid(),
  morador_id uuid references public.moradores(id) on delete set null,
  reserva_id uuid references public.reservas(id) on delete set null,
  pessoa_nome text not null, -- snapshot do nome pra histórico
  unidade text not null check (unidade in ('Rib', 'AP')),
  item text not null,
  valor numeric(10,2) not null,
  data date not null,
  pago boolean not null default false,
  criado_em timestamptz default now()
);

alter table public.lancamentos
  add constraint fk_lanc_consumo foreign key (consumo_id) references public.consumos(id) on delete set null;

-- 7) COMUNICADOS
create table if not exists public.comunicados (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  mensagem text not null,
  destino text not null check (destino in ('Todas', 'Rib', 'AP')),
  autor_id uuid references auth.users(id),
  data date not null default current_date,
  criado_em timestamptz default now()
);

-- 8) INADIMPLÊNCIA — VIEW CALCULADA
-- Lista moradoras ativas que não têm receita lançada no mês corrente
create or replace view public.inadimplencia_mes as
select
  m.id,
  m.nome,
  m.unidade,
  m.quarto,
  m.valor,
  m.dia_vencimento,
  -- multa 2% + juros 1% ao mês proporcional aos dias de atraso
  round(
    m.valor * 0.02 +
    m.valor * 0.01 / 30 *
    greatest(0, current_date - make_date(
      extract(year from current_date)::int,
      extract(month from current_date)::int,
      m.dia_vencimento
    )),
    2
  ) as encargos
from public.moradores m
where m.status = 'ativo'
  and not exists (
    select 1 from public.lancamentos l
    where l.morador_id = m.id
      and l.tipo = 'receita'
      and l.categoria = 'Aluguel'
      and to_char(l.data, 'YYYY-MM') = to_char(current_date, 'YYYY-MM')
  );

-- 9) RESULTADO MENSAL — VIEW
create or replace view public.resultado_mensal as
select
  unidade,
  to_char(data, 'YYYY-MM') as mes,
  sum(case when tipo = 'receita' then valor else 0 end) as receitas,
  sum(case when tipo = 'despesa' then valor else 0 end) as despesas,
  sum(case when tipo = 'receita' then valor else -valor end) as liquido
from public.lancamentos
group by unidade, to_char(data, 'YYYY-MM')
order by mes desc, unidade;

-- =========================================================
-- 10) MÓDULO DE LIMPEZA — AMBIENTES, CHECKLISTS E TAREFAS
-- =========================================================

-- 10a) Ambientes físicos da unidade AP (quartos, banheiros, cozinha etc.)
create table if not exists public.ambientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,                -- ex: "Quarto 1", "Cozinha", "Banheiro social"
  tipo text not null check (tipo in (
    'quarto_individual', 'quarto_compartilhado', 'banheiro',
    'cozinha', 'area_comum', 'lavanderia'
  )),
  unidade text not null default 'AP' check (unidade = 'AP'),
  cama text,                         -- se for quarto de hostel, qual cama (ex: "Beliche A-baixo")
  ativo boolean not null default true,
  criado_em timestamptz default now()
);

-- 10b) Modelos de checklist por tipo de ambiente
-- Cadastrados uma vez pela Gabi; a arrumadeira não edita.
create table if not exists public.checklist_modelos (
  id uuid primary key default gen_random_uuid(),
  tipo_ambiente text not null check (tipo_ambiente in (
    'quarto_individual', 'quarto_compartilhado', 'banheiro',
    'cozinha', 'area_comum', 'lavanderia'
  )),
  titulo text not null,              -- ex: "Limpeza de check-out — Quarto individual"
  itens jsonb not null default '[]', -- array de strings: ["Trocar roupa de cama", "Limpar banheiro", ...]
  criado_em timestamptz default now(),
  unique (tipo_ambiente)
);

-- 10c) Tarefas de limpeza do dia
-- Geradas automaticamente quando há check-out, ou manualmente para limpeza de rotina.
create table if not exists public.tarefas_limpeza (
  id uuid primary key default gen_random_uuid(),
  data date not null default current_date,
  ambiente_id uuid not null references public.ambientes(id) on delete cascade,
  reserva_id uuid references public.reservas(id) on delete set null, -- só quando é check-out de hóspede
  tipo_tarefa text not null default 'checkout' check (tipo_tarefa in ('checkout', 'rotina')),
  status text not null default 'pendente' check (status in ('pendente', 'em_andamento', 'concluida')),
  checklist jsonb not null default '[]', -- cópia dos itens do modelo, com campo "feito": true/false
  arrumadeira_id uuid references public.usuarios(id) on delete set null,
  observacoes text,
  iniciado_em timestamptz,
  concluido_em timestamptz,
  criado_em timestamptz default now()
);

create index idx_tarefas_data on public.tarefas_limpeza(data);
create index idx_tarefas_status on public.tarefas_limpeza(status);

-- =========================================================
-- ROW LEVEL SECURITY (RLS)
-- =========================================================
alter table public.usuarios enable row level security;
alter table public.moradores enable row level security;
alter table public.lancamentos enable row level security;
alter table public.metas enable row level security;
alter table public.reservas enable row level security;
alter table public.consumos enable row level security;
alter table public.comunicados enable row level security;
alter table public.ambientes enable row level security;
alter table public.checklist_modelos enable row level security;
alter table public.tarefas_limpeza enable row level security;

-- Função auxiliar: o usuário atual é admin?
create or replace function public.is_admin() returns boolean as $$
  select exists (
    select 1 from public.usuarios
    where id = auth.uid() and perfil = 'admin'
  );
$$ language sql stable security definer;

-- Função auxiliar: id do morador vinculado ao usuário atual
create or replace function public.current_morador_id() returns uuid as $$
  select morador_id from public.usuarios where id = auth.uid();
$$ language sql stable security definer;

-- Políticas: ADMIN tem acesso total a tudo
create policy "admin_all_usuarios" on public.usuarios for all using (is_admin());
create policy "admin_all_moradores" on public.moradores for all using (is_admin());
create policy "admin_all_lancamentos" on public.lancamentos for all using (is_admin());
create policy "admin_all_metas" on public.metas for all using (is_admin());
create policy "admin_all_reservas" on public.reservas for all using (is_admin());
create policy "admin_all_consumos" on public.consumos for all using (is_admin());
create policy "admin_all_comunicados" on public.comunicados for all using (is_admin());
create policy "admin_all_ambientes" on public.ambientes for all using (is_admin());
create policy "admin_all_checklists" on public.checklist_modelos for all using (is_admin());
create policy "admin_all_tarefas" on public.tarefas_limpeza for all using (is_admin());

-- Função auxiliar: o usuário atual é limpeza?
create or replace function public.is_limpeza() returns boolean as $$
  select exists (
    select 1 from public.usuarios
    where id = auth.uid() and perfil = 'limpeza'
  );
$$ language sql stable security definer;

-- Políticas: LIMPEZA vê ambientes e checklists, gerencia só suas tarefas do dia
create policy "limpeza_ve_ambientes" on public.ambientes
  for select using (is_limpeza());

create policy "limpeza_ve_checklists" on public.checklist_modelos
  for select using (is_limpeza());

create policy "limpeza_ve_tarefas_do_dia" on public.tarefas_limpeza
  for select using (is_limpeza() and data = current_date);

create policy "limpeza_atualiza_tarefas" on public.tarefas_limpeza
  for update using (is_limpeza() and arrumadeira_id = auth.uid())
  with check (data = current_date);

-- Limpeza pode ver reservas do dia (para saber nomes dos hóspedes)
create policy "limpeza_ve_checkouts_do_dia" on public.reservas
  for select using (is_limpeza() and checkout = current_date);

-- Políticas: MORADOR vê só os dados dela (Portal Dominhas)
create policy "morador_ve_proprio_perfil" on public.usuarios
  for select using (id = auth.uid());

create policy "morador_ve_proprio_cadastro" on public.moradores
  for select using (id = current_morador_id());

create policy "morador_ve_proprias_cobrancas" on public.lancamentos
  for select using (morador_id = current_morador_id());

create policy "morador_ve_proprios_consumos" on public.consumos
  for select using (morador_id = current_morador_id());

create policy "morador_ve_comunicados" on public.comunicados
  for select using (
    destino = 'Todas'
    or destino = (select unidade from public.moradores where id = current_morador_id())
  );

-- =========================================================
-- 11) COMUNA DAS DOMINHAS (comunidade de moradoras)
-- =========================================================
create table if not exists public.comuna_posts (
  id uuid primary key default gen_random_uuid(),
  morador_id uuid not null references public.moradores(id) on delete cascade,
  texto text not null,
  categoria text not null default 'geral' check (categoria in ('geral', 'dica', 'evento', 'pedido', 'oferta')),
  criado_em timestamptz default now()
);

create index idx_comuna_posts_data on public.comuna_posts(criado_em);

alter table public.comuna_posts enable row level security;

-- Moradoras (ativas e ex) podem ver todos os posts
create policy "morador_ve_posts" on public.comuna_posts
  for select using (
    exists (select 1 from public.usuarios where id = auth.uid() and perfil = 'morador')
  );

-- Moradoras podem criar posts vinculados a si mesmas
create policy "morador_cria_post" on public.comuna_posts
  for insert with check (
    exists (select 1 from public.usuarios where id = auth.uid() and perfil = 'morador' and morador_id = comuna_posts.morador_id)
  );

-- Admin vê e gerencia tudo
create policy "admin_all_comuna" on public.comuna_posts for all using (is_admin());

-- =========================================================
-- 12) MURAL DA CASA (recados anônimos entre moradoras)
-- Posts anônimos, expiram em 7 dias, filtrados por unidade.
-- Só moradoras ativas da mesma unidade veem e criam.
-- =========================================================
create table if not exists public.mural_recados (
  id uuid primary key default gen_random_uuid(),
  morador_id uuid not null references public.moradores(id) on delete cascade,
  unidade text not null check (unidade in ('AP', 'Rib')),
  texto text not null,
  criado_em timestamptz default now(),
  expira_em timestamptz default (now() + interval '7 days')
);

create index idx_mural_recados_expira on public.mural_recados(expira_em);
create index idx_mural_recados_unidade on public.mural_recados(unidade);

alter table public.mural_recados enable row level security;

-- Moradoras ativas veem recados da SUA unidade que ainda não expiraram
-- IMPORTANTE: morador_id NÃO é exposto na query de leitura (anonimato)
create policy "morador_ve_recados_unidade" on public.mural_recados
  for select using (
    expira_em > now()
    and exists (
      select 1 from public.usuarios u
      join public.moradores m on m.id = u.morador_id
      where u.id = auth.uid()
        and u.perfil = 'morador'
        and m.status in ('ativo', 'aviso')
        and m.unidade = mural_recados.unidade
    )
  );

-- Moradora cria recado na unidade dela
create policy "morador_cria_recado" on public.mural_recados
  for insert with check (
    exists (
      select 1 from public.usuarios u
      join public.moradores m on m.id = u.morador_id
      where u.id = auth.uid()
        and u.perfil = 'morador'
        and m.status in ('ativo', 'aviso')
        and m.id = mural_recados.morador_id
        and m.unidade = mural_recados.unidade
    )
  );

-- Admin vê e gerencia tudo
create policy "admin_all_mural" on public.mural_recados for all using (is_admin());

-- =========================================================
-- STORAGE BUCKET para comprovantes de OCR
-- =========================================================
-- Rodar no painel Storage: criar bucket 'comprovantes' (privado)
-- Política sugerida no bucket: só admins fazem upload e leitura.

-- =========================================================
-- DADOS INICIAIS (opcional — descomentar para popular)
-- =========================================================
-- insert into public.metas (unidade, mes, meta_liquida) values
--   ('Rib', date_trunc('month', current_date), 8000),
--   ('AP',  date_trunc('month', current_date), 12000);
