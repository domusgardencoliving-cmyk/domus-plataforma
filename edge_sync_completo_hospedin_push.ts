// =========================================================
// EDGE FUNCTION: sync-completo-hospedin-push
// Empurra reservas DG (diretas) pra Hospedin (POST + PUT).
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const HOSPEDIN_BASE = "https://pms-api.hospedin.com/api/v2";
const ACCOUNT_ID = "23949";

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
        console.log(`Hospedin login HTTP ${r.status} (tent ${tentativa}): ${txt.slice(0, 200)}`);
        if (tentativa < 3) { await new Promise(res => setTimeout(res, 1000 * tentativa)); continue; }
        return null;
      }
      try {
        const d = JSON.parse(txt);
        if (d?.token) return d.token;
      } catch {
        const m = txt.match(/"token"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
        console.log(`Hospedin login JSON inválido (tent ${tentativa}): ${txt.slice(0, 300)}`);
      }
      if (tentativa < 3) await new Promise(res => setTimeout(res, 1000 * tentativa));
    } catch (e: any) {
      console.log(`Hospedin login erro (tent ${tentativa}): ${e.message}`);
      if (tentativa < 3) await new Promise(res => setTimeout(res, 1000 * tentativa));
    }
  }
  return null;
};

const criarReservaHospedin = async (token: string, reserva: any) => {
  const body = {
    reservation: {
      check_in: reserva.checkin,
      check_out: reserva.checkout,
      total_value: Number(reserva.valor_total) || 0,
      guest_attributes: {
        name: reserva.hospede_nome || "Reserva Direta",
        phone_number: reserva.hospede_contato || "",
        email: reserva.hospede_email || "",
      },
      reservation_items_attributes: [{
        accommodation_id: reserva.hospedin_accommodation_id || null,
        check_in: reserva.checkin,
        check_out: reserva.checkout,
        adults: reserva.adultos || 1,
        children: reserva.criancas || 0,
      }],
      observation: `Reserva DG (canal: ${reserva.canal_codigo || "direto"}). Sync auto.`,
      status: reserva.status === "confirmada" ? "confirmed" : "pending",
    },
  };
  const r = await fetch(`${HOSPEDIN_BASE}/${ACCOUNT_ID}/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let d: any = {};
  try { d = JSON.parse(txt); } catch {}
  return { ok: r.ok, status: r.status, data: d };
};

const atualizarReservaHospedin = async (token: string, hospedinId: string, reserva: any) => {
  const body = {
    reservation: {
      check_in: reserva.checkin,
      check_out: reserva.checkout,
      total_value: Number(reserva.valor_total) || 0,
      status: (
        reserva.status === "cancelada" ? "cancelled" :
        reserva.status === "check-in" ? "checked_in" :
        reserva.status === "check-out" ? "checked_out" :
        reserva.status === "confirmada" ? "confirmed" : "pending"
      ),
    },
  };
  const r = await fetch(`${HOSPEDIN_BASE}/${ACCOUNT_ID}/reservations/${hospedinId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status };
};

Deno.serve(async (_req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const EMAIL = Deno.env.get("HOSPEDIN_EMAIL")!;
  const PASSWORD = Deno.env.get("HOSPEDIN_PASSWORD")!;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const inicio = Date.now();

  const token = await loginHospedin(EMAIL, PASSWORD);
  if (!token) {
    return new Response(JSON.stringify({ ok: false, erro: "login Hospedin falhou (3 tentativas)" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  const stats = { criadas: 0, atualizadas: 0, erros: 0 };
  const acoes: any[] = [];
  const erros: any[] = [];

  // CASO 1: reservas diretas DG sem hospedin_id → CRIAR
  const { data: paraCriar } = await sb
    .from("reservas")
    .select("*")
    .in("canal_codigo", ["direto", "venda_direta", "pre_reserva", "VD", "PR"])
    .is("hospedin_id", null)
    .neq("status", "cancelada")
    .gte("checkin", new Date().toISOString().slice(0, 10))
    .limit(20);

  for (const r of (paraCriar || [])) {
    try {
      const result = await criarReservaHospedin(token, r);
      if (result.ok) {
        const novoId = result.data?.reservation?.id || result.data?.id;
        if (novoId) {
          await sb.from("reservas").update({
            hospedin_id: String(novoId),
            ultima_sync_hospedin: new Date().toISOString(),
            status_sync_hospedin: "sincronizada",
          }).eq("id", r.id);
          stats.criadas++;
          acoes.push({ acao: "criada_hospedin", dg_id: r.id, hospedin_id: novoId, hospede: r.hospede_nome });
        }
      } else {
        stats.erros++;
        await sb.from("reservas").update({
          status_sync_hospedin: "erro",
          erro_sync_hospedin: JSON.stringify(result.data).slice(0, 500),
        }).eq("id", r.id);
        erros.push({ dg_id: r.id, hospede: r.hospede_nome, status: result.status });
      }
      await new Promise(res => setTimeout(res, 400));
    } catch (e: any) {
      stats.erros++;
      erros.push({ dg_id: r.id, erro: e.message?.slice(0, 200) });
    }
  }

  // CASO 2: reservas DG com hospedin_id que mudaram localmente → ATUALIZAR
  const { data: paraAtualizar } = await sb
    .from("reservas")
    .select("*")
    .in("canal_codigo", ["direto", "venda_direta", "pre_reserva", "VD", "PR"])
    .not("hospedin_id", "is", null)
    .gte("checkin", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
    .limit(20);

  for (const r of (paraAtualizar || [])) {
    const localMaisNovo = r.atualizado_em && r.ultima_sync_hospedin &&
                         new Date(r.atualizado_em).getTime() > new Date(r.ultima_sync_hospedin).getTime();
    if (!localMaisNovo) continue;

    try {
      const result = await atualizarReservaHospedin(token, r.hospedin_id, r);
      if (result.ok) {
        await sb.from("reservas").update({
          ultima_sync_hospedin: new Date().toISOString(),
          status_sync_hospedin: "sincronizada",
        }).eq("id", r.id);
        stats.atualizadas++;
        acoes.push({ acao: "atualizada_hospedin", dg_id: r.id, hospedin_id: r.hospedin_id, hospede: r.hospede_nome });
      } else {
        stats.erros++;
        erros.push({ dg_id: r.id, hospedin_id: r.hospedin_id, status: result.status });
      }
      await new Promise(res => setTimeout(res, 400));
    } catch (e: any) {
      stats.erros++;
      erros.push({ dg_id: r.id, erro: e.message?.slice(0, 200) });
    }
  }

  await sb.from("auditoria_sync_hospedin").insert({
    rodou_em: