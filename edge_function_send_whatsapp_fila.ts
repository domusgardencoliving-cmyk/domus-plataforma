// =========================================================
// EDGE FUNCTION: send-whatsapp-fila
// Disparada por cron externo OU pg_cron
// Puxa mensagens com status='pronto', envia via Meta WhatsApp Business API
// Marca status='enviado' (com meta_message_id) ou 'erro'
//
// Variáveis de ambiente esperadas:
//   META_WHATSAPP_TOKEN       (Bearer token permanente do app Meta)
//   META_WHATSAPP_PHONE_ID    (ID do número de origem do WABA)
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
  // Tira tudo que não é dígito
  let digits = String(raw).replace(/\D/g, "");
  // Se começar com 0, tira
  digits = digits.replace(/^0+/, "");
  // Se tem 10 ou 11 dígitos (DDD + número), prepend 55
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  // Validação mínima: precisa começar com 55 e ter 12-13 dígitos
  if (!digits.startsWith("55") || digits.length < 12 || digits.length > 13) return null;
  return digits;
};

const sendWhatsApp = async (
  token: string,
  phoneId: string,
  to: string,
  body: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> => {
  try {
    const r = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, error: JSON.stringify(data?.error || data) };
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const META_TOKEN = Deno.env.get("META_WHATSAPP_TOKEN");
  const META_PHONE_ID = Deno.env.get("META_WHATSAPP_PHONE_ID");

  if (!META_TOKEN || !META_PHONE_ID) {
    return new Response(
      JSON.stringify({
        ok: false,
        erro: "META_WHATSAPP_TOKEN ou META_WHATSAPP_PHONE_ID nao configurado",
        proximo_passo: "configurar via Supabase Dashboard → Edge Functions → Secrets",
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

    const send = await sendWhatsApp(META_TOKEN, META_PHONE_ID, phone, item.mensagem_montada);

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

    // Pequena pausa entre envios para não bater rate-limit do Meta
    await new Promise((r) => setTimeout(r, 250));
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
