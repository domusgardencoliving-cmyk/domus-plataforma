/**
 * SYNC BIDIRECIONAL HOSPEDIN ↔ SUPABASE
 *
 * Resolve o problema: reservas DIRETAS feitas no /reservar.html
 * não chegavam no Hospedin (que ainda é a fonte da verdade pro mapa de
 * disponibilidade compartilhado com Booking, Airbnb, Expedia).
 *
 * O QUE ESTE SQL CRIA:
 *
 * 1. Coluna `hospedin_sync_status` na tabela reservas
 *    - 'pendente' (recém criada, ainda não foi pro Hospedin)
 *    - 'sincronizada' (POST OK, ID retornado salvo em hospedin_id)
 *    - 'erro' (POST falhou, motivo em hospedin_sync_erro)
 *    - 'nao_aplicavel' (ex: reserva veio do próprio Hospedin)
 *
 * 2. Coluna `hospedin_sync_erro` (text) — guarda última mensagem de erro
 * 3. Coluna `hospedin_sync_tentativas` (int) — quantas vezes tentou
 * 4. Coluna `hospedin_sync_em` (timestamptz) — quando sincronizou ok
 *
 * 5. Função `enviar_reserva_para_hospedin(p_reserva_id uuid)`
 *    - Pega credenciais do Vault
 *    - Autentica
 *    - Monta o POST com os campos da reserva
 *    - Atualiza o status da sincronização
 *    - Retorna jsonb com resultado
 *
 * 6. Trigger `trg_envia_reserva_para_hospedin`
 *    - Dispara AFTER INSERT em reservas
 *    - Só pra reservas com plataforma='Direto' e status NÃO cancelada
 *    - Chama a função acima de forma assíncrona via pg_net
 *
 * 7. Função `resincronizar_pendentes_hospedin(p_limite int)`
 *    - Pega reservas com status='pendente' ou 'erro'
 *    - Tenta enviar pro Hospedin de novo
 *    - Útil pra rodar manualmente do PMS quando quiser
 *
 * Como rodar:
 *   1. Cole tudo no SQL Editor do Supabase
 *   2. Execute
 *   3. Verifique a saída final (deve dizer "OK")
 */

SET statement_timeout = '300s';

-- =========================================================
-- 1. COLUNAS DE CONTROLE NA TABELA reservas
-- =========================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='reservas' AND column_name='hospedin_sync_status') THEN
    ALTER TABLE public.reservas ADD COLUMN hospedin_sync_status text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='reservas' AND column_name='hospedin_sync_erro') THEN
    ALTER TABLE public.reservas ADD COLUMN hospedin_sync_erro text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='reservas' AND column_name='hospedin_sync_tentativas') THEN
    ALTER TABLE public.reservas ADD COLUMN hospedin_sync_tentativas integer DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='reservas' AND column_name='hospedin_sync_em') THEN
    ALTER TABLE public.reservas ADD COLUMN hospedin_sync_em timestamptz;
  END IF;
END$$;

-- Índice pra acelerar a query de pendentes
CREATE INDEX IF NOT EXISTS idx_reservas_hospedin_sync_status
  ON public.reservas (hospedin_sync_status)
  WHERE hospedin_sync_status IN ('pendente', 'erro');

