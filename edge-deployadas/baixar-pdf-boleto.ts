t cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info"
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    let codigo_solicitacao = url.searchParams.get("codigo_solicitacao");
    let unidade = url.searchParams.get("unidade");
    let boleto_id = url.searchParams.get("boleto_id");
    if (req.method === "POST") {
      try { const b = await req.json(); codigo_solicitacao = codigo_solicitacao || b.codigo_solicitacao; unidade = unidade || b.unidade; boleto_id = boleto_id || b.boleto_id; } catch (_) {}
    }

    const SUPA = Deno.env.get("SUPABASE_URL");
    const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (boleto_id && !codigo_solicitacao) {
      const rr = await fetch(SUPA + "/rest/v1/boletos_dominhas?id=eq." + boleto_id + "&select=banco_inter_id,morador_id", {
        headers: { "apikey": SVC, "Authorization": "Bearer " + SVC }
      });
      const arr = await rr.json();
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("boleto nao encontrado: " + boleto_id);
      codigo_solicitacao = arr[0].banco_inter_id;
      if (!unidade) {
        const r2 = await fetch(SUPA + "/rest/v1/moradores?id=eq." + arr[0].morador_id + "&select=unidade", {
          headers: { "apikey": SVC, "Authorization": "Bearer " + SVC }
        });
        const m = await r2.json();
        const u = (m[0]?.unidade || "AP").toUpperCase();
        unidade = u.includes("RIB") ? "Rib" : "AP";
      }
    }

    if (!codigo_solicitacao) throw new Error("codigo_solicitacao ou boleto_id obrigatorio");

    const r = await fetch(SUPA + "/functions/v1/inter-emit-boleto", {
      method: "POST",
      headers: { "Authorization": "Bearer " + SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ acao: "baixar_pdf", codigo_solicitacao, unidade: unidade || "AP" })
    });
    const json = await r.json();
    if (!json.ok || !json.pdf_base64) {
      return new Response(JSON.stringify({ ok: false, erro: json.erro || "inter-emit-boleto nao retornou pdf_base64", json }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const bin = Uint8Array.from(atob(json.pdf_base64), c => c.charCodeAt(0));

    // Atualiza url_boleto com data: URL? Nao — vai ficar gigante.
    // Em vez disso, so retorna o PDF agora.
    return new Response(bin, {
      status: 200,
      headers: { ...cors, "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=boleto-domus.pdf" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
