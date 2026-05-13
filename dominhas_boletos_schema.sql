/**
 * BOLETOS DOMINHAS — schema completo
 *
 * Substitui o BR Condomínio. Fluxo:
 *  1. Gabi entra na página "Boletos Dominhas" do DG Gestão no início do mês
 *  2. Página mostra todas as moradoras ativas com valor mensal sugerido
 *  3. Gabi ajusta valores específicos (energia, extras, multas) se precisar
 *  4. Clica "Enviar malote pro Inter"
 *  5. Sistema faz POST pra API Inter pra cada boleto
 *  6. Inter devolve: linha digitável, código de barras, PDF e PIX copia-cola
 *  7. Tudo salvo aqui; Portal Dominhas mostra automaticamente
 *  8. Carteiro WhatsApp avisa cada moradora "Seu boleto de [mês] já está no Portal"
 *
 * Como rodar: cole no SQL Editor do Supabase e Run.
 */

-- =========================================================
-- 1. TABELA dominhas_lote_envio (1 lote por mes)
-- =========================================================
CREATE TABLE IF NOT EXISTS public.dominhas_lote_envio (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mes_referencia  date NOT NULL,                          -- primeiro dia do mes (ex: 2026-06-01)
  data_vencimento date NOT NULL,                          -- dia que todos os boletos vencem (default 5)
  total_boletos   int  DEFAULT 0,
  total_valor     numeric(10,2) DEFAULT 0,
  status          text NOT NULL DEFAULT 'rascunho',       -- 'rascunho' | 'enviando' | 'enviado' | 'erro'
  inter_resposta  jsonb,                                  -- payload da resposta do Inter (pra debug)
  observacoes     text,
  criado_por      text,                                   -- email da Gabi
  criado_em       timestamptz NOT NULL DEFAULT now(),
  enviado_em      timestamptz,
  UNIQUE (mes_referencia)                                 -- so 1 lote por mes
);

CREATE INDEX IF NOT EXISTS idx_lote_mes ON public.dominhas_lote_envio (mes_referencia DESC);
CREATE INDEX IF NOT EXISTS idx_lote_status ON public.dominhas_lote_envio (status);

-- =========================================================
-- 2. TABELA dominhas_boletos (1 por moradora por mes)
-- =========================================================
CREATE TABLE IF NOT EXISTS public.dominhas_boletos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id             uuid REFERENCES public.dominhas_lote_envio(id) ON DELETE SET NULL,
  moradora_id         uuid,                                -- FK pra public.moradores (sem constraint dura pra nao quebrar)
  moradora_nome       text NOT NULL,                       -- snapshot
  moradora_email      text,
  moradora_whatsapp   text,
  unidade             text,                                -- 'AP' ou 'Rib'
  quarto              text,                                -- nome do quarto
  mes_referencia      date NOT NULL,                       -- primeiro dia do mes
  data_vencimento     date NOT NULL,
  -- composicao do valor (json livre, mas com chaves padronizadas)
  valor_coliving      numeric(10,2) NOT NULL DEFAULT 0,
  valor_energia       numeric(10,2) NOT NULL DEFAULT 0,
  valor_extras        numeric(10,2) NOT NULL DEFAULT 0,    -- mercadinho, ficha lavanderia, etc
  valor_multas        numeric(10,2) NOT NULL DEFAULT 0,
  valor_descontos     numeric(10,2) NOT NULL DEFAULT 0,
  valor_total         numeric(10,2) NOT NULL,              -- coliving + energia + extras + multas - descontos
  composicao_detalhe  jsonb,                               -- ex: {extras_lista: [{nome:"Ficha lavanderia", valor:18.90}]}
  -- retorno do Inter
  inter_codigo_solicitacao text,                           -- codigo da requisicao
  inter_nosso_numero       text,                           -- nosso numero gerado
  inter_linha_digitavel    text,
  inter_codigo_barras      text,
  inter_pix_copia_cola     text,
  inter_pix_qrcode_base64  text,                           -- imagem base64 do QR
  inter_pdf_url            text,                           -- URL do PDF salvo no Storage
  inter_resposta_raw       jsonb,                          -- pra debug
  -- status do boleto
  status              text NOT NULL DEFAULT 'pendente',    -- 'pendente' | 'gerado' | 'pago' | 'vencido' | 'cancelado'
  data_pagamento      date,
  forma_pagamento     text,                                -- 'pix' | 'boleto' | 'transferencia'
  -- comunicacao
  notificado_em       timestamptz,                         -- quando o Carteiro avisou
  baixado_em          timestamptz,                         -- quando a moradora baixou o PDF
  -- auditoria
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (moradora_id, mes_referencia)                     -- 1 boleto por moradora por mes
);

