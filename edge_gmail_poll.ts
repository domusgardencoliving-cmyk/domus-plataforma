// =========================================================
// EDGE FUNCTION: gmail-poll-atrio
//
// Faz polling do Gmail (via API REST com OAuth refresh token) a cada 10 min
// Filtra emails NOVOS de Airbnb/Booking/Webquartos
// Parsea conteúdo e cria mensagem no Átrio (tabela conversas + mensagens_inbox)
//
// SETUP necessário (OAuth uma vez, refresh_token sem expiração):
//   1. Google Cloud Console → criar Project "Domus Atrio"
//   2. Enable Gmail API
//   3. OAuth consent screen → External, scope: gmail.readonly
//   4. Credentials → OAuth 2.0 Client ID (web) → redirect: localhost:3000
//   5. Pegar refresh_token via OAuth Playground
//
// Variáveis de ambiente:
//   GOOGLE_CLIENT_ID         (do passo 4)
//   GOOGLE_CLIENT_SECRET     (do passo 4)
//   GOOGLE_REFRESH_TOKEN     (do passo 5)
//   GMAIL_USER               (domusgardencoliving@gmail.com)
//   ULTIMA_SYNC_GMAIL        (timestamp ISO da última checagem — auto)
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const detectarCanal = (from: string, subject: string): string | null => {
  const f = (from + " " + subject).toLowerCase();
  if (f.includes("airbnb.com") || f.includes("airbnb")) return "airbnb";
  if (f.includes("booking.com") || f.includes("booking")) return "booking";
  if (f.includes("webquartos") || f.includes("web quartos")) return "webquartos";
  if (f.includes("expedia") || f.includes("hotels.com")) return "expedia";
  return null;
};

const parseEmailDomus = (snippet: string, payload: any, canal: string) => {
  let bodyText = snippet || "";
  let hospedeNome = "";

  // tenta extrair body de payload.parts
  if (payload?.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        try {
          bodyText = atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
          break;
        } catch {}
      }
    }
  } else if (payload?.body?.data) {
    try {
      bodyText = atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    } catch {}
  }

  // Extrai nome do hóspede por padrão de cada plataforma
  if (canal === "airbnb") {
    const m = bodyText.match(/(?:from|de)[\s:]+([A-Za-zÀ-ÿ\s]+?)(?:\n|$|<)/i)
            || bodyText.match(/^([A-Za-zÀ-ÿ\s]+?)\s+(?:sent|enviou)/im);
    hospedeNome = (m?.[1] || "").trim();
  } else if (canal === "booking") {
    const m = bodyText.match(/^([A-Za-zÀ-ÿ\s]+?)\s+(?:sent|enviou)/im);
    hospedeNome = (m?.[1] || "").trim();
  } else if (canal === "webquartos") {
    const m = bodyText.match(/de\s+([A-Za-zÀ-ÿ\s]+?)(?:\s+sobre|\n)/i);
    hospedeNome = (m?.[1] || "").trim();
  }

  return { bodyText: bodyText.slice(0, 3000), hospedeNome };
};

const renovarAccessToken = async (clientId: string, clientSecret: string, refreshToken: string) => {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  return d.access_token as string | undefined;
};

Deno.serve(async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
  const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  const GMAIL_USER = Deno.env.get("GMAIL_USER") || "domusgardencoliving@gmail.com";

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    return new Response(JSON.stringify({
      ok: false,
      erro: "Faltam credenciais Google OAuth",
      proximo_passo: "Configurar GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN nos Secrets",
    }), { headers: { "Content-Type": "application/json" } });
  }

  const accessToken = await renovarAccessToken(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN);
  if (!accessToken) {
    return new Response(JSON.stringify({ ok: false, erro: "Falhou ao renovar access_token" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Busca emails de Airbnb/Booking/Webquartos não lidos OU recentes (24h)
  const query = "from:(airbnb.com OR booking.com OR webquartos.com.br) newer_than:1d -from:noreply";
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${GMAIL_USER}/messages?q=${encodeURIComponent(query)}&maxResults=50`,
    { headers: { Authorization: "Bearer " + accessToken } },
  );
  const list = await listRes.json();
  const messageIds: string[] = (list.messages || []).map((m: any) => m.id);

  const processados: any[] = [];

  for (const msgId of messageIds) {
    // Verifica se já processamos esse email (deduplicação)
    const { data: existe } = await sb
      .from("mensagens_inbox")
      .select("id")
      .eq("external_message_id", msgId)
      .maybeSingle();
    if (existe) {
      processados.push({ msgId, status: "ja_existia" });
      continue;
    }

    // Pega detalhes do email
    const detRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${GMAIL_USER}/messages/${msgId}?format=full`,
      { headers: { Authorization: "Bearer " + accessToken } },
    );
    const det = await detRes.json();
    const headers: Record<string, string> = {};
    for (const h of (det.payload?.headers || [])) {
      headers[h.name.toLowerCase()] = h.value;
    }

    const from = headers["from"] || "";
    const subject = headers["subject"] || "";
    const canal = detectarCanal(from, subject);
    if (!canal) {
      processados.push({ msgId, status: "canal_desconhecido", from });
      continue;
    }

    const { bodyText, hospedeNome } = parseEmailDomus(det.snippet || "", det.payload, canal);

    // Insere no Átrio via RPC
    const { error } = await sb.rpc("registrar_mensagem_entrada", {
      p_canal: canal,
      p_identificador_externo: from,
      p_hospede_nome: hospedeNome || from.split("<")[0].trim(),
      p_hospede_telefone: null,
      p_conteudo: bodyText,
      p_tipo: "texto",
      p_external_message_id: msgId,
      p_metadados: { from, subject, gmail_thread_id: det.threadId },
    });

    processados.push({ msgId, canal, status: error ? "erro:" + error.message : "novo", hospedeNome });
  }

  return new Response(JSON.stringify({
    ok: true,
    encontrados: messageIds.length,
    novos: processados.filter(p => p.status === "novo").length,
    duplicados: processados.filter(p => p.status === "ja_existia").length,
    erros: processados.filter(p => p.status?.startsWith("erro")).length,
    detalhes: processados,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
