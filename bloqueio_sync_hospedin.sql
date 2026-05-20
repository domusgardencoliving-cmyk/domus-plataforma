-- =========================================================
-- BLOQUEIO ↔ HOSPEDIN — sync push pra bloqueios
-- Aplicado em 2026-05-20
-- =========================================================
-- O quê: faz com que bloqueios criados no DG (canal_codigo='bloqueio')
--        sejam empurrados pro Hospedin pelo sync push existente. Idem
--        pra cancelamento de bloqueio (DG → PUT status=cancelled lá).
--
-- ⚠️ PRÉ-REQUISITO IMPORTANTE:
-- A tabela public.quartos_mapping precisa ter os hospedin_place_id REAIS
-- pra cada cama. Hoje só Studio 1 e Studio 2 têm IDs conhecidos.
-- Pras outras 11 camas (Ind 3-5, H6-C1..C4, H7-C5..C8) o ID deve vir de:
--   GET https://pms-api.hospedin.com/api/v2/23949/places
-- Antes de bloqueios em camas diferentes de Studio 1/2 sincronizarem,
-- esses IDs precisam ser populados (UPSERT manual).
-- =========================================================

-- 1. Garante a coluna hospedin_accommodation_id (a Edge Function lê dela)
ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS hospedin_accommodation_id int;

-- 2. Trigger ampliado: cobre Direto E bloqueio, e cobre UPDATE de status
CREATE OR REPLACE FUNCTION public.trg_envia_reserva_para_hospedin_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_e_bloqueio boolean := (COALESCE(NEW.canal_codigo, '') = 'bloqueio'
                          OR COALESCE(NEW.plataforma, '') = 'Bloqueio');
  v_e_direto   boolean := (COALESCE(NEW.plataforma, '') = 'Direto');
  v_status     text    := COALESCE(NEW.status, '');
BEGIN
  -- Caso 1: row nova sem hospedin_id → criar lá (POST)
  IF NEW.hospedin_id IS NULL AND (v_e_direto OR v_e_bloqueio)
     AND v_status NOT IN ('cancelada', 'por_engano') THEN
    NEW.hospedin_sync_status := 'pendente';
    NEW.status_sync_hospedin := 'pendente';

  -- Caso 2: já tem hospedin_id E status mudou pra cancelada → atualizar lá (PUT)
  ELSIF NEW.hospedin_id IS NOT NULL
     AND TG_OP = 'UPDATE'
     AND NEW.status = 'cancelada'
     AND COALESCE(OLD.status, '') <> 'cancelada' THEN
    NEW.hospedin_sync_status := 'pendente';
    NEW.status_sync_hospedin := 'pendente';
    NEW.atualizado_em := NOW();

  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_envia_reserva_para_hospedin ON public.reservas;
CREATE TRIGGER trg_envia_reserva_para_hospedin
  BEFORE INSERT OR UPDATE ON public.reservas
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_envia_reserva_para_hospedin_fn();

-- 3. Trigger que preenche hospedin_accommodation_id por cama (via quartos_mapping)
CREATE OR REPLACE FUNCTION public.trg_preenche_hospedin_accommodation_id_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_place_id int;
BEGIN
  IF NEW.hospedin_accommodation_id IS NULL AND NEW.cama IS NOT NULL THEN
    SELECT q.hospedin_place_id INTO v_place_id
      FROM public.quartos_mapping q
     WHERE q.cama_supabase = NEW.cama
     LIMIT 1;
    IF v_place_id IS NOT NULL THEN
      NEW.hospedin_accommodation_id := v_place_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preenche_hospedin_accommodation_id ON public.reservas;
CREATE TRIGGER trg_preenche_hospedin_accommodation_id
  BEFORE INSERT OR UPDATE ON public.reservas
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_preenche_hospedin_accommodation_id_fn();

-- 4. Retroativo: marca bloqueios existentes (sem hospedin_id) como pendentes
UPDATE public.reservas
   SET status_sync_hospedin = 'pendente',
       hospedin_sync_status = 'pendente'
 WHERE (canal_codigo = 'bloqueio' OR plataforma = 'Bloqueio')
   AND hospedin_id IS NULL
   AND status NOT IN ('cancelada', 'por_engano');

-- 5. Retroativo: preenche hospedin_accommodation_id pra reservas conhecidas
UPDATE public.reservas r
   SET hospedin_accommodation_id = q.hospedin_place_id
  FROM public.quartos_mapping q
 WHERE r.cama = q.cama_supabase
   AND r.hospedin_accommodation_id IS NULL;

-- 6. Confirmação: bloqueios pendentes + camas sem mapping
SELECT
  'bloqueios_pendentes_push' AS metrica,
  COUNT(*) AS valor
  FROM public.reservas
 WHERE (canal_codigo = 'bloqueio' OR plataforma = 'Bloqueio')
   AND status_sync_hospedin = 'pendente'
UNION ALL
SELECT
  'bloqueios_sem_accommodation_id (sync vai falhar)',
  COUNT(*)
  FROM public.reservas
 WHERE (canal_codigo = 'bloqueio' OR plataforma = 'Bloqueio')
   AND status_sync_hospedin = 'pendente'
   AND hospedin_accommodation_id IS NULL
UNION ALL
SELECT 'camas_sem_mapping_definido', COUNT(DISTINCT cama)
  FROM public.reservas r
 WHERE r.cama IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.quartos_mapping q WHERE q.cama_supabase = r.cama);
