// =========================================================
// EDGE FUNCTION: email-to-inbox
//
// Recebe POST com email parseado (de Mailgun, SendGrid Inbound, ou Cloudflare Email Workers)
// Detecta canal (airbnb, booking, webquartos) pelo domínio do remetente
// Extrai nome do hospede + mensagem original
// Cria/atualiza conversa via RPC `registrar_mensagem_entrada`
//
// Setup do email forwarding:
//  Gmail Filter: from:airbnb.com OR from:booking.com OR from:webquartos.com.br
//    → Forward para inbox@parse.mailgun.com (ou serviço similar)
//    → Mailgun manda POST pra esta Edge Function
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

interface EmailParsed {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}

const detectarCanal = (email: EmailParsed): string => {
  const from = (email.from || "").toLowerCase();
  if (from.includes("airbnb.com")) return "airbnb";
  if (from.includes("booking.com")) return "booking";
  if (from.includes("webquartos.com")) return "webquartos";
  if (from.includes("expedia.com") || from.includes("hotels.com")) return "expedia";
  return "email";
};

// Extrair nome do hospede e mensagem original baseado no template de cada plataforma
const parseEmail = (email: EmailParsed, canal: string) => {
  const txt = email.text || stripHtml(email.html || "");
  let hospedeNome = "";
  let mensagemOriginal = txt;
  let identificadorExterno = email.from;

  if (canal === "airbnb") {
    // Airbnb: "From: Maria Silva" ou "Maria Silva sent you a message"
    const m1 = txt.match(/(?:from|de)[\s:]+([A-Za-zÀ-ÿ\s]+?)(?:\n|$|<)/i);
    const m2 = txt.match(/^([A-Za-zÀ-ÿ\s]+?)\s+(?:sent you|enviou)/im);
    hospedeNome = (m1?.[1] || m2?.[1] || "").trim();
    // Mensagem geralmente fica entre "Message:" e "Reply" ou "Respond"
    const corpo = txt.match(/(?:message|mensagem|escreveu)[\s:]*\n+([\s\S]+?)(?:\n+(?:reply|respond|responder|cancel|view))/i);
    if (corpo) mensagemOriginal = corpo[1].trim();
  } else if (canal === "booking") {
    // Booking: "X sent you a message about your reservation Y"
    const m = txt.match(/^([A-Za-zÀ-ÿ\s]+?)\s+(?:sent|enviou)/im);
    hospedeNome = (m?.[1] || "").trim();
    const corpo = txt.match(/(?:message|mensagem)[\s:]*\n+([\s\S]+?)(?:\n+(?:reply|view|cancel))/i);
    if (corpo) mensagemOriginal = corpo[1].trim();
  } else if (canal === "webquartos") {
    // Webquartos: "Mensagem de Maria Silva sobre reserva #123"
    const m = txt.match(/de\s+([A-Za-zÀ-ÿ\s]+?)(?:\s+sobre|\n)/i);
    hospedeNome = (m?.[1] || "").trim();
  }

  return {
    canal,
    identificadorExterno,
    hospedeNome: hospedeNome || email.from.split("@")[0],
    hospedeTelefone: null as string | null,
    mensagemOriginal,
    metadados: { from: email.from, subject: email.subject },
  };
};

const stripHtml = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, erro: "use POST" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: EmailParsed;
  try {
    body = (await req.json()) as EmailParsed;
  } catch {
    // Aceita também form-encoded (Mailgun usa multipart/form-data)
    const form = await req.formData();
    body = {
      from: String(form.get("from") || form.get("sender") || ""),
      to: String(form.get("to") || form.get("recipient") || ""),
      subject: String(form.get("subject") || ""),
      text: String(form.get("body-plain") || form.get("text") || ""),
      html: String(form.get("body-html") || form.get("html") || ""),
    };
  }

  const canal = detectarCanal(body);
  const parsed = parseEmail(body, canal);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await sb.rpc("registrar_mensagem_entrada", {
    p_canal: parsed.canal,
    p_identificador_externo: parsed.identificadorExterno,
    p_hospede_nome: parsed.hospedeNome,
    p_hospede_telefone: parsed.hospedeTelefone,
    p_conteudo: parsed.mensagemOriginal,
    p_tipo: "texto",
    p_external_message_id: body.headers?.["message-id"] || null,
    p_metadados: parsed.metadados,
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, erro: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, canal, mensagem_id: data }), {
    headers: { "Content-Type": "application/json" },
  });
});
