/**
 * IA VALIDADORA DE RESERVAS — V3
 *
 * Mudancas em relacao a V2:
 *   1. Canais anonimizados (Airbnb / Hotels.com / Booking) nao tem telefone
 *      real disponivel — entao "Sem telefone" nesses casos nao eh critico,
 *      eh apenas "atencao" (ou nem aparece). Reduz drasticamente os falsos
 *      criticos na aba Problemas.
 *   2. Reconhece mais variacoes de "Nome generico":
 *      - "Hospede Hotels.com", "Hospede Airbnb", "Hospede Direto", "Hospede Booking"
 *      - Variacoes com acento ("hóspede")
 *      - Nomes vazios apenas com palavras nas categorias
 *   3. Reservas no passado (checkout < hoje) nao precisam mais ser revalidadas
 *      como criticas — sao historicas.
 *
 * Como rodar:
 *   1. Supabase Dashboard -> SQL Editor
 *   2. Cole e rode
 *   3. O backfill (passo 4) vai re-validar todas e a aba Problemas vai
 *      mostrar a contagem real (esperado: ~50-100 criticos em vez de 380)
 */

-- 1. Garante colunas (idempotente)
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS validacao_status text DEFAULT 'nao_validada',
  ADD COLUMN IF NOT EXISTS validacao_problemas jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS validacao_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_reservas_validacao_status ON public.reservas (validacao_status);

-- 2. Funcao de validacao V3
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
  v_canal_anonimo boolean := false;
  v_canal_lower text;
  v_eh_historica boolean := false;
BEGIN
  SELECT * INTO v_r FROM public.reservas WHERE id = p_reserva_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','erro');
  END IF;

  IF v_r.status = 'cancelada' OR COALESCE(v_r.nao_contabilizar, false) THEN
    RETURN jsonb_build_object('status','ignorada','problemas','[]'::jsonb);
  END IF;

  -- Reserva ja concluida (checkout no passado) — nao revalidar criticos
  IF v_r.checkout IS NOT NULL AND v_r.checkout < CURRENT_DATE THEN
    v_eh_historica := true;
  END IF;

  -- Detectar canal anonimizado
  v_canal_lower := LOWER(COALESCE(v_r.canal_codigo, '') || ' ' || COALESCE(v_r.plataforma, ''));
  IF v_canal_lower ~ '(airbnb|hotels\.com|hotels com|booking|hotelscom|^ar$|^bk$|^ht$|^ar:|^bk:|^ht:)' THEN
    v_canal_anonimo := true;
  END IF;

  -- Nome
  IF v_r.hospede_nome IS NULL OR LENGTH(TRIM(v_r.hospede_nome)) < 3 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_nome','msg','Sem nome ou nome muito curto','severidade', CASE WHEN v_eh_historica THEN 'atencao' ELSE 'critico' END);
    IF v_eh_historica THEN v_atencao := v_atencao + 1; ELSE v_critico := v_critico + 1; END IF;
  ELSE
    v_nome_lower := LOWER(v_r.hospede_nome);
    IF v_nome_lower LIKE 'hospede %'
       OR v_nome_lower LIKE 'hóspede %'
       OR v_nome_lower LIKE 'hospede.%'
       OR v_nome_lower LIKE 'hosp%booking%'
       OR v_nome_lower LIKE 'hosp%direto%'
       OR v_nome_lower LIKE 'hosp%outro%'
       OR v_nome_lower LIKE 'hosp%airbnb%'
       OR v_nome_lower LIKE 'hosp%hotels%'
       OR v_nome_lower IN ('booking','airbnb','hospede','hóspede','convidado','guest') THEN
      -- Em canais anonimizados, nome generico eh quase a regra. Atencao leve.
      v_probs := v_probs || jsonb_build_object('campo','hospede_nome','msg','Nome generico - precisa do real','severidade','atencao');
      v_atencao := v_atencao + 1;
    END IF;
  END IF;

  -- Telefone — comportamento depende do canal
  IF v_r.hospede_contato IS NULL OR LENGTH(TRIM(v_r.hospede_contato)) = 0 THEN
    -- Sem contato. Se canal anonimizado, eh esperado (nao critico nem atencao — apenas info)
    -- Se canal direto/WhatsApp/etc., eh critico.
    IF v_canal_anonimo THEN
      -- Nao adiciona o problema (canal nao fornece contato — eh normal)
      NULL;
    ELSE
      v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Sem telefone','severidade', CASE WHEN v_eh_historica THEN 'atencao' ELSE 'critico' END);
      IF v_eh_historica THEN v_atencao := v_atencao + 1; ELSE v_critico := v_critico + 1; END IF;
    END IF;
  ELSIF POSITION('@' IN v_r.hospede_contato) > 0 THEN
    v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Email no campo de telefone','severidade','atencao');
    v_atencao := v_atencao + 1;
  ELSE
    v_tel_so_digitos := REGEXP_REPLACE(v_r.hospede_contato, '[^0-9]', '', 'g');
    IF LENGTH(v_tel_so_digitos) < 10 THEN
      -- Curto demais. Em canal anonimizado, talvez seja o codigo mascarado do canal — atencao.
      v_probs := v_probs || jsonb_build_object('campo','hospede_contato','msg','Telefone curto demais','severidade', CASE WHEN v_canal_anonimo THEN 'atencao' ELSE 'critico' END);
      IF v_canal_anonimo THEN v_atencao := v_atencao + 1; ELSE v_critico := v_critico + 1; END IF;
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

  -- Quarto/Cama
  IF (v_r.cama IS NULL OR LENGTH(TRIM(v_r.cama)) = 0) AND (v_r.quarto IS NULL OR LENGTH(TRIM(v_r.quarto)) = 0) THEN
    v_probs := v_probs || jsonb_build_object('campo','cama','msg','Sem quarto/cama','severidade','critico');
    v_critico := v_critico + 1;
  END IF;

  -- Valor (atencao se zerado em reserva FUTURA; em historica deixa passar)
  IF (v_r.valor_total IS NULL OR v_r.valor_total <= 0) AND NOT v_eh_historica THEN
    -- Em reserva direta zerada eh esperado (bloqueio, cortesia). So marca se nao for bloqueio.
    IF COALESCE(v_r.canal_codigo, '') != 'bloqueio' AND COALESCE(v_r.plataforma, '') != 'Bloqueio' THEN
      v_probs := v_probs || jsonb_build_object('campo','valor_total','msg','Valor total zerado','severidade','atencao');
      v_atencao := v_atencao + 1;
    END IF;
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

-- 3. Trigger (mesmo da v2)
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
  BEFORE INSERT OR UPDATE OF hospede_nome, hospede_contato, checkin, checkout, cama, quarto, valor_total, status, canal_codigo, plataforma
  ON public.reservas
  FOR EACH ROW EXECUTE FUNCTION public.fn_trigger_validar_reserva();

-- 4. Backfill: re-valida TODAS as reservas com a logica V3
UPDATE public.reservas r
   SET validacao_status = (public.validar_reserva_jsonb(r.id))->>'status',
       validacao_problemas = (public.validar_reserva_jsonb(r.id))->'problemas',
       validacao_em = now()
 WHERE COALESCE(r.status, '') != 'cancelada' AND COALESCE(r.nao_contabilizar, false) = false;

-- 5. Mostra a distribuicao final
SELECT validacao_status, COUNT(*) AS qt
  FROM public.reservas
 WHERE COALESCE(status, '') NOT IN ('cancelada')
   AND COALESCE(nao_contabilizar, false) = false
 GROUP BY 1
 ORDER BY 1;
