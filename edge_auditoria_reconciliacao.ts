// =========================================================
// EDGE FUNCTION: auditoria-reconciliacao
// =========================================================
// Audita E reconcilia reservas entre Hospedin e PMS.
//
// MODOS:
//   - dry_run (default): só identifica divergências e órfãs, não altera nada
//   - apply: corrige PMS com dados do Hospedin (Hospedin é fonte de verdade
//            pra reservas OTA; reservas Direto são intocadas se PMS tem dado)
//
// CHAMADA:
//   POST /functions/v1/auditoria-reconciliacao
//   body opcional: { "modo": "apply" }  ← pra aplicar correções
//   body opcional: { "modo": "dry_run" } ← só audita (default)
//
// SAÍDA:
//   {
//     ok: true, modo, rodou_em, duracao_ms,
//     resumo: { hospedin_total, pms_total, ok, divergentes,
//               somente_hospedin, somente_pms, sem_hospedin_id,
//               corrigidas, criadas, marcadas_canceladas },
//     reservas: [ { tipo, ..., divergencias, dados_hospedin, dados_pms, acao_aplicada } ]
//   }
//
// SECRETS necessários:
//   HOSPEDIN_EMAIL, HOSPEDIN_PASSWORD (Edge Function Secrets)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injetados)
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const HOSPEDIN_BASE = "https://pms.hospedin.com";
const HOSPEDIN_SLUG = "domus-garden-coliving-894c75e4-0dae-4a75-8dca-9a8ee53a2369";

const TIMEOUT_LOGIN_MS = 20000;
const TIMEOUT_FETCH_MS = 60000;

const HOSPEDIN_PLACE_TO_CAMA: Record<string, string> = {
  "335187": "Studio 1",
  "335188": "Studio 2",
  "335189": "Individual 3",
  "335190": "Individual 4",
  "335191": "Individual 5",
  "335192": "Hostel 6 - Cama 1",
  "338390": "Hostel 6 - Cama 2",
  "338391": "Hostel 6 - Cama 3",
  "338392": "Hostel 6 - Cama 4",
  "338393": "Hostel 7 - Cama 5",
  "338394": "Hostel 7 - Cama 6",
  "348425": "Hostel 7 - Cama 7",
  "348426": "Hostel 7 - Cama 8",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function mapearStatusHospedinParaDG(s: string | null): string | null {
  switch ((s || "").toLowerCase()) {
    case "canceled":         return "cancelada";
    case "no_show":          return "no_show";
    case "reservation":      return "confirmada";
    case "check_in":         return "check-in";
    case "check_out":        return "check-out";
    case "pre_reservation":  return "pre_reserva";
    case "waitlist":         return "em_espera";
    case "blocked":          return "bloqueio";
    default:                 return null;
  }
}

function detectarPlataforma(code: string | null | undefined): { plataforma: string; canal: string } {
  const c = (code || "").toUpperCase();
  if (c.startsWith("VD:")) return { plataforma: "Direto", canal: "direto" };
  if (c.startsWith("BO:")) return { plataforma: "Booking", canal: "booking" };
  if (c.startsWith("AI:")) return { plataforma: "Airbnb", canal: "airbnb" };
  if (c.startsWith("HE:")) return { plataforma: "Hospedin", canal: "hospedin" };
  return { plataforma: "Hospedin", canal: "hospedin" };
}

async function fetchTO(url: string, opts: RequestInit, ms: number, label = "fetch"): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(tid); }
}

