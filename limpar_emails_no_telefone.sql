-- =========================================================
-- LIMPAR 265 RESERVAS COM EMAIL NO CAMPO TELEFONE
--
-- Causa: ao puxar reservas do Booking/Airbnb, o "telefone" vinha
-- como o e-mail tipo "fforge.892304@guest.booking.com"
-- Isso quebra wa.me que extrai "892304" como telefone
--
-- Solução:
-- 1. Toda reserva com @ em hospede_contato → setar NULL
-- 2. Re-extração do telefone real é feita via JS depois (puxando do JSON
--    da página Hospedin /reservations/{id}/edit, regex "phone":"...")
-- =========================================================

-- 1. Diagnóstico: quantas reservas tem o problema?
SELECT 'ANTES' AS momento,
  COUNT(*) AS total_com_email_no_tel,
  COUNT(*) FILTER (WHERE checkin >= CURRENT_DATE) AS futuras_afetadas
  FROM public.reservas
 WHERE hospede_contato LIKE '%@%';

-- 2. Salva backup do que estava
CREATE TABLE IF NOT EXISTS public.backup_emails_no_telefone (
  reserva_id uuid PRIMARY KEY,
  hospede_contato_antigo text,
  hospede_nome text,
  canal_codigo text,
  checkin date,
  salvo_em timestamptz DEFAULT now()
);

INSERT INTO public.backup_emails_no_telefone (reserva_id, hospede_contato_antigo, hospede_nome, canal_codigo, checkin)
SELECT id, hospede_contato, hospede_nome, canal_codigo, checkin
  FROM public.reservas
 WHERE hospede_contato LIKE '%@%'
ON CONFLICT (reserva_id) DO NOTHING;

-- 3. Limpa: seta NULL onde tem @
UPDATE public.reservas
   SET hospede_contato = NULL
 WHERE hospede_contato LIKE '%@%';

-- 4. Diagnóstico final
SELECT 'DEPOIS' AS momento,
  COUNT(*) AS total_com_email_no_tel,
  (SELECT COUNT(*) FROM public.backup_emails_no_telefone) AS backup_salvos,
  (SELECT COUNT(*) FROM public.reservas WHERE hospede_contato IS NULL AND checkin >= CURRENT_DATE
     AND COALESCE(status,'') != 'cancelada' AND COALESCE(nao_contabilizar,false) = false) AS futuras_sem_tel
  FROM public.reservas
 WHERE hospede_contato LIKE '%@%';

-- 5. Nota: re-extracao via JS do PMS (puxa /reservations/{id}/edit da Hospedin
--    e extrai phone do WhatsAppPopover JSON via regex)
SELECT 'OK - emails removidos do campo telefone. Re-extracao via PMS.' AS resultado;
