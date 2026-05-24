-- ============================================================
-- SETUP: Disponibilidade de Visitas (Schema + RPCs)
-- ============================================================
-- Cria:
--   1. Tabela visitas_config (horários por dia da semana, intervalo)
--   2. Tabela visitas_bloqueios (datas bloqueadas — viagens, feriados)
--   3. RPC obter_horarios_disponiveis(p_data date) — usada pelo /agendar-visita
--   4. RPC admin_bloquear_data, admin_desbloquear_data, admin_atualizar_horarios
-- ============================================================

BEGIN;

-- 1) Config de horários por dia da semana (1=segunda, 7=domingo)
CREATE TABLE IF NOT EXISTS public.visitas_config (
  dia_semana    int  PRIMARY KEY CHECK (dia_semana BETWEEN 0 AND 6),  -- 0=domingo, 6=sábado
  ativo         boolean NOT NULL DEFAULT true,
  hora_inicio   time NOT NULL DEFAULT '11:00',
  hora_fim      time NOT NULL DEFAULT '18:30',
  intervalo_min int  NOT NULL DEFAULT 30 CHECK (intervalo_min IN (15, 30, 60)),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Insere config padrão se ainda não existir (todos os dias 11h-18:30, slots de 30min)
INSERT INTO public.visitas_config (dia_semana, ativo, hora_inicio, hora_fim, intervalo_min)
VALUES
  (0, true, '11:00', '18:30', 30),  -- Dom
  (1, true, '11:00', '18:30', 30),  -- Seg
  (2, true, '11:00', '18:30', 30),  -- Ter
  (3, true, '11:00', '18:30', 30),  -- Qua
  (4, true, '11:00', '18:30', 30),  -- Qui
  (5, true, '11:00', '18:30', 30),  -- Sex
  (6, true, '11:00', '18:30', 30)   -- Sáb
ON CONFLICT (dia_semana) DO NOTHING;

-- 2) Bloqueios de datas específicas (Gabi viajando, feriado, etc.)
CREATE TABLE IF NOT EXISTS public.visitas_bloqueios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_inicio date NOT NULL,
  data_fim    date NOT NULL CHECK (data_fim >= data_inicio),
  motivo      text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitas_bloqueios_range
  ON public.visitas_bloqueios (data_inicio, data_fim);

-- 3) RPC pública: usada pelo agendar-visita.html pra saber os slots
CREATE OR REPLACE FUNCTION public.obter_horarios_disponiveis(p_data date)
RETURNS TABLE (slot time, ocupado boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dia_semana int;
  v_config public.visitas_config%ROWTYPE;
  v_bloqueio_existe boolean;
  v_hora time;
BEGIN
  -- Se está bloqueado, retorna vazio
  SELECT EXISTS (
    SELECT 1 FROM public.visitas_bloqueios
     WHERE p_data BETWEEN data_inicio AND data_fim
  ) INTO v_bloqueio_existe;
  IF v_bloqueio_existe THEN
    RETURN;
  END IF;

  -- Pega config do dia (0=Domingo até 6=Sábado em EXTRACT(DOW))
  v_dia_semana := EXTRACT(DOW FROM p_data)::int;
  SELECT * INTO v_config FROM public.visitas_config WHERE dia_semana = v_dia_semana;

  -- Se dia desativado, retorna vazio
  IF NOT FOUND OR NOT v_config.ativo THEN
    RETURN;
  END IF;

  -- Gera slots entre hora_inicio e hora_fim com intervalo configurado
  v_hora := v_config.hora_inicio;
  WHILE v_hora <= v_config.hora_fim LOOP
    slot := v_hora;
    SELECT EXISTS (
      SELECT 1 FROM public.visitas_agendadas
       WHERE data = p_data
         AND horario = v_hora
         AND status NOT IN ('cancelado', 'no_show')
    ) INTO ocupado;
    RETURN NEXT;
    v_hora := v_hora + (v_config.intervalo_min || ' minutes')::interval;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.obter_horarios_disponiveis(date) TO anon, authenticated;

-- 4) RPCs admin (precisam de service_role ou auth admin)

CREATE OR REPLACE FUNCTION public.admin_bloquear_data(
  p_data_inicio date,
  p_data_fim date DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.visitas_bloqueios (data_inicio, data_fim, motivo)
  VALUES (p_data_inicio, COALESCE(p_data_fim, p_data_inicio), p_motivo)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_bloquear_data(date, date, text) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.admin_desbloquear_data(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.visitas_bloqueios WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_desbloquear_data(uuid) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.admin_atualizar_horarios(
  p_dia_semana int,
  p_ativo boolean,
  p_hora_inicio time,
  p_hora_fim time,
  p_intervalo_min int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.visitas_config
     SET ativo = p_ativo,
         hora_inicio = p_hora_inicio,
         hora_fim = p_hora_fim,
         intervalo_min = p_intervalo_min,
         atualizado_em = now()
   WHERE dia_semana = p_dia_semana;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_atualizar_horarios(int, boolean, time, time, int) TO service_role, authenticated;

-- RPCs pra ler config e listar bloqueios (pra a tela admin renderizar)
CREATE OR REPLACE FUNCTION public.admin_listar_config_horarios()
RETURNS SETOF public.visitas_config
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM public.visitas_config ORDER BY dia_semana;
$$;
GRANT EXECUTE ON FUNCTION public.admin_listar_config_horarios() TO service_role, authenticated, anon;

CREATE OR REPLACE FUNCTION public.admin_listar_bloqueios()
RETURNS SETOF public.visitas_bloqueios
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM public.visitas_bloqueios
   WHERE data_fim >= CURRENT_DATE
   ORDER BY data_inicio;
$$;
GRANT EXECUTE ON FUNCTION public.admin_listar_bloqueios() TO service_role, authenticated, anon;

COMMIT;

-- ============================================================
-- TESTE: confirma que as RPCs funcionam
-- ============================================================
-- SELECT * FROM admin_listar_config_horarios();
-- SELECT * FROM obter_horarios_disponiveis(CURRENT_DATE + 1);
-- SELECT admin_bloquear_data('2026-06-10', '2026-06-17', 'Viagem Santos');
-- SELECT * FROM admin_listar_bloqueios();
