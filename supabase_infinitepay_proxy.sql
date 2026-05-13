-- =========================================================
-- PROXY INFINITEPAY — Função server-side para gerar links
-- Rodar no SQL Editor do Supabase
-- =========================================================

-- 1) Habilitar a extensão HTTP (permite chamadas HTTP do PostgreSQL)
create extension if not exists http with schema extensions;

-- 2) Função que gera link de checkout InfinitePay
-- Chamada pelo frontend via: db.rpc('gerar_checkout_infinitepay', {...})
create or replace function public.gerar_checkout_infinitepay(
  p_handle text,
  p_descricao text,
  p_valor_centavos int,
  p_order_nsu text default null,
  p_redirect_url text default null,
  p_cliente_nome text default null,
  p_cliente_email text default null,
  p_cliente_telefone text default null
)
returns json
language plpgsql
security definer
as $$
declare
  payload json;
  response extensions.http_response;
  result json;
begin
  -- Montar o payload
  payload := json_build_object(
    'handle', p_handle,
    'items', json_build_array(
      json_build_object(
        'description', p_descricao,
        'quantity', 1,
        'price', p_valor_centavos
      )
    )
  );

  -- Adicionar campos opcionais
  if p_order_nsu is not null then
    payload := (
      select json_object_agg(key, value)
      from (
        select * from json_each(payload)
        union all
        select 'order_nsu', to_json(p_order_nsu)
      ) t
    );
  end if;

  if p_redirect_url is not null then
    payload := (
      select json_object_agg(key, value)
      from (
        select * from json_each(payload)
        union all
        select 'redirect_url', to_json(p_redirect_url)
      ) t
    );
  end if;

  if p_cliente_nome is not null then
    payload := (
      select json_object_agg(key, value)
      from (
        select * from json_each(payload)
        union all
        select 'customer', json_build_object(
          'name', p_cliente_nome,
          'email', coalesce(p_cliente_email, ''),
          'phone_number', coalesce(p_cliente_telefone, '')
        )
      ) t
    );
  end if;

  -- Fazer a chamada HTTP POST para InfinitePay
  select * into response
  from extensions.http((
    'POST',
    'https://api.checkout.infinitepay.io/links',  -- URL nova (migração 13/maio/2026, prazo era 01/06)
    array[extensions.http_header('Content-Type', 'application/json')],
    'application/json',
    payload::text
  )::extensions.http_request);

  -- Retornar a resposta
  begin
    result := response.content::json;
  exception when others then
    result := json_build_object('error', 'Resposta invalida da InfinitePay', 'raw', response.content);
  end;

  return result;
end;
$$;

-- 3) Permitir que qualquer usuário (anon) chame a função
-- (necessário para o formulário público de pré-reserva)
grant execute on function public.gerar_checkout_infinitepay to anon;
grant execute on function public.gerar