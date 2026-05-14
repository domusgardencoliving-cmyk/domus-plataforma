// =========================================================
// EDGE FUNCTION: send-whatsapp-fila-zapi
// Versão Z-API (substitui a versão Meta enquanto não temos token oficial)
// Z-API é mais simples: precisa só de INSTANCE_ID + TOKEN
//
// Variáveis de ambiente esperadas:
//   ZAPI_INSTANCE_ID    (ex: "3D1234ABCD")
//   ZAPI_TOKEN          (ex: "ABC123XYZ")
//   ZAPI_CLIENT_TOKEN   (opcional — Account Security Token, se ativado na Z-API)
//   SUPABASE_URL              (auto-injetado)
//   SUPABASE_SERVICE_ROLE_KEY (auto-injetado)
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

interface FilaItem {
  id: string;
  reserva_id: string;
  momento: string;
  mensagem_montada: string;
  telefone_destino: string;
  tentativas: number;
}

const sanitizePhone = (raw: string): string | null => {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  digits = digits.replace(/^0+/, "");
  // Z-API exige formato 5511999999999 (sem +, sem espaço, com DDI 55)
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  if (!digits.startsWith("55") || digits.length < 12 || digits.length > 13) return null;
  return digits;
};

const sendWhatsAppZapi = async (
  instanceId: string,
  token: string,
  clientToken: string | undefined,
  to: string,
  body: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> => {
  try {
    const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (clientToken) headers["Client-Token"] = clientToken;

    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ phone: to, message: body }),
    });
    const data = await r.json();
    if (!r.ok || data?.error) {
      return { ok: false, error: JSON.stringify(data?.error || data) };
    }
    return { ok: true, messageId: data?.messageId || data?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ZAPI_INSTANCE = Deno.env.get("ZAPI_INSTANCE_ID");
  const ZAPI_TOKEN = Deno.env.get("ZAPI_TOKEN");
  const ZAPI_CLIENT_TOKEN = Deno.env.get("ZAPI_CLIENT_TOKEN");

  if (!ZAPI_INSTANCE || !ZAPI_TOKEN) {
    return new Response(
      JSON.stringify({
        ok: false,
        erro: "ZAPI_INSTANCE_ID ou ZAPI_TOKEN nao configurado",
        proximo_passo: "configurar via Supabase Dashboard -> Edge Functions -> Secrets",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // 1) Garante que a fila esteja com mensagem montada
  await sb.rpc("processar_fila_mensagens", { p_limite: 100 });

  // 2) Pega itens 'pronto'
  const { data: prontas, error: errProntas } = await sb
    .from("mensagens_whatsapp_fila")
    .select("id,reserva_id,momento,mensagem_montada,telefone_destino,tentativas")
    .eq("status", "pronto")
    .lte("tentativas", 3)
    .limit(20);

  if (errProntas) {
    return new Response(JSON.stringify({ ok: false, erro: errProntas.message }), { status: 200 });
  }

  const resultados: any[] = [];

  for (const item of (prontas || []) as FilaItem[]) {
    const phone = sanitizePhone(item.telefone_destino);

    if (!phone) {
      await sb
        .from("mensagens_whatsapp_fila")
        .update({
          status: "erro",
          erro_msg: "telefone invalido: " + item.telefone_destino,
          tentativas: item.tentativas + 1,
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", item.id);
      resultados.push({ id: item.id, status: "erro", erro: "telefone invalido" });
      continue;
    }

    const send = await sendWhatsAppZapi(
      ZAPI_INSTANCE,
      ZAPI_TOKEN,
      ZAPI_CLIENT_TOKEN,
      phone,
      item.mensagem_montada,
    );

    if (send.ok) {
      await sb
        .from("mensagens_whatsapp_fila")
        .update({
          status: "enviado",
          enviado_em: new Date().toISOString(),
          meta_message_id: send.messageId,
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", item.id);
      resultados.push({ id: item.id, status: "enviado", messageId: send.messageId });
    } else {
      await sb
        .from("mensagens_whatsapp_fila")
        .update({
          status: "erro",
          erro_msg: send.error,
          tentativas: item.tentativas + 1,
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", item.id);
      resultados.push({ id: item.id, status: "erro", erro: send.error });
    }

    // Pausa pra evitar rate-limit
    await new Promise((r) => setTimeout(r, 300));
  }

  return new Response(
    JSON.stringify({
      ok: true,
      processadas: resultados.length,
      enviadas: resultados.filter((r) => r.status === "enviado").length,
      erros: resultados.filter((r) => r.status === "erro").length,
      resultados,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
