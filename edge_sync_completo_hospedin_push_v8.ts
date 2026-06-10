// ===================================================================
// EDGE FUNCTION: sync-completo-hospedin-push (v8 — CREATE + UPDATE + CANCEL)
// MUDANÇAS v8 (em relação à v6):
//   - PARTE A: Cria reservas novas no Hospedin (igual v6)
//   - PARTE B: Atualiza reservas no Hospedin (datas/cama/valor) — quando DG.atualizado_em > DG.ultima_sync_hospedin
//   - PARTE C: Cancela no Hospedin quando DG.status='cancelada' E ainda não foi cancelada lá
//   - Endpoint Rails: POST /{slug}/reservations/{id} com _method=patch + reservation[status]=canceled
// ===================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const HOSPEDIN_BASE = "https://pms.hospedin.com";
const HOSPEDIN_SLUG = "domus-garden-coliving-894c75e4-0dae-4a75-8dca-9a8ee53a2369";

const HOSPEDIN_PLACE_IDS: Record<string, string> = {
  "Studio 1": "335187",
  "Studio 2": "335188",
  "Individual 3": "335189",
  "Individual 4": "335190",
  "Individual 5": "335191",
  "Hostel 6 - Cama 1": "335192",
  "Hostel 6 - Cama 2": "338390",
  "Hostel 6 - Cama 3": "338391",
  "Hostel 6 - Cama 4": "338392",
  "Hostel 7 - Cama 5": "338393",
  "Hostel 7 - Cama 6": "338394",
  "Hostel 7 - Cama 7": "348425",
  "Hostel 7 - Cama 8": "348426",
};

const HOSPEDIN_CANAIS: Record<string, string> = {
  "Direto": "33933",
  "Venda Direta": "33933",
  "direto": "33933",
  "Booking": "32944",
  "Booking.com": "32944",
  "Airbnb": "32942",
  "Hotels.com": "91051",
};

const MARCA_NAO_SINCRONIZAR = "JA_EXISTE_HOSPEDIN";
const MAX_CREATE = 10;
const MAX_UPDATE = 10;
const MAX_CANCEL = 10;

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
    const r1 = await fetch(`${HOSPEDIN_BASE}/login`, { method: "GET" });
    const html = await r1.text();
    const csrfMatch = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
    if (!csrfMatch) return null;
    const csrf = csrfMatch[1];
    let cookies = mergeCookies("", r1.headers.get("set-cookie"));

    const body = new URLSearchParams({
      utf8: "✓",
      authenticity_token: csrf,
      "user[email]": email,
      "user[password]": password,
      commit: "Entrar",
    });

    const r2 = await fetch(`${HOSPEDIN_BASE}/login`, {
      method: "POST",
      body: body.toString(),
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    });

    cookies = mergeCookies(cookies, r2.headers.get("set-cookie"));
    if (r2.status !== 302 && r2.status !== 200) return null;
    if (!cookies.includes("session")) return null;
    return cookies;
  } catch (e: any) {
    console.log(`[login] erro: ${e.message}`);
    return null;
  }
}

function fmtBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Pega CSRF da página /edit da reserva
async function pegarCSRFEdit(cookie: string, hospedinId: string): Promise<{ csrf: string | null; cookie: string }> {
  const r = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/${hospedinId}/edit`, {
    headers: { Cookie: cookie, accept: "text/html" },
  });
  cookie = mergeCookies(cookie, r.headers.get("set-cookie"));
  if (!r.ok) {
    console.log(`[csrf-edit] HTTP ${r.status} pra ${hospedinId}`);
    return { csrf: null, cookie };
  }
  const html = await r.text();
  const m = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
  return { csrf: m ? m[1] : null, cookie };
}

// PARTE A: cria reserva nova
function normNomeGuest(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

async function buscarGuestHospedin(cookie: string, nome: string): Promise<any | null> {
  try {
    const r = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/services/guests.json?term=${encodeURIComponent(nome)}`, { headers: { Cookie: cookie, accept: "application/json" } });
    const l = await r.json();
    return (Array.isArray(l) ? l : []).find((x: any) => normNomeGuest(x.name) === normNomeGuest(nome)) || null;
  } catch (_) { return null; }
}

