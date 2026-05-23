// =========================================================
// EDGE FUNCTION: oauth-callback
// =========================================================
// Recebe { provider, code, redirect_uri } do conectar-canais.html.
// Troca o `code` por access_token + refresh_token (via Google ou Meta).
// Salva tokens em public.contas_canais.
//
// Secrets esperados (Supabase Edge Functions):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  (já configurados)
//   META_APP_ID, META_APP_SECRET            (futuro, pra Instagram)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto)
//
// Criada 22/05/2026 pra ligar Gmail no Átrio.
// =========================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), {
  status: s,
  headers: { ...cors, "Content-Type": "application/json" }
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { provider, code, redirect_uri } = await req.json();
    if (!provider || !code) return json({ erro: "provider e code obrigatorios" }, 400);

    const SUPA = Deno.env.get("SUPABASE_URL")!;
    const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    let tokenData: any = null;
    let userInfo: any = null;

    if (provider === "gmail") {
      const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
      const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
      if (!clientId || !clientSecret) {
        return json({ erro: "GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET nao configurados" }, 500);
      }
      // 1. Trocar code por tokens
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirect_uri || "https://domusgardencoliving.com/conectar-canais.html",
          grant_type: "authorization_code"
        })
      });
      tokenData = await r.json();
      if (!r.ok || !tokenData.access_token) {
        return json({ erro: "Falha trocando code: " + JSON.stringify(tokenData) }, 400);
      }
      // 2. Pegar e-mail do usuário (pra identificar a conta)
      const u = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { "Authorization": "Bearer " + tokenData.access_token }
      });
      userInfo = await u.json();
    } else if (provider === "instagram") {
      const appId = Deno.env.get("META_APP_ID");
      const appSecret = Deno.env.get("META_APP_SECRET");
      if (!appId || !appSecret) {
        return json({ erro: "META_APP_ID ou META_APP_SECRET nao configurados (Instagram setup pendente)" }, 500);
      }
      const r = await fetch("https://graph.facebook.com/v18.0/oauth/access_token", {
        method: "GET",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      tokenData = await r.json();
      if (!r.ok) return json({ erro: "Falha Meta: " + JSON.stringify(tokenData) }, 400);
      userInfo = { email: "instagram@meta", id: tokenData.user_id || "unknown" };
    } else {
      return json({ erro: "provider desconhecido: " + provider }, 400);
    }

    // 3. Salvar/upsert em contas_canais
    const agora = new Date().toISOString();
    const upsert = {
      canal: provider,
      identificador: userInfo?.email || userInfo?.id || "unknown",
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_in: tokenData.expires_in || null,
      scope: tokenData.scope || null,
      status: "conectado",
      conectado_em: agora,
      atualizado_em: agora,
      metadata: userInfo || {}
    };

    const h = {
      "apikey": SVC,
      "Authorization": "Bearer " + SVC,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=representation"
    };
    const u = await fetch(SUPA + "/rest/v1/contas_canais?on_conflict=canal", {
      method: "POST",
      headers: h,
      body: JSON.stringify(upsert)
    });
    const saved = await u.json();
    if (!u.ok) {
      console.error("erro upsert", saved);
      return json({ erro: "Erro salvando token: " + JSON.stringify(saved) }, 500);
    }

    return json({ success: true, conta: userInfo?.email || userInfo?.id, refresh_token_obtido: !!tokenData.refresh_token });
  } catch (e: any) {
    console.error(e);
    return json({ erro: e.message || String(e) }, 500);
  }
});
