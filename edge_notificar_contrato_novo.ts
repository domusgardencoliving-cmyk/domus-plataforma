// =============================================================
// EDGE FUNCTION: notificar-contrato-novo
// =============================================================
// Envia email pra Gabi quando entra contrato novo de dominha.
// Disparada por trigger AFTER INSERT em contratos_pendentes
// (via pg_net.http_post).
//
// Body esperado: { contrato_id: "uuid" }
// =============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const fmtBR = (n: number | string | null) => {
  const v = Number(n || 0);
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtData = (s: string | null) => {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { contrato_id } = await req.json();
    if (!contrato_id) return json({ error: "contrato_id é obrigatório" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const toEmail = Deno.env.get("CONTRATOS_EMAIL_TO") || "domusgardencoliving@gmail.com";

    if (!resendKey) return json({ error: "RESEND_API_KEY não configurada" }, 500);

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: c, error: errC } = await supabase
      .from("contratos_pendentes")
      .select("*")
      .eq("id", contrato_id)
      .single();

    if (errC || !c) return json({ error: "Contrato não encontrado", detalhe: errC?.message }, 404);

    const modLabel = c.modalidade === "12" ? "12 meses tudo incluso" : "3 meses com caução";
    const valorMensal = c.modalidade === "12" ? 1450 : 1250;

    // Links das fotos (signed URL por 7 dias)
    const linksFotos: Record<string, string> = {};
    for (const [campo, path] of Object.entries({
      "RG/CNH frente": c.doc_frente_path,
      "RG/CNH verso": c.doc_verso_path,
      "CPF": c.doc_cpf_path,
      "Selfie": c.selfie_path,
    })) {
      if (path) {
        const { data: signed } = await supabase
          .storage
          .from("contratos-dominhas")
          .createSignedUrl(path, 60 * 60 * 24 * 7);
        if (signed?.signedUrl) linksFotos[campo] = signed.signedUrl;
      }
    }

    const fotosHtml = Object.entries(linksFotos)
      .map(([nome, url]) => `<li><a href="${url}" target="_blank" style="color:#008B9C;">${nome}</a></li>`)
      .join("");

    const cronograma = Array.isArray(c.cronograma) ? c.cronograma : [];
    const cronoHtml = cronograma
      .slice(0, 6)
      .map((p: any) => `<li><strong>${p.data}</strong> — R$ ${fmtBR(p.valor)} <span style="color:#666;">(${p.composicao})</span></li>`)
      .join("");

    const subject = `Nova dominha: ${c.nome} — ${modLabel}`;

    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#222;">
<div style="background:linear-gradient(135deg,#008B9C,#0A3142);color:white;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
  <h1 style="margin:0;font-size:22px;">🌿 Nova dominha submeteu contrato</h1>
  <p style="margin:8px 0 0;opacity:0.9;font-size:14px;">${modLabel}</p>
</div>

<h2 style="color:#0A3142;font-size:18px;border-bottom:2px solid #EBEBEB;padding-bottom:8px;">Dados pessoais</h2>
<p><strong>${c.nome}</strong> — ${c.idade || "—"} anos · ${c.profissao || "—"}<br>
CPF ${c.cpf || "—"} · RG ${c.rg || "—"}<br>
📱 ${c.telefone || "—"} · ✉ ${c.email || "—"}<br>
${c.endereco ? `📍 ${c.endereco}` : ""}</p>

<h2 style="color:#0A3142;font-size:18px;border-bottom:2px solid #EBEBEB;padding-bottom:8px;">Modalidade escolhida</h2>
<p><strong>${modLabel}</strong><br>
Aluguel: R$ ${fmtBR(c.aluguel || valorMensal)}/mês · Caução: R$ ${fmtBR(c.caucao || 0)} · Multa: R$ ${fmtBR(c.multa_rescisao || 0)}<br>
Data de mudança: <strong>${fmtData(c.data_entrada)}</strong></p>

${cronoHtml ? `<h2 style="color:#0A3142;font-size:18px;border-bottom:2px solid #EBEBEB;padding-bottom:8px;">Cronograma (próximos)</h2>
<ul>${cronoHtml}</ul>` : ""}

<h2 style="color:#0A3142;font-size:18px;border-bottom:2px solid #EBEBEB;padding-bottom:8px;">Contatos de emergência</h2>
<p>1. <strong>${c.emerg1_nome || "—"}</strong> · ${c.emerg1_tel || "—"} ${c.emerg1_rel ? `(${c.emerg1_rel})` : ""}<br>
2. <strong>${c.emerg2_nome || "—"}</strong> · ${c.emerg2_tel || "—"} ${c.emerg2_rel ? `(${c.emerg2_rel})` : ""}</p>

${fotosHtml ? `<h2 style="color:#0A3142;font-size:18px;border-bottom:2px solid #EBEBEB;padding-bottom:8px;">Documentos enviados</h2>
<ul>${fotosHtml}</ul>
<p style="font-size:12px;color:#666;font-style:italic;">Links válidos por 7 dias.</p>` : ""}

<div style="background:#FFF8F0;border:1px solid #EBEBEB;border-radius:8px;padding:16px;margin-top:24px;">
  <p style="margin:0;font-size:13px;"><strong>ID do contrato:</strong> <code style="font-size:11px;">${c.id}</code></p>
  <p style="margin:8px 0 0;font-size:13px;">Status: <strong>${c.status}</strong></p>
</div>

<p style="margin-top:24px;font-size:12px;color:#717171;text-align:center;">
Notificação automática do <a href="https://domusgardencoliving.com" style="color:#008B9C;">Domus Garden Coliving</a>
</p>
</body></html>`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Domus Garden <contratos@domusgardencoliving.com>",
        to: toEmail,
        subject,
        html,
      }),
    });

    const result = await r.json();
    if (!r.ok) {
      return json({ error: "Resend falhou", status: r.status, detalhe: result }, 500);
    }

    // Marca notificado_em na tabela
    await supabase
      .from("contratos_pendentes")
      .update({ atualizado_em: new Date().toISOString() })
      .eq("id", contrato_id);

    return json({ success: true, email_id: result.id, para: toEmail });

  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
