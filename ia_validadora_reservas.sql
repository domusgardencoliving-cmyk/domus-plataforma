/**
 * IA VALIDADORA DE RESERVAS
 *
 * Idéia da Gabi: cada reserva nova deveria ser validada automaticamente
 * pra garantir que tem nome, telefone, datas coerentes, etc. Se algo
 * estiver torto, a reserva entra numa lista "Precisa de atenção" no PMS.
 *
 * O que faz:
 * 1. Adiciona 2 colunas em reservas: validacao_status, validacao_problemas
 * 2. Cria função validar_reserva(uuid) que retorna lista de problemas
 * 3. Cria trigger que roda validação automaticamente em INSERT/UPDATE
 * 4. Faz backfill em todas as reservas existentes
 *
 * Como rodar: cole no SQL Editor do Supabase e Run.
 */

-- =========================================================
-- 1. ADICIONAR COLUNAS
-- =========================================================
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS validacao_status text DEFAULT 'nao_validada',
  ADD COLUMN IF NOT EXISTS validacao_problemas jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS validacao_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_reservas_validacao_status ON public.reservas (validacao_status);

-- =========================================================
-- 2. FUNÇÃO PRINCIPAL — analisa 1 reserva e retorna jsonb com problemas
-- =========================================================
CREATE OR REPLACE FUNCTION public.validar_reserva_jsonb(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_r record;
  v_probs jsonb := '[]'::jsonb;
  v_status text := 'ok';
  v_critico_count int := 0;
  v_atencao_count int := 0;
BEGIN
  SELECT * INTO v_r FROM public.reservas WHERE id = p_reserva_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','erro','problemas',jsonb_build_array(jsonb_build_object('campo','id','msg','Reserva não existe','severidade','critico')));
  END IF;

  -- Cancelada não precisa validar
  IF v_r.status = 'cancelada' OR COALESCE(v_r.nao_contabilizar, false) THEN
    RETURN jsonb_build_object('status','ignorada','problemas','[]'::jsonb);
  END IF;

  -- (1) Nome do hóspede vazio ou genérico
  IF v_r.hospede_nome IS NULL OR LENGTH(TRIM(v_r.hospede_nome)) < 3 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_nome','msg','Nome vazio ou muito curto','severidade','critico');
    v_critico_count := v_critico_count + 1;
  ELSIF v_r.hospede_nome ~* '^(hospede|hóspede|h[oó]spede)\s+(outro|direto|booking|airbnb|pre[\s-]?reserva)' THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_nome','msg','Nome genérico ("'||v_r.hospede_nome||'") — precisa do nome real','severidade','atencao');
    v_atencao_count := v_atencao_count + 1;
  END IF;

  -- (2) Telefone do hóspede
  IF v_r.hospede_contato IS NULL OR LENGTH(TRIM(v_r.hospede_contato)) = 0 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Sem telefone — não dá pra mandar mensagem WhatsApp','severidade','critico');
    v_critico_count := v_critico_count + 1;
  ELSIF v_r.hospede_contato LIKE '%@%' THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Tem e-mail no lugar de telefone','severidade','critico');
    v_critico_count := v_critico_count + 1;
  ELSIF LENGTH(REGEXP_REPLACE(v_r.hospede_contato, '\D', '', 'g')) < 10 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Telefone curto demais ('||v_r.hospede_contato||') — provavelmente errado','severidade','critico');
    v_critico_count := v_critico_count + 1;
  ELSIF LENGTH(REGEXP_REPLACE(v_r.hospede_contato, '\D', '', 'g')) > 15 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Telefone longo demais — formato suspeito','severidade','atencao');
    v_atencao_count := v_atencao_count + 1;
  END IF;

  -- (3) Datas coerentes
  IF v_r.checkin IS NULL OR v_r.checkout IS NULL THEN
    v_probs := v_probs || jsonb_build_object('campo','datas','msg','Check-in ou check-out vazios','severidade','critico');
    v_critico_count := v_critico_count + 1;
  ELSIF v_r.checkin >= v_r.checkout THEN
    v_probs := v_probs || jsonb_build_object('campo','datas','msg','Check-in >= Check-out — datas invertidas','severidade','critico');
    v_critico_count := v_critico_count + 1;
  END IF;

  -- (4) Quarto/Cama vazio
  IF (v_r.cama IS NULL OR LENGTH(TRIM(v_r.cama)) = 0) AND (v_r.quarto IS NULL OR LENGTH(TRIM(v_r.quarto)) = 0) THEN
    v_probs := v_probs || jsonb_build_object('campo','cama','msg','Sem quarto/cama atribuído','severidade','critico');
    v_critico_count := v_critico_count + 1;
  END IF;

  -- (5) Valor total
  IF v_r.valor_total IS NULL OR v_r.valor_total <= 0 THEN
    v_probs := v_probs || jsonb_build_object('campo','valor_total','msg','Valor total zerado — verifique','severidade','atencao');
    v_atencao_count := v_atencao_count + 1;
  END IF;

  -- (6) [removido — tabela reservas não tem hospede_email separado]

  -- Status final
  IF v_critico_count > 0 THEN v_status := 'critico';
  ELSIF v_atencao_count > 0 THEN v_status := 'atencao';
  ELSE v_status := 'ok';
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'problemas', v_probs,
    'criticos', v_critico_count,
    'atencao', v_atencao_count
  );
