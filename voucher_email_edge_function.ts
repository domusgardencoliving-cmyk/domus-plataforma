// =============================================================
// EDGE FUNCTION: enviar-voucher-email
// =============================================================
// Envia voucher de reserva por email usando o serviço Resend
// (https://resend.com — 100 emails/dia grátis no plano hobby).
//
// COMO INSTALAR (Gabi, 1 vez):
//
//   1. Criar conta gratuita em https://resend.com
//   2. Verificar o domínio domusgardencoliving.com (instruções no painel)
//   3. Pegar API key (começa com "re_...")
//   4. Painel Supabase → Edge Functions → Settings → adicionar variável:
//        RESEND_API_KEY = re_SUACHAVE
//   5. Painel Supabase → Edge Functions → Deploy a new function
//        Nome: enviar-voucher-email
//        Conteúdo: este arquivo inteiro
//   6. Pronto — a função pode ser chamada via RPC ou direto pelo frontend.
//
// COMO USAR (do frontend):
//   const { data, error } = await supabase.functions.invoke('enviar-voucher-email', {
//     body: { reserva_id: 'uuid-aqui' }
//   });
// =============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { reserva_id } = await req.json();
    if (!reserva_id) {
      return json({ error: "reserva_id é obrigatório" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");

    if (!resendKey) {
      return json({
        error: "RESEND_API_KEY não configurada nas variáveis da Edge Function",
        instrucao: "Painel Supabase → Edge Functions → Settings → adicionar RESEND_API_KEY"
      }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Buscar dados da reserva
    const { data: reserva, error: errReserva } = await supabase
      .from("reservas")
      .select("*")
      .eq("id", reserva_id)
      .single();

    if (errReserva || !reserva) {
      return json({ error: "Reserva não encontrada", detalhe: errReserva?.message }, 404);
    }

    if (!reserva.email) {
      return json({ error: "Reserva sem email cadastrado" }, 400);
    }

    // Montar HTML do voucher
    const html = montarHTMLVoucher(reserva);
    const texto = montarTextoPlano(reserva);
    const subject = `Voucher Domus Garden — Reserva ${reserva.id.substring(0, 8).toUpperCase()}`;

    // Enviar via Resend API
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Domus Garden <reservas@domusgardencoliving.com>",
        to: [reserva.email],
        bcc: ["domusgardencoliving@gmail.com"],
        subject,
        html,
        text: texto,
        reply_to: "domusgardencoliving@gmail.com",
      }),
    });

    const resendData = await resendResponse.json();

    if (!resendResponse.ok) {
      console.error("[voucher] erro Resend:", resendData);
      return json({
        error: "Falha ao enviar email pelo Resend",
        detalhe: resendData
      }, 500);
    }

    // Log de envio
    await supabase.from("emails_enviados").insert({
      reserva_id,
      destinatario: reserva.email,
      tipo: "voucher",
      assunto: subject,
      enviado_em: new Date().toISOString(),
      resend_id: resendData.id || null
    }).then(() => {}, () => {}); // não bloquear se a tabela não existir

    return json({
      success: true,
      message: "Voucher enviado",
      destinatario: reserva.email,
      resend_id: resendData.id,
    });

  } catch (err) {
    console.error("[voucher] erro inesperado:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function fmtData(s: string): string {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

function fmtMoeda(n: number): string {
  return (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function montarHTMLVoucher(r: any): string {
  const codigo = String(r.id).substring(0, 8).toUpperCase();
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="utf-8">
  <title>Voucher Domus Garden</title>
</head>
<body style="margin:0;padding:0;background:#F8F5F0;font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#2C3E50;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#F8F5F0;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

        <!-- Header azul -->
        <tr><td style="background:linear-gradient(135deg,#2C5F8D 0%,#1B3F5F 100%);padding:36px 32px;color:#fff;text-align:center;">
          <div style="font-size:38px;line-height:1;margin-bottom:12px;">🏡</div>
          <h1 style="margin:0;font-family:Georgia,serif;font-size:26px;font-weight:normal;letter-spacing:0.5px;">Domus Garden Coliving</h1>
          <p style="margin:6px 0 0;font-size:13px;opacity:0.9;letter-spacing:1px;text-transform:uppercase;">Voucher de Reserva</p>
        </td></tr>

        <!-- Badge VÁLIDO -->
        <tr><td style="padding:24px 32px 8px;text-align:center;">
          <span style="display:inline-block;background:#D4EDDA;color:#155724;padding:6px 16px;border-radius:999px;font-size:11px;font-weight:bold;letter-spacing:1px;">✓ RESERVA CONFIRMADA</span>
        </td></tr>

        <!-- Saudação -->
        <tr><td style="padding:8px 32px 24px;text-align:center;">
          <h2 style="margin:0;font-family:Georgia,serif;font-size:22px;color:#1B3F5F;">Olá, ${r.hospede_nome || "amigo(a)"}!</h2>
          <p style="margin:8px 0 0;color:#5A6B7B;font-size:14px;">Sua estadia está reservada. Aqui está seu voucher para guardar.</p>
        </td></tr>

        <!-- Caixa com detalhes -->
        <tr><td style="padding:0 32px 16px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#F8F5F0;border-radius:12px;padding:20px;">
            <tr>
              <td style="padding:8px 0;font-size:12px;color:#8A9BA9;letter-spacing:1px;text-transform:uppercase;">Código da reserva</td>
              <td style="padding:8px 0;font-family:'Courier New',monospace;font-size:16px;font-weight:bold;color:#1B3F5F;text-align:right;">${codigo}</td>
            </tr>
            <tr><td colspan="2" style="border-top:1px dashed #D5C9B8;height:1px;"></td></tr>
            <tr>
              <td style="padding:10px 0;font-size:13px;color:#5A6B7B;">Acomodação</td>
              <td style="padding:10px 0;font-size:14px;font-weight:600;color:#2C3E50;text-align:right;">${r.cama || "—"}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;font-size:13px;color:#5A6B7B;">Check-in</td>
              <td style="padding:10px 0;font-size:14px;color:#2C3E50;text-align:right;">${fmtData(r.checkin)} <span style="color:#8A9BA9;font-size:12px;">(a partir das 16h)</span></td>
            </tr>
            <tr>
              <td style="padding:10px 0;font-size:13px;color:#5A6B7B;">Check-out</td>
              <td style="padding:10px 0;font-size:14px;color:#2C3E50;text-align:right;">${fmtData(r.checkout)} <span style="color:#8A9BA9;font-size:12px;">(até as 11h)</span></td>
            </tr>
            ${r.valor_total ? `
            <tr><td colspan="2" style="border-top:1px dashed #D5C9B8;height:1px;"></td></tr>
            <tr>
              <td style="padding:10px 0;font-size:13px;color:#5A6B7B;">Valor total</td>
              <td style="padding:10px 0;font-size:18px;font-weight:bold;color:#2C5F8D;text-align:right;font-family:Georgia,serif;">${fmtMoeda(Number(r.valor_total))}</td>
            </tr>` : ""}
          </table>
        </td></tr>

        <!-- Endereço -->
        <tr><td style="padding:8px 32px 24px;">
          <p style="margin:0;font-size:11px;color:#8A9BA9;letter-spacing:1px;text-transform:uppercase;">Endereço</p>
          <p style="margin:6px 0 0;font-size:14px;color:#2C3E50;line-height:1.5;">R. Andrade Pertence, 25 · Vila Olímpia<br>São Paulo · SP · 04543-100</p>
          <p style="margin:10px 0 0;">
            <a href="https://maps.google.com/?q=R.+Andrade+Pertence,+25,+Vila+Olímpia,+São+Paulo" style="color:#2C5F8D;text-decoration:none;font-size:13px;font-weight:600;">📍 Abrir no Google Maps →</a>
          </p>
        </td></tr>

        <!-- Próximos passos -->
        <tr><td style="padding:0 32px 24px;">
          <p style="margin:0;font-size:11px;color:#8A9BA9;letter-spacing:1px;text-transform:uppercase;">Próximos passos</p>
          <ol style="margin:8px 0 0;padding-left:20px;color:#5A6B7B;font-size:13px;line-height:1.7;">
            <li><strong>No dia do seu check-in, às 14h</strong> (2h antes da chegada), você recebe automaticamente pelo WhatsApp: endereço, vídeo de como chegar, senha da porta da rua, senha do quarto e Wi-Fi 🌿</li>
            <li>Você não precisa fazer nada — é só relaxar e curtir a viagem</li>
            <li>Qualquer dúvida antes ou durante, é só responder nosso WhatsApp: <a href="https://wa.me/5511943330911" style="color:#2C5F8D;">(11) 94333-0911</a></li>
          </ol>
        </td></tr>

        <!-- Botões -->
        <tr><td style="padding:0 32px 24px;text-align:center;">
          <a href="https://wa.me/5511943330911?text=Oi!%20Tenho%20uma%20dúvida%20sobre%20minha%20reserva%20${codigo}" style="display:inline-block;background:#25D366;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:600;font-size:14px;">💬 Falar no WhatsApp</a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#F8F5F0;padding:24px 32px;text-align:center;border-top:1px solid #E8DDD0;">
          <p style="margin:0;font-family:Georgia,serif;font-style:italic;color:#8A9BA9;font-size:13px;">"Mais leve que hotel, mais humana que aluguel."</p>
          <p style="margin:12px 0 0;font-size:11px;color:#A8B5C0;">Domus Garden Coliving · Desde 2021 · São Paulo, SP</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function montarTextoPlano(r: any): string {
  const codigo = String(r.id).substring(0, 8).toUpperCase();
  return `Oi ${r.hospede_nome || "amigo(a)"}!

Sua reserva na Domus Garden está confirmada ✓

CÓDIGO: ${codigo}
Acomodação: ${r.cama || "—"}
Check-in: ${fmtData(r.checkin)} (a partir das 16h)
Check-out: ${fmtData(r.checkout)} (até as 11h)
${r.valor_total ? `Total: ${fmtMoeda(Number(r.valor_total))}\n` : ""}
Endereço: R. Andrade Pertence, 25, Vila Olímpia, São Paulo
Mapa: https://maps.google.com/?q=R.+Andrade+Pertence,+25,+Vila+Olímpia

⏰ NO DIA DA CHEGADA, ÀS 14h, você r