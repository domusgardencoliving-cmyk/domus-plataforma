-- =========================================================
-- FOLLOW-UP CARRINHO ABANDONADO
--
-- Pessoas que iniciaram pre_reserva no DG mas não pagaram.
-- Após 2h sem pagamento → enviar mensagem WhatsApp + email gentil:
-- "vimos que você começou uma reserva e não finalizou, podemos ajudar?"
-- Após 24h → segunda mensagem com cupom de R$ 10 desconto
-- Após 72h → arquivar (status carrinho_abandonado_arquivado)
-- =========================================================

-- 1. Marcar reservas em pre_reserva (não pagas) com timestamp de criação pra rastrear
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS followup_carrinho_status text DEFAULT 'nenhum'
    CHECK (followup_carrinho_status IN ('nenhum','primeiro_aviso','segundo_aviso_cupom','arquivado','convertida'));

CREATE INDEX IF NOT EXISTS idx_followup_carrinho ON public.reservas (followup_carrinho_status, criado_em)
  WHERE status IN ('em_espera','pre_reserva') AND followup_carrinho_status != 'arquivado';

-- 2. Funcao que detecta carrinho abandonado e enfileira mensagem
CREATE OR REPLACE FUNCTION public.processar_carrinho_abandonado()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_r record;
  v_msg text;
  v_horas_desde_criacao numeric;
  v_total_avisados int := 0;
  v_total_cupons int := 0;
  v_total_arquivados int := 0;
  v_cupom_codigo text;
BEGIN
  FOR v_r IN
    SELECT id, hospede_nome, hospede_contato, checkin, checkout, valor_total, criado_em,
           cama, followup_carrinho_status
      FROM public.reservas
     WHERE status IN ('em_espera','pre_reserva')
       AND COALESCE(nao_contabilizar, false) = false
       AND COALESCE(followup_carrinho_status, 'nenhum') != 'arquivado'
       AND checkin >= CURRENT_DATE
       AND criado_em > now() - INTERVAL '7 days'
       AND hospede_contato IS NOT NULL
  LOOP
    v_horas_desde_criacao := EXTRACT(EPOCH FROM (now() - v_r.criado_em)) / 3600;

    -- 1º aviso após 2h
    IF v_r.followup_carrinho_status = 'nenhum' AND v_horas_desde_criacao >= 2 THEN
      v_msg := 'Oi ' || split_part(COALESCE(v_r.hospede_nome, 'querido(a)'), ' ', 1) || '!' || E'\n\n'
        || 'Vi que voce comecou uma reserva na Domus pra ' || to_char(v_r.checkin, 'DD/MM') ||
           ' e nao finalizou ainda.' || E'\n\n'
        || 'Posso te ajudar com algo? Se ficou alguma duvida sobre o quarto, pagamento ou algo, e so responder essa mensagem.' || E'\n\n'
        || 'Pra finalizar, e so voltar em domusgardencoliving.com/reservar' || E'\n\n'
        || 'Te aguardamos!' || E'\n\n_— Equipe Domus Garden_';

      INSERT INTO public.mensagens_whatsapp_fila (reserva_id, momento, agendado_para, status, mensagem_montada, telefone_destino)
      VALUES (v_r.id, 'carrinho_2h_' || v_r.id::text, now(), 'pronto', v_msg, v_r.hospede_contato)
      ON CONFLICT DO NOTHING;

      UPDATE public.reservas SET followup_carrinho_status = 'primeiro_aviso' WHERE id = v_r.id;
      v_total_avisados := v_total_avisados + 1;

    -- 2º aviso após 24h com cupom
    ELSIF v_r.followup_carrinho_status = 'primeiro_aviso' AND v_horas_desde_criacao >= 24 THEN
      -- gera codigo de cupom unico (primeiros 4 caracteres do nome + 4 chars random)
      v_cupom_codigo := UPPER(SUBSTRING(REGEXP_REPLACE(COALESCE(v_r.hospede_nome,'gabi'),'[^A-Za-z]','','g'), 1, 4))
                       || '-' || UPPER(SUBSTRING(MD5(v_r.id::text), 1, 4));

      -- Cria cupom de R$ 10 desconto, validade 48h
      INSERT INTO public.cupons (codigo, desconto_tipo, desconto_valor, validade_inicio, validade_fim, max_usos, ativo, observacao)
      VALUES (v_cupom_codigo, 'fixo', 10.00, now(), now() + INTERVAL '48 hours', 1, true,
              'Carrinho abandonado: ' || COALESCE(v_r.hospede_nome,'?') || ' (reserva ' || v_r.id || ')')
      ON CONFLICT (codigo) DO NOTHING;

      v_msg := 'Oi ' || split_part(COALESCE(v_r.hospede_nome, 'querido(a)'), ' ', 1) || '!' || E'\n\n'
        || 'Pra te ajudar a confirmar essa reserva, separei um cupom de *R$ 10 OFF* exclusivo pra voce, valido por 48h:' || E'\n\n'
        || '*Cupom:* ' || v_cupom_codigo || E'\n\n'
        || 'E so voltar em domusgardencoliving.com/reservar e usar no checkout.' || E'\n\n'
        || 'Qualquer duvida me chama por aqui mesmo!' || E'\n\n_— Equipe Domus Garden_';

      INSERT INTO public.mensagens_whatsapp_fila (reserva_id, momento, agendado_para, status, mensagem_montada, telefone_destino)
      VALUES (v_r.id, 'carrinho_24h_cupom_' || v_r.id::text, now(), 'pronto', v_msg, v_r.hospede_contato)
      ON CONFLICT DO NOTHING;

      UPDATE public.reservas SET followup_carrinho_status = 'segundo_aviso_cupom' WHERE id = v_r.id;
      v_total_cupons := v_total_cupons + 1;

    -- Arquivar após 72h
    ELSIF v_horas_desde_criacao >= 72 AND v_r.followup_carrinho_status = 'segundo_aviso_cupom' THEN
      UPDATE public.reservas SET followup_carrinho_status = 'arquivado' WHERE id = v_r.id;
      v_total_arquivados := v_total_arquivados + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'avisos_2h', v_total_avisados,
    'cupons_24h', v_total_cupons,
    'arquivados_72h', v_total_arquivados
  );
END
$func$;
GRANT EXECUTE ON FUNCTION public.processar_carrinho_abandonado() TO service_role, authenticated, anon;

-- 3. Cron a cada 30 min
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule('carrinho_abandonado_30min');
    PERFORM cron.schedule('carrinho_abandonado_30min', '*/30 * * * *',
      $cron$ SELECT public.processar_carrinho_abandonado(); $cron$);
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cron erro: %', SQLERRM; END $$;

SELECT 'OK Follow-up carrinho abandonado pronto' AS status;
