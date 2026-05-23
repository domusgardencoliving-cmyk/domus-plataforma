// =========================================================
// EDGE FUNCTION: enviar-mensagem-canal
// =========================================================
// Body: { conversa_id: uuid, texto: string }
// Lê conversa, decide canal, envia via Gmail API (Airbnb/Booking/Webquartos/email
// todos saem como e-mail, o canal entrega pra plataforma deles).
// Insere a mensagem em mensagens_inbox com direcao='saida'.
// =========================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};
const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SUPA = Deno.env.get("SUPABASE_URL");
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CID = Deno.env.get("GOOGLE_CLIENT_ID");
const CSEC = Deno.env.get("GOOGLE_CLIENT_SECRET");

const h = { "apikey": SVC, "Authorization": "Bearer " + SVC, "Content-Type": "application/json" };

const renovarAccessToken = async (refreshToken) => {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, refresh_token: refreshToken, grant_type: "refresh_token" })
  });
  const d = await r.json();
  return d.access_token || null;
};

// Codifica string UTF-8 -> base64url (Gmail API espera assim)
const base64UrlEncode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { conversa_id, texto } = await req.json();
    if (!conversa_id || !texto) return j({ erro: "conversa_id e texto obrigatorios" }, 400);

    // 1. Busca conversa
    const rC = await fetch(SUPA + "/rest/v1/conversas?id=eq." + conversa_id + "&select=*", { headers: h });
    const conv = (await rC.json())[0];
    if (!conv) return j({ erro: "conversa nao encontrada" }, 404);

    // 2. Busca conta Gmail (refresh_token + identificador remetente)
    const rA = await fetch(SUPA + "/rest/v1/contas_canais?canal=eq.gmail&status=eq.conectado&select=*&limit=1", { headers: h });
    const conta = (await rA.json())[0];
    if (!conta || !conta.refresh_token) return j({ erro: "Gmail nao conectado" }, 400);

    // 3. Renova access_token
    const accessToken = await renovarAccessToken(conta.refresh_token);
    if (!accessToken) return j({ erro: "Falha renovando token" }, 500);

    // 4. Determina destinatário e assunto/threading
    const destinatario = conv.identificador_externo;
    const userPath = conta.identificador === "unknown" ? "me" : encodeURIComponent(conta.identificador);

    // 5. Pega última mensagem de entrada pra threading (In-Reply-To, References, Subject)
    const rM = await fetch(SUPA + "/rest/v1/mensagens_inbox?conversa_id=eq." + conversa_id + "&direcao=eq.entrada&order=enviada_em.desc&limit=1&select=external_message_id,metadados", { headers: h });
    const ultima = (await rM.json())[0];
    const meta = ultima?.metadados || {};
    const subjectOriginal = meta.subject || "Mensagem da Domus Garden";
    const subjectResposta = subjectOriginal.match(/^re:/i) ? subjectOriginal : "Re: " + subjectOriginal;
    const threadId = meta.gmail_thread_id;
    const inReplyTo = ultima?.external_message_id ? ("<" + ultima.external_message_id + ">") : null;

    // 6. Monta MIME (RFC 2822)
    const rfcSubject = "=?UTF-8?B?" + base64UrlEncode(subjectResposta).replace(/-/g, "+").replace(/_/g, "/") + "?=";
    const headers = [
      "To: " + destinatario,
      "Subject: " + rfcSubject,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      inReplyTo ? "In-Reply-To: " + inReplyTo : null,
      inReplyTo ? "References: " + inReplyTo : null,
      "MIME-Version: 1.0"
    ].filter(Boolean).join("\r\n");
    const bodyB64 = btoa(unescape(encodeURIComponent(texto)));
    const raw = headers + "\r\n\r\n" + bodyB64;
    const rawEncoded = base64UrlEncode(raw);

    // 7. Envia via Gmail API
    const payload = { raw: rawEncoded };
    if (threadId) payload.threadId = threadId;
    const rSend = await fetch("https://gmail.googleapis.com/gmail/v1/users/" + userPath + "/messages/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const sendData = await rSend.json();
    if (!rSend.ok) return j({ erro: "Falha enviando: " + JSON.stringify(sendData) }, 500);

    // 8. Insere mensagem em mensagens_inbox como direcao=saida
    const insertMsg = {
      conversa_id,
      direcao: "saida",
      autor: conta.identificador,
      autor_tipo: "operador",
      conteudo: texto,
      tipo: "texto",
      external_message_id: sendData.id || null,
      metadados: { gmail_thread_id: sendData.threadId, sent_via: "atrio" },
      enviada_em: new Date().toISOString(),
      status_envio: "enviada"
    };
    await fetch(SUPA + "/rest/v1/mensagens_inbox", {
      method: "POST",
      headers: { ...h, "Prefer": "return=minimal" },
      body: JSON.stringify(insertMsg)
    });

    // 9. Atualiza conversa (atualizada_em, zera nao_lidas)
    await fetch(SUPA + "/rest/v1/conversas?id=eq." + conversa_id, {
      method: "PATCH",
      headers: { ...h, "Prefer": "return=minimal" },
      body: JSON.stringify({ atualizada_em: new Date().toISOString(), nao_lidas: 0 })
    });

    return j({ success: true, gmail_id: sendData.id, thread: sendData.threadId });
  } catch (e) {
    console.error(e);
    return j({ erro: e.message || String(e) }, 500);
  }
});
