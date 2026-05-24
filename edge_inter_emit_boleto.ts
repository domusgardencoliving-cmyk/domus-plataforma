import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
const INTER_BASE = "https://cdpj.partners.bancointer.com.br";
const ENDERECO: Record<string, any> = {
  RIB: { logradouro: "Rua Ribeirao Claro, 547", bairro: "Vila Olimpia", cidade: "Sao Paulo", uf: "SP", cep: "04549060" },
  AP:  { logradouro: "Rua Dr. Andrade Pertence, 73", bairro: "Vila Olimpia", cidade: "Sao Paulo", uf: "SP", cep: "04549020" },
};
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const limparCpf = (s: string) => (s || "").replace(/\D/g, "");

// Reconstroi PEM se vier sem quebras de linha (paste em form web come \n)
function fixPem(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();
  // Normaliza CRLF para LF
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Detecta header e footer (PRIVATE KEY, RSA PRIVATE KEY, CERTIFICATE, etc)
  const m = s.match(/-----BEGIN ([^-]+)-----([\s\S]+?)-----END ([^-]+)-----/);
  if (!m) return s; // nao parece PEM, devolve cru
  const tipo = m[1].trim();
  const tipoFim = m[3].trim();
  // Pega so o miolo base64, remove TODO whitespace
  const miolo = m[2].replace(/\s+/g, "");
  // Reconstroi com quebras a cada 64 chars
  const linhas: string[] = [];
  for (let i = 0; i < miolo.length; i += 64) linhas.push(miolo.slice(i, i + 64));
  return `-----BEGIN ${tipo}-----\n${linhas.join("\n")}\n-----END ${tipoFim}-----\n`;
}

