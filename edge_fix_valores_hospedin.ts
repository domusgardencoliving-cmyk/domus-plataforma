// ===================================================================
// EDGE FUNCTION: sync-completo-hospedin-pull (v8 — cancelamento + status)
// MUDANÇAS v8 (em relação à v7):
//   - Salva campo 'status' do Hospedin como status_hospedin no DG
//   - Detecta status='canceled' e setta status='cancelada' + cancelado_em=now() no DG
//   - Detecta 'no_show' e propaga (cria novo status no DG se preciso)
//   - precisaUpdate também considera status_hospedin
// ===================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const HOSPEDIN_BASE = "https://pms.hospedin.com";
const HOSPEDIN_SLUG = "domus-garden-coliving-894c75e4-0dae-4a75-8dca-9a8ee53a2369";

const MAX_RESERVAS_POR_EXECUCAO = 150; // era 30: reservas alem da 30a posicao NUNCA eram processadas (furo do Fabrizio 10/06)
const TIMEOUT_LOGIN_MS = 20000;
const TIMEOUT_FETCH_LISTA_MS = 60000;

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

// Mapeamento Hospedin status → DG status
// Só propaga status terminais (canceled). Os outros mantemos como estavam.
function mapearStatusHospedinParaDG(statusHospedin: string | null | undefined): string | null {
  switch ((statusHospedin || "").toLowerCase()) {
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

async function fetchComTimeout(
  url: string,
  opts: RequestInit,
  timeoutMs: number,
  label = "fetch"
): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => {
    console.log(`[timeout:${label}] abortando após ${timeoutMs}ms`);
    ctrl.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

function mergeCookies(existing: string, setCookieHeader: string | null): string {
  if (!setCookieHeader) return existing;
  const novosPares: Record<string, string> = {};
  setCookieHeader.split(/,(?=[^;]+?=)/).forEach((c) => {
    const m = c.trim().match(/^([^=]+)=([^;]*)/);
    if (m) novosPares[m[1].trim()] = m[2].trim();
  });
  const existPares: Record<string, string> = {};
  if (existing) {
    existing.split(";").forEach((c) => {
      const m = c.trim().match(/^([^=]+)=(.*)$/);
      if (m) existPares[m[1].trim()] = m[2];
    });
  }
  const final = { ...existPares, ...novosPares };
  return Object.entries(final).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function loginHospedin(email: string, password: string): Promise<string | null> {
  try {
    console.log("[login] GET /login");
    const r1 = await fetchComTimeout(`${HOSPEDIN_BASE}/login`, { method: "GET" }, TIMEOUT_LOGIN_MS, "login-get");
    const html = await r1.text();
    const csrfMatch = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
    if (!csrfMatch) {
      console.log("[login] CSRF nao encontrado");
      return null;
    }
    const csrf = csrfMatch[1];
    let cookies = mergeCookies("", r1.headers.get("set-cookie"));

    const body = new URLSearchParams({
      utf8: "✓",
      authenticity_token: csrf,
      "user[email]": email,
      "user[password]": password,
      commit: "Entrar",
    });

    console.log("[login] POST /login");
    const r2 = await fetchComTimeout(
      `${HOSPEDIN_BASE}/login`,
      {
        method: "POST",
        body: body.toString(),
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
      },
      TIMEOUT_LOGIN_MS,
      "login-post"
    );

    cookies = mergeCookies(cookies, r2.headers.get("set-cookie"));
    if (r2.status !== 302 && r2.status !== 200) {
      console.log(`[login] HTTP inesperado: ${r2.status}`);
      return null;
    }
    if (!cookies.includes("session")) {
      console.log("[login] cookie session ausente");
      return null;
    }
    console.log("[login] ok");
    return cookies;
  } catch (e: any) {
    console.log(`[login] erro: ${e.message}`);
    return null;
  }
}

// ===================================================================
// EDGE FUNCTION: fix-valores-hospedin
// Busca o valor REAL de reservas zeradas direto da pagina /edit do
// Hospedin (campo reservation[daily] e afins).
// modo 'dry' = so relata | modo 'apply' = grava valor_total/valor_diaria
// ===================================================================
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jOut = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function aplicar(item: any, z: any, modo: string, sb: any) {
  if (modo === "apply" && item.valor_proposto && item.valor_proposto > 0 && !item.aplicado) {
    const upd: any = { valor_total: item.valor_proposto };
    const d2 = item.daily || (item.daily_cents ? item.daily_cents / 100 : null);
    if (d2) upd.valor_diaria = d2;
    const u = await sb(`reservas?id=eq.${z.id}`, { method: "PATCH", body: JSON.stringify(upd) }).then((r: Response) => r.json());
    item.aplicado = Array.isArray(u) && u.length > 0;
  }
  return item;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const modo = b.modo === "apply" ? "apply" : "dry";

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const EMAIL = Deno.env.get("HOSPEDIN_EMAIL")!;
    const PASSWORD = Deno.env.get("HOSPEDIN_PASSWORD")!;
    const sb = (path: string, opts: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers || {}) } });

    // reservas zeradas com hospedin_id
    const zeradas: any[] = await sb(`reservas?select=id,hospedin_id,hospede_nome,cama,checkin,checkout,canal_codigo&valor_total=eq.0&hospedin_id=not.is.null&checkout=gte.2026-06-01&status=not.in.(cancelada,rescindida)&order=checkin`).then((r) => r.json());
    if (!Array.isArray(zeradas) || !zeradas.length) return jOut({ ok: true, msg: "nenhuma zerada com hospedin_id", zeradas });

    // ===== API V2 (pms-api) — JWT =====
    const V2_BASE = "https://pms-api.hospedin.com/api/v2/23949";
    let jwt: string | null = null;
    try {
      const rAuth = await fetchComTimeout(`${V2_BASE}/authentication/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }, 15000, "auth-v2");
      const jAuth = await rAuth.json().catch(() => ({}));
      jwt = jAuth.token || jAuth.jwt || jAuth.access_token || (jAuth.data && (jAuth.data.token || jAuth.data.jwt)) || null;
      if (!jwt && b.acao === "auth-debug") return jOut({ status: rAuth.status, chaves: Object.keys(jAuth) });
    } catch (_) {}

    const cookie = jwt ? "" : (await loginHospedin(EMAIL, PASSWORD)) || "";
    if (!jwt && !cookie) return jOut({ ok: false, erro: "nenhum login funcionou" }, 500);
    if (b.acao === "auth-debug") return jOut({ ok: true, viaJwt: !!jwt });

    // modo sonda: devolve estrutura da pagina de uma reserva pra calibrar parser
    if (b.acao === "sonda" && b.hospedin_id) {
      const out: any = {};
      for (const rota of ["edit", ""]) {
        const url = `${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/${b.hospedin_id}${rota ? "/" + rota : ""}`;
        const rr = await fetchComTimeout(url, { headers: { Cookie: cookie, accept: "text/html" } }, 15000, `sonda-${rota}`);
        const html = rr.ok ? await rr.text() : "";
        out[rota || "show"] = {
          status: rr.status,
          inputs: (html.match(/<input[^>]*name="[^"]*"[^>]*>/g) || []).map((i: string) => {
            const n = (i.match(/name="([^"]*)"/) || [])[1];
            const v = (i.match(/value="([^"]*)"/) || [])[1];
            return n + "=" + String(v || "").slice(0, 30);
          }).filter((x: string) => !/token|utf8|method/.test(x)).slice(0, 40),
          reais: (html.match(/.{0,30}R\$\s?[\d.,]+.{0,10}/g) || []).map((x: string) => x.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 20),
        };
      }
      // sonda de endpoints JSON
      out.jsons = {};
      const rrId = b.rate_id || null;
      const rotasJson = [
        `reservations/${b.hospedin_id}.json`,
        `reservations/${b.hospedin_id}/edit.json`,
        `reservations/${b.hospedin_id}/payments.json`,
        `reservations/${b.hospedin_id}/finances.json`,
        `reservations/${b.hospedin_id}/rate_reservations.json`,
      ].concat(rrId ? [`rate_reservations/${rrId}.json`] : []);
      for (const rota of rotasJson) {
        try {
          const rr = await fetchComTimeout(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/${rota}`, { headers: { Cookie: cookie, accept: "application/json" } }, 10000, rota);
          const ct = rr.headers.get("content-type") || "";
          let resumo = "status=" + rr.status + " ct=" + ct.slice(0, 30);
          if (rr.ok && ct.includes("json")) {
            const txt = await rr.text();
            const campos = [...new Set((txt.match(/"[a-z_]*(amount|total|cents|daily|price|value|commission)[a-z_]*"\s*:\s*[^,}]{1,20}/g) || []))].slice(0, 25);
            resumo += " | " + campos.join(" § ");
          }
          out.jsons[rota] = resumo;
        } catch (e: any) { out.jsons[rota] = "erro " + String(e.message || "").slice(0, 40); }
      }
      return jOut({ ok: true, sonda: out });
    }

    const resultados: any[] = [];
    for (const z of zeradas) {
      const noites = Math.max(1, Math.round((new Date(z.checkout).getTime() - new Date(z.checkin).getTime()) / 86400000));
      const item: any = { id: z.id, hospedin_id: z.hospedin_id, nome: z.hospede_nome, cama: z.cama, periodo: `${z.checkin}→${z.checkout}`, noites, canal: z.canal_codigo };
      try {
        if (jwt) {
          const rV2 = await fetchComTimeout(`${V2_BASE}/reservations/${z.hospedin_id}`, { headers: { Authorization: `Bearer ${jwt}`, accept: "application/json" } }, 12000, `v2-${z.hospedin_id}`);
          item.v2Status = rV2.status;
          if (rV2.ok) {
            const d = await rV2.json().catch(() => ({}));
            const h = d.reservation || d.data || d;
            const num = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
            item.total_amount = num(h.total_amount);
            item.total_to_receive = num(h.total_to_receive);
            item.total_daily_cents = num(h.total_daily_cents);
            item.daily_cents = num(h.daily_cents);
            item.total_received = num(h.total_received);
            item.ota_paga = h.has_payment_coming_from_ota ?? null;
            item.valor_proposto = item.total_amount || item.total_to_receive
              || (item.total_daily_cents ? Math.round(item.total_daily_cents) / 100 : null)
              || (item.daily_cents ? Math.round(item.daily_cents * noites) / 100 : null)
              || item.total_received || null;
          }
        }
        if (item.valor_proposto) { resultados.push(await aplicar(item, z, modo, sb)); continue; }
        if (!cookie) { resultados.push(item); continue; }
        const rEdit = await fetchComTimeout(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/${z.hospedin_id}/edit`, { headers: { Cookie: cookie, accept: "text/html" } }, 15000, `edit-${z.hospedin_id}`);
        item.editStatus = rEdit.status;
        if (rEdit.ok) {
          const html = await rEdit.text();
          const pega = (re: RegExp) => { const m = html.match(re); return m ? m[1] : null; };
          const brl = (s: string | null) => { if (!s) return null; const n = parseFloat(s.replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
          item.daily = brl(pega(/name="reservation\[daily\]"[^>]*value="([^"]+)"/));
          item.total_field = brl(pega(/name="reservation\[total[^"]*\]"[^>]*value="([^"]+)"/));
          item.commission = brl(pega(/name="reservation\[commission[^"]*\]"[^>]*value="([^"]+)"/));
          // fallback: qualquer "Total" com R$ na pagina
          const mTot = html.match(/Total[^R]{0,40}R\$\s*([\d.,]+)/i);
          item.total_pagina = brl(mTot ? mTot[1] : null);
          // valor final proposto (BRUTO, padrao Nicole): total_field > total_pagina > daily*noites
          item.valor_proposto = item.total_field || item.total_pagina || (item.daily ? Math.round(item.daily * noites * 100) / 100 : null);
        }
      } catch (e: any) { item.erro = String(e.message || e); }

      resultados.push(await aplicar(item, z, modo, sb));
    }
    return jOut({ ok: true, modo, total: resultados.length, resultados });
  } catch (e) {
    return jOut({ ok: false, erro: String(e) }, 500);
  }
});