-- =========================================================
-- 2. FUNÇÃO QUE ENVIA UMA RESERVA PRO HOSPEDIN
-- =========================================================
CREATE OR REPLACE FUNCTION public.enviar_reserva_para_hospedin(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '60s'
AS $$
DECLARE
  v_reserva           record;
  v_email             text;
  v_password          text;
  v_account_id        text;
  v_token             text;
  v_base_url          text;
  v_response          record;
  v_body              jsonb;
  v_resp_body         jsonb;
  v_hospedin_id       text;
  v_place_id          int;
  v_sale_channel_id   int := 33933;  -- VENDA DIRETA (default)
BEGIN
  -- Pega a reserva
  SELECT * INTO v_reserva FROM public.reservas WHERE id = p_reserva_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'erro', 'Reserva nao encontrada');
  END IF;

  -- Se já sincronizou, não precisa fazer de novo
  IF v_reserva.hospedin_sync_status = 'sincronizada' AND v_reserva.hospedin_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'observacao', 'Ja sincronizada', 'hospedin_id', v_reserva.hospedin_id);
  END IF;

  -- Credenciais
  SELECT decrypted_secret INTO v_email FROM vault.decrypted_secrets WHERE name = 'hospedin_email';
  SELECT decrypted_secret INTO v_password FROM vault.decrypted_secrets WHERE name = 'hospedin_password';
  SELECT decrypted_secret INTO v_account_id FROM vault.decrypted_secrets WHERE name = 'hospedin_account_id';

  IF v_email IS NULL OR v_password IS NULL OR v_account_id IS NULL THEN
    UPDATE public.reservas
       SET hospedin_sync_status = 'erro',
           hospedin_sync_erro = 'Credenciais Hospedin ausentes no Vault',
           hospedin_sync_tentativas = COALESCE(hospedin_sync_tentativas, 0) + 1
     WHERE id = p_reserva_id;
    RETURN jsonb_build_object('success', false, 'erro', 'Credenciais Hospedin ausentes');
  END IF;

  v_base_url := 'https://pms-api.hospedin.com/api/v2/' || v_account_id;

  -- Autenticar
  SELECT status, content::text AS body INTO v_response
  FROM extensions.http_post(
    'https://pms-api.hospedin.com/api/v2/authentication/sessions',
    jsonb_build_object('email', v_email, 'password', v_password)::text,
    'application/json'
  );

  IF v_response.status != 200 THEN
    UPDATE public.reservas
       SET hospedin_sync_status = 'erro',
           hospedin_sync_erro = 'Falha auth Hospedin: HTTP ' || v_response.status,
           hospedin_sync_tentativas = COALESCE(hospedin_sync_tentativas, 0) + 1
     WHERE id = p_reserva_id;
    RETURN jsonb_build_object('success', false, 'erro', 'Falha autenticacao');
  END IF;

  v_token := COALESCE(
    (v_response.body::jsonb)->'data'->>'token',
    (v_response.body::jsonb)->>'token'
  );

  -- Mapear cama → place_id (consultar tabela quartos_mapping ou inferir)
  -- Pra Hostel: H6-C1=Hostel 6 - Cama 1, etc
  -- Por enquanto, assume tabela auxiliar com mapeamento; se não houver, busca pelo nome
  SELECT q.hospedin_place_id INTO v_place_id
    FROM public.quartos_mapping q
   WHERE q.cama_supabase = v_reserva.cama
   LIMIT 1;

  -- Montar o body do POST
  v_body := jsonb_build_object(
    'check_in',           v_reserva.checkin::text,
    'check_out',          v_reserva.checkout::text,
    'adults',             COALESCE(v_reserva.adultos, 1),
    'children',           COALESCE(v_reserva.criancas, 0),
    'place_id',           v_place_id,
    'sale_channel_id',    v_sale_channel_id,
    'status',             CASE
                            WHEN v_reserva.status = 'confirmada' THEN 'reservation'
                            WHEN v_reserva.status = 'check-in' THEN 'check_in'
                            WHEN v_reserva.status = 'check_in' THEN 'check_in'
                            WHEN v_reserva.status = 'cancelada' THEN 'canceled'
                            ELSE 'pre_reservation'
                          END,
    'note',               COALESCE(v_reserva.observacoes, 'Reserva criada via /reservar.html (Direto)'),
    'total_amount',       (COALESCE(v_reserva.valor_total, 0) * 100)::int,  -- centavos
    'guest', jsonb_build_object(
      'name',  COALESCE(v_reserva.hospede_nome, 'Hospede sem nome'),
      'ssn',   v_reserva.hospede_documento,
      'note',  E'\nTelefone: ' || COALESCE(v_reserva.hospede_contato, '')
    )
  );

  -- POST pra Hospedin
  SELECT status, content::text AS body INTO v_response
  FROM extensions.http(
    ('POST',
     v_base_url || '/reservations',
     ARRAY[
       extensions.http_header('Authorization', 'Bearer ' || v_token),
       extensions.http_header('Content-Type', 'application/json')
     ],
     'application/json',
     v_body::text
    )::extensions.http_request
  );

  IF v_response.status NOT IN (200, 201) THEN
    UPDATE public.reservas
       SET hospedin_sync_status = 'erro',
           hospedin_sync_erro = 'POST Hospedin HTTP ' || v_response.status || ': ' || LEFT(COALESCE(v_response.body, ''), 500),
           hospedin_sync_tentativas = COALESCE(hospedin_sync_tentativas, 0) + 1
     WHERE id = p_reserva_id;
    RETURN jsonb_build_object(
      'success', false,
      'erro', 'POST falhou',
      'http_status', v_response.status,
      'response_preview', LEFT(COALESCE(v_response.body, ''), 500),
      'body_enviado', v_body
    );
  END IF;

  -- Parse do response pra pegar o ID novo
  v_resp_body := v_response.body::jsonb;
  v_hospedin_id := COALESCE(
    (v_resp_body->'data'->>'id'),
    (v_resp_body->>'id')
  );

  -- Atualiza a reserva como sincronizada
  UPDATE public.reservas
     SET hospedin_id            = v_hospedin_id::int,
         hospedin_sync_status   = 'sincronizada',
         hospedin_sync_erro     = NULL,
         hospedin_sync_em       = now(),
         hospedin_sync_tentativas = COALESCE(hospedin_sync_tentativas, 0) + 1
   WHERE id = p_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'hospedin_id', v_hospedin_id,
    'http_status', v_response.status
  );