async function criarGuestHospedin(cookie: string, nome: string, tel: string | null): Promise<{ cookie: string; id: string | null }> {
  try {
    const rN = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/guests/new`, { headers: { Cookie: cookie, accept: "text/html" } });
    cookie = mergeCookies(cookie, rN.headers.get("set-cookie"));
    const csrf = (await rN.text()).match(/name="authenticity_token"[^>]*value="([^"]+)"/)?.[1];
    if (!csrf) return { cookie, id: null };
    const p = new URLSearchParams();
    p.append("utf8", "\u2713"); p.append("authenticity_token", csrf);
    p.append("guest[name]", nome);
    ["email", "ssn", "identification", "passport", "birth", "gender", "occupation", "note"].forEach((k) => p.append(`guest[${k}]`, ""));
    const t = String(tel || "").replace(/\D/g, "");
    p.append("guest[contact_attributes][ddi]", t.length >= 10 ? "55" : "");
    p.append("guest[contact_attributes][phone]", t.length >= 10 ? (t.startsWith("55") ? t.slice(2) : t) : "");
    p.append("commit", "Salvar");
    const r = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/guests`, { method: "POST", body: p.toString(), redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: HOSPEDIN_BASE, Referer: `${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/guests/new` } });
    cookie = mergeCookies(cookie, r.headers.get("set-cookie"));
    const g = await buscarGuestHospedin(cookie, nome);
    return { cookie, id: g ? String(g.id) : null };
  } catch (_) { return { cookie, id: null }; }
}

