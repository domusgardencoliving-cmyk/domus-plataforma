-- =========================================================
-- FIX: template dia_checkout estava faltando na funcao montar_mensagem_checkin
--
-- A funcao retornava {success:false, erro:'Template nao encontrado para momento dia_checkout'}
-- Vamos criar um WRAPPER que se a funcao original retornar erro pra dia_checkout,
-- monta a mensagem aqui (lembrete amigavel as 10h)
-- =========================================================

CREATE OR REPLACE FUNCTION public.montar_mensagem_dia_checkout(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_r record;
  v_primeiro_nome text;
  v_msg text;
BEGIN
  SELECT res.id, res.checkout, res.cama, res.unidade_codigo, res.canal_codigo,
         COALESCE(NULLIF(h.nome,''), res.hospede_nome, 'querido(a) hospede') AS nome,
         COALESCE(NULLIF(h.telefone,''), res.hospede_contato) AS telefone
    INTO v_r
    FROM public.reservas res
    LEFT JOIN public.hospedes h ON h.id = res.hospede_id
   WHERE res.id = p_reserva_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'reserva nao encontrada');
  END IF;

  v_primeiro_nome := split_part(v_r.nome, ' ', 1);

  v_msg := 'Bom dia, ' || v_primeiro_nome || '! ' || E'\n\n' ||
    'Hoje e seu ultimo dia conosco na Domus. ' || E'\n' ||
    'Check-out ate as *13h* — e so fechar a porta e ir embora, nao precisa devolver nada na recepcao. ' || E'\n\n' ||
    'Se precisar de mais tempo pra arrumar as coisas, e so responder essa mensagem que vamos verificar a possibilidade de estender o horario de saida ' || E'\n\n' ||
    'Foi muito bom ter voce aqui — esperamos te ver de novo em breve! ' || E'\n\n' ||
    '_— Equipe Domus Garden_';

  RETURN jsonb_build_object(
    'success', true,
    'aplicavel', true,
    'mensagem', v_msg,
    'telefone', v_r.telefone,
    'reserva_id', v_r.id
  );
END
$func$;

GRANT EXECUTE ON FUNCTION public.montar_mensagem_dia_checkout(uuid) TO service_role, authenticated, anon;

-- Patch na funcao principal: se chamar com dia_checkout, usa a nova
CREATE OR REPLACE FUNCTION public.montar_mensagem_checkin_v2(p_reserva_id uuid, p_momento text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_resp jsonb;
BEGIN
  -- Se for dia_checkout, usa a nova funcao especializada
  IF p_momento = 'dia_checkout' THEN
    RETURN public.montar_mensagem_dia_checkout(p_reserva_id);
  END IF;

  -- Se nao, chama a original
  v_resp := public.montar_mensagem_checkin(p_reserva_id, p_momento);
  RETURN v_resp;
END
$func$;

GRANT EXECUTE ON FUNCTION public.montar_mensagem_checkin_v2(uuid, text) TO service_role, authenticated, anon;

-- Atualizar processar_fila_mensagens pra usar v2
CREATE OR REPLACE FUNCTION public.processar_fila_mensagens(p_limite int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_item record;
  v_msg jsonb;
  v_processados int := 0;
  v_aplicaveis int := 0;
  v_nao_aplicaveis int := 0;
  v_erros int := 0;
BEGIN
  FOR v_item IN
    SELECT f.id, f.reserva_id, f.momento, r.hospede_contato
      FROM public.mensagens_whatsapp_fila f
      JOIN public.reservas r ON r.id = f.reserva_id
     WHERE f.status = 'pendente'
       AND f.agendado_para <= now()
       AND r.status != 'cancelada'
       AND COALESCE(r.nao_contabilizar, false) = false
     ORDER BY f.agendado_para ASC
     LIMIT p_limite
  LOOP
    BEGIN
      v_msg := public.montar_mensagem_checkin_v2(v_item.reserva_id, v_item.momento);

      IF (v_msg->>'success')::boolean = false THEN
        UPDATE public.mensagens_whatsapp_fila
           SET status = 'erro', erro_msg = v_msg->>'error', tentativas = tentativas + 1, atualizado_em = now()
         WHERE id = v_item.id;
        v_erros := v_erros + 1;
      ELSIF COALESCE((v_msg->>'aplicavel')::boolean, true) = false THEN
        UPDATE public.mensagens_whatsapp_fila
           SET status = 'nao_aplicavel', erro_msg = v_msg->>'motivo', atualizado_em = now()
         WHERE id = v_item.id;
        v_nao_aplicaveis := v_nao_aplicaveis + 1;
      ELSE
        UPDATE public.mensagens_whatsapp_fila
           SET status = 'pronto', mensagem_montada = v_msg->>'mensagem', telefone_destino = v_item.hospede_contato, atualizado_em = now()
         WHERE id = v_item.id;
        v_aplicaveis := v_aplicaveis + 1;
      END IF;

      v_processados := v_processados + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.mensagens_whatsapp_fila
         SET status = 'erro', erro_msg = SQLERRM, tentativas = tentativas + 1, atualizado_em = now()
       WHERE id = v_item.id;
      v_erros := v_erros + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('processados', v_processados, 'prontos_para_enviar', v_aplicaveis, 'nao_aplicaveis', v_nao_aplicaveis, 'erros', v_erros);
END
$func$;

-- Resetar mensagens dia_checkout que estavam erradas
UPDATE public.mensagens_whatsapp_fila SET status = 'pendente', erro_msg = NULL
 WHERE momento = 'dia_checkout' AND status IN ('erro', 'nao_aplicavel');

-- Re-processar a fila pra montar as mensagens
SELECT public.processar_fila_mensagens(200) AS resultado_processamento;

-- Validacao
SELECT jsonb_build_object(
  'mensagens_dia_checkout_prontas', (SELECT COUNT(*) FROM public.mensagens_whatsapp_fila WHERE momento='dia_checkout' AND status='pronto'),
  'mensagens_dia_checkout_pendentes', (SELECT COUNT(*) FROM public.mensagens_whatsapp_fila WHERE momento='dia_checkout' AND status='pendente'),
  'mensagens_dia_checkout_erros', (SELECT COUNT(*) FROM public.mensagens_whatsapp_fila WHERE momento='dia_checkout' AND status='erro'),
  'sample_msg', (SELECT mensagem_montada FROM public.mensagens_whatsapp_fila WHERE momento='dia_checkout' AND status='pronto' LIMIT 1)
) AS status_apos_patch;
