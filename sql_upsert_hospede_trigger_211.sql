-- ============================================================
-- FIX BUG #211 — aplicado em 09/06/2026 (madrugada de 10/06)
-- Reservas agora criam/atualizam o cadastro central (hospedes)
-- e linkam hospede_id automaticamente em TODO INSERT de reserva
-- (PMS, site, sync pull — qualquer origem).
--
-- Componentes (JA APLICADOS em producao via Mgmt API):
--   1. extensao unaccent (nao existia! verificar_hospede_bloqueado dependia dela)
--   2. RPC upsert_hospede_de_reserva(nome, tel, email) SECURITY DEFINER
--      - match por telefone >= email >= nome normalizado
--      - cria se nao existe; preenche tel/email faltantes se existe
--      - guards: nomes genericos (hospede/teste/bloqueio/VD:/Cama ), alias @guest.booking.com
--   3. trigger trg_aa_reservas_upsert_hospede BEFORE INSERT em reservas
--      - "aa" no nome pra rodar ANTES do trg_bloquear_reserva_hospede_inadimplente
--      - nunca quebra o INSERT (exception -> segue sem link)
-- ============================================================
create extension if not exists unaccent with schema public;

create or replace function public.upsert_hospede_de_reserva(p_nome text, p_telefone text default null, p_email text default null)
returns uuid language plpgsql security definer set search_path=public as $fn$
declare
  v_id uuid;
  v_tel text := regexp_replace(coalesce(p_telefone,''), '\D', '', 'g');
  v_email text := lower(trim(coalesce(p_email,'')));
  v_nome text := regexp_replace(trim(coalesce(p_nome,'')), '\s+', ' ', 'g');
begin
  if v_nome = '' or length(v_nome) < 5 then return null; end if;
  if v_nome ~* '^(hospede|hóspede|teste|bloqueio|VD:|PR:|BO:|AI:|HO:|Cama )' then return null; end if;
  if v_email like '%@guest.booking.com%' then v_email := ''; end if;
  if length(v_tel) >= 10 then
    select id into v_id from hospedes where regexp_replace(coalesce(telefone,''),'\D','','g') = v_tel limit 1;
  end if;
  if v_id is null and v_email <> '' then
    select id into v_id from hospedes where lower(coalesce(email,'')) = v_email limit 1;
  end if;
  if v_id is null then
    select id into v_id from hospedes where lower(unaccent(regexp_replace(trim(nome),'\s+',' ','g'))) = lower(unaccent(v_nome)) limit 1;
  end if;
  if v_id is null then
    begin
      insert into hospedes (nome, telefone, email, ativo, criado_em, atualizado_em)
      values (v_nome, nullif(trim(coalesce(p_telefone,'')),''), nullif(v_email,''), true, now(), now())
      returning id into v_id;
    exception when unique_violation then
      select id into v_id from hospedes where nome = v_nome limit 1;
    end;
  else
    update hospedes set
      telefone = case when (coalesce(telefone,'') = '' or telefone like '%@%') and v_tel <> '' then trim(p_telefone) else telefone end,
      email = case when coalesce(email,'') = '' and v_email <> '' then v_email else email end,
      atualizado_em = now()
    where id = v_id;
  end if;
  return v_id;
end $fn$;
grant execute on function public.upsert_hospede_de_reserva(text,text,text) to anon, authenticated, service_role;

create or replace function public.tg_reservas_upsert_hospede()
returns trigger language plpgsql security definer set search_path=public as $tg$
declare v_id uuid; v_tel text; v_email text; v_c text;
begin
  if coalesce(NEW.plataforma,'') = 'Bloqueio' or coalesce(NEW.canal_codigo,'') = 'bloqueio' then return NEW; end if;
  v_c := trim(coalesce(NEW.hospede_contato,''));
  if position('@' in v_c) > 0 then v_email := v_c; else v_tel := v_c; end if;
  v_id := public.upsert_hospede_de_reserva(NEW.hospede_nome, v_tel, v_email);
  if NEW.hospede_id is null and v_id is not null then NEW.hospede_id := v_id; end if;
  return NEW;
exception when others then
  return NEW;
end $tg$;

drop trigger if exists trg_aa_reservas_upsert_hospede on public.reservas;
create trigger trg_aa_reservas_upsert_hospede before insert on public.reservas
for each row execute function public.tg_reservas_upsert_hospede();