async function criarReservaHospedin(cookie: string, reserva: any): Promise<{ code: string | null; hospedin_id: string | null; erro?: string }> {
  const cama = reserva.cama;
  const placeId = HOSPEDIN_PLACE_IDS[cama];
  if (!placeId) return { code: null, hospedin_id: null, erro: `Sem mapeamento pra cama: ${cama}` };

  const canalKey = reserva.plataforma || "Direto";
  const canalId = HOSPEDIN_CANAIS[canalKey] || HOSPEDIN_CANAIS["Direto"];

  // resolve guest central (busca -> cria) pra reserva nascer COM hospede vinculado
  let guestId: string | null = null;
  if (!ehBloqueio) {
    const nomeGuest = String(reserva.hospede_nome || "").trim();
    if (nomeGuest && nomeGuest.length >= 5 && !/^(hospede|teste|VD:|PR:|BO:|AI:|Cama )/i.test(nomeGuest)) {
      const gx = await buscarGuestHospedin(cookie, nomeGuest);
      if (gx) { guestId = String(gx.id); }
      else {
        const cr = await criarGuestHospedin(cookie, nomeGuest, reserva.hospede_contato);
        cookie = cr.cookie; guestId = cr.id;
      }
    }
  }

  const rNew = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/new`, {
    headers: { Cookie: cookie, accept: "text/html" },
  });
  cookie = mergeCookies(cookie, rNew.headers.get("set-cookie"));
  const newHtml = await rNew.text();
  const csrf = newHtml.match(/name="authenticity_token"[^>]*value="([^"]+)"/)?.[1];
  if (!csrf) return { code: null, hospedin_id: null, erro: "CSRF Nova Reserva não encontrado" };

  const periodo = `${fmtBR(reserva.checkin)} - ${fmtBR(reserva.checkout)}`;
  const noites = Math.max(1, (new Date(reserva.checkout).getTime() - new Date(reserva.checkin).getTime()) / 86400000);
  const dailyNum = Number(reserva.valor_total || 0) / noites;
  const daily = dailyNum.toFixed(2).replace(".", ",");

  const params = new URLSearchParams();
  params.append("utf8", "✓");
  params.append("authenticity_token", csrf);
  params.append("reservation[status]", "reservation");
  params.append("reservation[period]", periodo);
  params.append("reservation[place_id]", placeId);
  params.append("reservation[daily]", daily);
  params.append("reservation[sale_channel_id]", canalId);
  params.append("reservation[adults]", String(reserva.num_hospedes || 1));
  params.append("reservation[children]", "0");
  params.append("reservation[note]", `Sync DG ${new Date().toISOString().slice(0, 10)} ${reserva.observacoes || ""}`.slice(0, 500));
  if (guestId) params.append("reservation[guest_id]", guestId);
    params.append("guest[name]", reserva.hospede_nome || "Hóspede Direto");

  const tel = String(reserva.hospede_contato || "").replace(/[^0-9]/g, "");
  if (tel.length >= 10) {
    params.append("guest[contact_attributes][ddi]", "55");
    params.append("guest[contact_attributes][phone]", tel.startsWith("55") ? tel.slice(2) : tel);
  }
  params.append("commit", "Salvar");

  const r = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations`, {
    method: "POST",
    body: params.toString(),
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: HOSPEDIN_BASE, Referer: `${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/new` },
    redirect: "manual",
  });

  const loc = r.headers.get("location") || "";
  if (r.status === 302 && /\/reservations\/\d+/.test(loc)) {
    const hospedin_id = loc.match(/\/reservations\/(\d+)/)?.[1] || null;
    let code: string | null = null;
    try {
      const rList = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/services/reservations.json`, {
        headers: { Cookie: cookie, accept: "application/json" },
      });
      const list = await rList.json();
      const m = list.find((x: any) => String(x.id) === hospedin_id);
      if (m) code = m.code;
    } catch (_) {}
    return { code, hospedin_id };
  }

  const body = await r.text();
  const errosMatch = Array.from(body.matchAll(/<(?:div|p|span)[^>]+class="[^"]*(?:error|alert|invalid)[^"]*"[^>]*>([^<]{5,200})</g))
    .map((m) => m[1].trim())
    .filter(Boolean);
  return { code: null, hospedin_id: null, erro: (errosMatch.join(" | ") || `HTTP ${r.status}`) + ` [loc=${loc.slice(0,140)}] [body=${body.replace(/\s+/g, " ").slice(0,200)}]` };
}

// PARTE B/C: atualiza ou cancela reserva existente
// Envia POST /reservations/{id} com _method=patch
async function atualizarReservaHospedin(
  cookie: string,
  hospedinId: string,
  campos: { status?: string; checkin?: string; checkout?: string; cama?: string; valor_total?: number; nome?: string }
): Promise<{ ok: boolean; erro?: string }> {
  const edit = await pegarCSRFEdit(cookie, hospedinId);
  const csrf = edit.csrf;
  cookie = edit.cookie;
  if (!csrf) return { ok: false, erro: "CSRF Edit não encontrado (reserva existe?)" };

  const params = new URLSearchParams();
  params.append("_method", "patch");
  params.append("utf8", "✓");
  params.append("authenticity_token", csrf);

  if (campos.status) {
    params.append("reservation[status]", campos.status);
  }
  if (campos.checkin && campos.checkout) {
    params.append("reservation[period]", `${fmtBR(campos.checkin)} - ${fmtBR(campos.checkout)}`);
  }
  if (campos.cama) {
    const placeId = HOSPEDIN_PLACE_IDS[campos.cama];
    if (placeId) params.append("reservation[place_id]", placeId);
  }
  if (typeof campos.valor_total === "number" && campos.checkin && campos.checkout) {
    const noites = Math.max(1, (new Date(campos.checkout).getTime() - new Date(campos.checkin).getTime()) / 86400000);
    const dailyNum = campos.valor_total / noites;
    params.append("reservation[daily]", dailyNum.toFixed(2).replace(".", ","));
  }
  if (campos.nome) {
    params.append("guest[name]", campos.nome);
  }
  params.append("commit", "Salvar");

  const r = await fetch(`${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/${hospedinId}`, {
    method: "POST",
    body: params.toString(),
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: HOSPEDIN_BASE, Referer: `${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/${hospedinId}/edit` },
    redirect: "manual",
  });

  // 302 redirect = sucesso. 200 sem redirect = pode ter erro de validação.
  if (r.status === 302) {
    return { ok: true };
  }
  if (r.status === 200) {
    const body = await r.text();
    if (body.includes("error") || body.includes("invalid")) {
      const erros = Array.from(body.matchAll(/<(?:div|p|span)[^>]+class="[^"]*(?:error|alert|invalid)[^"]*"[^>]*>([^<]{5,200})</g))
        .map((m) => m[1].trim())
        .filter(Boolean);
      if (erros.length > 0) return { ok: false, erro: erros.join(" | ") };
    }
    return { ok: true }; // assume sucesso se não detectou erro
  }
  return { ok: false, erro: `HTTP ${r.status}` };
}

Deno.serve(async (_req) => {
  const inicio = Date.now();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const EMAIL = Deno.env.get("HOSPEDIN_EMAIL")!;
  const PASSWORD = Deno.env.get("HOSPEDIN_PASSWORD")!;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const cookie = await loginHospedin(EMAIL, PASSWORD);
  if (!cookie) {
    return new Response(JSON.stringify({ ok: false, erro: "Login Hospedin falhou" }), { status: 500 });
  }

  const stats = { criadas: 0, atualizadas: 0, canceladas: 0, ignoradas: 0, erros: 0 };
  const acoes: any[] = [];
  const erros: any[] = [];

  // ============ PARTE A: CREATE ============
  try {
    const { data: paraCriar } = await sb
      .from("reservas")
      .select("*")
      .in("canal_codigo", ["direto", "venda_direta", "pre_reserva", "VD", "PR"])
      .is("hospedin_id", null)
      .neq("status", "cancelada")
      .gte("checkin", new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10))
      .limit(MAX_CREATE);

    for (const r of paraCriar || []) {
      if ((r.observacoes || "").includes(MARCA_NAO_SINCRONIZAR)) {
        stats.ignoradas++;
        acoes.push({ acao: "ignorada_marca", dg_id: r.id });
        await sb.from("reservas").update({ status_sync_hospedin: "ignorada", ultima_sync_hospedin: new Date().toISOString() }).eq("id", r.id);
        continue;
      }
      try {
        const result = await criarReservaHospedin(cookie, r);
        if (result.erro) {
          stats.erros++;
          erros.push({ etapa: "create", dg_id: r.id, erro: result.erro.slice(0, 200) });
          await sb.from("reservas").update({
            status_sync_hospedin: "erro",
            erro_sync_hospedin: result.erro.slice(0, 500),
            ultima_sync_hospedin: new Date().toISOString(),
          }).eq("id", r.id);
        } else {
          const upd: any = { status_sync_hospedin: "sincronizada", ultima_sync_hospedin: new Date().toISOString() };
          if (result.hospedin_id) upd.hospedin_id = result.hospedin_id;
          if (result.code) upd.codigo_externo = result.code;
          await sb.from("reservas").update(upd).eq("id", r.id);
          stats.criadas++;
          acoes.push({ acao: "criada", dg_id: r.id, hospedin_id: result.hospedin_id });
        }
        await new Promise((res) => setTimeout(res, 300));
      } catch (e: any) {
        stats.erros++;
        erros.push({ etapa: "create", dg_id: r.id, erro: (e.message || String(e)).slice(0, 200) });
      }
    }
  } catch (e: any) {
    erros.push({ etapa: "create_batch", erro: (e.message || String(e)).slice(0, 200) });
  }

  // ============ PARTE C: CANCEL ============
  // Reservas com hospedin_id NOT NULL + status='cancelada' + ainda não foram canceladas no Hospedin (status_hospedin != canceled)
  try {
    const { data: paraCancelar } = await sb
      .from("reservas")
      .select("id, hospedin_id, hospede_nome, status_hospedin, cancelado_em")
      .eq("status", "cancelada")
      .not("hospedin_id", "is", null)
      .or("status_hospedin.neq.canceled,status_hospedin.is.null")
      .filter("cancelado_em", "gt", new Date(Date.now() - 7 * 86400000).toISOString())
      .limit(MAX_CANCEL);

    for (const r of paraCancelar || []) {
      try {
        const result = await atualizarReservaHospedin(cookie, String(r.hospedin_id), { status: "canceled" });
        if (result.ok) {
          await sb.from("reservas").update({
            status_hospedin: "canceled",
            ultima_sync_hospedin: new Date().toISOString(),
            status_sync_hospedin: "sincronizada",
          }).eq("id", r.id);
          stats.canceladas++;
          acoes.push({ acao: "cancelada_no_hospedin", dg_id: r.id, hospedin_id: r.hospedin_id, nome: r.hospede_nome });
        } else {
          stats.erros++;
          erros.push({ etapa: "cancel", dg_id: r.id, hospedin_id: r.hospedin_id, erro: result.erro?.slice(0, 200) });
        }
        await new Promise((res) => setTimeout(res, 300));
      } catch (e: any) {
        stats.erros++;
        erros.push({ etapa: "cancel", dg_id: r.id, erro: (e.message || String(e)).slice(0, 200) });
      }
    }
  } catch (e: any) {
    erros.push({ etapa: "cancel_batch", erro: (e.message || String(e)).slice(0, 200) });
  }

  // ============ PARTE B: UPDATE ============
  // Reservas com hospedin_id NOT NULL + atualizado_em > ultima_sync_hospedin + 5 seg
  // (margem evita ping-pong com o trigger)
  // Fix 05/06/2026: PostgREST .filter() não avalia "now() - interval ..." como expressão SQL;
  // recebia string literal e ignorava o filtro, fazendo o push rodar em massa.
  // Agora calculamos o cutoff em JS e passamos uma data ISO real.
  try {
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: paraAtualizar } = await sb
      .from("reservas")
      .select("id, hospedin_id, checkin, checkout, cama, valor_total, hospede_nome, status, atualizado_em, ultima_sync_hospedin")
      .not("hospedin_id", "is", null)
      .neq("status", "cancelada")
      .gt("atualizado_em", cutoff7d) // só janela recente (7 dias)
      .order("atualizado_em", { ascending: false })
      .limit(MAX_UPDATE * 5); // pega mais e filtra em memória

    const realmenteParaAtualizar = (paraAtualizar || []).filter((r: any) => {
      if (!r.ultima_sync_hospedin) return true;
      const dtAtualizado = new Date(r.atualizado_em).getTime();
      const dtSync = new Date(r.ultima_sync_hospedin).getTime();
      return dtAtualizado > dtSync + 5000; // 5 segundos de margem
    }).slice(0, MAX_UPDATE);

    for (const r of realmenteParaAtualizar) {
      try {
        const result = await atualizarReservaHospedin(cookie, String(r.hospedin_id), {
          checkin: r.checkin,
          checkout: r.checkout,
          cama: r.cama,
          valor_total: Number(r.valor_total || 0),
          nome: r.hospede_nome,
        });
        if (result.ok) {
          await sb.from("reservas").update({
            ultima_sync_hospedin: new Date().toISOString(),
            status_sync_hospedin: "sincronizada",
          }).eq("id", r.id);
          stats.atualizadas++;
          acoes.push({ acao: "atualizada_no_hospedin", dg_id: r.id, hospedin_id: r.hospedin_id, nome: r.hospede_nome });
        } else {
          stats.erros++;
          erros.push({ etapa: "update", dg_id: r.id, hospedin_id: r.hospedin_id, erro: result.erro?.slice(0, 200) });
        }
        await new Promise((res) => setTimeout(res, 300));
      } catch (e: any) {
        stats.erros++;
        erros.push({ etapa: "update", dg_id: r.id, erro: (e.message || String(e)).slice(0, 200) });
      }
    }
  } catch (e: any) {
    erros.push({ etapa: "update_batch", erro: (e.message || String(e)).slice(0, 200) });
  }

  // Auditoria
  try {
    await sb.from("auditoria_sync_hospedin").insert({
      rodou_em: new Date().toISOString(),
      duracao_ms: Date.now() - inicio,
      stats: { ...stats, direcao: "push_dg_pra_hospedin", versao: "v8_guest_vinculado" },
      acoes: acoes.slice(0, 50),
      erros,
    });
  } catch (_) {}

  return new Response(
    JSON.stringify({ ok: erros.length === 0, duracao_ms: Date.now() - inicio, stats, acoes, erros }, null, 2),
    { headers: { "Content-Type": "application/json" } }
  );
});
