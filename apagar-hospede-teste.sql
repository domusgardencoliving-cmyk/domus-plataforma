-- ============================================================
-- Apagar o hóspede "Teste" do CRM
-- ============================================================

-- 1) Localiza o Teste e quantas reservas tem
SELECT id, nome, COUNT(r.id) AS qtd_reservas
  FROM hospedes h
  LEFT JOIN reservas r ON r.hospede_id = h.id
 WHERE LOWER(h.nome) = 'teste' OR LOWER(h.nome) LIKE 'teste %' OR LOWER(h.nome) = 'test'
 GROUP BY h.id, h.nome;

-- 2) Se aparecer e tiver reservas: limpa as reservas antes (são fake)
DELETE FROM reservas
 WHERE hospede_id IN (
   SELECT id FROM hospedes
    WHERE LOWER(nome) = 'teste' OR LOWER(nome) LIKE 'teste %' OR LOWER(nome) = 'test'
 );

-- 3) Apaga o hóspede Teste
DELETE FROM hospedes
 WHERE LOWER(nome) = 'teste' OR LOWER(nome) LIKE 'teste %' OR LOWER(nome) = 'test';

-- 4) Confirma que foi apagado
SELECT id, nome FROM hospedes WHERE LOWER(nome) ILIKE '%teste%';
