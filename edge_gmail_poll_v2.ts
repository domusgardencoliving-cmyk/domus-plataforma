// =========================================================
// EDGE FUNCTION: gmail-poll-atrio (v2)
// =========================================================
// Polling do Gmail a cada 10 min (cron). Diferenças da v1:
// - Le refresh_token da tabela contas_canais (em vez de env var)
// - Suporta multiplas contas Gmail conectadas (loop por linha)
// - Sem dependencia supabase-js (fetch direto, evita BOOT_ERROR)
//
// Criada 22/05/2026.
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

const detectarCanal = (from: string, subject: string): string | null => {
  const f = (from + " " + subject).toLowerCase();
  if (f.includes("airbnb.com") || f.includes("airbnb")) return "airbnb";
  if (f.includes("booking.com") || f.includes("booking")) return "booking";
  if (f.includes("webquartos") || f.includes("web quartos")) return "webquartos";
  if (f.includes("expedia") || f.includes("hotels.com")) return "expedia";
  return "email"; // e-mail direto (não-OTA)
};

// Decodifica base64url -> UTF-8 (preservando emojis e acentos)
const decodeUtf8 = (b64url: string): string => {
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
};

// Remove HTML tags e entities pra obter texto limpo
const stripHtml = (html: string): string => {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const extrairBody = (payload: any, snippet: string): string => {
  // Tenta text/plain primeiro (mais limpo)
  const procurar = (p: any): { tipo: string; data: string } | null => {
    if (p?.body?.data && p.mimeType === "text/plain") return { tipo: "text", data: p.body.data };
    if (p?.body?.data && p.mimeType === "text/html") return { tipo: "html", data: p.body.data };
    if (p?.parts) {
      // text/plain tem prioridade
      for (const part of p.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) return { tipo: "text", data: part.body.data };
      }
      // depois html
      for (const part of p.parts) {
        if (part.mimeType === "text/html" && part.body?.data) return { tipo: "html", data: part.body.data };
      }
      // depois recursivo (multipart aninhado)
      for (const part of p.parts) {
        const r = procurar(part);
        if (r) return r;
      }
    }
    return null;
  };

  const found = procurar(payload);
  if (found) {
    try {
      const txt = decodeUtf8(found.data);
      return found.tipo === "html" ? stripHtml(txt) : txt;
    } catch { /* fallback abaixo */ }
  }
  return snippet || "";
};

const renovarAccessToken = async (refreshToken: string): Promise<string | null> => {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const d = await r.json();
  return d.access_token || null;
};

Deno.serve(async () => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return new Response(JSON.stringify({ ok: false, erro: "GOOGLE_CLIENT_ID/SECRET nao configurado" }), { headers: { "Content-Type": "application/json" } });
  }

  // 1. Busca contas gmail conectadas (com refresh_token)
  const r0 = await fetch(SUPA + "/rest/v1/contas_canais?canal=eq.gmail&status=eq.conectado&select=id,identificador,refresh_token", { headers: h });
  const contas = await r0.json();
  if (!Array.isArray(contas) || contas.length === 0) {
    return new Response(JSON.stringify({ ok: true, erro: "Nenhuma conta gmail conectada" }), { headers: { "Content-Type": "application/json" } });
  }

  const resumo: any[] = [];

  for (const conta of contas) {
    if (!conta.refresh_token) {
      resumo.push({ conta: conta.identificador, status: "sem_refresh_token" });
      continue;
    }

    const accessToken = await renovarAccessToken(conta.refresh_token);
    if (!accessToken) {
      resumo.push({ conta: conta.identificador, status: "falha_renovar_token" });
      continue;
    }

    // 2. Busca emails recentes (1 dia) de Airbnb/Booking/Webquartos OU qualquer outro
    const q = "newer_than:1d -from:noreply -from:no-reply";
    const userPath = conta.identificador === "unknown" ? "me" : encodeURIComponent(conta.identificador);
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${userPath}/messages?q=${encodeURIComponent(q)}&maxResults=30`, {
      headers: { "Authorization": "Bearer " + accessToken }
    });
    const list = await listRes.json();
    const messageIds: string[] = (list.messages || []).map((m: any) => m.id);
    let novos = 0, jaTinha = 0, erros = 0;

    for (const msgId of messageIds) {
      // Dedup: já processamos esse email?
      const rDup = await fetch(SUPA + "/rest/v1/mensagens_inbox?external_message_id=eq." + msgId + "&select=id&limit=1", { headers: h });
      const dupArr = await rDup.json();
      if (Array.isArray(dupArr) && dupArr.length > 0) { jaTinha++; continue; }

      // Detalhes do email
      const detRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${userPath}/messages/${msgId}?format=full`, {
        headers: { "Authorization": "Bearer " + accessToken }
      });
      const det = await detRes.json();
      const headers: Record<string, string> = {};
      for (const hd of (det.payload?.headers ||