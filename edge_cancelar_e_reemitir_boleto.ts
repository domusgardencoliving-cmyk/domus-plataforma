// =========================================================
// EDGE FUNCTION: cancelar-e-reemitir-boleto
// =========================================================
// Cancela um boleto existente no Banco Inter e emite um novo
// (mesmo valor, mesma moradora) com nova data_vencimento.
//
// Body: { boleto_id: uuid, nova_data_vencimento: 'YYYY-MM-DD', motivo?: string }
//
// Fluxo:
//   1. Busca boleto + morador (lê banco_inter_id, unidade, valor)
//   2. Cancela o boleto antigo no Inter (acao=cancelar)
//   3. Marca como 'cancelado' no banco com motivo
//   4. Emite novo boleto via inter-emit-boleto (valor + composição igual + nova data)
//   5. Retorna detalhes do novo
//
// Criada em 21/05/2026. Usado pra Ana Clara em 21/05 — antecipar
// boleto vencendo 20/05 pra 21/05 sem juros/multa.
// =========================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { boleto_id, nova_data_vencimento, motivo } = await req.json();
    if (!boleto_id) throw new Error("boleto_id obrigatorio");
    if (!nova_data_vencimento) throw new Error("nova_data_vencimento obrigatoria");

    const SUPA = Deno.env.get("SUPABASE_URL");
    const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // 1. Busca boleto + morador
    const r1 = await fetch(SUPA + "/rest/v1/boletos_dominhas?id=eq." + boleto_id + "&select=*", {
      headers: { "apikey": SVC, "Authorization": "Bearer " + SVC }
    });
    const ba = await r1.json();
    if (!Array.isArray(ba) || ba.length === 0) throw new Error("boleto nao encontrado");
    const b = ba[0];
    const codigo_antigo = b.banco_inter_id;

    const r2 = await fetch(SUPA + "/rest/v1/moradores?id=eq." + b.morador_id + "&select=unidade", {
      headers: { "apikey": SVC, "Authorization": "Bearer " + SVC }
    });
    const ma = await r2.json();
    const unidade = (ma[0]?.unidade || "AP").toUpperCase().includes("RIB") ? "Rib" : "AP";

    // 2. Cancelar antigo no Inter
    let cancelOut = null;
    if (codigo_antigo) {
      const rc = await fetch(SUPA + "/functions/v1/inter-emit-boleto", {
        method: "POST",
        headers: { "Authorization": "Bearer " + SVC, "Content-Type": "application/json" },
        body: JSON.stringify({ acao: "cancelar", codigo_solicitacao: codigo_antigo, unidade })
      });
      cancelOut = { status: rc.status, body: (await rc.text()).slice(0, 300) };
    }

    // 3. Marcar antigo como cancelado no banco
    await fetch(SUPA + "/rest/v1/boletos_dominhas?id=eq." + boleto_id, {
      method: "PATCH",
      headers: { "apikey": SVC, "Authorization": "Bearer " + SVC, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ status: "cancelado", forma_pagamento: "(reemitido) " + (motivo || "antecipacao manual") })
    });

    // 4. Emitir novo boleto
    const rNovo = await fetch(SUPA + "/functions/v1/inter-emit-boleto", {
      method: "POST",
      headers: { "Authorization": "Bearer " + SVC, "Content-Type": "application/json" },
      body: JSON.stringify({
        morador_id: b.morador_id,
        mes_referencia: b.mes_referencia,
        valor: Number(b.valor),
        data_vencimento: nova_data_vencimento,
        descricao_extras: b.descricao_extras || null,
        valor_base: b.valor_base,
        valor_energia: b.valor_energia,
        valor_extras: b.valor_extras
      })
    });
    const novoJson = await rNovo.json();

    return new Response(JSON.stringify({ ok: rNovo.ok, cancelar: cancelOut, emitir: novoJson }, null, 2), {
      headers: { ...cors, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: e.message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" }
    });
  }
});
