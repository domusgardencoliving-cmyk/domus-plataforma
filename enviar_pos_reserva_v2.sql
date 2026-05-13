-- enviar_pos_reserva v2: Azul Domus #008B9C + logo + acentos corretos
-- Dia das Mães 2026 — refeito com a Gabi
CREATE OR REPLACE FUNCTION public.enviar_pos_reserva(
  p_reserva_id uuid,
  p_email_override text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  r RECORD;
  v_email text;
  v_eh_ota boolean;
  v_assunto text;
  v_corpo text;
  v_ambiente text;
  v_unidade text;
  v_endereco text;
  v_unidade_nome text;
  v_bonus_block text := '';
  v_request_id bigint;
BEGIN
  SELECT res.id,
         COALESCE(NULLIF(h.nome,''), res.hospede_nome) AS hospede_nome,
         COALESCE(NULLIF(h.telefone,''), res.hospede_contato) AS hospede_contato,
         h.email AS hospede_email,
         res.cama, res.checkin, res.checkout,
         res.plataforma, res.canal_codigo, res.forma_pagamento,
         res.ambiente_id, res.unidade_codigo
    INTO r
    FROM public.reservas res
    LEFT JOIN public.hospedes h ON h.id = res.hospede_id
   WHERE res.id = p_reserva_id;

  v_email := COALESCE(NULLIF(p_email_override, ''),
                      NULLIF(r.hospede_email, ''),
                      'domusgardencoliving@gmail.com');

  v_eh_ota := COALESCE(r.canal_codigo, '') IN ('booking','airbnb','expedia','hostelworld')
              OR COALESCE(r.plataforma, '') ILIKE ANY (ARRAY['%booking%','%airbnb%','%expedia%','%hostel%world%']);

  v_ambiente := COALESCE(r.cama, 'sua acomodação');
  v_unidade  := CASE WHEN COALESCE(r.unidade_codigo, '') ILIKE 'rib%' THEN 'Rib' ELSE 'AP' END;
  v_unidade_nome := CASE WHEN v_unidade = 'Rib' THEN 'Ribeirão Claro' ELSE 'Andrade Pertence' END;
  v_endereco := CASE
    WHEN v_unidade = 'Rib'
      THEN 'Rua Ribeirão Claro, 547 — Vila Olímpia, São Paulo — CEP 04549-060'
    ELSE  'Rua Dr. Andrade Pertence, 73 — Vila Olímpia, São Paulo — CEP 04549-020'
  END;

  v_assunto := 'Sua reserva na Domus está confirmada — vem chegando!';

  IF v_eh_ota THEN
    v_bonus_block :=
      '<div style="background:#C9A961;color:#fff;padding:18px;border-radius:8px;margin:20px 24px 0;text-align:center">'
      || '<strong style="font-size:15px;display:block;margin-bottom:6px">Um carinho extra para a sua próxima vez</strong>'
      || '<span style="font-size:13px">Use o cupom <strong>VOLTA10</strong> e ganhe 10% OFF reservando direto pelo nosso site.</span>'
      || '</div>';
  END IF;

  v_corpo :=
    '<div style="background:#008B9C;padding:30px 0;font-family:Arial,sans-serif">'
    || '<div style="max-width:600px;margin:0 auto">'

    || '<div style="text-align:center;padding:0 24px 20px">'
    || '<img src="https://domusgardencoliving.com/logo-branco.png" alt="Domus Garden" style="max-width:180px;height:auto;display:inline-block">'
    || '</div>'

    || '<div style="background:#FFF8F0;padding:32px 24px;border-radius:12px;margin:0 16px;color:#333">'
    || '<h1 style="color:#0A3142;font-size:22px;margin:0 0 8px;text-align:center">'
    ||   'Que alegria ter você aqui, '
    ||   split_part(COALESCE(r.hospede_nome,'querido(a) hóspede'),' ',1)
    ||   '!'
    || '</h1>'
    || '<p style="color:#666;text-align:center;margin:0 0 24px">Sua reserva está confirmada. ♥</p>'

    || '<h2 style="color:#0A3142;font-size:16px;margin:24px 0 12px">Os detalhes</h2>'
    || '<p style="margin:6px 0"><strong>Acomodação:</strong> ' || v_ambiente || '</p>'
    || '<p style="margin:6px 0"><strong>Check-in:</strong> '   || to_char(r.checkin,  'DD/MM/YYYY') || ' a partir das 16h</p>'
    || '<p style="margin:6px 0"><strong>Check-out:</strong> '  || to_char(r.checkout, 'DD/MM/YYYY') || ' até 13h</p>'

    || '<h2 style="color:#0A3142;font-size:16px;margin:24px 0 12px">Como funciona o auto check-in</h2>'
    || '<p style="margin:6px 0">A Domus funciona em modo <strong>auto check-in</strong> — você chega na hora que quiser <strong>a partir das 16h</strong> e abre tudo com as senhas que vamos te enviar. <em>Sem esperar recepção, sem horário rígido, sem stress.</em></p>'

    || '<h2 style="color:#0A3142;font-size:16px;margin:24px 0 12px">No dia do seu check-in</h2>'
    || '<p style="margin:6px 0">Você vai receber pelo WhatsApp:</p>'
    || '<ul style="margin:8px 0;padding-left:24px;color:#333">'
    ||   '<li>Vídeo mostrando exatamente como chegar e entrar</li>'
    ||   '<li>Senha da <strong>porta da rua</strong></li>'
    ||   '<li>Senha da <strong>fechadura digital do seu quarto</strong></li>'
    ||   '<li>Wi-Fi e tudo que precisa pra se sentir em casa</li>'
    || '</ul>'

    || '<h2 style="color:#0A3142;font-size:16px;margin:24px 0 12px">O endereço</h2>'
    || '<p style="margin:6px 0"><strong>Domus ' || v_unidade_nome || '</strong></p>'
    || '<p style="margin:6px 0">' || v_endereco || '</p>'
    || '</div>'

    || v_bonus_block

    || '<div style="text-align:center;padding:24px;color:#FFF8F0;font-size:12px;line-height:1.6">'
    ||   'Domus Garden Coliving • Vila Olímpia, São Paulo<br>'
    ||   'Dúvidas? Responda este e-mail ou chame no WhatsApp <strong>(11) 94333-0911</strong>'
    || '</div>'

    || '</div></div>';

  SELECT enviar_email_gmail(v_email, v_assunto, v_corpo, 'Domus Garden') INTO v_request_id;
  RETURN 'email_enviado req=' || v_request_id || ' to=' || v_email;

EXCEPTION WHEN OTHERS THEN
  RETURN 'erro: ' || SQLERRM;
END;
$func$;
