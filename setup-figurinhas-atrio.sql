-- ============================================================
-- SETUP: Figurinhas salvas no Átrio
-- ============================================================
-- Tabela pra salvar stickers que chegam ou que a Gabi quer reusar.
-- A integração completa (upload pro Storage + galeria visual) vai
-- ser feita junto com o deploy da Z-API.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.figurinhas_salvas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL,        -- URL no Supabase Storage (bucket "figurinhas")
  emoji_alt   text,                  -- emoji ou texto alternativo
  origem      text,                  -- 'recebida' (de hóspede) ou 'upload' (Gabi enviou)
  origem_msg_id uuid REFERENCES public.mensagens_inbox(id) ON DELETE SET NULL,
  usos_total  int DEFAULT 0,
  favorito    boolean DEFAULT false,
  criada_em   timestamptz DEFAULT now(),
  criada_por  text                   -- email ou 'gabi'
);

CREATE INDEX IF NOT EXISTS idx_figurinhas_favoritas ON public.figurinhas_salvas(favorito DESC, usos_total DESC);

ALTER TABLE public.figurinhas_salvas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS figurinhas_admin_all ON public.figurinhas_salvas;
CREATE POLICY figurinhas_admin_all ON public.figurinhas_salvas
  FOR ALL TO authenticated, service_role, anon USING (true) WITH CHECK (true);

SELECT 'tabela figurinhas_salvas criada ✅' AS status;
