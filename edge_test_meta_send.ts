// EDGE FUNCTION: test-meta-send
// Função simples pra testar envio Meta — chama com ?to=5511943330911 ou body
// Usa as variáveis WHATSAPP_TOKEN e WHATSAPP_PHONE_ID do Secrets

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const TOKEN = Deno.env.get("WHATSAPP_TOKEN");
  const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID");

  if (!TOKEN || !PHONE_ID) {
    return new Response(JSON.stringify({ ok: false, erro: "secrets nao configurados" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // pega "to" da query string ou do body
  let to = url.searchParams.get("to");
  if (!to && req.method === "POST") {
    try { const body = await req.json(); to = body.to; } catch {}
  }
  to = to || "5511943330911"; // default Gabi

  // remove tudo que nao é digito
  to = String(to).replace(/\D/g, "");

  const r = await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "hello_world",
        language: { code: "en_US" },
      },
    }),
  });
  const data = await r.json();

  return new Response(
    JSON.stringify({
      ok: r.ok,
      status: r.status,
      to,
      response: data,
    }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
