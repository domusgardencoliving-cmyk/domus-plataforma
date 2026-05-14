-- =========================================================
-- SALA DE CONVERSAS DOMUS — Inbox unificado de todos os canais
--
-- Canais suportados:
--  - whatsapp (Meta Cloud API + automacao IA)
--  - instagram (Meta Graph API - mesma conta business)
--  - airbnb (email-to-inbox + futura API se Airbnb liberar)
--  - booking (extranet polling + email-to-inbox)
--  - webquartos (email-to-inbox)
--  - email (gmail SMTP/IMAP)
--  - manual (Gabi anota conversa que aconteceu fora)
-- =========================================================

-- 1. TABELA conversas (1 linha por hospede x canal)
CREATE TABLE IF NOT EXISTS public.conversas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal text NOT NULL CHECK (canal IN ('whatsapp','instagram','airbnb','booking','webquartos','email','manual')),
  identificador_externo text,
  hospede_id uuid REFERENCES public.hospedes(id) ON DELETE SET NULL,
  reserva_id uuid REFERENCES public.reservas(id) ON DELETE SET NULL,
  hospede_nome_cache text,
  hospede_telefone_cache text,
  hospede_avatar text,
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','aguardando_hospede','aguardando_gabi','aguardando_ia','arquivada','spam')),
  prioridade text DEFAULT 'normal' CHECK (prioridade IN ('baixa','normal','alta','vip','urgente')),
  ultima_mensagem_em timestamptz DEFAULT now(),
  ultima_mensagem_preview text,
  ultima_mensagem_direcao text CHECK (ultima_mensagem_direcao IN ('entrada','saida')),
  nao_lidas int DEFAULT 0,
  tags text[],
  ia_pode_responder boolean DEFAULT true,
  metadados jsonb DEFAULT '{}'::jsonb,
  criada_em timestamptz DEFAULT now(),
  atualizada_em timestamptz DEFAULT now(),
  UNIQUE (canal, identificador_externo)
);

CREATE INDEX IF NOT EXISTS idx_conversas_canal_status ON public.conversas (canal, status);
CREATE INDEX IF NOT EXISTS idx_conversas_ultima ON public.conversas (ultima_mensagem_em DESC);
CREATE INDEX IF NOT EXISTS idx_conversas_hospede ON public.conversas (hospede_id);
CREATE INDEX IF NOT EXISTS idx_conversas_reserva ON public.conversas (reserva_id);

-- 2. TABELA mensagens (cada msg individual)
CREATE TABLE IF NOT EXISTS public.mensagens_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id uuid NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  direcao text NOT NULL CHECK (direcao IN ('entrada','saida')),
  autor text,
  autor_tipo text CHECK (autor_tipo IN ('hospede','gabi','denilton','ia','sistema','automatico')),
  conteudo text,
  conteudo_html text,
  tipo text DEFAULT 'texto' CHECK (tipo IN ('texto','imagem','video','audio','documento','localizacao','sistema','template','reacao')),
  midia_url text,
  midia_mime text,
  enviada_em timestamptz NOT NULL DEFAULT now(),
  lida_em timestamptz,
  status_envio text DEFAULT 'enviada' CHECK (status_envio IN ('enviada','entregue','lida','falhou','agendada','rascunho')),
  external_message_id text,
  reply_to_id uuid REFERENCES public.mensagens_inbox(id) ON DELETE SET NULL,
  metadados jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_msg_conversa_data ON public.mensagens_inbox (conversa_id, enviada_em DESC);
CREATE INDEX IF NOT EXISTS idx_msg_external_id ON public.mensagens_inbox (external_message_id);
CREATE INDEX IF NOT EXISTS idx_msg_nao_lidas ON public.mensagens_inbox (conversa_id) WHERE lida_em IS NULL AND direcao = 'entrada';

-- 3. TABELA respostas_ia_sugeridas (IA propõe, Gabi aprova/edita)
CREATE TABLE IF NOT EXISTS public.respostas_ia_sugeridas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id uuid NOT NULL REFERENCES public.conversas(id) ON DELETE CASCADE,
  mensagem_origem_id uuid REFERENCES public.mensagens_inbox(id) ON DELETE SET NULL,
  resposta_sugerida text NOT NULL,
  contexto_usado jsonb,
  modelo_ia text,
  confianca numeric,
  status text DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','editada','rejeitada','enviada_auto')),
  resposta_final_enviada text,
  decidida_em timestamptz,
  decidida_por text,
  criada_em timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_respostas_ia_pendentes ON public.respostas_ia_sugeridas (conversa_id, status, criada_em DESC);

-- 4. TABELA contas_canais (credenciais e config de cada conta conectada)
CREATE TABLE IF NOT EXISTS public.contas_canais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canal text NOT NULL,
  nome_amigavel text,
  identificador text,
  status text DEFAULT 'desconectado' CHECK (status IN ('conectado','desconectado','erro','aguardando_aprovacao')),
  config jsonb DEFAULT '{}'::jsonb,
  ultima_sync_em timestamptz,
  total_conversas int DEFAULT 0,
  total_mensagens int DEFAULT 0,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now()
);