function mergeCookies(existing: string, set: string | null): string {
  if (!set) return existing;
  const novos: Record<string, string> = {};
  set.split(/,(?=[^;]+?=)/).forEach((c) => {
    const m = c.trim().match(/^([^=]+)=([^;]*)/);
    if (m) novos[m[1].trim()] = m[2].trim();
  });
  const old: Record<string, string> = {};
  if (existing) existing.split(";").forEach((c) => {
    const m = c.trim().match(/^([^=]+)=(.*)$/);
    if (m) old[m[1].trim()] = m[2];
  });
  return Object.entries({ ...old, ...novos }).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function loginHospedin(email: string, password: string): Promise<string | null> {
  try {
    const r1 = await fetchTO(`${HOSPEDIN_BASE}/login`, { method: "GET" }, TIMEOUT_LOGIN_MS, "login-get");
    const html = await r1.text();
    const csrf = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
    if (!csrf) return null;
    let cookies = mergeCookies("", r1.headers.get("set-cookie"));
    const body = new URLSearchParams({
      utf8: "✓",
      authenticity_token: csrf[1],
      "user[email]": email,
      "user[password]": password,
      commit: "Entrar",
    });
    const r2 = await fetchTO(
      `${HOSPEDIN_BASE}/login`,
      { method: "POST", body: body.toString(), redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies } },
      TIMEOUT_LOGIN_MS, "login-post"
    );
    cookies = mergeCookies(cookies, r2.headers.get("set-cookie"));
    if (!cookies.includes("session")) return null;
    return cookies;
  } catch { return null; }
}

function brToISO(s: string): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function extrairValorHospedin(h: any): number | null {
  if (h.total_amount != null && Number(h.total_amount) > 0) return Number(h.total_amount);
  if (h.total_to_receive != null && Number(h.total_to_receive) > 0) return Number(h.total_to_receive);
  if (h.total_amount_cents != null && Number(h.total_amount_cents) > 0) return Number(h.total_amount_cents) / 100;
  if (h.total_daily_cents != null && Number(h.total_daily_cents) > 0) return Number(h.total_daily_cents) / 100;
  if (h.daily_cents != null && Number(h.daily_cents) > 0) {
    const noites = (h._noites && Number(h._noites) > 0) ? Number(h._noites) : 1;
    return (Number(h.daily_cents) / 100) * noites;
  }
  if (h.total_value != null && Number(h.total_value) > 0) return Number(h.total_value);
  if (h.daily_total != null && Number(h.daily_total) > 0) return Number(h.daily_total);
  return null;
}

function normalizar(s: any): string {
  return (s == null ? "" : String(s)).trim().toLowerCase().replace(/\s+/g, " ");
}

function digitsOnly(s: any): string {
  return (s == null ? "" : String(s)).replace(/\D/g, "");
}

interface Divergencia {
  campo: string;
  valor_hospedin: any;
  valor_pms: any;
  valor_corrigido?: any;
}

