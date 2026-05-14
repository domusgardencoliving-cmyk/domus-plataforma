-- =========================================================
-- CARTEIRO DOMINHAS — Lembretes automáticos de boleto
--
-- Regra Gabi: lembrar D-1 (véspera vencimento), D-0 (dia do vencimento)
-- e D+1, D+3, D+5... (atrasado, dia sim dia não)
--
-- Cada moradora tem boleto mensal com data de vencimento.
-- Esta função roda diariamente, identifica quem precisa de lembrete,
-- monta mensagem e enfileira pra Meta API enviar.
-- =========================================================

-- 1. Garantir que tabela boletos_dominhas existe (cria se não)
CREATE TABLE IF NOT EXISTS public.boletos_dominhas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  morador_id uuid REFERENCES public.moradores(id) ON DELETE CASCADE,
  morador_nome text,
  morador_telefone text,
  mes_referencia date NOT NULL,
  valor numeric NOT NULL,
  data_vencimento date NOT NULL,
  url_boleto text,
  codigo_barras text,
  pix_copia_cola text,
  status text DEFAULT 'aberto' CHECK (status IN ('aberto','pago','vencido','cancelado')),
  pago_em timestamptz,
  forma_pagamento text,
  banco_inter_id text,
  ultimo_lembrete_em timestamptz,
  total_lembretes int DEFAULT 0,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boletos_status_venc ON public.boletos_dominhas (status, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_boletos_morador ON public.boletos_dominhas (morador_id);

ALTER TABLE public.boletos_dominhas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS boletos_anon ON public.boletos_dominhas;
CREATE POLICY boletos_anon ON public.boletos_dominhas FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 2. FUNCAO: gerar lembretes pra hoje
CREATE OR REPLACE FUNCTION public.gerar_lembretes_boletos_dominhas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_b record;
  v_dias_para_venc int;
  v_msg text;
  v_momento text;
  v_total_lembretes int := 0;
  v_total_atraso int := 0;
  v_total_vespera int := 0;
  v_total_dia int := 0;
BEGIN
  FOR v_b IN
    SELECT b.*, m.nome AS morador_nome_full, m.telefone AS morador_tel_full, m.unidade
      FROM public.boletos_dominhas b
      LEFT JOIN public.moradores m ON m.id = b.morador_id
     WHERE b.status IN ('aberto', 'vencido')
       AND b.data_vencimento >= CURRENT_DATE - INTERVAL '60 days'
       AND b.morador_telefone IS NOT NULL
  LOOP
    v_dias_para_venc := (v_b.data_vencimento - CURRENT_DATE)::int;

    -- Decide momento de lembrete
    IF v_dias_para_venc = 1 THEN
      v_momento := 'vespera_vencimento';
      v_total_vespera := v_total_vespera + 1;
    ELSIF v_dias_para_venc = 0 THEN
      v_momento := 'dia_vencimento';
      v_total_dia := v_total_dia + 1;
    ELSIF v_dias_para_venc < 0 AND ABS(v_dias_para_venc) % 2 = 1 THEN
      -- Atrasado: lembrete dia sim dia não (D+1, D+3, D+5...)
      v_momento := 'atrasado';
      v_total_atraso := v_total_atraso + 1;
    ELSE
      CONTINUE;
    END IF;

    -- Montar mensagem (Bettina mode — acolhedora, sem cobrar pesado)
    IF v_momento = 'vespera_vencimento' THEN
      v_msg := 'Oi ' || split_part(COALESCE(v_b.morador_nome_full, v_b.morador_nome, 'querida'), ' ', 1) || '! ' || E'\n\n' ||
        'Lembrete carinhoso: amanha (' || to_char(v_b.data_vencimento, 'DD/MM') || ') vence o boleto da Domus referente a ' ||
        to_char(v_b.mes_referencia, 'TMMonth/YYYY') || '.' || E'\n\n' ||
        '*Valor:* R$ ' || replace(to_char(v_b.valor, 'FM999G990D00'), '.', ',') || E'\n\n' ||
        CASE WHEN v_b.pix_copia_cola IS NOT NULL THEN
          '*PIX (copia e cola):*' || E'\n' || '`' || v_b.pix_copia_cola || '`' || E'\n\n' ELSE '' END ||
        CASE WHEN v_b.url_boleto IS NOT NULL THEN
          'Boleto pra impressao: ' || v_b.url_boleto || E'\n\n' ELSE '' END ||
        'Qualquer duvida e so responder essa mensagem.' || E'\n\n' ||
        '_— Equipe Domus Garden_';
    ELSIF v_momento = 'dia_vencimento' THEN
      v_msg := 'Oi ' || split_part(COALESCE(v_b.morador_nome_full, v_b.morador_nome, 'querida'), ' ', 1) || '!' || E'\n\n' ||
        'Hoje (' || to_char(v_b.data_vencimento, 'DD/MM') || ') vence o boleto da Domus, no valor de R$ ' ||
        replace(to_char(v_b.valor, 'FM999G990D00'), '.', ',') || '.' || E'\n\n' ||
        CASE WHEN v_b.pix_copia_cola IS NOT NULL THEN
          '*PIX (copia e cola):*' || E'\n' || '`' || v_b.pix_copia_cola || '`' || E'\n\n' ELSE '' END ||
        CASE WHEN v_b.url_boleto IS NOT NULL THEN
          'Boleto pra impressao: ' || v_b.url_boleto || E'\n\n' ELSE '' END ||
        'Se ja pagou, desconsidera essa mensagem ;)' || E'\n\n' ||
        '_— Equipe Domus Garden_';
    ELSE
      -- Atrasado
      v_msg := 'Oi ' || split_part(COALESCE(v_b.morador_nome_full, v_b.morador_nome, 'querida'), ' ', 1) || '!' || E'\n\n' ||
        'Identifiquei aqui que o boleto de ' || to_char(v_b.mes_referencia, 'TMMonth/YYYY') ||
        ' (R$ ' || replace(to_char(v_b.valor, 'FM999G990D00'), '.', ',') ||
        ', vencido em ' || to_char(v_b.data_vencimento, 'DD/MM') || ') ainda esta em aberto.' || E'\n\n' ||
        'Se ja pagou, e so me mandar o comprovante que regularizo aqui!' || E'\n\n' ||
        CASE WHEN v_b.pix_copia_cola IS NOT NULL THEN
          'Se preferir pagar agora, segue o PIX:' || E'\n' || '`' || v_b.pix_copia_cola || '`' || E'\n\n' ELSE '' END ||
        'Se precisar combinar prazo ou parcelar, me avisa que damos um jeito juntas.' || E'\n\n' ||
        '_— Equipe Domus Garden_';
    END IF;

    -- Enfileira mensagem WhatsApp (usa a mesma fila do check-in/out)
    INSERT INTO public.mensagens_whatsapp_fila (reserva_id, momento, agendado_para, status, mensagem_montada, telefone_destino)
    VALUES (
      gen_random_uuid()::uuid,  -- placeholder: boletos nao tem reserva_id, mas precisamos atender FK
      'boleto_' || v_momento,
      now(),
      'pronto',  -- pula direto pra pronto pq ja temos a mensagem
      v_msg,
      v_b.morador_telefone
    )
    ON CONFLICT DO NOTHING;

    -- Atualiza ultimo lembrete
    UPDATE public.boletos_dominhas
       SET ultimo_lembrete_em = now(), total_lembretes = total_lembretes + 1
     WHERE id = v_b.id;

    v_total_lembretes := v_total_lembretes + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'data', CURRENT_DATE,
    'total_lembretes_enfileirados', v_total_lembretes,
    'vespera', v_total_vespera,
    'dia', v_total_dia,
    'atrasados', v_total_atraso
  );
END
$func$;

GRANT EXECUTE ON FUNCTION public.gerar_lembretes_boletos_dominhas() TO service_role, authenticated, anon;

-- 3. CRON: roda todo dia 9h da manha (BRT) = 12h UTC
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule('lembretes_boletos_dominhas_9h');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.schedule('lembretes_boletos_dominhas_9h', '0 12 * * *',
      $cron$ SELECT public.gerar_lembretes_boletos_dominhas(); $cron$);
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cron erro: %', SQLERRM; END $$;

SELECT 'OK Carteiro Dominhas pronto' AS status,
  (SELECT COUNT(*) FROM public.boletos_dominhas) AS boletos_cadastrados,
  (SELECT COUNT(*) FROM public.moradores) AS moradores_total;
