// =========================================================
// EDGE FUNCTION: ical-poll-booking
//
// Lê o feed iCal público que a Booking publica pro hostel da Domus
// e UPSERT direto na tabela reservas. Sem precisar passar pela Hospedin.
//
// Onde pegar o iCal da Booking:
//   1. Extranet Booking → Disponibilidade → Sincronização de calendário
//   2. Copiar URL "Exportar calendário" pra cada UH (acomodação)
//   3. Salvar no Supabase secrets como BOOKING_ICAL_AP, BOOKING_ICAL_RIB etc
//
// Limitação iCal: só vem nome do hóspede + datas + ID externo.
// Telefone/email/valor são preenchidos pelo email parser (Átrio).
//
// Cron sugerido: a cada 5min (cada UH é uma URL diferente)
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

interface EventoICal {
  uid: string;          // ID único da reserva no calendário Booking
  summary: string;      // ex: "CLOSED - Not available", "Joao Silva", "GUEST: 12345..."
  dtstart: string;      // YYYYMMDD
  dtend: string;        // YYYYMMDD
  description?: string;
}

const parseICal = (texto: string): EventoICal[] => {
  const eventos: EventoICal[] = [];
  const blocos = texto.split("BEGIN:VEVENT").slice(1);
  for (const bloco of blocos) {
    const evento: any = {};
    const lines = bloco.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("END:VEVENT")) break;
      const m = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.+)$/);
      if (!m) continue;
      const [, key, value] = m;
      const k = key.toLowerCase();
      if (k === "uid") evento.uid = value.trim();
      else if (k === "summary") evento.summary = value.trim();
      else if (k === "dtstart") evento.dtstart = value.trim().slice(0, 8);
      else if (k === "dtend") evento.dtend = value.trim().slice(0, 8);
      else if (k === "description") evento.description = value.trim();
    }
    if (evento.uid && evento.dtstart) eventos.push(evento);
  }
  return eventos;
};

const isoFromYYYYMMDD = (s: string): string =>
  `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

const isReservaReal = (summary: string): boolean => {
  const s = (summary || "").toLowerCase();
  // Booking marca períodos bloqueados como "CLOSED"
  return !s.includes("closed") && !s.includes("not available") && !s.includes("blocked");
};

const extractNomeBooking = (summary: string, description?: string): string => {
  // Booking iCal padrão: SUMMARY = "CLOSED - Not available" OU nome do hóspede
  // Ou na description tem "GUEST: Nome..."
  if (description) {
    const m = description.match(/GUEST:\s*([^\n\\]+)/i);
    if (m) return m[1].trim();
  }
  return summary || "Reserva Booking";
};

Deno.serve(async (_req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const inicio = Date.now();

  // Lista de URLs iCal da Booking (uma por UH/acomodação)
  // Cada uma vai vir do secret BOOKING_ICAL_<UH>
  // Ex de URL: https://admin.booking.com/hotel/hoteladmin/ical.html?t=ABCD&prop=12345&room=67890
  const icalUrls: Array<{ url: string; cama: string; unidade: string }> = [];
  const env = Deno.env.toObject();
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("BOOKING_ICAL_") && v) {
      // BOOKING_ICAL_AP_STUDIO_1 → cama "Studio 1", unidade "AP"
      const partes = k.replace("BOOKING_ICAL_", "").split("_");
      const unidade = partes[0]; // AP ou RIB
      const cama = partes.slice(1).map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(" ");
      icalUrls.push({ url: v as string, cama, unidade });
    }
  }

  if (icalUrls.length === 0) {
    return new Response(JSON.stringify({
      ok: false,
      erro: "Nenhuma URL iCal Booking configurada nos secrets (BOOKING_ICAL_*)",
      como_configurar: "Supabase → Project Settings → Edge Functions → Secrets. Adicionar BOOKING_ICAL_AP_STUDIO_1 = url, BOOKING_ICAL_AP_INDIVIDUAL_3 = url, etc",
    }), { headers: { "Content-Type": "application/json" } });
  }

  const stats = { criadas: 0, atualizadas: 0, ignoradas: 0, erros: 0, total_eventos: 0 };
  const acoes: any[] = [];
  const erros: any[] = [];

  for (const { url, cama, unidade } of icalUrls) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Domus-DG/1.0" } });
      if (!r.ok) {
        stats.erros++;
        erros.push({ url, cama, status: r.status });
        continue;
      }
      const texto = await r.text();
      const eventos = parseICal(texto);
      stats.total_eventos += eventos.length;

      for (const ev of eventos) {
        if (!isReservaReal(ev.summary)) {
          stats.ignoradas++;
          continue;
        }

        const nome = extractNomeBooking(ev.summary, ev.description);
        const checkin = isoFromYYYYMMDD(ev.dtstart);
        const checkout = isoFromYYYYMMDD(ev.dtend);
        const externoId = `BOOKING_ICAL_${ev.uid}`;

        // Existe?
        const { data: existente } = await sb.from("reservas")
          .select("id, checkin, checkout")
          .eq("externo_id_canal", externoId)
          .maybeSingle();

        if (!existente) {
          await sb.from("reservas").insert({
            hospede_nome: nome,
            cama,
            checkin,
            checkout,
            status: "confirmada",
            canal_codigo: "booking",
            externo_id_canal: externoId,
            origem_dados: "ical_booking",
            ultima_sync_hospedin: new Date().toISOString(),
          });
          stats.criadas++;
          acoes.push({ acao: "criada", nome, cama, checkin, checkout, uid: ev.uid });
        } else if (existente.checkin !== checkin || existente.checkout !== checkout) {
          await sb.from("reservas").update({ checkin, checkout, ultima_sync_hospedin: new Date().toISOString() }).eq("id", existente.id);
          stats.atualizadas++;
          acoes.push({ acao: "datas_atualizadas", nome, cama, novo_checkin: checkin, novo_checkout: checkout });
        }
      }
    } catch (e: any) {
      stats.erros++;
      erros.push({ url, cama, erro: e.message?.slice(0, 200) });
    }
  }

  // Log
  await sb.from("auditoria_sync_hospedin").insert({
    rodou_em: new Date().toISOString(),
    duracao_ms: Date.now() - inicio,
    stats: { ...stats, fonte: "ical_booking" },
    acoes: acoes.slice(0, 50),
    erros,
  }).then(() => {}).catch(() => {});

  return new Response(JSON.stringify({ ok: true, stats, acoes, erros, duracao_ms: Date.now() - inicio }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