function comparar(h: any, pms: any): Divergencia[] {
  const out: Divergencia[] = [];

  // nome
  const nomeH_raw = h.guest_name || h.guest?.name || h.full_name || "";
  const nomeH = normalizar(nomeH_raw);
  const nomePMS = normalizar(pms.hospede_nome || "");
  if (nomeH && nomePMS && nomeH !== nomePMS) {
    out.push({ campo: "hospede_nome", valor_hospedin: nomeH_raw, valor_pms: pms.hospede_nome, valor_corrigido: nomeH_raw });
  }

  // telefone
  const telH_raw = h.guest_phone || h.guest?.phone || "";
  const telH = digitsOnly(telH_raw);
  const telPMS = digitsOnly(pms.hospede_contato || "");
  if (telH && telH.length >= 8 && telPMS && !telPMS.includes(telH) && !telH.includes(telPMS)) {
    out.push({ campo: "hospede_contato", valor_hospedin: telH_raw, valor_pms: pms.hospede_contato, valor_corrigido: telH_raw });
  } else if (telH && telH.length >= 8 && !telPMS) {
    out.push({ campo: "hospede_contato", valor_hospedin: telH_raw, valor_pms: null, valor_corrigido: telH_raw });
  }

  // cama
  const camaH = HOSPEDIN_PLACE_TO_CAMA[String(h.place_id)] || null;
  if (camaH && pms.cama && camaH !== pms.cama) {
    out.push({ campo: "cama", valor_hospedin: camaH, valor_pms: pms.cama, valor_corrigido: camaH });
  }

  // checkin
  const ciH = brToISO(h.check_in);
  if (ciH && pms.checkin && ciH !== pms.checkin) {
    out.push({ campo: "checkin", valor_hospedin: ciH, valor_pms: pms.checkin, valor_corrigido: ciH });
  }

  // checkout
  const coH = brToISO(h.check_out);
  if (coH && pms.checkout && coH !== pms.checkout) {
    out.push({ campo: "checkout", valor_hospedin: coH, valor_pms: pms.checkout, valor_corrigido: coH });
  }

  // valor (tolerância de R$ 1 pra arredondamento)
  const valH = extrairValorHospedin(h);
  const valPMS = pms.valor_total != null ? Number(pms.valor_total) : null;
  if (valH != null && valPMS != null && Math.abs(valH - valPMS) > 1) {
    out.push({ campo: "valor_total", valor_hospedin: valH, valor_pms: valPMS, valor_corrigido: valH });
  } else if (valH != null && (valPMS == null || valPMS === 0)) {
    out.push({ campo: "valor_total", valor_hospedin: valH, valor_pms: valPMS, valor_corrigido: valH });
  }

  // status
  const statusH = (h.status || "").toLowerCase();
  const statusEsperado = mapearStatusHospedinParaDG(statusH);
  if (statusEsperado && pms.status && statusEsperado !== pms.status) {
    // Não sobrescreve check-in / check-out já feitos manualmente
    if (!(pms.status === "check-in" && statusH === "reservation")
        && !(pms.status === "check-out")) {
      out.push({ campo: "status", valor_hospedin: statusEsperado, valor_pms: pms.status, valor_corrigido: statusEsperado });
    }
  }

  // status_hospedin gravado
  if (statusH && (pms.status_hospedin || "").toLowerCase() !== statusH) {
    out.push({ campo: "status_hospedin", valor_hospedin: statusH, valor_pms: pms.status_hospedin, valor_corrigido: statusH });
  }

  return out;
}

