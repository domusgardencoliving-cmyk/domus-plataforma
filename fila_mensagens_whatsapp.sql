-- =========================================================
-- FILA DE MENSAGENS WHATSAPP AUTOMÁTICAS
-- Pré-pronta pra Meta WhatsApp Business API
--
-- Como funciona:
-- 1. Toda reserva nova/editada AGENDA mensagens na fila (pre_checkin, dia_checkin, pre_checkout, dia_checkout)
-- 2. Horários: dia_checkin às 14h (2h antes do check-in 16h)
--              dia_checkout às 10h (lembrete amigável)
--              pre_checkin às 14h do dia anterior (só se 2+ noites)
--              pre_checkout às 14h do dia anterior (só se 3+ noites)
-- 3. pg_cron roda a cada 5 min, pega itens com agendado_para <= now()
-- 4. Por enquanto SÓ MONTA a mensagem e marca como 'pronto'
-- 5. Quando Meta API estiver plugada, dispara via Edge Function e marca 'enviado'
-- =========================================================

-- 1. TABELA da fila
CREATE TABLE IF NOT EXISTS public.mensagens_whatsapp_fila (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reserva_id uuid NOT NULL REFERENCES public.reservas(id) ON DELETE CASCADE,
  momento text NOT NULL CHECK (momento IN ('pre_checkin','dia_checkin','pre_checkout','dia_checkout')),
  agendado_para timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pronto','enviado','erro','cancelado','nao_aplicavel')),
  mensagem_montada text,
  telefone_destino text,
  enviado_em timestamptz,
  meta_message_id text,
  erro_msg text,
  tentativas int DEFAULT 0,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now(),
  UNIQUE(reserva_id, momento)
);

CREATE INDEX IF NOT EXISTS idx_fila_status_agendado ON public.mensagens_whatsapp_fila (status, agendado_para);
CREATE INDEX IF NOT EXISTS idx_fila_reserva ON public.mensagens_whatsapp_fila (reserva_id);

