// =========================================================
// EDGE FUNCTION: inter-emit-boleto
// Emite boleto Inter via API mTLS pra moradoras Domus.
//
// POST body (modo MENSALIDADE — default):
//   { morador_id: uuid, mes_referencia: 'YYYY-MM-DD', valor?: number }
//   -> usa dia_vencimento da moradora pra calcular vencimento
//
// POST body (modo CUSTOM — caucao, boletos avulsos, etc):
//   {
//     morador_id: uuid,
//     valor: number,
//     vencimento: 'YYYY-MM-DD',       // override completo
//     descricao?: string,              // override da mensagem.linha1
//     mes_referencia?: 'YYYY-MM-DD',  // pra registro
//     unidade?: 'AP' | 'Rib'          // opcional, se nao vier infere do morador
//   }
//
// Resposta: { ok, banco_inter_id, url_boleto, pix_copia_cola, codigo_barras }
//
// Requer secrets: INTER_<UNIDADE>_CLIENT_ID, _CLIENT_SECRET, _CERT, _KEY
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const INTER_BASE = "https://cdpj.partners.bancointer.com.br";

const ENDERECO_UNIDADE: Record<string, any> = {
  RIB: { logradouro: "Rua Ribeirão Claro, 547", bairro: "Vila Olímpia", cidade: "São Paulo", uf: "SP", cep: "04549060" },
  AP:  { logradouro: "Rua Dr. Andrade Pertence, 73", bairro: "Vila Olímpia", cidade: "São Paulo", uf: "SP", cep: "04549020" },
};

const limparCpf = (s: string) => (s || "").replace(/\D/g, "");

const getOAuthToken = async (clientId: string, secret: string, cert: string, key: string) => {
  const client = Deno.createHttpClient({ cert, privateKey: key });
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: "boleto-cobranca.read boleto-cobranca.write",
    grant_type: "client_credentials",
  });
  const r = await fetch(`${INTER_BASE}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    client,
  } as any);
  const txt = await r.text();
  if (!r.ok) throw new Error(`OAuth Inter ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt).access_token as string;
};

