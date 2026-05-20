// =============================================================
// EDGE FUNCTION: pos-assinatura-contrato
// =============================================================
// Disparada pelo webhook-zapsign quando o documento é assinado.
// Em sequência:
//   1. Marca contrato como assinado + baixa PDF assinado
//   2. Chama RPC criar_dominha_e_moradora (cria registros em moradores e dominhas)
//   3. Chama Inter API (Edge Function inter-emit-boleto) pra primeiro boleto da caução
//   4. Manda email pra moradora avisando + link do portal + senha provisória
//
// Body: { zapsign_doc_token, source: 'webhook' | 'manual' }
// =============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const json = (b: any, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json", ...corsHeaders } });

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { zapsign_doc_token, contrato_id: contrato_id_input } = body;

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ZAPSIGN_TOKEN = Deno.env.get("ZAPSIGN_API_TOKEN")!;
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    const sb = createClient(SUPABASE_URL, SVC);

    // 1. Encontrar contrato — por zapsign_doc_id ou contrato_id
    let contrato;
    if (contrato_id_input) {
      const { data } = await sb.from("contratos_pendentes").select("*").eq("id", contrato_id_input).single();
      contrato = data;
    } else if (zapsign_doc_token) {
      const { data } = await sb.from("contratos_pendentes").select("*").eq("zapsign_doc_id", zapsign_doc_token).single();
      contrato = data;
    }

    if (!contrato) return json({ error: "contrato não encontrado", zapsign_doc_token, contrato_id_input }, 404);

    if (contrato.status === "assinado") {
      return json({ success: true, ja_processado: true, contrato_id: contrato.id });
    }

    // 2. Baixar PDF assinado (se temos token)
    let signedPdfPath: string | null = null;
    if (zapsign_doc_token) {
      try {
        const docResp = await fetch(`https://api.zapsign.com.br/api/v1/docs/${zapsign_doc_token}/`, {
          headers: { "Authorization": `Bearer ${ZAPSIGN_TOKEN}` }
        });
        if (docResp.ok) {
          const docData = await docResp.json();
          const signedUrl = docData.signed_file;
          if (signedUrl) {
            const pdfResp = await fetch(signedUrl);
            const pdfBlob = await pdfResp.arrayBuffer();
            signedPdfPath = `assinados/${contrato.id}.pdf`;
            await sb.storage.from("contratos-dominhas").upload(signedPdfPath, pdfBlob, {
              contentType: "application/pdf", upsert: true
            });
          }
        }
      } catch (e) { console.warn("download PDF assinado:", e); }
    }

    // 3. Criar dominha + moradora via RPC
    const { data: rpcResult, error: rpcErr } = await sb.rpc("criar_dominha_e_moradora", {
      p_contrato_id: contrato.id,
      p_quarto: contrato.quarto || null,
      p_valor: contrato.valor_final || contrato.aluguel,
      p_dia_vencimento: 15
    });

    if (rpcErr || !rpcResult?.success) {
      await sb.from("contratos_pendentes").update({
        observacoes: (contrato.observacoes || "") + `\n[pos-assinatura erro criar_dominha: ${rpcErr?.message || JSON.stringify(rpcResult)}]`
      }).eq("id", contrato.id);
      return json({ error: "criar_dominha falhou", detalhe: rpcErr || rpcResult }, 500);
    }

    const senhaProvisoria = rpcResult.senha_provisoria;
    const dominhaId = rpcResult.dominha_id;
    const moradorId = rpcResult.morador_id;

    // 4. Emite primeiro boleto da caução via Inter (tenta — não bloqueia se falhar)
    let boletoResult: any = { tentado: false };
    try {
      const interResp = await fetch(`${SUPABASE_URL}/functions/v1/inter-emit-boleto`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SVC}` },
        body: JSON.stringify({
          unidade: contrato.unidade,
          morador_id: moradorId,
          valor: Number(contrato.caucao || 0),
          vencimento: (() => {
            const [y, m, d] = contrato.data_entrada.split("-");
            const dt = new Date(Number(y), Number(m) - 1, Number(d) - 1);
            return dt.toISOString().slice(0, 10);
          })(),
          descricao: `Caução — Contrato Domus ${contrato.unidade}`,
          email: contrato.email
        })
      });
      boletoResult = { status: interResp.status, body: (await interResp.text()).slice(0, 400) };
    } catch (e: any) { boletoResult = { erro: e.message }; }

    // 5. Atualiza status do contrato
    await sb.from("contratos_pendentes").update({
      status: "assinado",
      assinado_em: new Date().toISOString(),
      contrato_assinado_path: signedPdfPath,
      atualizado_em: new Date().toISOString()
    }).eq("id", contrato.id);

    // 6. Envia email pra moradora com link do portal + senha provisória
    let emailResult: any = { tentado: false };
    if (RESEND_KEY && contrato.email && senhaProvisoria) {
      try {
        const unidadeLabel = contrato.unidade === "AP" ? "Andrade Pertence" : "Ribeirão Claro";
        const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#222;">
<div style="background:linear-gradient(135deg,#008B9C,#0A3142);color:white;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
  <h1 style="margin:0;font-size:22px;">Bem-vinda à Domus 🌿</h1>
  <p style="margin:8px 0 0;opacity:0.9;">Unidade ${unidadeLabel}</p>
</div>
<p>Oi <strong>${contrato.nome.split(" ")[0]}</strong>! Recebemos a assinatura do teu contrato — tá tudo formalizado.</p>
<h2 style="color:#0A3142;border-bottom:2px solid #EBEBEB;padding-bottom:8px;">Próximos passos</h2>
<p><strong>📄 Contrato assinado:</strong> ficará disponível no Portal Dominhas.</p>
<p><strong>💰 Boleto da caução:</strong> ${boletoResult.status === 200 ? "enviado por email separado, com vencimento 1 dia antes da tua mudança." : "será enviado em breve por e-mail/WhatsApp."}</p>
<h2 style="color:#0A3142;border-bottom:2px solid #EBEBEB;padding-bottom:8px;">Portal Dominhas</h2>
<p>Acesse a tua área pra ver contrato, boletos, comunicados, mini mercado e a Comuna das Dominhas:</p>
<div style="background:#FFF8F0;border:1px solid #EBEBEB;border-radius:8px;padding:16px;margin:16px 0;">
  <p style="margin:0;"><strong>Link:</strong> <a href="https://domusgardencoliving.com/dominhas.html" style="color:#008B9C;">https://domusgardencoliving.com/dominhas.html</a></p>
  <p style="margin:8px 0 0;"><strong>E-mail:</strong> ${contrato.email}</p>
  <p style="margin:4px 0 0;"><strong>Senha provisória:</strong> <code style="background:#fff;padding:4px 8px;border-radius:4px;font-size:14px;">${senhaProvisoria}</code></p>
  <p style="margin:8px 0 0;font-size:12px;color:#717171;">Recomenda-se alterar a senha no primeiro acesso.</p>
</div>
<p style="margin-top:24px;">Qualquer coisa, me chama no WhatsApp <a href="https://wa.me/5511943330911" style="color:#008B9C;">(11) 94333-0911</a> 💛</p>
<p style="font-size:12px;color:#717171;margin-top:24px;text-align:center;">Domus Garden Coliving · ${unidadeLabel}</p>
</body></html>`;

        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Domus Garden <onboarding@resend.dev>",
            to: contrato.email,
            cc: "domusgardencoliving@gmail.com",
            subject: `Bem-vinda à Domus ${unidadeLabel} 🌿 — seu acesso ao Portal Dominhas`,
            html
          })
        });
        emailResult = { status: r.status, body: (await r.text()).slice(0, 200) };
      } catch (e: any) { emailResult = { erro: e.message }; }
    }

    return json({
      success: true,
      contrato_id: contrato.id,
      dominha_id: dominhaId,
      morador_id: moradorId,
      signed_pdf_path: signedPdfPath,
      boleto: boletoResult,
      email_moradora: emailResult
    });

  } catch (e: any) {
    console.error("pos-assinatura erro:", e);
    return json({ error: e.message }, 500);
  }
});
