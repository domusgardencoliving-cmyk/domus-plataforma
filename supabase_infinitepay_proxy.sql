-- =========================================================
-- PROXY INFINITEPAY — Funções server-side (checkout + webhook)
-- Atualizado 12/06/2026: webhook_url automático em todo link
-- + processar_webhook entende o formato NOVO do Checkout
-- (invoice_slug/paid_amount/transaction_nsu/order_nsu).
-- Fonte da verdade = banco; este arquivo espelha o deploy.
-- =========================================================

create extension if not exists http with schema extensions;

-- 1) Gera link de checkout JÁ com webhook_url apontando pro
--    endpoint webhook-infinitepay (notificação automática de pagamento)
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
as $fn$
declare
  payload jsonb;
  response extensions.http_response;
  result json;
begin
  payload := jsonb_build_object(
    'handle', p_handle,
    'webhook_url', 'https://motwhfbpundrhvuwjntw.supabase.co/functions/v1/webhook-infinitepay',
    'items', jsonb_build_array(
      jsonb_build_object('description', p_descricao, 'quantity', 1, 'price', p_valor_centavos)
    )
  );
  if p_order_nsu is not null then payload := payload || jsonb_build_object('order_nsu', p_order_nsu); end if;
  if p_redirect_url is not null then payload := payload || jsonb_build_object('redirect_url', p_redirect_url); end if;
  if p_cliente_nome is not null then
    payload := payload || jsonb_build_object('customer', jsonb_build_object(
      'name', p_cliente_nome,
      'email', coalesce(p_cliente_email, ''),
      'phone_number', coalesce(p_cliente_telefone, '')
    ));
  end if;
  select * into response
  from extensions.http((
    'POST',
    'https://api.checkout.infinitepay.io/links',
    array[extensions.http_header('Content-Type', 'application/json')],
    'application/json',
    payload::text
  )::extensions.http_request);
  begin
    result := response.content::json;
  exception when others then
    result := json_build_object('error', 'Resposta invalida da InfinitePay', 'raw', response.content);
  end;
  return result;
end;
$fn$;

grant execute on function public.gerar_checkout_infinitepay to anon;

-- 2) processar_webhook_infinitepay: extração atualizada no banco em
--    12/06/2026 pra aceitar formato novo do Checkout:
--    v_evento  += CASE WHEN payload ? 'invoice_slug' THEN 'checkout.paid'
--    v_status  += CASE WHEN invoice_slug e paid_amount/amount > 0 THEN 'paid'
--    v_valor   += paid_amount (prioridade) / 100
--    v_transaction_id += transaction_nsu
--    Vínculo de reserva continua por order_nsu 'RES-<uuid>' (reservar.html linha ~2863).
--    Definição completa: pg_get_functiondef no banco.