END$$;

GRANT EXECUTE ON FUNCTION public.validar_reserva_jsonb(uuid) TO service_role, anon, authenticated;

-- =========================================================
-- 3. FUNÇÃO TRIGGER — chamada automaticamente em INSERT/UPDATE
-- =========================================================
CREATE OR REPLACE FUNCTION public.fn_trigger_validar_reserva()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_resultado jsonb;
BEGIN
  -- Não valida em UPDATE da própria coluna (evita loop)
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status
     AND OLD.hospede_nome IS NOT DISTINCT FROM NEW.hospede_nome
     AND OLD.hospede_contato IS NOT DISTINCT FROM NEW.hospede_contato
     AND OLD.checkin = NEW.checkin
     AND OLD.checkout = NEW.checkout
     AND OLD.cama IS NOT DISTINCT FROM NEW.cama
     AND OLD.valor_total IS NOT DISTINCT FROM NEW.valor_total THEN
    RETURN NEW;  -- nada importante mudou
  END IF;

  v_resultado := public.validar_reserva_jsonb(NEW.id);
  NEW.validacao_status := v_resultado->>'status';
  NEW.validacao_problemas := v_resultado->'problemas';
  NEW.validacao_em := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_validar_reserva ON public.reservas;
CREATE TRIGGER trg_validar_reserva
  BEFORE INSERT OR UPDATE ON public.reservas
  FOR EACH ROW EXECUTE FUNCTION public.fn_trigger_validar_reserva();

-- =========================================================
-- 4. BACKFILL — valida todas as reservas existentes
-- =========================================================
DO $$
DECLARE
  v_r record;
  v_count int := 0;
  v_critico int := 0;
  v_atencao int := 0;
  v_ok int := 0;
  v_resultado jsonb;
BEGIN
  FOR v_r IN SELECT id FROM public.reservas WHERE COALESCE(status,'') != 'cancelada' AND COALESCE(nao_contabilizar,false) = false LOOP
    v_resultado := public.validar_reserva_jsonb(v_r.id);
    UPDATE public.reservas SET
      validacao_status = v_resultado->>'status',
      validacao_problemas = v_resultado->'problemas',
      validacao_em = now()
    WHERE id = v_r.id;
    v_count := v_count + 1;
    IF v_resultado->>'status' = 'critico' THEN v_critico := v_critico + 1;
    ELSIF v_resultado->>'status' = 'atencao' THEN v_atencao := v_atencao + 1;
    ELSE v_ok := v_ok + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'Validadas % reservas — % criticas, % atencao, % ok', v_count, v_critico, v_atencao, v_ok;
END$$;

-- =========================================================
-- RESULTADO
-- =========================================================
SELECT 'OK - IA validadora ativa' AS status,
       jsonb_build_object(
         'colunas_criadas', ARRAY['validacao_status','validacao_problemas','validacao_em'],
         'funcoes', ARRAY['validar_reserva_jsonb','fn_trigger_validar_reserva'],
         'trigger', 'trg_validar_reserva (BEFORE INSERT OR UPDATE)',
         'distribuicao_atual', (
           SELECT jsonb_object_agg(validacao_status, contagem)
           FROM (SELECT validacao_status, COUNT(*) as contagem FROM public.reservas
                 WHERE COALESCE(status,'') != 'cancelada' GROUP BY validacao_status) sub
         )
       ) AS detalhes;
                                                                                                                                                                                                                                                                                                                 