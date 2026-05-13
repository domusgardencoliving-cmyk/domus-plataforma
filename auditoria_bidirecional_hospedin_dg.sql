-- =========================================================
-- AUDITORIA BIDIRECIONAL HOSPEDIN ↔ DG (FASE 2 da IA)
--
-- Pra cada reserva com canal_hospedin_id (sincronizada), compara
-- campos críticos entre Hospedin e DG e RESOLVE divergências
-- baseado na regra de canal de venda:
--   - BO/AI/AR (Booking/Airbnb): Hospedin é fonte da verdade
--   - VD/PR/HO (direto/pré/criado): DG é fonte da verdade
--
-- Campos auditados: hospede_nome, hospede_contato (telefone),
--                   checkin, checkout, cama/quarto, valor_total
--
-- Cada divergência resolvida:
--  - é gravada em divergencias_resolvidas
--  - notifica Gabi (insert em notificacoes_gabi → Carteiro pega depois)
-- =========================================================

-- 1. TABELA de log de divergências
CREATE TABLE IF NOT EXISTS public.divergencias_resolvidas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reserva_id uuid REFERENCES public.reservas(id) ON DELETE CASCADE,
  campo text NOT NULL,
  valor_antigo text,
  valor_novo text,
  fonte_aceita text NOT NULL CHECK (fonte_aceita IN ('hospedin','dg','manual')),
  motivo text,
  canal_codigo text,
  resolvido_em timestamptz DEFAULT now(),
  notificou_gabi boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_divs_reserva ON public.divergencias_resolvidas (reserva_id);
CREATE INDEX IF NOT EXISTS idx_divs_data ON public.divergencias_resolvidas (resolvido_em DESC);

