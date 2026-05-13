/**
 * SETUP V2 — Mensagens de check-in COMPLETAS no padrão real da Gabi
 *
 * O que esse SQL faz:
 *   1. Adiciona coluna `localizacao` na tabela senhas_portas
 *   2. Atualiza as 7 senhas reais dos quartos (Studio 1/2, Individual 3/4/5, Hostel 6/7)
 *   3. Substitui o template PADRAO 'dia_checkin' pelo formato real (com WiFi correto,
 *      lavanderia OMO, mercadinho, silêncio, procedimento de check-out, etc)
 *   4. Cria templates específicos por quarto incluindo a localização interna
 *   5. Atualiza a função montar_mensagem_checkin pra usar a localização dinâmica
 *
 * Como rodar: cole TUDO no SQL Editor do Supabase e Run.
 */

-- =========================================================
-- 1. ADICIONAR coluna localizacao em senhas_portas
-- =========================================================
ALTER TABLE public.senhas_portas
  ADD COLUMN IF NOT EXISTS localizacao text;

-- =========================================================
-- 2. ATUALIZAR senhas reais + localizações
-- =========================================================
UPDATE public.senhas_portas SET senha = '2405', localizacao = 'Ao entrar na casa, o Studio 1 é a primeira porta de frente ao jardim.', confirmada = true WHERE quarto_codigo = 'Studio 1';
UPDATE public.senhas_portas SET senha = '1501', localizacao = '(localização do Studio 2 a configurar)', confirmada = false WHERE quarto_codigo = 'Studio 2';
UPDATE public.senhas_portas SET senha = '2302', localizacao = 'Ao entrar na casa, siga o corredor até o final (casa de trás). Suba a escada e, no topo, o Individual 3 será a primeira porta à esquerda.', confirmada = true WHERE quarto_codigo = 'Individual 3';
UPDATE public.senhas_portas SET senha = '1007', localizacao = '(localização do Individual 4 a configurar)', confirmada = false WHERE quarto_codigo = 'Individual 4';
UPDATE public.senhas_portas SET senha = '1103', localizacao = '(localização do Individual 5 a configurar)', confirmada = false WHERE quarto_codigo = 'Individual 5';
UPDATE public.senhas_portas SET senha = '0911', localizacao = 'Ao entrar na casa, siga o corredor até o final (casa de trás). Suba a escada e, no topo, o Hostel 6 será a primeira porta de frente.', confirmada = true WHERE quarto_codigo = 'Hostel 6';
UPDATE public.senhas_portas SET senha = '1234', localizacao = '(localização do Hostel 7 a configurar)', confirmada = false WHERE quarto_codigo = 'Hostel 7';

