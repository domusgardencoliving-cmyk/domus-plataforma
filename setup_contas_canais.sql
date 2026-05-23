-- =========================================================
-- Tabela contas_canais — guarda tokens OAuth de cada canal
-- conectado ao Átrio (Gmail, Instagram, WhatsApp futuro, etc)
-- =========================================================

create table if not exists public.contas_canais (
  id              uuid primary key default gen_random_uuid(),
  canal           text not null unique,             -- 'gmail', 'instagram', 'whatsapp'
  identificador   text not null,                    -- email do gmail, @user do insta, +tel do wa
  access_token    text,                              -- token curto (expira em ~1h)
  refresh_token   text,                              -- token longo (não expira, usar pra renovar)
  expires_in      integer,
  scope           text,
  status          text default 'conectado' check (status in ('conectado','desconectado','erro')),
  conectado_em    timestamptz default now(),
  atualizado_em   timestamptz default now(),
  metadata        jsonb default '{}'::jsonb         -- info adicional (nome, foto, etc)
);

create index if not exists idx_contas_canais_canal on public.contas_canais(canal);

-- RLS: só service_role consegue ler/escrever tokens (são sensíveis)
alter table public.contas_canais enable row level security;
drop policy if exists "service role tudo" on public.contas_canais;
create policy "service role tudo" on public.contas_canais
  for all to service_role using (true) with check (true);

-- Permite anon ler APENAS status + identificador (pro conectar-canais.html mostrar "conectado/pendente")
drop policy if exists "anon ler status" on public.contas_canais;
create policy "anon ler status" on public.contas_canais
  for select to anon, authenticated using (true);

-- =========================================================
-- Cron gmail-poll-10min
-- =========================================================

select cron.schedule(
  'gmail-poll-10min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://motwhfbpundrhvuwjntw.supabase.co/functions/v1/gmail-poll-atrio',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1)
    )
  );
  $$
);