CREATE INDEX IF NOT EXISTS idx_boletos_lote ON public.dominhas_boletos (lote_id);
CREATE INDEX IF NOT EXISTS idx_boletos_moradora ON public.dominhas_boletos (moradora_id);
CREATE INDEX IF NOT EXISTS idx_boletos_mes ON public.dominhas_boletos (mes_referencia DESC);
CREATE INDEX IF NOT EXISTS idx_boletos_status ON public.dominhas_boletos (status);
CREATE INDEX IF NOT EXISTS idx_boletos_venc ON public.dominhas_boletos (data_vencimento);

-- Trigger: atualizar atualizado_em
CREATE OR REPLACE FUNCTION public.fn_dominhas_boletos_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.atualizado_em := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_dominhas_boletos_updated ON public.dominhas_boletos;
CREATE TRIGGER trg_dominhas_boletos_updated
  BEFORE UPDATE ON public.dominhas_boletos
  FOR EACH ROW EXECUTE FUNCTION public.fn_dominhas_boletos_updated();

-- =========================================================
-- 3. RLS — Portal Dominhas: moradora so ve os boletos dela
-- =========================================================
ALTER TABLE public.dominhas_boletos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dominhas_lote_envio ENABLE ROW LEVEL SECURITY;

-- service_role pode tudo
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='dominhas_boletos' AND policyname='service_role_full') THEN
    EXECUTE 'CREATE POLICY service_role_full ON public.dominhas_boletos FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='dominhas_lote_envio' AND policyname='service_role_full') THEN
    EXECUTE 'CREATE POLICY service_role_full ON public.dominhas_lote_envio FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
  -- anon (usado pela app) tambem libera por enquanto - validacao por moradora_id no codigo
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='dominhas_boletos' AND policyname='anon_read_write') THEN
    EXECUTE 'CREATE POLICY anon_read_write ON public.dominhas_boletos FOR ALL TO anon USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='dominhas_lote_envio' AND policyname='anon_read_write') THEN
    EXECUTE 'CREATE POLICY anon_read_write ON public.dominhas_lote_envio FOR ALL TO anon USING (true) WITH CHECK (true)';
  END IF;
END$$;

