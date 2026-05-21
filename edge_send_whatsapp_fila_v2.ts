// =========================================================
// EDGE FUNCTION: send-whatsapp-fila (v2 — sem dependência)
// =========================================================
// Roda a cada 5 min (via cron pg_cron + net.http_post).
//
// 1. Chama RPC `processar_fila_mensagens(100)` pra mover mensagens
//    'pendente' agendadas pra 'pronto'
// 2. Busca até 20 mensagens 'pronto' com tentativas <= 3
// 3. Envia cada uma via Meta WhatsApp Business API (graph.facebook.com)
// 4. Marca como 'enviado' (com meta_message_id) ou 'erro'
//
// Diferença pra v1 (no repo: edge_function_send_whatsapp_fila.ts):
// não usa supabase-js (estava dando BOOT_ERROR no Deno Edge runtime).
// Usa fetch puro pro PostgREST.
//
// Secrets esperados:
//   WHATSAPP_TOKEN          Bearer token do app Meta
//   WHATSAPP_PHONE_ID       ID do número WABA
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto)
//
// ⚠️ 21/05/2026: WHATSAPP_TOKEN expirado (error 190 OAuthException).
// Cron `send-whatsapp-fila-5min` está PAUSADO até renovar.
// =========================================================

const sanitizePhone = (raw) => {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  if (!digits.startsWith("55") || digits.length < 12 || digits.length > 13) return null;
  return digits;
};

const sendWA = async (token, phoneId, to, body) => {
  try {
    const r = await fetch("https://graph.facebook.com/v25.0/" + phoneId + "/messages", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body } })
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, error: JSON.stringify(data?.error || data) };
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (e) { return { ok: false, error: e.message }; }
};

Deno.serve(async (req) => {
  const SUPA = Deno.env.get("SUPABASE_URL");
  const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN");
  const WA_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID");
  if (!WA_TOKEN || !WA_PHONE_ID) {
    return new Response(JSON.stringify({ ok: false, erro: "WHATSAPP_TOKEN ou WHATSAPP_PHONE_ID nao configurado" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const h = { "apikey": SVC, "Authorization": "Bearer " + SVC, "Content-Type": "application/json", "Prefer": "return=minimal" };

  try {
    await fetch(SUPA + "/rest/v1/rpc/processar_fila_mensagens", {
      method: "POST", headers: h, body: JSON.stringify({ p_limite: 100 })
    });
  } catch (e) {}

  const r1 = await fetch(SUPA + "/rest/v1/mensagens_whatsapp_fila?status=eq.pronto&tentativas=lte.3&limit=20&select=id,reserva_id,momento,mensagem_montada,telefone_destino,tentativas", { headers: h });
  const prontas = await r1.json();
  if (!Array.isArray(prontas)) {
    return new Response(JSON.stringify({ ok: false, erro: "Erro lendo fila", detail: prontas }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const resultados = [];
  for (const it of prontas) {
    const phone = sanitizePhone(it.telefone_destino);
    if (!phone) {
      await fetch(SUPA + "/rest/v1/mensagens_whatsapp_fila?id=eq." + it.id, {
        method: "PATCH", headers: h,
        body: JSON.stringify({ status: "erro", erro_msg: "telefone invalido: " + it.telefone_destino, tentativas: it.tentativas + 1, atualizado_em: new Date().toISOString() })
      });
      resultados.push({ id: it.id, status: "erro_telefone" });
      continue;
    }
    const send = await sendWA(WA_TOKEN, WA_PHONE_ID, phone, it.mensagem_montada);
    if (send.ok) {
      await fetch(SUPA + "/rest/v1/mensagens_whatsapp_fila?id=eq." + it.id, {
        method: "PATCH", headers: h,
        body: JSON.stringify({ status: "enviado", enviado_em: new Date().toISOString(), meta_message_id: send.messageId, atualizado_em: new Date().toISOString() })
      });
      resultados.push({ id: it.id, status: "enviado" });
    } else {
      await fetch(SUPA + "/rest/v1/mensagens_whatsapp_fila?id=eq." + it.id, {
        method: "PATCH", headers: h,
        body: JSON.stringify({ status: "erro", erro_msg: send.error, tentativas: it.tentativas + 1, atualizado_em: new Date().toISOString() })
      });
      resultados.push({ id: it.id, status: "erro", erro: send.error });
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return new Response(JSON.stringify({
    ok: true,
    processadas: resultados.length,
    enviadas: resultados.filter(r => r.status === "enviado").length,
    erros: resultados.filter(r => r.status !== "enviado").length,
    resultados
  }), { headers: { "Content-Type": "application/json" } });
});
