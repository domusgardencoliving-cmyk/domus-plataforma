/**
 * IA VALIDADORA DE RESERVAS — V2 simplificada
 * Versão com regex mais simples e sem caracteres especiais que estavam dando erro.
 */

-- 1. ADICIONAR COLUNAS
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS validacao_status text DEFAULT 'nao_validada',
  ADD COLUMN IF NOT EXISTS validacao_problemas jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS validacao_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_reservas_validacao_status ON public.reservas (validacao_status);

-- 2. FUNCAO DE VALIDACAO (sem regex complexo)
CREATE OR REPLACE FUNCTION public.validar_reserva_jsonb(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $func$
DECLARE
  v_r record;
  v_probs jsonb := '[]'::jsonb;
  v_status text := 'ok';
  v_critico int := 0;
  v_atencao int := 0;
  v_tel_so_digitos text;
  v_nome_lower text;
BEGIN
  SELECT * INTO v_r FROM public.reservas WHERE id = p_reserva_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','erro');
  END IF;

  IF v_r.status = 'cancelada' OR COALESCE(v_r.nao_contabilizar, false) THEN
    RETURN jsonb_build_object('status','ignorada','problemas','[]'::jsonb);
  END IF;

  -- Nome
  IF v_r.hospede_nome IS NULL OR LENGTH(TRIM(v_r.hospede_nome)) < 3 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_nome','msg','Sem nome ou nome muito curto','severidade','critico');
    v_critico := v_critico + 1;
  ELSE
    v_nome_lower := LOWER(v_r.hospede_nome);
    IF v_nome_lower LIKE 'hospede %' OR v_nome_lower LIKE 'hóspede %' OR v_nome_lower LIKE 'hosp%booking%' OR v_nome_lower LIKE 'hosp%direto%' OR v_nome_lower LIKE 'hosp%outro%' THEN
      v_probs := v_probs || jsonb_build_object('campo','hospede_nome','msg','Nome generico - precisa do real','severidade','atencao');
      v_atencao := v_atencao + 1;
    END IF;
  END IF;

  -- Telefone
  IF v_r.hospede_contato IS NULL OR LENGTH(TRIM(v_r.hospede_contato)) = 0 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Sem telefone','severidade','critico');
    v_critico := v_critico + 1;
  ELSIF POSITION('@' IN v_r.hospede_contato) > 0 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Email no campo de telefone','severidade','critico');
    v_critico := v_critico + 1;
  ELSE
    -- conta apenas digitos
    v_tel_so_digitos := REGEXP_REPLACE(v_r.hospede_contato, '[^0-9]', '', 'g');
    IF LENGTH(v_tel_so_digitos) < 10 THEN
      v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Telefone curto demais','severidade','critico');
      v_critico := v_critico + 1;
    ELSIF LENGTH(v_tel_so_digitos) > 15 THEN
      v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Telefone longo demais','severidade','atencao');
      v_atencao := v_atencao + 1;
    END IF;
  END IF;

  -- Datas
  IF v_r.checkin IS NULL OR v_r.checkout IS NULL THEN
    v_probs := v_probs || jsonb_build_object('campo','datas','msg','Datas vazias','severidade','critico');
    v_critico := v_critico + 1;
  ELSIF v_r.checkin >= v_r.checkout THEN
    v_probs := v_probs || jsonb_build_object('campo','datas','msg','Datas invertidas','severidade','critico');
    v_critico := v_critico + 1;
  END IF;

  -- Quarto
  IF (v_r.cama IS NULL OR LENGTH(TRIM(v_r.cama)) = 0) AND (v_r.quarto IS NULL OR LENGTH(TRIM(v_r.quarto)) = 0) THEN
    v_probs := v_probs || jsonb_build_object('campo','cama','msg','Sem quarto/cama','severidade','critico');
    v_critico := v_critico + 1;
  END IF;

  -- Valor
  IF v_r.valor_total IS NULL OR v_r.valor_total <= 0 THEN
    v_probs := v_probs || jsonb_build_object('campo','valor_total','msg','Valor total zerado','severidade','atencao');
    v_atencao := v_atencao + 1;
  END IF;

  -- Status final
  IF v_critico > 0 THEN v_status := 'critico';
  ELSIF v_atencao > 0 THEN v_status := 'atencao';
  ELSE v_status := 'ok';
  END IF;

  RETURN jsonb_build_object('status', v_status, 'problemas', v_probs, 'criticos', v_critico, 'atencao', v_atencao);
END
$func$;

GRANT EXECUTE ON FUNCTION public.validar_reserva_jsonb(uuid) TO service_role, anon, authenticated;

-- 3. TRIGGER
CREATE OR REPLACE FUNCTION public.fn_trigger_validar_reserva()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
DECLARE
  v_resultado jsonb;
BEGIN
  v_resultado := public.validar_reserva_jsonb(NEW.id);
  NEW.validacao_status := v_resultado->>'status';
  NEW.validacao_problemas := v_resultado->'problemas';
  NEW.validacao_em := now();
  RETURN NEW;
END
$func$;

DROP TRIGGER IF EXISTS trg_validar_reserva ON public.reservas;
CREATE TRIGGER trg_validar_reserva
  BEFORE INSERT OR UPDATE OF hospede_nome, hospede_contato, checkin, checkout, cama, quarto, valor_total, status
  ON public.reservas
  FOR EACH ROW EXECUTE FUNCTION public.fn_trigger_validar_reserva();

-- 4. BACKFILL
UPDATE public.reservas r
   SET validacao_status = (public.validar_reserva_jsonb(r.id))->>'status',
       validacao_problemas = (public.validar_reserva_jsonb(r.id))->'problemas',
       validacao_em = now()
 WHERE COALESCE(r.status, '') != 'cancelada' AND COALESCE(r.nao_contabilizar, false) = false;

SELECT 'OK' AS status,
       (SELECT jsonb_object_agg(validacao_status, c)
        FROM (SELECT validacao_status, COUNT(*) c FROM public.reservas
              WHERE COALESCE(status,'') != 'cancelada' GROUP BY validacao_status) sub) AS distribuicao;
