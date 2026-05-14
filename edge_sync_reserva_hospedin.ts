// =========================================================
// EDGE FUNCTION: sync-reserva-hospedin
//
// Toda vez que entra reserva DIRETA no DG (canal=VD/PR/direto),
// criamos uma reserva equivalente na Hospedin via API V2.
// Trigger: pg_net no INSERT de reservas com canal direto, ou polling
// 5min nas que ficaram com hospedin_id NULL.
//
// Variáveis:
//   HOSPEDIN_EMAIL    (já existe nos secrets)
//   HOSPEDIN_PASSWORD (já existe)
//   HOSPEDIN_ACCOUNT_ID  (já existe — 23949)
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const HOSPEDIN_BASE = "https://pms-api.hospedin.com/api/v2";

const loginHospedin = async (email: string, password: string) => {
  const r = await fetch(`${HOSPEDIN_BASE}/authentication/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: { email, password } }),
  });
  const d = await r.json();
  return d.token as string | undefined;
};

const criarReservaHospedin = async (token: string, accountId: string, reserva: any) => {
  const body = {
    reservation: {
      check_in: reserva.checkin,
      check_out: reserva.checkout,
      total_value: reserva.valor_total || 0,
      guest_attributes: {
        name: reserva.hospede_nome || "Reserva Direta",
        phone_number: reserva.hospede_contato || "",
        email: reserva.hospede_email || "",
      },
      reservation_items_attributes: [{
        accommodation_id: reserva.hospedin_accommodation_id || null,
        check_in: reserva.checkin,
        check_out: reserva.checkout,
        adults: 1,
        children: 0,
      }],
      observation: "Reserva direta criada via DG Gestão (sync auto). Canal: " + (reserva.canal_codigo || "direto"),
      status: "confirmed",
    },
  };

  const r = await fetch(`${HOSPEDIN_BASE}/${accountId}/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  return { ok: r.ok, status: r.status, data: d };
};

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const EMAIL = Deno.env.get("HOSPEDIN_EMAIL")!;
  const PASSWORD = Deno.env.get("HOSPEDIN_PASSWORD")!;
  const ACCOUNT = Deno.env.get("HOSPEDIN_ACCOUNT_ID") || "23949";

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Login Hospedin
  const token = await loginHospedin(EMAIL, PASSWORD);
  if (!token) {
    return new Response(JSON.stringify({ ok: false, erro: "login Hospedin falhou" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pega reservas DIRETAS sem hospedin_id (não sincronizadas)
  const { data: reservas, error } = await sb
    .from("reservas")
    .select("id,hospede_nome,hospede_contato,checkin,checkout,valor_total,canal_codigo,plataforma,cama,unidade_codigo")
    .in("canal_codigo", ["direto", "venda_direta", "pre_reserva", "VD", "PR"])
    .is("hospedin_id", null)
    .neq("status", "cancelada")
    .gte("checkin", new Date().toISOString().slice(0, 10))
    .limit(20);

  if (error) {
    return new Response(JSON.stringify({ ok: false, erro: error.message }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const resultados: any[] = [];
  for (const r of (reservas || [])) {
    const result = await criarReservaHospedin(token, ACCOUNT, r);
    if (result.ok) {
      const novoId = result.data?.reservation?.id || result.data?.id;
      if (novoId) {
        await sb.from("reservas").update({
          hospedin_id: String(novoId),
          ultima_sync_hospedin: new Date().toISOString(),
          status_sync_hospedin: "sincronizada",
        }).eq("id", r.id);
      }
      resultados.push({ reserva_id: r.id, hospede: r.hospede_nome, status: "criada", hospedin_id: novoId });
    } else {
      await sb.from("reservas").update({
        status_sync_hospedin: "erro",
        erro_sync_hospedin: JSON.stringify(result.data).slice(0, 500),
      }).eq("id", r.id);
      resultados.push({ reserva_id: r.id, hospede: r.hospede_nome, status: "erro", erro: result.data });
    }
    await new Promise(r => setTimeout(r, 500)); // espaça calls
  }

  return new Response(JSON.stringify({
    ok: true,
    processadas: resultados.length,
    sucesso: resultados.filter(r => r.status === "criada").length,
    erros: resultados.filter(r => r.status === "erro").length,
    detalhes: resultados,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
