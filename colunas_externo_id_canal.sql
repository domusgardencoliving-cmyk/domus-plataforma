-- =========================================================
-- Colunas pra ingestores iCal (Booking/Airbnb/Webquartos diretos)
-- =========================================================

ALTER TABLE public.reservas
  ADD COLUMN IF NOT EXISTS externo_id_canal text,
  ADD COLUMN IF NOT EXISTS origem_dados text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_externo_id_canal
  ON public.reservas (externo_id_canal)
  WHERE externo_id_canal IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reservas_origem_dados
  ON public.reservas (origem_dados)
  WHERE origem_dados IS NOT NULL;

COMMENT ON COLUMN public.reservas.externo_id_canal IS 'ID da reserva no canal de origem (BOOKING_ICAL_xxx, AIRBNB_HMxxx, WEBQUARTOS_xxx). UNIQUE pra impedir duplicar mesma reserva da OTA';
COMMENT ON COLUMN public.reservas.origem_dados IS 'Como a reserva chegou no DG: ical_booking, ical_airbnb, ical_webquartos, hospedin, direto, manual';

SELECT 'OK colunas iCal adicionadas' AS status,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='reservas'
           AND column_name IN ('externo_id_canal','origem_dados')) AS colunas_criadas;
