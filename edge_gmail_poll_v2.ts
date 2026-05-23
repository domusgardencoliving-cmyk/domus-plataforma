// =========================================================
// EDGE FUNCTION: gmail-poll-atrio (v3)
// =========================================================
// v3 (22/05/2026): UTF-8 decode + stripHtml pra evitar emojis corrompidos
// =========================================================

const SUPA = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");

const h = {
  "apikey": SVC,
  "Authorization": "Bearer " + SVC,
  "Content-Type": "application/json"
};

const detectarCanal = (from, subject) => {
  const f = (from + " " + subject).toLowerCase();
  if (f.includes("airbnb")) return "airbnb";
  if (f.includes("booking")) return "booking";
  if (f.includes("webquartos") || f.includes("web quartos")) return "webquartos";
  if (f.includes("expedia") || f.includes("hotels.com")) return "expedia";
  return "email";
};

const decodeUtf8 = (b64url) => {
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
};

const stripHtml = (html) => html
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/?(p|div|tr|li)[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&[a-z]+;/gi, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const extrairBody = (payload, snippet) => {
  const procurar = (p) => {
    if (p?.body?.data && p.mimeType === "text/plain") return { tipo: "text", data: p.body.data };
    if (p?.body?.data && p.mimeType === "text/html") return { tipo: "html", data: p.body.data };
    if (p?.parts) {
      for (const part of p.parts) if (part.mimeType === "text/plain" && part.body?.data) return { tipo: "text", data: part.body.data };
      for (const part of p.parts) if (part.mimeType === "text/html" && part.body?.data) return { tipo: "html", data: part.body.data };
      for (const part of p.parts) { const r = procurar(part); if (r) return r; }
    }
    return null;
  };
  const found = procurar(payload);
  if (found) {
    try {
      const txt = decodeUtf8(found.data);
      return found.tipo === "html" ? stripHtml(txt) : txt;
    } catch {}
  }
  return snippet || "";
};

const renovarAccessToken = async (refreshToken) => {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" })
  });
  const d = await r.json();
  return d.access_token || null;
};

Deno.serve(async () => {
  if (!CLIENT_ID || !CLIENT_SECRET) return new Response(JSON.stringify({ ok: false, erro: "GOOGLE_CLIENT_ID/SECRET nao configurado" }), { headers: { "Content-Type": "application/json" } });

  const r0 = await fetch(SUPA + "/rest/v1/contas_canais?canal=eq.gmail&status=eq.conectado&select=id,identificador,refresh_token", { headers: h });
  const contas = await r0.json();
  if (!Array.isArray(contas) || contas.length === 0) return new Response(JSON.stringify({ ok: true, erro: "Nenhuma conta gmail conectada" }), { headers: { "Content-Type": "application/json" } });

  const resumo = [];
  for (const conta of contas) {
    if (!conta.refresh_token) { resumo.push({ conta: conta.identificador, status: "sem_refresh_token" }); continue; }
    const accessToken = await renovarAccessToken(conta.refresh_token);
    if (!accessToken) { resumo.push({ conta: conta.identificador, status: "falha_renovar_token" }); continue; }

    const q = "newer_than:1d -from:noreply -from:no-reply";
    const userPath = conta.identificador === "unknown" ? "me" : encodeURIComponent(conta.identificador);
    const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/" + userPath + "/messages?q=" + encodeURIComponent(q) + "&maxResults=30", { headers: { "Authorization": "Bearer " + accessToken } });
    const list = await listRes.json();
    const messageIds = (list.messages || []).map(m => m.id);
    let novos = 0, jaTinha = 0, erros = 0;

    for (const msgId of messageIds) {
      const rDup = await fetch(SUPA + "/rest/v1/mensagens_inbox?external_message_id=eq." + msgId + "&select=id&limit=1", { headers: h });
      const dupArr = await rDup.json();
      if (Array.isArray(dupArr) && dupArr.length > 0) { jaTinha++; continue; }

      const detRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/" + userPath + "/messages/" + msgId + "?format=full", { headers: { "Authorization": "Bearer " + accessToken } });
      const det = await detRes.json();
      const headersMap = {};
      for (const hd of (det.payload?.headers || [])) headersMap[hd.name.toLowerCase()] = hd.value;

      const from = headersMap["from"] || "";
      const subject = headersMap["subject"] || "(sem assunto)";
      const canal = detectarCanal(from, subject) || "email";
      const bodyText = extrairBody(det.payload, det.snippet || "").slice(0, 3000);
      const fromEmail = (from.match(/<([^>]+)>/) || [, from])[1].trim();

      const rIns = await fetch(SUPA + "/rest/v1/rpc/registrar_mensagem_entrada", {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          p_canal: canal,
          p_identificador_externo: fromEmail,
          p_hospede_nome: from.split("<")[0].trim() || fromEmail,
          p_hospede_telefone: null,
          p_conteudo: subject + "\n\n" + bodyText,
          p_tipo: "texto",
          p_external_message_id: msgId,
          p_metadados: { from, subject, gmail_thread_id: det.threadId, gmail_message_id: msgId }
        })
      });
      if (rIns.ok) novos++; else erros++;
    }

    await fetch(SUPA + "/rest/v1/contas_canais?id=eq." + conta.id, {
      method: "PATCH",
      headers: { ...h, "Prefer": "return=minimal" },
      body: JSON.stringify({ ultima_sync_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
    });
    resumo.push({ conta: conta.identificador, encontrados: messageIds.length, novos, ja_tinha: jaTinha, erros });
  }
  return new Response(JSON.stringify({ ok: true, resumo }, null, 2), { headers: { "Content-Type": "application/json" } });
});