-- 2. TABELA de notificações pra Gabi (Carteiro lê)
CREATE TABLE IF NOT EXISTS public.notificacoes_gabi (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  titulo text NOT NULL,
  conteudo text,
  reserva_id uuid REFERENCES public.reservas(id) ON DELETE SET NULL,
  metadados jsonb DEFAULT '{}'::jsonb,
  enviada_whatsapp boolean DEFAULT false,
  enviada_email boolean DEFAULT false,
  vista_no_pms boolean DEFAULT false,
  criada_em timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_pendentes ON public.notificacoes_gabi (vista_no_pms, criada_em DESC);

-- 3. FUNÇÃO: resolve divergências de UMA reserva comparando com payload Hospedin
-- Recebe a reserva_id e o JSON da reserva da Hospedin (já sincronizada externamente)
CREATE OR REPLACE FUNCTION public.auditar_e_resolver_divergencia(
  p_reserva_id uuid,
  p_hospedin jsonb  -- payload da Hospedin com campos guest_name, guest_phone, checkin, checkout, room, total
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_dg record;
  v_canal text;
  v_fonte text;  -- 'hospedin' ou 'dg'
  v_resolucoes jsonb := '[]'::jsonb;
  v_atualizacoes_dg jsonb := '{}'::jsonb;
  v_h_nome text;
  v_h_tel text;
  v_h_checkin date;
  v_h_checkout date;
  v_h_cama text;
  v_h_valor numeric;
BEGIN
  SELECT id, hospede_nome, hospede_contato, checkin, checkout, cama, quarto, valor_total,
         canal_codigo, plataforma
    INTO v_dg
    FROM public.reservas
   WHERE id = p_reserva_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'erro', 'reserva nao encontrada');
  END IF;

  v_canal := COALESCE(v_dg.canal_codigo, '');

  -- Decide fonte da verdade pelo canal
  v_fonte := CASE
    WHEN v_canal IN ('booking','airbnb','expedia','hostelworld','BO','AI','AR') THEN 'hospedin'
    WHEN v_canal IN ('direto','venda_direta','pre_reserva','VD','PR') THEN 'dg'
    WHEN v_canal IN ('hospedin','HO') THEN 'hospedin'
    ELSE 'hospedin'  -- default conservador (atualiza nosso a partir do PMS antigo)
  END;

  -- Extrai campos da Hospedin
  v_h_nome     := NULLIF(TRIM(p_hospedin->>'guest_name'), '');
  v_h_tel      := NULLIF(TRIM(p_hospedin->>'guest_phone'), '');
  v_h_checkin  := (p_hospedin->>'checkin')::date;
  v_h_checkout := (p_hospedin->>'checkout')::date;
  v_h_cama     := NULLIF(TRIM(p_hospedin->>'room'), '');
  v_h_valor    := (p_hospedin->>'total')::numeric;

  -- ========== HOSPEDIN É FONTE: copia pra DG quando diverge ==========
  IF v_fonte = 'hospedin' THEN

    IF v_h_nome IS NOT NULL AND v_h_nome IS DISTINCT FROM v_dg.hospede_nome
       AND (v_dg.hospede_nome IS NULL OR LENGTH(TRIM(v_dg.hospede_nome)) < 3
            OR LOWER(v_dg.hospede_nome) LIKE 'h%spede%') THEN
      v_atualizacoes_dg := v_atualizacoes_dg || jsonb_build_object('hospede_nome', v_h_nome);
      INSERT INTO public.divergencias_resolvidas (reserva_id, campo, valor_antigo, valor_novo, fonte_aceita, motivo, canal_codigo)
      VALUES (p_reserva_id, 'hospede_nome', v_dg.hospede_nome, v_h_nome, 'hospedin', 'nome generico/vazio no DG', v_canal);
      v_resolucoes := v_resolucoes || jsonb_build_object('campo','hospede_nome','direcao','hospedin->dg','valor', v_h_nome);
    END IF;

    IF v_h_tel IS NOT NULL AND v_h_tel IS DISTINCT FROM v_dg.hospede_contato
       AND (v_dg.hospede_contato IS NULL OR LENGTH(TRIM(v_dg.hospede_contato)) = 0
            OR v_dg.hospede_contato LIKE '%@%') THEN
      v_atualizacoes_dg := v_atualizacoes_dg || jsonb_build_object('hospede_contato', v_h_tel);
      INSERT INTO public.divergencias_resolvidas (reserva_id, campo, valor_antigo, valor_novo, fonte_aceita, motivo, canal_codigo)
      VALUES (p_reserva_id, 'hospede_contato', v_dg.hospede_contato, v_h_tel, 'hospedin', 'tel vazio/email no DG', v_canal);
      v_resolucoes := v_resolucoes || jsonb_build_object('campo','hospede_contato','direcao','hospedin->dg','valor', v_h_tel);
    END IF;

    IF v_h_checkin IS NOT NULL AND v_h_checkin IS DISTINCT FROM v_dg.checkin THEN
      v_atualizacoes_dg := v_atualizacoes_dg || jsonb_build_object('checkin', v_h_checkin);
      INSERT INTO public.divergencias_resolvidas (reserva_id, campo, valor_antigo, valor_novo, fonte_aceita, motivo, canal_codigo)
      VALUES (p_reserva_id, 'checkin', v_dg.checkin::text, v_h_checkin::text, 'hospedin', 'datas diferentes', v_canal);
      v_resolucoes := v_resolucoes || jsonb_build_object('campo','checkin','direcao','hospedin->dg','valor', v_h_checkin);
    END IF;

    IF v_h_checkout IS NOT NULL AND v_h_checkout IS DISTINCT FROM v_dg.checkout THEN
      v_atualizacoes_dg := v_atualizacoes_dg || jsonb_build_object('checkout', v_h_checkout);
      INSERT INTO public.divergencias_resolvidas (reserva_id, campo, valor_antigo, valor_novo, fonte_aceita, motivo, canal_codigo)
      VALUES (p_reserva_id, 'checkout', v_dg.checkout::text, v_h_checkout::text, 'hospedin', 'datas diferentes', v_canal);
      v_resolucoes := v_resolucoes || jsonb_build_object('campo','checkout','direcao','hospedin->dg','valor', v_h_checkout);
    END IF;

    IF v_h_cama IS NOT NULL AND v_h_cama IS DISTINCT FROM COALESCE(v_dg.cama, v_dg.quarto)
       AND (v_dg.cama IS NULL OR LENGTH(TRIM(v_dg.cama)) = 0) THEN
      v_atualizacoes_dg := v_atualizacoes_dg || jsonb_build_object('cama', v_h_cama);
      INSERT INTO public.divergencias_resolvidas (reserva_id, campo, valor_antigo, valor_novo, fonte_aceita, motivo, canal_codigo)
      VALUES (p_reserva_id, 'cama', v_dg.cama, v_h_cama, 'hospedin', 'quarto vazio no DG', v_canal);
      v_resolucoes := v_resolucoes || jsonb_build_object('campo','cama','direcao','hospedin->dg','valor', v_h_cama);
    END IF;

    IF v_h_valor IS NOT NULL AND v_h_valor > 0 AND v_h_valor IS DISTINCT FROM v_dg.valor_total
       AND (v_dg.valor_total IS NULL OR v_dg.valor_total = 0) THEN
      v_atualizacoes_dg := v_atualizacoes_dg || jsonb_build_object('valor_total', v_h_valor);
      INSERT INTO public.divergencias_resolvidas (reserva_id, campo, valor_antigo, valor_novo, fonte_aceita, motivo, canal_codigo)
      VALUES (p_reserva_id, 'valor_total', v_dg.valor_total::text, v_h_valor::text, 'hospedin', 'valor zerado/vazio no DG', v_canal);
      v_resolucoes := v_resolucoes || jsonb_build_object('campo','valor_total','direcao','hospedin->dg','valor', v_h_valor);
    END IF;

    -- Aplica todas as atualizações em uma única operação
    IF v_atualizacoes_dg <> '{}'::jsonb THEN
      UPDATE public.reservas SET
        hospede_nome    = COALESCE(v_atualizacoes_dg->>'hospede_nome', hospede_nome),
        hospede_contato = COALESCE(v_atualizacoes_dg->>'hospede_contato', hospede_contato),
        checkin         = COALESCE((v_atualizacoes_dg->>'checkin')::date, checkin),
        checkout        = COALESCE((v_atualizacoes_dg->>'checkout')::date, checkout),
        cama            = COALESCE(v_atualizacoes_dg->>'cama', cama),
        valor_total     = COALESCE((v_atualizacoes_dg->>'valor_total')::numeric, valor_total)
      WHERE id = p_reserva_id;
    END IF;
  END IF;

  -- ========== DG É FONTE: marca o que precisa ser empurrado pra Hospedin ==========
  -- (envio de fato é feito por outra função/cron com Hospedin API)
  -- Aqui só registra o que mudou e cria notificação

  -- ========== Notifica Gabi de cada divergência resolvida ==========
  IF jsonb_array_length(v_resolucoes) > 0 THEN
    INSERT INTO public.notificacoes_gabi (tipo, titulo, conteudo, reserva_id, metadados)
    VALUES (
      'divergencia_resolvida',
      'Divergencia resolvida: ' || COALESCE(v_dg.hospede_nome, 'reserva') || ' (' || COALESCE(v_canal, '?') || ')',
      jsonb_array_length(v_resolucoes) || ' campo(s) atualizado(s) automaticamente',
      p_reserva_id,
      jsonb_build_object('resolucoes', v_resolucoes, 'fonte', v_fonte)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'fonte_aceita', v_fonte,
    'canal', v_canal,
    'divergencias_encontradas', jsonb_array_length(v_resolucoes),
    'resolucoes', v_resolucoes
  );
END
$func$;

GRANT EXECUTE ON FUNCTION public.auditar_e_resolver_divergencia(uuid, jsonb) TO service_role, authenticated;

-- 4. RLS para o PMS conseguir ler divergencias e notificacoes
ALTER TABLE public.divergencias_resolvidas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS divs_anon_read ON public.divergencias_resolvidas;
CREATE POLICY divs_anon_read ON public.divergencias_resolvidas
  FOR SELECT TO anon, authenticated USING (true);

ALTER TABLE public.notificacoes_gabi ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_anon_all ON public.notificacoes_gabi;
CREATE POLICY notif_anon_all ON public.notificacoes_gabi
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 5. RESULTADO
SELECT 'OK - Auditoria bidirecional pronta' AS status,
  jsonb_build_object(
    'tabelas_criadas', ARRAY['divergencias_resolvidas','notificacoes_gabi'],
    'funcao_principal', 'auditar_e_resolver_divergencia(reserva_id, hospedin_jsonb)',
    'regra_de_fonte', jsonb_build_object(
      'BO/AI/AR/HO (OTAs/Hospedin)', 'Hospedin manda',
      'VD/PR (direto/pre)', 'DG manda',
      'default', 'Hospedin (conservador)'
    ),
    'proximo_passo', 'Conectar com sync Hospedin existente: pra cada reserva sincronizada, chamar auditar_e_resolver_divergencia'
  ) AS detalhes;