INSERT INTO public.contas_canais (canal, nome_amigavel, identificador, status, config) VALUES
  ('whatsapp', 'WhatsApp Domus (chip novo)', '+55 11 ?????-????', 'aguardando_aprovacao',
   '{"meta_app_id":"4485544395009504","aguardando":"chip novo + Etapa 2 Meta"}'::jsonb),
  ('instagram', 'Instagram @domusgardencoliving', '@domusgardencoliving', 'desconectado',
   '{"plano":"conectar via Meta Business mesmo app"}'::jsonb),
  ('airbnb', 'Airbnb Domus Garden', '?', 'desconectado',
   '{"plano":"email-to-inbox via forward Airbnb -> Edge Function","limitacao":"Airbnb nao tem API publica de mensagens"}'::jsonb),
  ('booking', 'Booking.com Domus Garden', '?', 'desconectado',
   '{"plano":"polling extranet (precisa login automatizado) OU forward email","limitacao":"API Booking restrita"}'::jsonb),
  ('webquartos', 'Webquartos Domus Garden', '?', 'desconectado',
   '{"plano":"forward email Webquartos -> Edge Function","investigar":"se tem API"}'::jsonb)
ON CONFLICT DO NOTHING;

-- 5. RLS basica
ALTER TABLE public.conversas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversas_anon_all ON public.conversas;
CREATE POLICY conversas_anon_all ON public.conversas FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.mensagens_inbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS msg_anon_all ON public.mensagens_inbox;
CREATE POLICY msg_anon_all ON public.mensagens_inbox FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.respostas_ia_sugeridas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resp_ia_anon ON public.respostas_ia_sugeridas;
CREATE POLICY resp_ia_anon ON public.respostas_ia_sugeridas FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.contas_canais ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contas_anon ON public.contas_canais;
CREATE POLICY contas_anon ON public.contas_canais FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 6. FUNCAO helper: registrar mensagem entrada (chamada pelos webhooks)
CREATE OR REPLACE FUNCTION public.registrar_mensagem_entrada(
  p_canal text,
  p_identificador_externo text,
  p_hospede_nome text,
  p_hospede_telefone text,
  p_conteudo text,
  p_tipo text DEFAULT 'texto',
  p_external_message_id text DEFAULT NULL,
  p_metadados jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_conversa_id uuid;
  v_msg_id uuid;
  v_hospede_id uuid;
BEGIN
  -- Acha hospede pelo telefone (se for WhatsApp)
  IF p_hospede_telefone IS NOT NULL THEN
    SELECT id INTO v_hospede_id FROM public.hospedes
     WHERE telefone = p_hospede_telefone OR telefone = REGEXP_REPLACE(p_hospede_telefone, '\D','','g')
     LIMIT 1;
  END IF;

  -- Acha ou cria conversa
  SELECT id INTO v_conversa_id FROM public.conversas
   WHERE canal = p_canal AND identificador_externo = p_identificador_externo
   LIMIT 1;

  IF v_conversa_id IS NULL THEN
    INSERT INTO public.conversas (canal, identificador_externo, hospede_id, hospede_nome_cache, hospede_telefone_cache, status, ultima_mensagem_preview, ultima_mensagem_direcao, nao_lidas)
    VALUES (p_canal, p_identificador_externo, v_hospede_id, p_hospede_nome, p_hospede_telefone, 'aberta', LEFT(p_conteudo, 100), 'entrada', 1)
    RETURNING id INTO v_conversa_id;
  ELSE
    UPDATE public.conversas SET
      ultima_mensagem_em = now(),
      ultima_mensagem_preview = LEFT(p_conteudo, 100),
      ultima_mensagem_direcao = 'entrada',
      nao_lidas = nao_lidas + 1,
      status = 'aguardando_gabi',
      atualizada_em = now(),
      hospede_nome_cache = COALESCE(NULLIF(p_hospede_nome, ''), hospede_nome_cache)
    WHERE id = v_conversa_id;
  END IF;

  -- Insere mensagem
  INSERT INTO public.mensagens_inbox (conversa_id, direcao, autor, autor_tipo, conteudo, tipo, external_message_id, metadados)
  VALUES (v_conversa_id, 'entrada', p_hospede_nome, 'hospede', p_conteudo, p_tipo, p_external_message_id, p_metadados)
  RETURNING id INTO v_msg_id;

  RETURN v_msg_id;
END
$func$;

GRANT EXECUTE ON FUNCTION public.registrar_mensagem_entrada(text, text, text, text, text, text, text, jsonb) TO service_role, authenticated, anon;

-- 7. RESULTADO
SELECT 'OK - Sala de Conversas Domus pronta' AS status,
  (SELECT COUNT(*) FROM public.contas_canais) AS contas_canais_pre_cadastradas;
