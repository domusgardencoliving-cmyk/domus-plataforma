-- =========================================================
-- Sync Hospedin: colunas + cron processador + RLS
-- =========================================================

-- 1. Colunas pra rastrear sync na tabela reservas
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS status_sync_hospedin text DEFAULT 'pendente'
    CHECK (status_sync_hospedin IN ('pendente','sincronizada','erro','nao_aplicavel','desabilitada')),
  ADD COLUMN IF NOT EXISTS ultima_sync_hospedin timestamptz,
  ADD COLUMN IF NOT EXISTS erro_sync_hospedin text,
  ADD COLUMN IF NOT EXISTS hospedin_id text;

CREATE INDEX IF NOT EXISTS idx_reservas_sync_status ON public.reservas (status_sync_hospedin)
  WHERE status_sync_hospedin = 'pendente';
CREATE INDEX IF NOT EXISTS idx_reservas_hospedin_id ON public.reservas (hospedin_id) WHERE hospedin_id IS NOT NULL;

-- 2. Marcar como nao_aplicavel reservas que ja vieram da Hospedin (canais OTAs)
UPDATE public.reservas
   SET status_sync_hospedin = 'nao_aplicavel'
 WHERE canal_codigo IN ('booking','airbnb','expedia','hostelworld','BO','AI','AR','HO','hospedin')
   AND status_sync_hospedin = 'pendente';

-- 3. Marcar como sincronizada reservas que ja tem hospedin_id (vieram do PMS antigo)
UPDATE public.reservas
   SET status_sync_hospedin = 'sincronizada',
       ultima_sync_hospedin = COALESCE(ultima_sync_hospedin, now())
 WHERE hospedin_id IS NOT NULL AND status_sync_hospedin = 'pendente';

-- 4. Funcao helper que retorna stats do sync (pro PMS mostrar)
CREATE OR REPLACE FUNCTION public.stats_sync_hospedin()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'sincronizadas', COUNT(*) FILTER (WHERE status_sync_hospedin = 'sincronizada'),
    'pendentes', COUNT(*) FILTER (WHERE status_sync_hospedin = 'pendente'),
    'erros', COUNT(*) FILTER (WHERE status_sync_hospedin = 'erro'),
    'nao_aplicaveis', COUNT(*) FILTER (WHERE status_sync_hospedin = 'nao_aplicavel'),
    'total', COUNT(*),
    'ultima_sync_geral', MAX(ultima_sync_hospedin)
  )
  FROM public.reservas
  WHERE status != 'cancelada' AND COALESCE(nao_contabilizar, false) = false
    AND checkin >= CURRENT_DATE - INTERVAL '90 days';
$$;
GRANT EXECUTE ON FUNCTION public.stats_sync_hospedin() TO anon, authenticated, service_role;

-- 5. Cron pra rodar Edge Function de sync a cada 5 min (precisa pg_net habilitado)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    PERFORM cron.unschedule('sync_reserva_hospedin_5min');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
-- Nota: o cron real precisa de pg_net + URL da Edge Function. Por enquanto chama manualmente.

SELECT 'OK colunas sync criadas' AS status,
  public.stats_sync_hospedin() AS stats_atuais;
