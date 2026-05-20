// =============================================================
// EDGE FUNCTION: processar-aprovacao-contrato
// =============================================================
// Disparada da tela admin quando Gabi clica "Aprovar".
// Body: { contrato_id, quarto?, valor_final?, cortesia_dias_extras?, parcelas_caucao? }
// Gera o contrato no ZapSign a partir do template correto (AP/Rib),
// salva zapsign_doc_id + link, e dispara envio do link pra moradora.
// =============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const json = (b: any, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json", ...corsHeaders } });

// Helpers
const meses = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const dataExtenso = (s: string) => { const [y,m,d] = s.split("-"); return `${parseInt(d)} de ${meses[parseInt(m)-1]} de ${y}`; };
const fmtBR = (n: number) => Number(n||0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtData = (s: string) => { const [y,m,d] = s.split("-"); return `${d}/${m}/${y}`; };

// Números por extenso (1-9999 cobre todos nossos casos)
const u = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const e10 = ["dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const d10 = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const c100 = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
function porExtenso(n: number): string {
  if (n === 0) return "zero";
  if (n < 0) return "menos " + porExtenso(-n);
  if (n < 10) return u[n];
  if (n < 20) return e10[n - 10];
  if (n < 100) { const d = Math.floor(n / 10), r = n % 10; return d10[d] + (r ? " e " + u[r] : ""); }
  if (n === 100) return "cem";
  if (n < 1000) { const c = Math.floor(n / 100), r = n % 100; return c100[c] + (r ? " e " + porExtenso(r) : ""); }
  const m = Math.floor(n / 1000), r = n % 1000;
  const mil = m === 1 ? "mil" : porExtenso(m) + " mil";
  return mil + (r ? (r < 100 ? " e " : " ") + porExtenso(r) : "");
}
function reaisExtenso(v: number): string {
  const inteiro = Math.floor(v);
  const cent = Math.round((v - inteiro) * 100);
  let s = porExtenso(inteiro) + " reais";
  if (cent > 0) s += " e " + porExtenso(cent) + " centavos";
  return s;
}

function diasNoMes(ano: number, mes: number): number { return new Date(ano, mes, 0).getDate(); }

function calcularCronograma(input: {
  unidade: string, data_entrada: string, aluguel: number, caucao: number,
  parcelas_caucao: number, cortesia_dias_extras: number
}) {
  const [y, m, d] = input.data_entrada.split("-").map(Number);
  const dia = d;
  const ultimoDiaMes = diasNoMes(y, m);
  const dias_cortesia = (ultimoDiaMes - dia + 1) + input.cortesia_dias_extras;

  const cronograma: any[] = [];
  const caucaoParcela = +(input.caucao / input.parcelas_caucao).toFixed(2);

  // 1. Caucao 1a parcela: vence 1 dia antes da entrada
  const dtCaucao1 = new Date(y, m - 1, dia - 1);
  cronograma.push({
    data: dtCaucao1.toLocaleDateString("pt-BR"),
    valor: caucaoParcela,
    composicao: input.parcelas_caucao > 1 ? `Caução (1ª de ${input.parcelas_caucao} parcelas)` : "Caução (parcela única à vista)",
    obs: "Vence 1 dia antes da entrada"
  });

  // 2. Boleto pro-rata: dia 01 do mês seguinte, 14 dias proporcionais
  const dia01ProxMes = new Date(y, m, 1);
  const proRata = +((input.aluguel / 30) * 14).toFixed(2);
  cronograma.push({
    data: dia01ProxMes.toLocaleDateString("pt-BR"),
    valor: proRata,
    composicao: `Proporcional 14 dias (01/${String(m+1).padStart(2,'0')} a 14/${String(m+1).padStart(2,'0')})`,
    obs: "Cobre dia 1 ao 14 do mês seguinte"
  });

  // 3. Caucao 2a parcela (se houver): junto com o boleto pro-rata (mesma data dia 15 do mes seguinte)
  if (input.parcelas_caucao > 1) {
    const dtCaucao2 = new Date(y, m, 15);
    cronograma.push({
      data: dtCaucao2.toLocaleDateString("pt-BR"),
      valor: caucaoParcela,
      composicao: `Caução (2ª e última parcela)`,
      obs: "Completa a caução"
    });
  }

  // 4. Mensalidades cheias - dia 15 de cada mes
  // (Cobrir tantas quanto possivel ate 6 linhas de cronograma)
  for (let i = 0; cronograma.length < 6; i++) {
    const dtParcela = new Date(y, m + 1 + i, 15);
    if (dtParcela.getMonth() !== ((m + 1 + i) % 12)) break;
    cronograma.push({
      data: dtParcela.toLocaleDateString("pt-BR"),
      valor: input.aluguel,
      composicao: `Aluguel cheio + energia (15/${String(dtParcela.getMonth()+1).padStart(2,'0')} a 14/${String((dtParcela.getMonth()+2)%12 || 12).padStart(2,'0')})`,
      obs: ""
    });
  }

  return { cronograma, dias_cortesia, ultimoDiaMes };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { contrato_id, quarto, valor_final, cortesia_dias_extras, parcelas_caucao, cortesia_obs } = body;
    if (!contrato_id) return json({ error: "contrato_id obrigatório" }, 400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ZAPSIGN_TOKEN = Deno.env.get("ZAPSIGN_API_TOKEN")!;
    const ZAPSIGN_AP = Deno.env.get("ZAPSIGN_TEMPLATE_AP")!;
    const ZAPSIGN_RIB = Deno.env.get("ZAPSIGN_TEMPLATE_RIB")!;
    const ZAPSIGN_SANDBOX = (Deno.env.get("ZAPSIGN_SANDBOX") || "true") === "true";
    const sb = createClient(SUPABASE_URL, SVC);

    const { data: c, error: errC } = await sb.from("contratos_pendentes").select("*").eq("id", contrato_id).single();
    if (errC || !c) return json({ error: "contrato não encontrado", detalhe: errC?.message }, 404);
    if (!c.unidade) return json({ error: "contrato sem unidade definida" }, 400);

    // Valores efetivos (sobrescreve com input da Gabi se fornecido)
    const aluguel = Number(valor_final ?? c.aluguel);
    const caucao = +(aluguel * 0.5).toFixed(2);
    const multa_total = +(aluguel * 1.5).toFixed(2); // caucao retida + 1 aluguel
    const parcelas = Math.max(1, Math.min(2, parcelas_caucao ?? 1));
    const cortesia_extras = Math.max(0, cortesia_dias_extras ?? 0);

    // Cronograma + cortesia
    const { cronograma, dias_cortesia, ultimoDiaMes } = calcularCronograma({
      unidade: c.unidade, data_entrada: c.data_entrada, aluguel, caucao,
      parcelas_caucao: parcelas, cortesia_dias_extras: cortesia_extras
    });

    const [y, m, _d] = c.data_entrada.split("-").map(Number);
    const fimMes = `${String(ultimoDiaMes).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
    const fimMesExt = dataExtenso(`${y}-${String(m).padStart(2,'0')}-${String(ultimoDiaMes).padStart(2,'0')}`);
    const dataInicioAluguel = `01/${String(m+1).padStart(2,'0')}/${y}`;

    // Modalidade texto
    const modTexto = c.modalidade === "12" ? "12 (doze) meses tudo incluso" : "3 (três) meses com caução";
    const fimPrazo = new Date(y, m - 1 + (c.modalidade === "12" ? 12 : 3), _d).toLocaleDateString("pt-BR");

    // Cortesia adicional paragrafo (se houver)
    const cortesiaPar = (cortesia_extras > 0 || cortesia_obs)
      ? `§ Cortesia adicional: ${cortesia_obs || ''} Total de ${dias_cortesia} dia(s) de cortesia comercial.`
      : "";

    // Montar variáveis pro ZapSign
    const vars: Record<string, string> = {
      nome: c.nome,
      idade: String(c.idade || ""),
      rg: c.rg || "",
      cpf: c.cpf || "",
      endereco_pessoal: c.endereco || "",
      telefone: c.telefone || "",
      email: c.email || "",
      emerg1_tel: `${c.emerg1_nome || ""} ${c.emerg1_tel || ""}`.trim(),
      emerg2_tel: `${c.emerg2_nome || ""} ${c.emerg2_tel || ""}`.trim(),
      quarto: quarto || "a definir conforme disponibilidade",
      unidade_endereco: c.unidade === "AP"
        ? "Rua Andrade Pertence, nº 73 – Vila Olímpia – São Paulo/SP"
        : "Rua Ribeirão Claro, nº 547 – Vila Olímpia – São Paulo/SP",
      modalidade_texto: modTexto,
      data_entrada_extenso: dataExtenso(c.data_entrada),
      data_fim_prazo: fimPrazo,
      data_inicio_aluguel: dataInicioAluguel,
      fim_mes_entrada_extenso: fimMesExt,
      dias_cortesia: String(dias_cortesia),
      caucao: fmtBR(caucao),
      caucao_extenso: reaisExtenso(caucao),
      aluguel_regular: fmtBR(aluguel),
      aluguel_regular_extenso: reaisExtenso(aluguel),
      multa_total: fmtBR(multa_total),
      data_assinatura: new Date().toLocaleDateString("pt-BR"),
    };
    // Linhas do cronograma
    for (let i = 0; i < 6; i++) {
      vars[`linha_cronograma_${i + 1}`] = cronograma[i]
        ? `${cronograma[i].data} — R$ ${fmtBR(cronograma[i].valor)} — ${cronograma[i].composicao}${cronograma[i].obs ? " (" + cronograma[i].obs + ")" : ""}`
        : "";
    }

    // Template correto
    const template_id = c.unidade === "AP" ? ZAPSIGN_AP : ZAPSIGN_RIB;

    // Monta payload ZapSign
    const data_to_send = Object.entries(vars).map(([k, v]) => ({ de: `{{${k}}}`, para: v || " " }));
    const zsPayload = {
      sandbox: ZAPSIGN_SANDBOX,
      name: `Contrato ${c.unidade} - ${c.nome}`,
      signer_name: c.nome,
      signer_email: c.email || "",
      signer_phone_country: "55",
      signer_phone_number: (c.telefone || "").replace(/\D/g, ""),
      send_automatic_email: true,
      send_automatic_whatsapp: false, // ativar quando configurar WhatsApp tokens
      lang: "pt-br",
      external_id: contrato_id,
      data: data_to_send,
    };

    const r = await fetch(`https://api.zapsign.com.br/api/v1/models/${template_id}/create-doc-from-template/`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${ZAPSIGN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(zsPayload),
    });
    const zsResp = await r.json();
    if (!r.ok) {
      await sb.from("contratos_pendentes").update({
        status: "erro_zapsign",
        observacoes: (c.observacoes || "") + `\n[ZapSign erro ${r.status}: ${JSON.stringify(zsResp).slice(0, 300)}]`,
      }).eq("id", contrato_id);
      return json({ error: "ZapSign falhou", status: r.status, detalhe: zsResp }, 500);
    }

    // Salva doc_token + signing link
    const docToken = zsResp.token;
    const signer = (zsResp.signers || [])[0] || {};
    const signLink = signer.sign_url || zsResp.sign_url || null;

    await sb.from("contratos_pendentes").update({
      status: "enviado_zapsign",
      zapsign_doc_id: docToken,
      zapsign_link_assinatura: signLink,
      atualizado_em: new Date().toISOString(),
    }).eq("id", contrato_id);

    return json({ success: true, doc_token: docToken, sign_link: signLink, sandbox: ZAPSIGN_SANDBOX });

  } catch (e: any) {
    console.error("processar-aprovacao erro:", e);
    return json({ error: e.message }, 500);
  }
});