async function getToken(cid: string, sec: string, cert: string, key: string) {
  const cl = Deno.createHttpClient({ cert, key });
  const body = new URLSearchParams({ client_id: cid, client_secret: sec, scope: "boleto-cobranca.read boleto-cobranca.write", grant_type: "client_credentials" });
  const r = await fetch(`${INTER_BASE}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), client: cl } as any);
  const t = await r.text();
  if (!r.ok) throw new Error(`OAuth ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t).access_token as string;
}
async function emit(tok: string, cert: string, key: string, p: any) {
  const cl = Deno.createHttpClient({ cert, key });
  const r = await fetch(`${INTER_BASE}/cobranca/v3/cobrancas`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify(p), client: cl } as any);
  const t = await r.text();
  if (!r.ok) throw new Error(`Cobranca ${r.status}: ${t.slice(0, 500)}`);
  return JSON.parse(t);
}
async function cancel(tok: string, cert: string, key: string, cs: string, motivo: string) {
  const cl = Deno.createHttpClient({ cert, key });
  const r = await fetch(`${INTER_BASE}/cobranca/v3/cobrancas/${cs}/cancelar`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ motivoCancelamento: motivo }), client: cl } as any);
  const t = await r.text();
  if (!r.ok && r.status !== 204) throw new Error(`Cancelar ${r.status}: ${t.slice(0, 500)}`);
  return { ok: true };
}
async function get(tok: string, cert: string, key: string, cs: string) {
  const cl = Deno.createHttpClient({ cert, key });
  const r = await fetch(`${INTER_BASE}/cobranca/v3/cobrancas/${cs}`, { headers: { Authorization: `Bearer ${tok}` }, client: cl } as any);
  const t = await r.text();
  if (!r.ok) throw new Error(`Buscar ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}
async function getPdf(tok: string, cert: string, key: string, cs: string): Promise<string> {
  const cl = Deno.createHttpClient({ cert, key });
  const r = await fetch(`${INTER_BASE}/cobranca/v3/cobrancas/${cs}/pdf`, { headers: { Authorization: `Bearer ${tok}` }, client: cl } as any);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PDF ${r.status}: ${t.slice(0, 300)}`);
  }
  // Inter retorna JSON { pdf: "base64..." } OU bytes diretos. Trata ambos.
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json();
    return j.pdf || j.boleto || "";
  }
  // se vier binario, converte pra base64
  const ab = await r.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function creds(uni: string) {
  const u = uni.toUpperCase().includes("RIB") ? "RIB" : "AP";
  const ID = Deno.env.get(`INTER_${u}_CLIENT_ID`);
  const SEC = Deno.env.get(`INTER_${u}_CLIENT_SECRET`);
  const CERT_RAW = Deno.env.get(`INTER_${u}_CERT`);
  const KEY_RAW = Deno.env.get(`INTER_${u}_KEY`);
  if (!ID || !SEC || !CERT_RAW || !KEY_RAW) throw new Error(`Faltam secrets Inter ${u}`);
  const CERT = fixPem(CERT_RAW);
  const KEY = fixPem(KEY_RAW);
  return { u, ID, SEC, CERT, KEY };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json();
    const acao = body.acao || "emitir";

    if (acao === "baixar_pdf") {
      const { codigo_solicitacao, unidade } = body;
      if (!codigo_solicitacao) throw new Error("codigo_solicitacao obrigatorio");
      const c = creds(unidade);
      const tok = await getToken(c.ID!, c.SEC!, c.CERT!, c.KEY!);
      const pdf64 = await getPdf(tok, c.CERT!, c.KEY!, codigo_solicitacao);
      return new Response(JSON.stringify({ ok: true, pdf_base64: pdf64 }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (acao === "atualizar_url") {
      // Busca url_boleto/codigo/pix atualizados no Inter e salva no Supabase
      const { codigo_solicitacao, unidade, boleto_dg_id } = body;
      if (!codigo_solicitacao) throw new Error("codigo_solicitacao obrigatorio");
      const c = creds(unidade);
      const tok = await getToken(c.ID!, c.SEC!, c.CERT!, c.KEY!);
      const cob = await get(tok, c.CERT!, c.KEY!, codigo_solicitacao);
      const url_b = cob.boleto?.urlBoleto || cob.urlBoleto || cob.pdf?.url || null;
      const cb = cob.boleto?.codigoBarras || cob.codigoBarras || null;
      const pix = cob.pix?.pixCopiaECola || cob.pixCopiaECola || null;
      const upd: any = { atualizado_em: new Date().toISOString() };
      if (url_b) upd.url_boleto = url_b;
      if (cb) upd.codigo_barras = cb;
      if (pix) upd.pix_copia_cola = pix;
      let q = sb.from("boletos_dominhas").update(upd);
      if (boleto_dg_id) q = q.eq("id", boleto_dg_id);
      else q = q.eq("banco_inter_id", codigo_solicitacao);
      const { error: eUp } = await q;
      if (eUp) throw new Error(`Salvar URL: ${eUp.message}`);
      return new Response(JSON.stringify({ ok: true, url_boleto: url_b, codigo_barras: cb, pix_copia_cola: pix }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (acao === "cancelar") {
      const { codigo_solicitacao, unidade } = body;
      if (!codigo_solicitacao) throw new Error("codigo_solicitacao obrigatorio");
      const c = creds(unidade);
      const tok = await getToken(c.ID!, c.SEC!, c.CERT!, c.KEY!);
      await cancel(tok, c.CERT!, c.KEY!, codigo_solicitacao, body.motivo || "ACERTOS");
      await sb.from("boletos_dominhas").update({ status: "cancelado", atualizado_em: new Date().toISOString() }).eq("banco_inter_id", codigo_solicitacao);
      return new Response(JSON.stringify({ ok: true, cancelado: codigo_solicitacao }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const { morador_id, mes_referencia, valor: vIn, data_vencimento: dvIn, descricao_extras: descIn } = body;
    if (!morador_id) throw new Error("morador_id obrigatorio");
    const { data: m, error: eM } = await sb.from("moradores").select("*").eq("id", morador_id).single();
    if (eM || !m) throw new Error(`Morador nao encontrado: ${morador_id}`);
    const cpf = limparCpf(m.cpf || "");
    if (cpf.length !== 11) throw new Error(`CPF invalido: '${m.cpf}'`);
    const c = creds(m.unidade || "");
    const end = ENDERECO[c.u];

    const mesRef = mes_referencia ? new Date(mes_referencia + "T12:00:00") : new Date();
    const mesISO = `${mesRef.getFullYear()}-${String(mesRef.getMonth() + 1).padStart(2, "0")}-01`;
    const { data: bEx } = await sb.from("boletos_dominhas").select("*").eq("morador_id", morador_id).eq("mes_referencia", mesISO).maybeSingle();

    const vBase = Number(bEx?.valor_base || 0);
    const vEner = Number(bEx?.valor_energia || 0);
    const vExtra = Number(bEx?.valor_extras || 0);
    const vTotal = Number(vIn || (vBase + vEner + vExtra) || m.valor);
    if (!vTotal || vTotal <= 0) throw new Error(`Valor invalido: ${vTotal}`);

    let dvISO: string;
    if (dvIn) dvISO = dvIn;
    else {
      const dia = m.dia_vencimento || 20;
      dvISO = new Date(mesRef.getFullYear(), mesRef.getMonth(), dia).toISOString().slice(0, 10);
    }

    const desc = descIn || bEx?.descricao_extras || `Mensalidade Domus ref. ${mesRef.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}`;
    const linhas = String(desc).split("\n").map((l: string) => l.trim()).filter(Boolean);
    const msg: any = {};
    linhas.slice(0, 5).forEach((l: string, i: number) => { msg[`linha${i + 1}`] = l.slice(0, 78); });

    const dAtraso = new Date(dvISO);
    dAtraso.setDate(dAtraso.getDate() + 1);
    const dAtrasoISO = dAtraso.toISOString().slice(0, 10);

    const seuNum = `DG${c.u.charAt(0)}${String(mesRef.getFullYear()).slice(2)}${String(mesRef.getMonth() + 1).padStart(2, "0")}${morador_id.slice(0, 6)}`;

    const payload: any = {
      seuNumero: seuNum,
      valorNominal: Number(vTotal.toFixed(2)),
      dataVencimento: dvISO,
      numDiasAgenda: 30,
      pagador: { cpfCnpj: cpf, tipoPessoa: "FISICA", nome: m.nome, endereco: end.logradouro, bairro: end.bairro, cidade: end.cidade, uf: end.uf, cep: end.cep, email: m.email || undefined },
      mensagem: msg,
      multa: { codigo: "PERCENTUAL", data: dAtrasoISO, taxa: 10 },
      mora: { codigo: "TAXAMENSAL", data: dAtrasoISO, taxa: 1 },
    };

    const tok = await getToken(c.ID!, c.SEC!, c.CERT!, c.KEY!);
    const r1 = await emit(tok, c.CERT!, c.KEY!, payload);
    const cs = r1.codigoSolicitacao || r1.codigo;
    await new Promise(r => setTimeout(r, 1500));
    const cob = await get(tok, c.CERT!, c.KEY!, cs);

    const url_b = cob.boleto?.urlBoleto || cob.urlBoleto || null;
    const cb = cob.boleto?.codigoBarras || cob.codigoBarras || null;
    const pix = cob.pix?.pixCopiaECola || cob.pixCopiaECola || null;

    const up: any = {
      morador_id, mes_referencia: mesISO,
      valor_base: vBase || vTotal, valor_energia: vEner, valor_extras: vExtra,
      data_vencimento: dvISO, url_boleto: url_b, codigo_barras: cb, pix_copia_cola: pix,
      banco_inter_id: cs, status: "emitido", descricao_extras: desc,
      atualizado_em: new Date().toISOString(),
    };
    const { data: salvo, error: eIns } = await sb.from("boletos_dominhas").upsert(up, { onConflict: "morador_id,mes_referencia" }).select().single();
    if (eIns) throw new Error(`Salvar boleto: ${eIns.message}`);

    return new Response(JSON.stringify({
      ok: true, morador: m.nome, banco_inter_id: cs, url_boleto: url_b, codigo_barras: cb,
      pix_copia_cola: pix, valor: vTotal, vencimento: dvISO,
      multa: `10% apos ${dAtrasoISO}`, juros: `1%/mes apos ${dAtrasoISO}`,
      boleto_dg_id: salvo?.id,
    }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, erro: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
