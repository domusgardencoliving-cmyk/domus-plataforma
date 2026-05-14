-- =========================================================
-- BACKUP DIÁRIO AUTOMÁTICO (todo dia 3h da manhã)
--
-- O que faz:
-- 1. Cria tabela `backups_diarios` que guarda snapshots em JSONB
-- 2. Função `gerar_backup_diario()` que dumpa as tabelas críticas
-- 3. Função `purgar_backups_antigos()` que mantém só últimos 30 dias (economia espaço)
-- 4. pg_cron agenda diariamente às 3h (BRT = 6h UTC)
-- 5. Cada backup retorna estatísticas + alerta se algo mudou drasticamente
-- =========================================================

-- 1. TABELA de backups
CREATE TABLE IF NOT EXISTS public.backups_diarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_backup date NOT NULL DEFAULT CURRENT_DATE,
  hora_backup timestamptz NOT NULL DEFAULT now(),
  tabela text NOT NULL,
  total_linhas int NOT NULL,
  conteudo_jsonb jsonb,
  tamanho_kb numeric,
  hash_sha256 text,
  UNIQUE(data_backup, tabela)
);

CREATE INDEX IF NOT EXISTS idx_backups_data ON public.backups_diarios (data_backup DESC, tabela);

-- 2. FUNÇÃO principal de backup
CREATE OR REPLACE FUNCTION public.gerar_backup_diario()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_tabelas text[] := ARRAY[
    'reservas', 'hospedes', 'lancamentos', 'cupons',
    'moradores', 'tarefas_limpeza', 'ambientes',
    'mensagens_whatsapp_fila', 'divergencias_resolvidas', 'notificacoes_gabi',
    'lista_espera', 'cleaners', 'admins'
  ];
  v_tabela text;
  v_count int;
  v_data jsonb;
  v_resumo jsonb := '[]'::jsonb;
  v_total_linhas int := 0;
  v_alertas jsonb := '[]'::jsonb;
  v_count_ontem int;
  v_diff int;
BEGIN
  FOREACH v_tabela IN ARRAY v_tabelas LOOP
    BEGIN
      -- Pega contagem
      EXECUTE format('SELECT COUNT(*) FROM public.%I', v_tabela) INTO v_count;

      -- Pega tudo como JSONB
      EXECUTE format('SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM public.%I t', v_tabela) INTO v_data;

      -- Compara com ontem (alerta se variação >20%)
      SELECT total_linhas INTO v_count_ontem
        FROM public.backups_diarios
       WHERE tabela = v_tabela AND data_backup = CURRENT_DATE - 1
       LIMIT 1;

      IF v_count_ontem IS NOT NULL THEN
        v_diff := v_count - v_count_ontem;
        IF ABS(v_diff) > GREATEST(10, v_count_ontem * 0.2) THEN
          v_alertas := v_alertas || jsonb_build_object(
            'tabela', v_tabela,
            'ontem', v_count_ontem,
            'hoje', v_count,
            'diferenca', v_diff,
            'severidade', CASE WHEN v_diff < 0 THEN 'critico_perda_dados' ELSE 'atencao' END
          );
        END IF;
      END IF;

      -- Insere backup (substitui se já tiver de hoje)
      INSERT INTO public.backups_diarios (data_backup, tabela, total_linhas, conteudo_jsonb, tamanho_kb, hash_sha256)
      VALUES (
        CURRENT_DATE, v_tabela, v_count, v_data,
        ROUND((octet_length(v_data::text)::numeric / 1024.0), 2),
        encode(sha256(v_data::text::bytea), 'hex')
      )
      ON CONFLICT (data_backup, tabela) DO UPDATE SET
        hora_backup = now(),
        total_linhas = EXCLUDED.total_linhas,
        conteudo_jsonb = EXCLUDED.conteudo_jsonb,
        tamanho_kb = EXCLUDED.tamanho_kb,
        hash_sha256 = EXCLUDED.hash_sha256;

      v_total_linhas := v_total_linhas + v_count;
      v_resumo := v_resumo || jsonb_build_object('tabela', v_tabela, 'linhas', v_count);
    EXCEPTION WHEN OTHERS THEN
      v_resumo := v_resumo || jsonb_build_object('tabela', v_tabela, 'erro', SQLERRM);
    END;
  END LOOP;

  -- Se tem alertas, registrar pra Gabi
  IF jsonb_array_length(v_alertas) > 0 THEN
    BEGIN
      INSERT INTO public.notificacoes_gabi (tipo, titulo, conteudo, metadados)
      VALUES (
        'backup_alerta',
        'Backup diario detectou variacao incomum',
        'Algumas tabelas mudaram +20% ontem -> hoje. Verifique se nao houve perda de dados.',
        jsonb_build_object('alertas', v_alertas, 'data', CURRENT_DATE)
      );
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'data', CURRENT_DATE,
    'total_tabelas', array_length(v_tabelas, 1),
    'total_linhas', v_total_linhas,
    'alertas', v_alertas,
    'resumo', v_resumo
  );
END
$func$;

GRANT EXECUTE ON FUNCTION public.gerar_backup_diario() TO service_role, authenticated;

-- 3. FUNÇÃO de purga (mantém só últimos 30 dias)
CREATE OR REPLACE FUNCTION public.purgar_backups_antigos()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_deletados int;
BEGIN
  DELETE FROM public.backups_diarios
   WHERE data_backup < CURRENT_DATE - INTERVAL '30 days';
  GET DIAGNOSTICS v_deletados = ROW_COUNT;
  RETURN v_deletados;
END
$func$;

GRANT EXECUTE ON FUNCTION public.purgar_backups_antigos() TO service_role, authenticated;

-- 4. CRON: todo dia 3h da manhã (BRT) = 6h UTC
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('backup_diario_3h');
    PERFORM cron.unschedule('purgar_backups_4h');
  END IF;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('backup_diario_3h', '0 6 * * *', $cron$ SELECT public.gerar_backup_diario(); $cron$);
    PERFORM cron.schedule('purgar_backups_4h', '0 7 * * *', $cron$ SELECT public.purgar_backups_antigos(); $cron$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron nao disponivel: %', SQLERRM;
END $$;

-- 5. RLS pra Gabi conseguir ver histórico no PMS
ALTER TABLE public.backups_diarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backups_admin_read ON public.backups_diarios;
CREATE POLICY backups_admin_read ON public.backups_diarios
  FOR SELECT TO anon, authenticated USING (true);

-- 6. Roda PRIMEIRO BACKUP AGORA pra começar o histórico
SELECT public.gerar_backup_diario() AS primeiro_backup;