Deno.serve(async (req) => {
  const inicio = Date.now();
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let modo: "dry_run" | "apply" = "dry_run";
  try {
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (b.modo === "apply") modo = "apply";
    }
  } catch (_) {}

  const SB_URL = Deno.env.get("SUPABASE_URL")!;
  const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const EMAIL = Deno.env.get("HOSPEDIN_EMAIL")!;
  const PASS = Deno.env.get("HOSPEDIN_PASSWORD")!;
  const sb = createClient(SB_URL, SB_KEY);

  const resumo: any = {
    modo,
    hospedin_total: 0, pms_total: 0,
    ok: 0, divergentes: 0,
    somente_hospedin: 0, somente_pms: 0,
    sem_hospedin_id: 0,
    corrigidas: 0, criadas: 0, marcadas_canceladas: 0,
    erros: [] as any[],
  };
  const reservasOut: any[] = [];

  try {
    // 1) Login Hospedin
    const cookie = await loginHospedin(EMAIL, PASS);
    if (!cookie) throw new Error("Login Hospedin falhou (cheque HOSPEDIN_PASSWORD)");

    // 2) Lista Hospedin
    const rH = await fetchTO(
      `${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/services/reservations.json`,
      { headers: { Cookie: cookie, accept: "application/json" } },
      TIMEOUT_FETCH_MS, "lista-hospedin"
    );
    if (!rH.ok) throw new Error(`HTTP ${rH.status} buscando reservas Hospedin`);
    const listaH: any[] = await rH.json();
    resumo.hospedin_total = listaH.length;

    // 3) Filtra janela -30 a +90 dias
    const hoje = new Date();
    const dataMin = new Date(hoje.getTime() - 30 * 86400000);
    const dataMax = new Date(hoje.getTime() + 90 * 86400000);
    const hElegiveis = listaH.filter((h) => {
      const ci = brToISO(h.check_in); const co = brToISO(h.check_out);
      if (!ci || !co) return false;
      const dci = new Date(ci + "T12:00:00"); const dco = new Date(co + "T12:00:00");
      return !(dco < dataMin || dci > dataMax);
    });

    // 4) Lista PMS na janela
    const { data: listaPMS, error: errPMS } = await sb
      .from("reservas")
      .select("id, hospede_nome, hospede_contato, cama, quarto, checkin, checkout, valor_total, plataforma, canal_codigo, status, status_hospedin, hospedin_id, codigo_externo, ultima_sync_hospedin, cancelado_em")
      .gte("checkin", dataMin.toISOString().slice(0, 10))
      .lte("checkout", dataMax.toISOString().slice(0, 10));
    if (errPMS) throw new Error("Erro lendo PMS: " + errPMS.message);
    resumo.pms_total = (listaPMS || []).length;

    // 5) Index PMS
    const pmsPorHospedinId: Record<string, any> = {};
    const pmsPorCode: Record<string, any> = {};
    for (const r of listaPMS || []) {
      if (r.hospedin_id) pmsPorHospedinId[String(r.hospedin_id)] = r;
      if (r.codigo_externo) pmsPorCode[String(r.codigo_externo)] = r;
    }

    // 6) Reconciliação
    const matched = new Set<string>();
    for (const h of hElegiveis) {
      const hid = String(h.id);
      const code = h.code || null;
      const match = pmsPorHospedinId[hid] || (code ? pmsPorCode[code] : null);

      if (match) {
        matched.add(match.id);
        const divs = comparar(h, match);

        if (divs.length === 0) {
          resumo.ok++;
          continue; // nada a fazer
        }

        resumo.divergentes++;
        const linha: any = {
          tipo: "divergente",
          hospedin_id: hid, dg_id: match.id,
          hospede_nome: match.hospede_nome,
          cama: match.cama,
          divergencias: divs,
        };

        if (modo === "apply") {
          // Aplica correções (Hospedin é fonte de verdade pra reservas OTA)
          const updatePayload: any = {};
          for (const d of divs) {
            if (d.valor_corrigido !== undefined) {
              updatePayload[d.campo] = d.valor_corrigido;
            }
          }
          updatePayload.ultima_sync_hospedin = new Date().toISOString();
          updatePayload.status_sync_hospedin = "sincronizada";

          // Se Hospedin diz cancelada, marca cancelado_em
          const statusH = (h.status || "").toLowerCase();
          if (statusH === "canceled" && !match.cancelado_em) {
            updatePayload.cancelado_em = new Date().toISOString();
          }

          // Se mudou cama, espelha em quarto também
          if (updatePayload.cama) updatePayload.quarto = updatePayload.cama;

          const { error: errUpd } = await sb.from("reservas").update(updatePayload).eq("id", match.id);
          if (errUpd) {
            linha.acao_aplicada = "erro";
            linha.erro = errUpd.message;
            resumo.erros.push({ dg_id: match.id, erro: errUpd.message });
          } else {
            linha.acao_aplicada = "corrigida";
            resumo.corrigidas++;
          }
        }

        reservasOut.push(linha);
      } else {
        // somente_hospedin — falta no PMS
        resumo.somente_hospedin++;
        const camaH = HOSPEDIN_PLACE_TO_CAMA[String(h.place_id)] || null;
        const linha: any = {
          tipo: "somente_hospedin",
          hospedin_id: hid, code,
          hospede_nome: h.guest_name || h.guest?.name || h.full_name || "—",
          guest_phone: h.guest_phone || h.guest?.phone,
          cama: camaH || `place_id=${h.place_id}`,
          checkin: brToISO(h.check_in),
          checkout: brToISO(h.check_out),
          valor: extrairValorHospedin(h),
          status_hospedin: h.status,
        };

        if (modo === "apply" && camaH) {
          // Cria no PMS
          const { plataforma, canal } = detectarPlataforma(code);
          const statusH = (h.status || "").toLowerCase();
          const statusIni = statusH === "canceled" ? "cancelada" : (mapearStatusHospedinParaDG(statusH) || "confirmada");
          const insertPayload: any = {
            hospede_nome: h.guest_name || h.guest?.name || h.full_name || "Hospede Hospedin",
            hospede_contato: h.guest_phone || h.guest?.phone || "",
            cama: camaH, quarto: camaH,
            checkin: brToISO(h.check_in),
            checkout: brToISO(h.check_out),
            status: statusIni,
            status_hospedin: h.status,
            valor_total: extrairValorHospedin(h),
            plataforma, canal_codigo: canal,
            hospedin_id: hid,
            codigo_externo: code,
            ultima_sync_hospedin: new Date().toISOString(),
            status_sync_hospedin: "sincronizada",
            observacoes: `Importada via auditoria-reconciliacao em ${new Date().toISOString().slice(0, 10)}.`,
          };
          if (statusH === "canceled") insertPayload.cancelado_em = new Date().toISOString();

          const { data: nova, error: errIns } = await sb.from("reservas").insert(insertPayload).select("id").single();
          if (errIns) {
            linha.acao_aplicada = "erro";
            linha.erro = errIns.message;
            resumo.erros.push({ hospedin_id: hid, erro: errIns.message });
          } else {
            linha.acao_aplicada = "criada_no_pms";
            linha.dg_id = nova?.id;
            resumo.criadas++;
          }
        }

        reservasOut.push(linha);
      }
    }

    // 7) Reservas PMS com hospedin_id que não vieram (provavelmente deletadas/canceladas no Hospedin)
    for (const r of listaPMS || []) {
      if (matched.has(r.id)) continue;
      if (!r.hospedin_id) {
        resumo.sem_hospedin_id++;
        continue;
      }
      resumo.somente_pms++;
      const linha: any = {
        tipo: "somente_pms",
        dg_id: r.id, hospedin_id: r.hospedin_id,
        hospede_nome: r.hospede_nome,
        cama: r.cama, checkin: r.checkin, checkout: r.checkout,
        status_atual_pms: r.status, plataforma: r.plataforma,
        motivo_possivel: "Tinha hospedin_id mas não está na lista atual (talvez deletada do Hospedin)",
      };

      if (modo === "apply" && r.status !== "cancelada") {
        // Marca como cancelada (provavelmente foi deletada do Hospedin)
        const { error: errUpd } = await sb.from("reservas")
          .update({
            status: "cancelada",
            cancelado_em: new Date().toISOString(),
            motivo_cancelamento: "Auto: deletada do Hospedin (auditoria-reconciliacao)",
            ultima_sync_hospedin: new Date().toISOString(),
          })
          .eq("id", r.id);
        if (errUpd) {
          linha.acao_aplicada = "erro";
          linha.erro = errUpd.message;
        } else {
          linha.acao_aplicada = "marcada_cancelada";
          resumo.marcadas_canceladas++;
        }
      }

      reservasOut.push(linha);
    }

    // 8) Grava histórico
    try {
      await sb.from("auditoria_reconciliacao_runs").insert({
        rodou_em: new Date().toISOString(),
        duracao_ms: Date.now() - inicio,
        modo,
        resumo,
        reservas: reservasOut.slice(0, 500),
      });
    } catch (e: any) {
      resumo.erros.push("Falha gravando histórico: " + (e.message || String(e)).slice(0, 200));
    }

    return new Response(JSON.stringify({
      ok: true, modo,
      duracao_ms: Date.now() - inicio,
      resumo, reservas: reservasOut,
    }, null, 2), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false, modo, erro: e.message || String(e),
      duracao_ms: Date.now() - inicio, resumo,
    }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