const emitirCobranca = async (token: string, cert: string, key: string, payload: any) => {
  const client = Deno.createHttpClient({ cert, privateKey: key });
  const r = await fetch(`${INTER_BASE}/cobranca/v3/cobrancas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    client,
  } as any);
  const txt = await r.text();
  if (!r.ok) throw new Error(`Cobrança Inter ${r.status}: ${txt.slice(0, 500)}`);
  return JSON.parse(txt);
};

const buscarCobranca = async (token: string, cert: string, key: string, codigoSolicitacao: string) => {
  const client = Deno.createHttpClient({ cert, privateKey: key });
  const r = await fetch(`${INTER_BASE}/cobranca/v3/cobrancas/${codigoSolicitacao}`, {
    headers: { Authorization: `Bearer ${token}` },
    client,
  } as any);
  const txt = await r.text();
  if (!r.ok) throw new Error(`Buscar cobrança Inter ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
};

Deno.serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json();
    const {
      morador_id,
      mes_referencia,
      valor: valorInput,
      vencimento: vencimentoInput,
      descricao: descricaoInput,
      unidade: unidadeInput,
      email: emailInput,
    } = body;
    if (!morador_id) throw new Error("morador_id obrigatório");

    const { data: m, error: errM } = await sb.from("moradores").select("*").eq("id", morador_id).single();
    if (errM || !m) throw new Error(`Morador não encontrado: ${morador_id}`);

    const cpf = limparCpf(m.cpf || "");
    if (cpf.length !== 11) throw new Error(`CPF inválido pra morador ${m.nome}: '${m.cpf}'`);

    // Unidade: prioriza input, senao infere do morador
    const unidadeRaw = (unidadeInput || m.unidade || "").toUpperCase();
    const unidade = unidadeRaw.includes("RIB") ? "RIB" : "AP";
    const CLIENT_ID = Deno.env.get(`INTER_${unidade}_CLIENT_ID`);
    const CLIENT_SECRET = Deno.env.get(`INTER_${unidade}_CLIENT_SECRET`);
    const CERT = Deno.env.get(`INTER_${unidade}_CERT`);
    const KEY = Deno.env.get(`INTER_${unidade}_KEY`);
    if (!CLIENT_ID || !CLIENT_SECRET || !CERT || !KEY) {
      throw new Error(`Credenciais Inter ${unidade} faltando nos secrets`);
    }
    const endereco = ENDERECO_UNIDADE[unidade];

    const valor = Number(valorInput || m.valor || m.aluguel);
    if (!valor || valor <= 0) throw new Error(`Valor inválido: ${valor}`);

    // VENCIMENTO — prioridade:
    // 1. vencimento explicito (modo custom, ex: caucao)
    // 2. mes_referencia + dia_vencimento da moradora (modo mensalidade)
    // 3. proximo dia_vencimento do mes atual
    let dataVencISO: string;
    let mesRefForLabel: Date;
    if (vencimentoInput) {
      dataVencISO = vencimentoInput;
      const [y, mo, _d] = vencimentoInput.split("-").map(Number);
      mesRefForLabel = new Date(y, mo - 1, 1);
    } else {
      const mesRef = mes_referencia ? new Date(mes_referencia) : new Date();
      mesRefForLabel = mesRef;
      const dia = m.dia_vencimento || 15;
      const dataVencimento = new Date(mesRef.getFullYear(), mesRef.getMonth(), dia);
      dataVencISO = dataVencimento.toISOString().slice(0, 10);
    }

    const seuNumero = `DG${unidade}-${mesRefForLabel.getFullYear()}${String(mesRefForLabel.getMonth() + 1).padStart(2, "0")}-${morador_id.slice(0, 8)}`;

    // Mensagem custom (caucao) ou padrao (mensalidade)
    const linha1 = descricaoInput || "Mensalidade Domus Garden Coliving";
    const linha2 = descricaoInput
      ? `Vencimento: ${dataVencISO.split("-").reverse().join("/")}`
      : `Ref: ${mesRefForLabel.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}`;

    const payloadInter = {
      seuNumero,
      valorNominal: Number(valor.toFixed(2)),
      dataVencimento: dataVencISO,
      numDiasAgenda: 30,
      pagador: {
        cpfCnpj: cpf,
        tipoPessoa: "FISICA",
        nome: m.nome,
        endereco: endereco.logradouro,
        bairro: endereco.bairro,
        cidade: endereco.cidade,
        uf: endereco.uf,
        cep: endereco.cep,
        email: emailInput || m.email || undefined,
      },
      mensagem: { linha1, linha2 },
    };

    const token = await getOAuthToken(CLIENT_ID, CLIENT_SECRET, CERT, KEY);
    const r1 = await emitirCobranca(token, CERT, KEY, payloadInter);
    const codigoSolicitacao = r1.codigoSolicitacao || r1.codigo;

    // Busca a cobrança pra pegar URL/codigo de barras/pix
    await new Promise(res => setTimeout(res, 1500));
    const cob = await buscarCobranca(token, CERT, KEY, codigoSolicitacao);

    const url_boleto = cob.boleto?.urlBoleto || cob.urlBoleto || null;
    const codigo_barras = cob.boleto?.codigoBarras || cob.codigoBarras || null;
    const pix_copia_cola = cob.pix?.pixCopiaECola || cob.pixCopiaECola || null;

    // Salva no banco
    const mesRefISO = mes_referencia
      || `${mesRefForLabel.getFullYear()}-${String(mesRefForLabel.getMonth() + 1).padStart(2, "0")}-01`;

    const { data: salvo, error: errIns } = await sb.from("boletos_dominhas").insert({
      morador_id,
      morador_nome: m.nome,
      morador_telefone: m.telefone || m.contato,
      mes_referencia: mesRefISO,
      valor,
      data_vencimento: dataVencISO,
      url_boleto,
      codigo_barras,
      pix_copia_cola,
      banco_inter_id: codigoSolicitacao,
      status: "pendente",
      total_lembretes: 0,
      descricao: descricaoInput || null,
    }).select().single();

    if (errIns) {
      // Se boletos_dominhas nao tem coluna 'descricao', tenta sem
      if (errIns.message?.includes("descricao") || errIns.message?.includes("column")) {
        const { data: salvo2, error: errIns2 } = await sb.from("boletos_dominhas").insert({
          morador_id,
          morador_nome: m.nome,
          morador_telefone: m.telefone || m.contato,
          mes_referencia: mesRefISO,
          valor,
          data_vencimento: dataVencISO,
          url_boleto,
          codigo_barras,
          pix_copia_cola,
          banco_inter_id: codigoSolicitacao,
          status: "pendente",
          total_lembretes: 0,
        }).select().single();
        if (errIns2) throw new Error(`Erro salvando boleto: ${errIns2.message}`);
        return new Response(JSON.stringify({
          ok: true,
          morador: m.nome,
          banco_inter_id: codigoSolicitacao,
          url_boleto,
          codigo_barras,
          pix_copia_cola,
          valor,
          vencimento: dataVencISO,
          boleto_dg_id: salvo2.id,
          aviso: "Coluna descricao nao existe em boletos_dominhas — boleto criado sem ela",
        }, null, 2), { headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Erro salvando boleto: ${errIns.message}`);
    }

    return new Response(JSON.stringify({
      ok: true,
      morador: m.nome,
      banco_inter_id: codigoSolicitacao,
      url_boleto,
      codigo_barras,
      pix_copia_cola,
      valor,
      vencimento: dataVencISO,
      boleto_dg_id: salvo.id,
    }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, erro: e.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
