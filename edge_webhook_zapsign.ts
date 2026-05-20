// =============================================================
// EDGE FUNCTION: webhook-zapsign
// =============================================================
// Recebe notificações do ZapSign quando documentos são criados,
// assinados, rejeitados, etc. Salva o payload bruto em
// public.zapsign_webhook_log e (se for assinatura concluida)
// chama processar-pos-assinatura.
//
// URL pra cadastrar no ZapSign:
//   https://motwhfbpundrhvuwjntw.supabase.co/functions/v1/webhook-zapsign
// =============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({}));
    const event = body?.event_type || body?.event || "unknown";
    const docId = body?.doc?.token || body?.token || body?.document_token || null;

    // Salva log bruto
    await supabase.from("zapsign_webhook_log").insert({
      event_type: event,
      doc_token: docId,
      payload: body,
      received_at: new Date().toISOString(),
    }).then(() => {}).catch((e) => console.error("log insert:", e));

    // Se for assinatura concluída, dispara pos-assinatura
    if (event === "doc_signed" || event === "signed") {
      try {
        await fetch(`${supabaseUrl}/functions/v1/pos-assinatura-contrato`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({ zapsign_doc_token: docId, source: "webhook" }),
        });
      } catch (e) {
        console.error("trigger pos-assinatura falhou:", e);
      }
    }

    return new Response(JSON.stringify({ ok: true, event }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (e: any) {
    console.error("webhook erro:", e);
    return new Response(JSON.stringify({ ok: false, erro: e.message }), {
      status: 200, // Sempre 200 pra ZapSign não retentar
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