-- =========================================================
-- 4. FUNCAO: criar lote do mes a partir das moradoras ativas
-- =========================================================
CREATE OR REPLACE FUNCTION public.criar_lote_boletos_mes(
  p_mes_referencia date,
  p_data_vencimento date DEFAULT NULL,
  p_criado_por text DEFAULT 'gabi'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_lote_id   uuid;
  v_moradora  record;
  v_total_b   int := 0;
  v_total_v   numeric := 0;
  v_venc      date;
BEGIN
  v_venc := COALESCE(p_data_vencimento, date_trunc('month', p_mes_referencia)::date + interval '4 days');

  -- Cria ou pega o lote do mes
  INSERT INTO public.dominhas_lote_envio (mes_referencia, data_vencimento, status, criado_por)
  VALUES (p_mes_referencia, v_venc, 'rascunho', p_criado_por)
  ON CONFLICT (mes_referencia) DO UPDATE SET data_vencimento = EXCLUDED.data_vencimento
  RETURNING id INTO v_lote_id;

  -- Pra cada moradora ativa, cria boleto se ainda nao existe
  FOR v_moradora IN
    SELECT id, nome, email, telefone, unidade, quarto, valor_mensal
      FROM public.moradores
     WHERE COALESCE(status, 'ativa') = 'ativa'
       AND COALESCE(valor_mensal, 0) > 0
  LOOP
    INSERT INTO public.dominhas_boletos (
      lote_id, moradora_id, moradora_nome, moradora_email, moradora_whatsapp,
      unidade, quarto, mes_referencia, data_vencimento,
      valor_coliving, valor_total, status
    ) VALUES (
      v_lote_id, v_moradora.id, v_moradora.nome, v_moradora.email, v_moradora.telefone,
      v_moradora.unidade, v_moradora.quarto, p_mes_referencia, v_venc,
      v_moradora.valor_mensal, v_moradora.valor_mensal, 'pendente'
    )
    ON CONFLICT (moradora_id, mes_referencia) DO NOTHING;

    v_total_b := v_total_b + 1;
    v_total_v := v_total_v + v_moradora.valor_mensal;
  END LOOP;

  -- Atualiza totais no lote
  UPDATE public.dominhas_lote_envio
     SET total_boletos = v_total_b, total_valor = v_total_v
   WHERE id = v_lote_id;

  RETURN jsonb_build_object('success', true, 'lote_id', v_lote_id, 'total_boletos', v_total_b, 'total_valor', v_total_v);
END$$;

GRANT EXECUTE ON FUNCTION public.criar_lote_boletos_mes(date, date, text) TO service_role, anon, authenticated;

-- =========================================================
-- 5. FUNCAO MOCK: simula geracao de boleto (pra teste sem Inter)
--    Quando a integracao real estiver pronta, a real substitui essa
-- =========================================================
CREATE OR REPLACE FUNCTION public.gerar_boletos_mock(p_lote_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_b record;
  v_count int := 0;
  v_pix_fake text;
BEGIN
  UPDATE public.dominhas_lote_envio SET status = 'enviando' WHERE id = p_lote_id;

  FOR v_b IN
    SELECT id, valor_total, moradora_nome, mes_referencia
      FROM public.dominhas_boletos
     WHERE lote_id = p_lote_id AND status = 'pendente'
  LOOP
    -- PIX fake (formato BRCode simplificado)
    v_pix_fake := '00020126360014BR.GOV.BCB.PIX0114DOMUSGARDEN' ||
                  to_char(v_b.valor_total*100, 'FM00000000') ||
                  '5204000053039865802BR5913DOMUS GARDEN6009SAO PAULO62070503***6304ABCD';

    UPDATE public.dominhas_boletos
       SET inter_codigo_solicitacao = 'MOCK-' || substring(id::text, 1, 8),
           inter_nosso_numero       = 'NN' || lpad((random()*999999999)::int::text, 9, '0'),
           inter_linha_digitavel    = '00190.50095 40144.816069 06809.350314 1 ' || lpad((extract(epoch from now())::bigint)::text, 14, '0'),
           inter_codigo_barras      = '00191' || lpad((extract(epoch from now())::bigint)::text, 39, '0'),
           inter_pix_copia_cola     = v_pix_fake,
           inter_pdf_url            = NULL,  -- sem PDF real ainda
           status                   = 'gerado'
     WHERE id = v_b.id;
    v_count := v_count + 1;
  END LOOP;

  UPDATE public.dominhas_lote_envio
     SET status = 'enviado', enviado_em = now()
   WHERE id = p_lote_id;

  RETURN jsonb_build_object('success', true, 'modo', 'mock', 'gerados', v_count);
END$$;

GRANT EXECUTE ON FUNCTION public.gerar_boletos_mock(uuid) TO service_role, anon, authenticated;

-- =========================================================
-- 6. VIEW: boletos da moradora pra usar no Portal Dominhas
-- =========================================================
CREATE OR REPLACE VIEW public.v_boletos_moradora AS
SELECT
  id,
  moradora_id,
  moradora_nome,
  unidade, quarto,
  to_char(mes_referencia, 'TMMonth/YYYY') AS mes_label,
  mes_referencia,
  data_vencimento,
  valor_total,
  valor_coliving, valor_energia, valor_extras, valor_multas, valor_descontos,
  status,
  data_pagamento,
  inter_pdf_url,
  inter_pix_copia_cola,
  inter_linha_digitavel,
  baixado_em,
  CASE
    WHEN status = 'pago' THEN 'Pago'
    WHEN status = 'cancelado' THEN 'Cancelado'
    WHEN data_vencimento < CURRENT_DATE AND status != 'pago' THEN 'Vencido'
    WHEN data_vencimento = CURRENT_DATE THEN 'Vence hoje'
    WHEN data_vencimento - CURRENT_DATE <= 3 THEN 'Vence em breve'
    ELSE 'Em dia'
  END AS situacao_label
  FROM public.dominhas_boletos
 ORDER BY mes_referencia DESC, data_vencimento;

GRANT SELECT ON public.v_boletos_moradora TO authenticated, anon, service_role;

-- =========================================================
-- RESULTADO
-- =========================================================
SELECT
  'OK' AS status,
  jsonb_build_object(
    'tabelas',       ARRAY['dominhas_lote_envio', 'dominhas_boletos'],
    'funcoes',       ARRAY['criar_lote_boletos_mes', 'gerar_boletos_mock'],
    'view',          'v_boletos_moradora',
    'proximo_passo', 'Rodar: SELECT public.criar_lote_boletos_mes((current_date)::date);'
  ) AS detalhes;
