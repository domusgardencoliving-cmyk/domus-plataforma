// ===================================================================
// EDGE FUNCTION: insight-fechamento
// Gera 3 insights de IA (Claude haiku) sobre o fechamento mensal de
// uma unidade, com cache em insights_fechamento (invalidado por hash
// dos dados — se os lançamentos mudarem, regenera).
// ===================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { unidade, mes } = await req.json();
    if (!["Rib", "AP"].includes(unidade) || !/^\d{4}-\d{2}$/.test(mes || "")) return json({ erro: "params" }, 400);

    const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const URL_SB = Deno.env.get("SUPABASE_URL")!;
    const sb = (path: string, opts: RequestInit = {}) =>
      fetch(`${URL_SB}/rest/v1/${path}`, {
        ...opts,
        headers: {
          apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json",
          ...(opts.headers || {}),
        },
      });

    // dados: mês alvo + 5 meses anteriores (contexto de tendência)
    const [a, m] = mes.split("-").map(Number);
    const prox = new Date(a, m, 1).toISOString().slice(0, 10);
    const ini6 = new Date(a, m - 6, 1).toISOString().slice(0, 10);
    const lanc = await sb(`lancamentos?unidade=eq.${unidade}&data=gte.${ini6}&data=lt.${prox}&select=tipo,categoria,descricao,valor,data,forma_pagamento&limit=2000`).then((r) => r.json());
    const doMes = (lanc as any[]).filter((l) => String(l.data).slice(0, 7) === mes);
    if (!doMes.length) return json({ insights: [] });

    const totR = doMes.filter((l) => l.tipo === "receita").reduce((s2, l) => s2 + Number(l.valor), 0);
    const totD = doMes.filter((l) => l.tipo === "despesa").reduce((s2, l) => s2 + Number(l.valor), 0);
    const hash = `${doMes.length}:${totR.toFixed(2)}:${totD.toFixed(2)}`;

    // cache válido?
    const c = await sb(`insights_fechamento?unidade=eq.${unidade}&mes=eq.${mes}&select=conteudo,hash`).then((r) => r.json());
    if (Array.isArray(c) && c.length && c[0].hash === hash && Array.isArray(c[0].conteudo) && c[0].conteudo.length) {
      return json({ insights: c[0].conteudo, cache: true });
    }

    // resumo pro modelo
    const porCat: Record<string, number> = {};
    doMes.filter((l) => l.tipo === "despesa").forEach((l) => { const k = l.categoria || "Outros"; porCat[k] = (porCat[k] || 0) + Number(l.valor); });
    const porMes: Record<string, number> = {};
    (lanc as any[]).forEach((l) => { const k = String(l.data).slice(0, 7); porMes[k] = (porMes[k] || 0) + (l.tipo === "receita" ? 1 : -1) * Number(l.valor); });
    const resumo = {
      unidade: unidade === "Rib" ? "Domus Ribeirão Claro (coliving feminino, 14 vagas)" : "Domus Andrade Pertence (coliving + hostel)",
      mes, entradas: totR.toFixed(2), saidas: totD.toFixed(2), resultado: (totR - totD).toFixed(2),
      margem_pct: totR > 0 ? Math.round(((totR - totD) / totR) * 100) : 0,
      despesas_por_categoria: porCat, liquido_ultimos_meses: porMes,
      qtd_receitas: doMes.filter((l) => l.tipo === "receita").length,
      qtd_despesas: doMes.filter((l) => l.tipo === "despesa").length,
    };

    const prompt = `Você é analista financeiro do Domus Garden Coliving. Dados do fechamento mensal (valores em R$):
${JSON.stringify(resumo, null, 1)}

Gere exatamente 3 insights curtos (1 frase cada, máximo 25 palavras) em português do Brasil sobre este fechamento. Regras:
- Concretos, com números (formato R$ 1.234,56 e percentuais)
- Úteis pra decisão da gestora (tendência, concentração de custo, comparação com meses anteriores, oportunidade)
- Meses com líquido muito baixo nos dados históricos provavelmente só não tiveram fechamento completo lançado — não trate como queda real
- Nunca use diminutivos
- Responda SOMENTE um array JSON: ["insight 1","insight 2","insight 3"]`;

    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    }).then((r) => r.json());

    const texto = ai?.content?.[0]?.text || "[]";
    let insights: string[] = [];
    try { insights = JSON.parse(texto.match(/\[[\s\S]*\]/)?.[0] || "[]"); } catch (_) { insights = []; }
    if (!Array.isArray(insights)) insights = [];
    insights = insights.filter((x) => typeof x === "string").slice(0, 3);

    if (insights.length) {
      await sb(`insights_fechamento?unidade=eq.${unidade}&mes=eq.${mes}`, { method: "DELETE" });
      await sb("insights_fechamento", { method: "POST", body: JSON.stringify({ unidade, mes, hash, conteudo: insights }) });
    }
    return json({ insights });
  } catch (e) {
    return json({ erro: String(e) }, 500);
  }
});