-- =========================================================
-- 3. NOVO TEMPLATE PADRAO dia_checkin (formato REAL completo)
-- =========================================================
INSERT INTO public.templates_mensagens_checkin (quarto_codigo, momento, titulo, mensagem)
VALUES ('PADRAO', 'dia_checkin', 'Instruções de check-in',
'*🏠 INSTRUÇÕES DE CHECK-IN | Domus Garden*

Bem-vindo(a)! 🌿 Ficamos felizes em ter você aqui. Abaixo, as informações para sua estadia no *{quarto}*:

💡 *Detalhe importante!* A Domus tem duas casas na Vila Olímpia 😊
A sua estadia é na: *{unidade_nome}*
📍 {endereco}
🗺️ Google Maps: {endereco_maps}

*🔐 Acesso à Casa*
Portão principal: Senha *{senha_quarto}#* (Passe a mão pela fechadura para os números acenderem).
Senha do quarto ({quarto}): *{senha_quarto}*✔️

*📍 Localização*
{localizacao}

*📶 Wi-Fi*
Rede: Domus Garden Coliving
Senha: Domus011223

*⏰ Horários Importantes*
Check-in: A partir das 16h
Check-out: Até as 13h
Silêncio: Das 23h às 7h

{linha_cama}*🧺 Facilidades*
Coworking: Acesso pela escada caracol no jardim. Disponível das 7h às 23h (apague as luzes ao sair, por favor).
Lavanderia OMO: Fichas a R$ 22,90. Peça via WhatsApp e pague pelo link do mercado abaixo.
Mini Mercado: https://loja.infinitepay.io/mercadinho_domus-garden

*🧹 Ao sair (Check-out)*
Pedimos que remova lençóis e fronhas e os coloque dentro da fronha do travesseiro, deixando-os no canto da cama. Não precisa incluir toalha e cobertor. Por favor, organize seu lixo.

*Atendimento via WhatsApp:* Das 9h às 21h. Fora desse horário, responderemos o mais rápido possível.

Aproveite sua estadia! 💚')
ON CONFLICT (quarto_codigo, momento) DO UPDATE
  SET mensagem = EXCLUDED.mensagem, titulo = EXCLUDED.titulo, atualizado_em = now();

-- Remover templates específicos de quarto antigos (a função vai usar o PADRAO + dados dinâmicos)
DELETE FROM public.templates_mensagens_checkin
 WHERE momento = 'dia_checkin'
   AND quarto_codigo IN ('Studio 1','Studio 2','Individual 3','Individual 4','Individual 5','Hostel 6','Hostel 7');

-- =========================================================
-- 4. ATUALIZAR FUNÇÃO MONTAR MENSAGEM
-- =========================================================
CREATE OR REPLACE FUNCTION public.montar_mensagem_checkin(p_reserva_id uuid, p_momento text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reserva       record;
  v_template      record;
  v_quarto_grupo  text;
  v_senha_quarto  text;
  v_senha_portao  text;
  v_localizacao   text;
  v_msg           text;
  v_unidade       text;
  v_unidade_nome  text;
  v_endereco      text;
  v_endereco_maps text;
  v_linha_cama    text;
BEGIN
  SELECT * INTO v_reserva FROM public.reservas WHERE id = p_reserva_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'erro', 'Reserva não encontrada');
  END IF;

  v_quarto_grupo := CASE
    WHEN v_reserva.cama ILIKE '%studio 1%' THEN 'Studio 1'
    WHEN v_reserva.cama ILIKE '%studio 2%' THEN 'Studio 2'
    WHEN v_reserva.cama ILIKE '%individual 3%' OR v_reserva.cama ILIKE '%ind%3%' THEN 'Individual 3'
    WHEN v_reserva.cama ILIKE '%individual 4%' OR v_reserva.cama ILIKE '%ind%4%' THEN 'Individual 4'
    WHEN v_reserva.cama ILIKE '%individual 5%' OR v_reserva.cama ILIKE '%ind%5%' THEN 'Individual 5'
    WHEN v_reserva.cama ILIKE '%hostel 6%' OR v_reserva.cama ILIKE '%h6%' THEN 'Hostel 6'
    WHEN v_reserva.cama ILIKE '%hostel 7%' OR v_reserva.cama ILIKE '%h7%' THEN 'Hostel 7'
    ELSE 'PADRAO'
  END;

  v_unidade := COALESCE(
    NULLIF(UPPER(v_reserva.unidade), ''),
    CASE
      WHEN v_reserva.cama ILIKE '%rib%' OR v_reserva.cama ILIKE '%ribeir%' THEN 'RIB'
      WHEN v_reserva.quarto ILIKE '%rib%' OR v_reserva.quarto ILIKE '%ribeir%' THEN 'RIB'
      ELSE 'AP'
    END
  );

  IF v_unidade = 'RIB' THEN
    v_unidade_nome  := 'Domus Ribeirão Claro';
    v_endereco      := 'R. Ribeirão Claro, 547 - Vila Olímpia, São Paulo';
    v_endereco_maps := 'https://maps.app.goo.gl/?q=R.+Ribeir%C3%A3o+Claro,+547+-+Vila+Ol%C3%ADmpia,+S%C3%A3o+Paulo';
  ELSE
    v_unidade_nome  := 'Domus Andrade Pertence';
    v_endereco      := 'R. Doutor Andrade Pertence, 73 - Vila Olímpia, São Paulo';
    v_endereco_maps := 'https://maps.app.goo.gl/?q=R.+Doutor+Andrade+Pertence,+73+-+Vila+Ol%C3%ADmpia,+S%C3%A3o+Paulo';
  END IF;

  -- Pega template específico ou cai no PADRAO
  SELECT * INTO v_template FROM public.templates_mensagens_checkin
   WHERE quarto_codigo = v_quarto_grupo AND momento = p_momento AND ativo = true LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO v_template FROM public.templates_mensagens_checkin
     WHERE quarto_codigo = 'PADRAO' AND momento = p_momento AND ativo = true LIMIT 1;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'erro', 'Template não encontrado para momento ' || p_momento);
  END IF;

  -- Senha + localizacao do quarto
  SELECT senha, localizacao INTO v_senha_quarto, v_localizacao
    FROM public.senhas_portas WHERE quarto_codigo = v_quarto_grupo;
  v_senha_quarto := COALESCE(v_senha_quarto, '****');
  v_localizacao  := COALESCE(v_localizacao, '(localização a configurar)');
  v_senha_portao := v_senha_quarto;  -- mesma senha (portão = quarto, padrão Domus)

  -- Linha extra pro Hostel pedir nº da cama
  IF v_quarto_grupo IN ('Hostel 6', 'Hostel 7') THEN
    v_linha_cama := E'*Por favor, nos informe o número da cama escolhida assim que se acomodar. 🛏️*\n\n';
  ELSE
    v_linha_cama := '';
  END IF;

  v_msg := v_template.mensagem;
  v_msg := REPLACE(v_msg, '{nome}',          COALESCE(SPLIT_PART(v_reserva.hospede_nome, ' ', 1), 'hóspede'));
  v_msg := REPLACE(v_msg, '{quarto}',        COALESCE(v_reserva.quarto, v_quarto_grupo, ''));
  v_msg := REPLACE(v_msg, '{cama}',          COALESCE(v_reserva.cama, ''));
  v_msg := REPLACE(v_msg, '{data_checkin}',  TO_CHAR(v_reserva.checkin, 'DD/MM/YYYY'));
  v_msg := REPLACE(v_msg, '{data_checkout}', TO_CHAR(v_reserva.checkout, 'DD/MM/YYYY'));
  v_msg := REPLACE(v_msg, '{endereco}',      v_endereco);
  v_msg := REPLACE(v_msg, '{endereco_maps}', v_endereco_maps);
  v_msg := REPLACE(v_msg, '{unidade}',       v_unidade);
  v_msg := REPLACE(v_msg, '{unidade_nome}',  v_unidade_nome);
  v_msg := REPLACE(v_msg, '{senha_quarto}',  v_senha_quarto);
  v_msg := REPLACE(v_msg, '{senha_portao}',  v_senha_portao);
  v_msg := REPLACE(v_msg, '{localizacao}',   v_localizacao);
  v_msg := REPLACE(v_msg, '{linha_cama}',    v_linha_cama);
  v_msg := REPLACE(v_msg, '{tecla}',         '#');
  v_msg := REPLACE(v_msg, '{video_url}',     COALESCE(v_template.video_url, '(em breve)'));
  v_msg := REPLACE(v_msg, '{link_avaliacao}','https://g.page/r/CSfDqfrq_hOEEBM/review');

  RETURN jsonb_build_object(
    'success', true,
    'mensagem', v_msg,
    'titulo', v_template.titulo,
    'unidade', v_unidade,
    'unidade_nome', v_unidade_nome,
    'endereco', v_endereco
  );
END$$;

GRANT EXECUTE ON FUNCTION public.montar_mensagem_checkin(uuid, text) TO service_role, anon, authenticated;

SELECT 'OK - mensagens completas no padrão Domus' AS status;
