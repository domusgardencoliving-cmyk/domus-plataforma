-- =========================================================
-- AUDITORIA SYNC HOSPEDIN COMPLETO
--
-- Tabela de log + cron 1min que dispara Edge Function de sync FULL
-- + função pra dashboard mostrar status em tempo real
-- =========================================================

-- 1. TABELA DE LOG
CREATE TABLE IF NOT EXISTS public.auditoria_sync_hospedin (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rodou_em    timestamptz NOT NULL DEFAULT now(),
  duracao_ms  int,
  stats       jsonb,
  acoes       jsonb,
  erros       jsonb
);

CREATE INDEX IF NOT EXISTS idx_audsync_rodou_em ON public.auditoria_sync_hospedin (rodou_em DESC);

ALTER TABLE public.auditoria_sync_hospedin ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='auditoria_sync_hospedin' AND policyname='all_anon') THEN
    EXECUTE 'CREATE POLICY all_anon ON public.auditoria_sync_hospedin FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- 2. STATUS PRO DASHBOARD: última execução + últimas ações + saúde
CREATE OR REPLACE VIEW public.v_status_sync_hospedin AS
SELECT
  (SELECT rodou_em FROM auditoria_sync_hospedin ORDER BY rodou_em DESC LIMIT 1) AS ultima_sync,
  (SELECT EXTRACT(EPOCH FROM (now() - rodou_em))::int FROM auditoria_sync_hospedin ORDER BY rodou_em DESC LIMIT 1) AS segundos_desde_ultima,
  (SELECT (stats->>'criadas')::int FROM auditoria_sync_hospedin ORDER BY rodou_em DESC LIMIT 1) AS ultima_criadas,
  (SELECT (stats->>'atualizadas')::int FROM auditoria_sync_hospedin ORDER BY rodou_em DESC LIMIT 1) AS ultima_atualizadas,
  (SELECT (stats->>'erros')::int FROM auditoria_sync_hospedin ORDER BY rodou_em DESC LIMIT 1) AS ultima_erros,
  (SELECT (stats->>'total_hospedin')::int FROM auditoria_sync_hospedin ORDER BY rodou_em DESC LIMIT 1) AS total_reservas_hospedin,
  (SELECT SUM((stats->>'criadas')::int) FROM auditoria_sync_hospedin WHERE rodou_em > now() - interval '24 hours') AS criadas_24h,
  (SELECT SUM((stats->>'atualizadas')::int) FROM auditoria_sync_hospedin WHERE rodou_em > now() - interval '24 hours') AS atualizadas_24h,
  (SELECT SUM((stats->>'erros')::int) FROM auditoria_sync_hospedin WHERE rodou_em > now() - interval '24 hours') AS erros_24h;

GRANT SELECT ON public.v_status_sync_hospedin TO anon, authenticated, service_role;

-- 3. CRON 1min — substitui o antigo sync-hospedin-reservas
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    -- desschedula o antigo (que só pegava novas)
    PERFORM cron.unschedule('sync-hospedin-reservas');

    -- agenda o novo (sync COMPLETO 1min)
    PERFORM cron.unschedule('sync-completo-hospedin-pull');
    PERFORM cron.schedule(
      'sync-completo-hospedin-pull',
      '* * * * *',  -- 1min
      $cron$
        SELECT net.http_post(
          url := 'https://motwhfbpundrhvuwjntw.supabase.co/functions/v1/sync-completo-hospedin-pull',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb
        );
      $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cron erro: %', SQLERRM; END $$;

-- 4. RESULTADO
SELECT 'OK auditoria sync Hospedin pronta' AS status,
       (SELECT COUNT(*) FROM auditoria_sync_hospedin) AS logs_existentes,
       (SELECT * FROM public.v_status_sync_hospedin) AS status_atual;
