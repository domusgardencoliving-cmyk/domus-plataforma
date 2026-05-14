// =========================================================
// EDGE FUNCTION: sync-completo-hospedin-pull
//
// PUXA TODAS as reservas da Hospedin (paginado) e espelha no DG.
// Diferente de sync-hospedin-reservas (que só pega novas), esta
// percorre TODAS as reservas futuras + recentes e faz UPSERT.
//
// Resolve casos como:
// - Reserva criada na Hospedin há dias mas nunca chegou no DG
// - Reserva existente que foi ESTENDIDA (mudou checkout)
// - Reserva que mudou de quarto, status, valor, etc.
//
// Estratégia:
//   1. Login Hospedin
//   2. GET /reservations?status=confirmed,checked_in&page=1..N
//   3. Pra cada reserva: comparar com DG (por hospedin_id)
//   4. INSERT se não existe, UPDATE se mudou algo, ignora se igual
//   5. Marcar timestamp e retornar resumo
//
// Cron sugerido: a cada 1 minuto (substitui o sync incremental)
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const HOSPEDIN_BASE = "https://pms-api.hospedin.com/api/v2";
const ACCOUNT_ID = "23949";

interface ReservaHospedin {
  id: number;
  check_in: string;
  check_out: string;
  total_value: number;
  status: string;
  guest?: { name?: string; phone_number?: string; email?: string };
  reservation_items?: Array<{ accommodation?: { name?: string; id?: number }; check_in?: string; check_out?: string }>;
  channel_code?: string;
  channel?: { code?: string; name?: string };
  updated_at?: string;
  created_at?: string;
}

const loginHospedin = async (email: string, password: string): Promise<string | null> => {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(`${HOSPEDIN_BASE}/authentication/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ session: { email, password } }),
      });
      const txt = await r.text();
      if (!r.ok) {
        console.log(`Hospedin login HTTP ${r.status} (tentativa ${tentativa}): ${txt.slice(0, 200)}`);
        if (tentativa < 3) { await new Promise(res => setTimeout(res, 1000 * tentativa)); continue; }
        return null;
      }
      // Tentar parse JSON; se falhar, tentar extrair token via regex
      try {
        const d = JSON.parse(txt);
        if (d?.token) return d.token;
      } catch {
        const m = txt.match(/"token"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
        console.log(`Hospedin login JSON inválido (tentativa ${tentativa}): ${txt.slice(0, 300)}`);
      }
      if (tentativa < 3) await new Promise(res => setTimeout(res, 1000 * tentativa));
    } catch (e: any) {
      console.log(`Hospedin login erro (tentativa ${tentativa}): ${e.message}`);
      if (tentativa < 3) await new Promise(res => setTimeout(res, 1000 * tentativa));
    }
  }
  return null;
};

const buscarPaginaHospedin = async (token: string, page: number, dataInicio: string): Promise<{ reservations: ReservaHospedin[]; total_pages: number }> => {
  // Busca reservas com check_in >= dataInicio (últimos 30 dias até futuro infinito)
  const url = `${HOSPEDIN_BASE}/${ACCOUNT_ID}/reservations?` +
    `q[check_in_gteq]=${dataInicio}&` +
    `q[s]=updated_at+desc&` +
    `page=${page}&per_page=100`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Hospedin API erro ${r.status}: ${txt.slice(0, 200)}`);
  }
  const d = await r.json();
  return {
    reservations: d?.reservations || d?.data || [],
    total_pages: d?.meta?.total_pages || d?.total_pages || 1,
  };
};

const normalizarStatusHospedin = (status: string): string => {
  const map: Record<string, string> = {
    "confirmed": "confirmada",
    "checked_in": "check-in",
    "checked_out": "check-out",
    "cancelled": "cancelada",
    "no_show": "nao_apareceu",
    "pending": "em_espera",
  };
  return map[status?.toLowerCase()] || status || "confirmada";
};

const extrairCama = (reserva: ReservaHospedin): string => {
  // Pega o nome da accommodation do primeiro item
  return reserva.reservation_items?.[0]?.accommodation?.name || "?";
};

const extrairCanal = (reserva: ReservaHospedin): string => {
  return reserva.channel?.code || reserva.channel_code || "hospedin";
};

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const EMAIL = Deno.env.get("HOSPEDIN_EMAIL")!;
  const PASSWORD = Deno.env.get("HOSPEDIN_PASSWORD")!;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const inicioRun = Date.now();

  // Login Hospedin
  const token = await loginHospedin(EMAIL, PASSWORD);
  if (!token) {
    return new Response(JSON.stringify({ ok: false, erro: "login Hospedin falhou" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // Janela: últimos 30 dias até infinito (pega tudo recente + futuro)
  const dataInicio = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let stats = { criadas: 0, atualizadas: 0, inalteradas: 0, erros: 0, total_hospedin: 0, paginas: 0 };
  const erros: any[] = [];
  const acoes: any[] = [];

  try {
    let page = 1;
    let totalPages = 1;
    do {
      const { reservations, total_pages } = await buscarPaginaHospedin(token, page, dataInicio);
      totalPages = total_pages;
      stats.paginas = page;
      stats.total_hospedin += reservations.length;

      for (const rH of reservations) {
        try {
          const hospedin_id = String(rH.id);
          const dadosNovos = {
            hospedin_id,
            hospede_nome: rH.guest?.name || "Hóspede sem nome",
            hospede_contato: rH.guest?.phone_number || rH.guest?.email || null,
            checkin: rH.check_in?.slice(0, 10),
            checkout: rH.check_out?.slice(0, 10),
            valor_total: rH.total_value || 0,
            status: normalizarStatusHospedin(rH.status),
            cama: extrairCama(rH),
            canal_codigo: extrairCanal(rH),
            ultima_sync_hospedin: new Date().toISOString(),
            status_sync_hospedin: "sincronizada",
          };

          // Existe no DG?
          const { data: existente } = await sb
            .from("reservas")
            .select("id, checkin, checkout, status, cama, valor_total")
            .eq("hospedin_id", hospedin_id)
            .maybeSingle();

          if (!existente) {
            // INSERT
            const { error: errIns } = await sb.from("reservas").insert(dadosNovos);
            if (errIns) throw errIns;
            stats.criadas++;
            acoes.push({ acao: "criada", hospedin_id, nome: dadosNovos.hospede_nome, cama: dadosNovos.cama });
          } else {
            // Comparar — só UPDATE se algo mudou
            const mudou =
              existente.checkin !== dadosNovos.checkin ||
              existente.checkout !== dadosNovos.checkout ||
              existente.status !== dadosNovos.status ||
              existente.cama !== dadosNovos.cama ||
              Number(existente.valor_total || 0) !== Number(dadosNovos.valor_total || 0);

            if (mudou) {
              const { error: errUpd } = await sb.from("reservas").update(dadosNovos).eq("id", existente.id);
              if (errUpd) throw errUpd;
              stats.atualizadas++;
              acoes.push({
                acao: "atualizada", hospedin_id, nome: dadosNovos.hospede_nome,
                de: { checkin: existente.checkin, checkout: existente.checkout, status: existente.status, cama: existente.cama },
                pra: { checkin: dadosNovos.checkin, checkout: dadosNovos.checkou