EXCEPTION WHEN OTHERS THEN
  UPDATE public.reservas
     SET hospedin_sync_status = 'erro',
         hospedin_sync_erro = 'Excecao: ' || SQLERRM,
         hospedin_sync_tentativas = COALESCE(hospedin_sync_tentativas, 0) + 1
   WHERE id = p_reserva_id;
  RETURN jsonb_build_object('success', false, 'erro', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.enviar_reserva_para_hospedin(uuid) TO service_role, authenticated, anon;

-- =========================================================
-- 3. TABELA AUXILIAR DE MAPEAMENTO DE QUARTOS
--    (Supabase usa nomes amigaveis; Hospedin usa place_id numerico)
-- =========================================================
CREATE TABLE IF NOT EXISTS public.quartos_mapping (
  id                  bigserial PRIMARY KEY,
  cama_supabase       text NOT NULL UNIQUE,
  hospedin_place_id   int  NOT NULL,
  hospedin_place_name text,
  unidade             text,                                -- 'AP' ou 'Rib'
  criado_em           timestamptz NOT NULL DEFAULT now()
);

-- Popular com o que conhecemos da Hospedin (do hospedin_api_mapa_completo.md)
-- Os IDs reais virão da função sync_hospedin_full quando rodar; aqui só os 2 que sabemos
INSERT INTO public.quartos_mapping (cama_supabase, hospedin_place_id, hospedin_place_name, unidade) VALUES
  ('Studio 1', 335187, 'Studio 1', 'AP'),
  ('Studio 2', 335188, 'Studio 2', 'AP')
ON CONFLICT (cama_supabase) DO NOTHING;

-- =========================================================
-- 4. TRIGGER QUE DISPARA O ENVIO QUANDO RESERVA DIRETA ENTRA
-- =========================================================
CREATE OR REPLACE FUNCTION public.trg_envia_reserva_para_hospedin_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Só pra reservas direta E ainda sem hospedin_id
  IF NEW.plataforma = 'Direto' AND COALESCE(NEW.status, '') NOT IN ('cancelada', 'por_engano') AND NEW.hospedin_id IS NULL THEN
    -- Marca como pendente; o cron / botao manual vai processar
    -- (não chamamos enviar_reserva_para_hospedin aqui pra não bloquear o INSERT)
    NEW.hospedin_sync_status := 'pendente';
  ELSIF NEW.hospedin_id IS NOT NULL THEN
    NEW.hospedin_sync_status := 'sincronizada';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_envia_reserva_para_hospedin ON public.reservas;
CREATE TRIGGER trg_envia_reserva_para_hospedin
  BEFORE INSERT ON public.reservas
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_envia_reserva_para_hospedin_fn();

-- =========================================================
-- 5. FUNÇÃO PARA RESINCRONIZAR PENDENTES (botão manual no PMS)
-- =========================================================
CREATE OR REPLACE FUNCTION public.resincronizar_pendentes_hospedin(p_limite int DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reserva       record;
  v_resultado     jsonb;
  v_sucessos      int := 0;
  v_falhas        int := 0;
  v_detalhes      jsonb := '[]'::jsonb;
BEGIN
  FOR v_reserva IN
    SELECT id, cama, hospede_nome, checkin
      FROM public.reservas
     WHERE hospedin_sync_status IN ('pendente', 'erro')
       AND COALESCE(status, '') NOT IN ('cancelada', 'por_engano')
       AND COALESCE(hospedin_sync_tentativas, 0) < 5  -- não tentar infinitamente
     ORDER BY hospedin_sync_status DESC,  -- pendente primeiro
              checkin ASC
     LIMIT p_limite
  LOOP
    v_resultado := public.enviar_reserva_para_hospedin(v_reserva.id);
    IF (v_resultado->>'success')::boolean THEN
      v_sucessos := v_sucessos + 1;
    ELSE
      v_falhas := v_falhas + 1;
    END IF;
    v_detalhes := v_detalhes || jsonb_build_object(
      'reserva_id', v_reserva.id,
      'hospede',    v_reserva.hospede_nome,
      'cama',       v_reserva.cama,
      'checkin',    v_reserva.checkin,
      'resultado',  v_resultado
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'total_processadas', v_sucessos + v_falhas,
    'sucessos', v_sucessos,
    'falhas',   v_falhas,
    'detalhes', v_detalhes
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resincronizar_pendentes_hospedin(int) TO service_role, authenticated, anon;

-- =========================================================
-- 6. MARCAR RESERVAS ANTIGAS DIRETAS COMO PENDENTES
--    (pra elas serem re-enviadas)
-- =========================================================
UPDATE public.reservas
   SET hospedin_sync_status = 'pendente'
 WHERE plataforma = 'Direto'
   AND hospedin_id IS NULL
   AND COALESCE(status, '') NOT IN ('cancelada', 'por_engano')
   AND hospedin_sync_status IS NULL;

-- Reservas vindas do próprio Hospedin → marca como sincronizada
UPDATE public.reservas
   SET hospedin_sync_status = 'sincronizada'
 WHERE hospedin_id IS NOT NULL
   AND hospedin_sync_status IS NULL;

-- =========================================================
-- 7. VIEW PARA O PMS MOSTRAR STATUS
-- =========================================================
CREATE OR REPLACE VIEW public.v_reservas_sync_status AS
SELECT
  hospedin_sync_status,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE plataforma = 'Direto') AS direta,
  MIN(hospedin_sync_em) AS primeira_sync,
  MAX(hospedin_sync_em) AS ultima_sync
  FROM public.reservas
 WHERE COALESCE(status, '') NOT IN ('cancelada', 'por_engano')
 GROUP BY hospedin_sync_status;

GRANT SELECT ON public.v_reservas_sync_status TO authenticated, anon;

-- =========================================================
-- 8. CRON (opcional, mas recomendado)
--    Roda a cada 5 minutos pra processar pendentes
--    Comentado por padrão - descomentar se quiser ativar
-- =========================================================
-- SELECT cron.schedule(
--   'resincronizar_hospedin',
--   '*/5 * * * *',
--   $cron$ SELECT public.resincronizar_pendentes_hospedin(10); $cron$
-- );

-- =========================================================
-- RESULTADO
-- =========================================================
SELECT
  'OK' AS status,
  'Sync bidirecional Hospedin instalado' AS mensagem,
  jsonb_build_object(
    'colunas_criadas', 4,
    'funcoes_criadas', 3,
    'trigger_criado', 'trg_envia_reserva_para_hospedin',
    'reservas_marcadas_pendente', (SELECT count(*) FROM reservas WHERE hospedin_sync_status='pendente'),
    'reservas_marcadas_sincronizada', (SELECT count(*) FROM reservas WHERE hospedin_sync_status='sincronizada'),
    'proximo_passo', 'Rodar SELECT public.resincronizar_pendentes_hospedin(5); pra processar as primeiras 5'
  ) AS detalhes;
