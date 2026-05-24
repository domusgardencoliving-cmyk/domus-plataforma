// =========================================================
// EDGE FUNCTION: webhook-zapsign
// =========================================================
// Recebe POST do ZapSign quando documento é assinado.
// Atualiza moradores.contrato_assinado_url e contratos_pendentes.status.
// Notifica Gabi via WhatsApp.
//
// Pra ativar:
// 1) Deploy essa Edge Function no Supabase
// 2) Configurar no ZapSign: Webhook URL =
//    https://motwhfbpundrhvuwjntw.supabase.co/functions/v1/webhook-zapsign
// 3) Evento: "document_signed"
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function avisarGabi(wpp: any, msg: string): Promise<void> {
  if (!wpp.token || !wpp.phoneId || !wpp.gabi) return;
  const url = `https://graph.facebook.com/v18.0/${wpp.phoneId}/messages`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${wpp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: wpp.gabi,
        type: "text",
        text: { body: msg, preview_url: false },
      }),
    });
  } catch (e) {
    console.error("avisarGabi erro:", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const SB_URL = Deno.env.get("SUPABASE_URL")!;
  const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supa = createClient(SB_URL, SB_KEY);

  const wpp = {
    token: Deno.env.get("WHATSAPP_TOKEN"),
    phoneId: Deno.env.get("WHATSAPP_PHONE_ID"),
    gabi: Deno.env.get("GABI_WHATSAPP"),
  };

  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return new Response(JSON.stringify({ ok: false, erro: "Body inválido" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" }
    });
  }

  // Estrutura típica do webhook ZapSign:
  // { event_type: "doc_signed", token: "...", name: "...", signers: [...], original_file_url: "...", signed_file_url: "..." }
  const eventType = body.event_type || body.event || "";
  const docToken = body.token || body.doc_token || body.document_token;
  const signedUrl = body.signed_file_url || body.signed_url || body.url_signed_pdf;
  const docName = body.name || body.document_name || "";

  // Só processa quando documento foi assinado
  if (!/sign(ed|ado)|complet/i.test(eventType)) {
    return new Response(JSON.stringify({ ok: true, ignored: true, event: eventType }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" }
    });
  }

  if (!docToken || !signedUrl) {
    return new Response(JSON.stringify({ ok: false, erro: "doc_token ou signed_url ausentes" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" }
    });
  }

  // Procura o contrato pendente que tem esse zapsign_doc_id
  const { data: contrato, error: errContrato } = await supa
    .from("contratos_pendentes")
    .select("id, nome, zapsign_doc_id")
    .eq("zapsign_doc_id", docToken)
    .maybeSingle();

  if (errContrato || !contrato) {
    // Talvez busque pelo zapsign_link_assinatura se doc_id não bater
    return new Response(JSON.stringify({
      ok: false, erro: "Contrato não encontrado pelo token ZapSign",
      docToken
    }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Atualiza contratos_pendentes
  await supa
    .from("contratos_pendentes")
    .update({
      status: "assinado",
      zapsign_link_assinatura: signedUrl,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", contrato.id);

  // Atualiza moradores.contrato_assinado_url se a moradora já foi criada
  await supa
    .from("moradores")
    .update({ contrato_assinado_url: signedUrl })
    .eq("contrato_pendente_id", contrato.id);

  // Notifica Gabi
  const msg = `✍️ *Contrato assinado*

*${contrato.nome}* assinou o contrato no ZapSign.

📄 PDF assinado: ${signedUrl}

Já anexei no Portal Dominhas dela. Aguardando ela pagar a caução pra você liberar o acesso.

_Carteiro Domus · webhook ZapSign_`;
  await avisarGabi(wpp, msg);

  return new Response(JSON.stringify({
    ok: true,
    contrato_id: contrato.id,
    nome: contrato.nome,
    signed_url: signedUrl,
  }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
});
