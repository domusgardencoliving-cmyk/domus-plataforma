/**
 * NOTAS OCR — adicionar coluna arquivo_url
 *
 * Pra que o histórico de notas processadas mostre a opção de
 * VER ou BAIXAR a nota fiscal original que foi lida pela IA.
 *
 * O arquivo é subido pro bucket "comprovantes" (pasta "notas-ocr/")
 * no momento em que a Gabi confirma o lançamento.
 *
 * Como rodar: cole no SQL Editor do Supabase e Run.
 */

-- 1. Adiciona coluna arquivo_url se ainda não existe
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='notas_ocr' AND column_name='arquivo_url') THEN
    ALTER TABLE public.notas_ocr ADD COLUMN arquivo_url text;
  END IF;
END$$;

-- 2. Garante que o bucket "comprovantes" existe e é public-read
INSERT INTO storage.buckets (id, name, public)
VALUES ('comprovantes', 'comprovantes', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 3. Política: qualquer um pode LER (necessário pra mostrar a imagem no modal)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='storage' AND tablename='objects'
       AND policyname='comprovantes_public_read'
  ) THEN
    EXECUTE 'CREATE POLICY "comprovantes_public_read" ON storage.objects FOR SELECT USING (bucket_id = ''comprovantes'')';
  END IF;
END$$;

-- 4. Política: usuários autenticados (e anon, que é como o app funciona) podem fazer upload
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='storage' AND tablename='objects'
       AND policyname='comprovantes_anon_insert'
  ) THEN
    EXECUTE 'CREATE POLICY "comprovantes_anon_insert" ON storage.objects FOR INSERT WITH CHECK (bucket_id = ''comprovantes'')';
  END IF;
END$$;

-- Resultado
SELECT
  'OK' AS status,
  jsonb_build_object(
    'coluna_arquivo_url', (SELECT column_name FROM information_schema.columns
                            WHERE table_schema='public' AND table_name='notas_ocr' AND column_name='arquivo_url'),
    'bucket_comprovantes_publico', (SELECT public FROM storage.buckets WHERE id = 'comprovantes'),
    'notas_existentes', (SELECT count(*) FROM notas_ocr),
    'notas_com_arquivo', (SELECT count(*) FROM notas_ocr WHERE arquivo_url IS NOT NULL)
  ) AS detalhes;
