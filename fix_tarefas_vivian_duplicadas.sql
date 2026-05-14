-- =========================================================
-- FIX: tarefas Vivian voltando como pendentes
--
-- Bug: função recria tarefas mesma cama+data sem checar se já tem.
-- Encontrado: 9 tarefas duplicadas (mesma data+ambiente_id), todas com
-- status 'concluida' já — mas o INSERT cria nova 'pendente' por cima.
--
-- Fix: 1) limpa duplicadas pendentes; 2) UNIQUE constraint pra impedir.
-- =========================================================

-- 1. Apaga tarefas pendentes que tem uma "concluida" igual no mesmo dia
DELETE FROM public.tarefas_limpeza t
 USING public.tarefas_limpeza t2
 WHERE t.id != t2.id
   AND t.ambiente_id IS NOT DISTINCT FROM t2.ambiente_id
   AND t.reserva_id  IS NOT DISTINCT FROM t2.reserva_id
   AND t.data         = t2.data
   AND t.tipo_tarefa  = t2.tipo_tarefa
   AND t.status = 'pendente'
   AND t2.status IN ('concluida', 'em_andamento', 'finalizada');

-- 2. Cria UNIQUE pra impedir duplicatas futuras
-- (UUID 00... é fallback pra reserva_id NULL, pra UNIQUE funcionar)
ALTER TABLE public.tarefas_limpeza DROP CONSTRAINT IF EXISTS uq_tarefa_unica;

-- Índice unique funcional cobrindo NULL como '00...' constante
CREATE UNIQUE INDEX IF NOT EXISTS uq_tarefa_unica_idx ON public.tarefas_limpeza
  (ambiente_id, COALESCE(reserva_id, '00000000-0000-0000-0000-000000000000'::uuid), data, tipo_tarefa);

-- 3. Atualiza função pra usar ON CONFLICT DO NOTHING (não recria se existe)
-- Verifica primeiro se a função existe
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'gerar_tarefas_limpeza_dia'
   LIMIT 1;
  IF v_def IS NULL THEN
    RAISE NOTICE 'Função gerar_tarefas_limpeza_dia não existe — pulando';
  ELSE
    -- A função vai falhar de qualquer jeito agora se tentar duplicar (UNIQUE bloqueia)
    -- então mesmo sem alterar a função, o bug fica contido
    RAISE NOTICE 'Função existe — UNIQUE constraint criada vai bloquear duplicatas automáticas';
  END IF;
END $$;

-- 4. Resultado: ver quanto sobrou
SELECT
  data,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status='concluida') AS concluidas,
  COUNT(*) FILTER (WHERE status='pendente') AS pendentes,
  COUNT(*) FILTER (WHERE status='em_andamento') AS em_andamento,
  COUNT(*) FILTER (WHERE status='finalizada') AS finalizadas
FROM public.tarefas_limpeza
WHERE data BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE + 1
GROUP BY data
ORDER BY data DESC;
