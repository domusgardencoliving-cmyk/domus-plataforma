-- =========================================================
-- TEMPLATES de resposta rápida no Átrio
-- Mensagens prontas que a Gabi clica e a IA personaliza com nome + reserva
-- =========================================================

CREATE TABLE IF NOT EXISTS public.templates_resposta_atrio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria text NOT NULL,
  nome text NOT NULL,
  conteudo text NOT NULL,
  variaveis text[],
  uso_total int DEFAULT 0,
  ativo boolean DEFAULT true,
  ordem int DEFAULT 0,
  criado_em timestamptz DEFAULT now()
);

ALTER TABLE public.templates_resposta_atrio ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS templates_atrio_anon ON public.templates_resposta_atrio;
CREATE POLICY templates_atrio_anon ON public.templates_resposta_atrio
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

INSERT INTO public.templates_resposta_atrio (categoria, nome, conteudo, variaveis, ordem) VALUES
-- Saudações
('saudacao', 'Bom dia', 'Bom dia, {nome}! Tudo bem? 🌿', ARRAY['nome'], 1),
('saudacao', 'Boa tarde', 'Boa tarde, {nome}! Como posso ajudar? ☀️', ARRAY['nome'], 2),
('saudacao', 'Boa noite', 'Boa noite, {nome}! Tudo certo aí? 🌙', ARRAY['nome'], 3),

-- Disponibilidade
('disponibilidade', 'Tem vaga sim', 'Oi {nome}! Sim, temos disponibilidade pra essas datas. Quer que eu separe pra você? 🏡', ARRAY['nome'], 10),
('disponibilidade', 'Sem vaga essa data', 'Oi {nome}, infelizmente essas datas estão lotadas. Mas posso ver outras datas próximas se quiser? 💚', ARRAY['nome'], 11),
('disponibilidade', 'Lista de espera', 'Oi {nome}! Posso te colocar na lista de espera. Se alguém cancelar, te aviso na hora ✨', ARRAY['nome'], 12),

-- Cupom / desconto
('cupom', 'Primeira reserva direta', 'Oi {nome}! Como é sua primeira pelo nosso site, separei o cupom *VOLTA10* (10% OFF) pra você 💚', ARRAY['nome'], 20),
('cupom', 'Recorrente', 'Oi {nome}! Pra você que já é da casa, separei um cupom especial. Posso enviar?', ARRAY['nome'], 21),

-- Check-in
('checkin', 'Confirmar chegada', 'Oi {nome}! Confirma pra mim seu horário aproximado de chegada? Pra eu deixar tudo prontinho 🌿', ARRAY['nome'], 30),
('checkin', 'Já posso entrar?', 'Oi {nome}! Check-in oficial é a partir das 16h. Se chegar antes, podemos verificar a possibilidade de entrar mais cedo. Que horas você chega?', ARRAY['nome'], 31),

-- Check-out
('checkout', 'Late check-out', 'Oi {nome}! Posso verificar a possibilidade de estender o horário de saída. Até que horas precisaria? Vou conferir agora.', ARRAY['nome'], 40),
('checkout', 'Esqueci algo', 'Oi {nome}! Pode descrever o que esqueceu? Vou checar no quarto e te dar um retorno rapidinho 💚', ARRAY['nome'], 41),

-- Endereço / Como chegar
('endereco', 'Endereço AP', 'Oi {nome}! O endereço é: *R. Andrade Pertence, 73 — Vila Olímpia, SP*. Atenção: temos 2 unidades na Vila Olímpia, então confere essa direitinho 😊', ARRAY['nome'], 50),
('endereco', 'Endereço Rib', 'Oi {nome}! O endereço é: *R. Ribeirão Claro, 547 — Vila Olímpia, SP*. Atenção: temos 2 unidades na Vila Olímpia, então confere essa direitinho 😊', ARRAY['nome'], 51),
('endereco', 'Como chegar Uber', 'Oi {nome}! O melhor é vir de Uber/99 — manda o endereço direto no app: {endereco}. Qualquer dificuldade me chama!', ARRAY['nome', 'endereco'], 52),

-- Pagamento
('pagamento', 'Pix copia e cola', 'Oi {nome}! Segue o Pix:' || E'\n\n' || '`{pix}`' || E'\n\n' || 'Total: R$ {valor}. Me avisa quando pagar pra eu confirmar 💚', ARRAY['nome', 'pix', 'valor'], 60),
('pagamento', 'Comprovante recebido', 'Oi {nome}! Recebi seu comprovante, tudo certo. Reserva confirmada! Te aguardo no dia 🌿', ARRAY['nome'], 61),

-- Encerramento
('encerramento', 'Beijo Domus', 'Qualquer coisa é só chamar! Beijo Domus 💚🌿', NULL, 90),
('encerramento', 'Até breve', 'Até breve! Foi um prazer ter você na Domus 💚', NULL, 91)
ON CONFLICT DO NOTHING;

SELECT 'OK Templates Atrio criados' AS status, COUNT(*) AS total FROM public.templates_resposta_atrio;