-- 2. FUNÇÃO: agenda as 4 mensagens de uma reserva (idempotente — UPSERT)
CREATE OR REPLACE FUNCTION public.agendar_mensagens_reserva(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_r record;
  v_noites int;
  v_agendados jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_r FROM public.reservas WHERE id = p_reserva_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'erro', 'reserva nao encontrada');
  END IF;

  -- Cancelada / não contabilizar -> apaga da fila
  IF v_r.status = 'cancelada' OR COALESCE(v_r.nao_contabilizar, false) THEN
    DELETE FROM public.mensagens_whatsapp_fila WHERE reserva_id = p_reserva_id AND status = 'pendente';
    RETURN jsonb_build_object('success', true, 'acao', 'limpou_fila_cancelada');
  END IF;

  IF v_r.checkin IS NULL OR v_r.checkout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'erro', 'datas vazias');
  END IF;

  v_noites := (v_r.checkout - v_r.checkin)::int;

  -- DIA DO CHECK-IN: 14h (2h antes do check-in oficial 16h)
  -- timezone America/Sao_Paulo => UTC = 17:00
  INSERT INTO public.mensagens_whatsapp_fila (reserva_id, momento, agendado_para, status)
  VALUES (
    p_reserva_id,
    'dia_checkin',
    (v_r.checkin::timestamp + interval '14 hours') AT TIME ZONE 'America/Sao_Paulo',
    'pendente'
  )
  ON CONFLICT (reserva_id, momento) DO UPDATE SET
    agendado_para = EXCLUDED.agendado_para,
    status = CASE WHEN public.mensagens_whatsapp_fila.status IN ('enviado','erro') THEN public.mensagens_whatsapp_fila.status ELSE 'pendente' END,
    atualizado_em = now();
  v_agendados := v_agendados || jsonb_build_object('momento','dia_checkin','quando', v_r.checkin || ' 14:00 BRT');

  -- DIA DO CHECK-OUT: 10h
  INSERT INTO public.mensagens_whatsapp_fila (reserva_id, momento, agendado_para, status)
  VALUES (
    p_reserva_id,
    'dia_checkout',
    (v_r.checkout::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo',
    'pendente'
  )
  ON CONFLICT (reserva_id, momento) DO UPDATE SET
    agendado_para = EXCLUDED.agendado_para,
    status = CASE WHEN public.mensagens_whatsapp_fila.status IN ('enviado','erro') THEN public.mensagens_whatsapp_fila.status ELSE 'pendente' END,
    atualizado_em = now();
  v_agendados := v_agendados || jsonb_build_object('momento','dia_checkout','quando', v_r.checkout || ' 10:00 BRT');

  -- PRE_CHECKIN: dia anterior 14h, só se 2+ noites
  IF v_noites >= 2 THEN
    INSERT INTO public.mensagens_whatsapp_fila (reserva_id, momento, agendado_para, status)
    VALUES (
      p_reserva_id,
      'pre_checkin',
      ((v_r.checkin - 1)::timestamp + interval '14 hours') AT TIME ZONE 'America/Sao_Paulo',
      'pendente'
    )
    ON CONFLICT (reserva_id, momento) DO UPDATE SET
      agendado_para = EXCLUDED.agendado_para,
      status = CASE WHEN public.mensagens_whatsapp_fila.status IN ('enviado','erro') THEN public.mensagens_whatsapp_fila.status ELSE 'pendente' END,
      atualizado_em = now();
    v_agendados := v_agendados || jsonb_build_object('momento','pre_checkin','quando', (v_r.checkin - 1) || ' 14:00 BRT');
  ELSE
    DELETE FROM public.mensagens_whatsapp_fila WHERE reserva_id = p_reserva_id AND momento = 'pre_checkin' AND status = 'pendente';
  END IF;

  -- PRE_CHECKOUT: dia anterior 14h, só se 3+ noites
  IF v_noites >= 3 THEN
    INSERT INTO public.mensagens_whatsapp_fila (reserva_id, momento, agendado_para, status)
    VALUES (
      p_reserva_id,
      'pre_checkout',
      ((v_r.checkout - 1)::timestamp + interval '14 hours') AT TIME ZONE 'America/Sao_Paulo',
      'pendente'
    )
    ON CONFLICT (reserva_id, momento) DO UPDATE SET
      agendado_para = EXCLUDED.agendado_para,
      status = CASE WHEN public.mensagens_whatsapp_fila.status IN ('enviado','erro') THEN public.mensagens_whatsapp_fila.status ELSE 'pendente' END,
      atualizado_em = now();
    v_agendados := v_agendados || jsonb_build_object('momento','pre_checkout','quando', (v_r.checkout - 1) || ' 14:00 BRT');
  ELSE
    DELETE FROM public.mensagens_whatsapp_fila WHERE reserva_id = p_reserva_id AND momento = 'pre_checkout' AND status = 'pendente';
  END IF;

  RETURN jsonb_build_object('success', true, 'noites', v_noites, 'agendados', v_agendados);
END
$func$;

GRANT EXECUTE ON FUNCTION public.agendar_mensagens_reserva(uuid) TO service_role, authenticated, anon;

-- 3. TRIGGER: agenda automaticamente em INSERT/UPDATE de reservas
CREATE OR REPLACE FUNCTION public.fn_trigger_agendar_mensagens()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  PERFORM public.agendar_mensagens_reserva(NEW.id);
  RETURN NEW;
END
$func$;

DROP TRIGGER IF EXISTS trg_agendar_mensagens ON public.reservas;
CREATE TRIGGER trg_agendar_mensagens
  AFTER INSERT OR UPDATE OF checkin, checkout, status, nao_contabilizar
  ON public.reservas
  FOR EACH ROW EXECUTE FUNCTION public.fn_trigger_agendar_mensagens();

-- 4. PROCESSADOR DA FILA — pega itens prontos pra processar
-- Por enquanto: só monta a mensagem e marca 'pronto' (até Meta API plugar)
CREATE OR REPLACE FUNCTION public.processar_fila_mensagens(p_limite int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_item record;
  v_msg jsonb;
  v_processados int := 0;
  v_aplicaveis int := 0;
  v_nao_aplicaveis int := 0;
  v_erros int := 0;
BEGIN
  FOR v_item IN
    SELECT f.id, f.reserva_id, f.momento, r.hospede_contato
      FROM public.mensagens_whatsapp_fila f
      JOIN public.reservas r ON r.id = f.reserva_id
     WHERE f.status = 'pendente'
       AND f.agendado_para <= now()
       AND r.status != 'cancelada'
       AND COALESCE(r.nao_contabilizar, false) = false
     ORDER BY f.agendado_para ASC
     LIMIT p_limite
  LOOP
    BEGIN
      v_msg := public.montar_mensagem_checkin(v_item.reserva_id, v_item.momento);

      IF (v_msg->>'success')::boolean = false THEN
        UPDATE public.mensagens_whatsapp_fila
           SET status = 'erro',
               erro_msg = v_msg->>'error',
               tentativas = tentativas + 1,
               atualizado_em = now()
         WHERE id = v_item.id;
        v_erros := v_erros + 1;
      ELSIF COALESCE((v_msg->>'aplicavel')::boolean, true) = false THEN
        UPDATE public.mensagens_whatsapp_fila
           SET status = 'nao_aplicavel',
               erro_msg = v_msg->>'motivo',
               atualizado_em = now()
         WHERE id = v_item.id;
        v_nao_aplicaveis := v_nao_aplicaveis + 1;
      ELSE
        UPDATE public.mensagens_whatsapp_fila
           SET status = 'pronto',
               mensagem_montada = v_msg->>'mensagem',
               telefone_destino = v_item.hospede_contato,
               atualizado_em = now()
         WHERE id = v_item.id;
        v_aplicaveis := v_aplicaveis + 1;
      END IF;

      v_processados := v_processados + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.mensagens_whatsapp_fila
         SET status = 'erro',
             erro_msg = SQLERRM,
             tentativas = tentativas + 1,
             atualizado_em = now()
       WHERE id = v_item.id;
      v_erros := v_erros + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processados', v_processados,
    'prontos_para_enviar', v_aplicaveis,
    'nao_aplicaveis', v_nao_aplicaveis,
    'erros', v_erros
  );
END
$func$;

GRANT EXECUTE ON FUNCTION public.processar_fila_mensagens(int) TO service_role, authenticated, anon;

-- 5. CRON: a cada 5 minutos processa a fila
-- (precisa pg_cron habilitado — Supabase tem por padrão)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('processar_fila_mensagens_5min');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'processar_fila_mensagens_5min',
      '*/5 * * * *',
      $cron$ SELECT public.processar_fila_mensagens(100); $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron nao disponivel ou erro: %', SQLERRM;
END $$;

-- 6. BACKFILL: agenda mensagens pra reservas futuras existentes
DO $$
DECLARE
  v_r record;
  v_count int := 0;
BEGIN
  FOR v_r IN
    SELECT id FROM public.reservas
     WHERE checkin >= CURRENT_DATE
       AND COALESCE(status,'') != 'cancelada'
       AND COALESCE(nao_contabilizar, false) = false
     ORDER BY checkin ASC
  LOOP
    PERFORM public.agendar_mensagens_reserva(v_r.id);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Agendadas mensagens para % reservas futuras', v_count;
END $$;

-- 7. RESULTADO
SELECT 'OK - fila de mensagens automaticas ativa' AS status,
  jsonb_build_object(
    'total_fila', (SELECT COUNT(*) FROM public.mensagens_whatsapp_fila),
    'pendentes', (SELECT COUNT(*) FROM public.mensagens_whatsapp_fila WHERE status='pendente'),
    'prontas', (SELECT COUNT(*) FROM public.mensagens_whatsapp_fila WHERE status='pronto'),
    'nao_aplicaveis', (SELECT COUNT(*) FROM public.mensagens_whatsapp_fila WHERE status='nao_aplicavel'),
    'cron_proxima_execucao', '*/5 * * * * (a cada 5 min)',
    'horarios', jsonb_build_object(
      'dia_checkin', '14:00 BRT (2h antes do check-in)',
      'dia_checkout', '10:00 BRT',
      'pre_checkin', '14:00 BRT do dia anterior (so se 2+ noites)',
      'pre_checkout', '14:00 BRT do dia anterior (so se 3+ noites)'
    )
  ) AS detalhes;
