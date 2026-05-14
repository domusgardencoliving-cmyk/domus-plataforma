// =========================================================
// EDGE FUNCTION: ical-poll-webquartos
//
// Webquartos publica iCal por anúncio (mesmo padrão Booking/Airbnb).
// Funcionamento idêntico aos outros 2: salvar URLs nos secrets,
// função puxa a cada 5min e UPSERT na tabela reservas.
//
// Como pegar: Webquartos → Painel → Calendário → "Sincronizar com outros sites"
// → Copiar link do Google Calendar (formato iCal). Salvar como
// WEBQUARTOS_ICAL_<UNIDADE>_<NOME_QUARTO> nos Supabase secrets.
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

interface EventoICal {
  uid: string;
  summary: string;
  dtstart: string;
  dtend: string;
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
  return !s.includes("bloqueado") && !s.includes("not available") && !s.includes("blocked");
};

Deno.serve(async (_req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const inicio = Date.now();

  const icalUrls: Array<{ url: string; cama: string; unidade: string }> = [];
  const env = Deno.env.toObject();
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("WEBQUARTOS_ICAL_") && v) {
      const partes = k.replace("WEBQUARTOS_ICAL_", "").split("_");
      const unidade = partes[0];
      const cama = partes.slice(1).map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(" ");
      icalUrls.push({ url: v as string, cama, unidade });
    }
  }

  if (icalUrls.length === 0) {
    return new Response(JSON.stringify({
      ok: false,
      erro: "Nenhuma URL iCal Webquartos configurada (WEBQUARTOS_ICAL_*)",
      como_configurar: "Webquartos → Painel → Calendário → Sincronizar → Copiar link iCal. Salvar nos Supabase secrets.",
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

        const externoId = `WEBQUARTOS_${ev.uid}`;
        const checkin = isoFromYYYYMMDD(ev.dtstart);
        const checkout = isoFromYYYYMMDD(ev.dtend);
        const nome = ev.summary || `Hóspede Webquartos`;

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
            canal_codigo: "webquartos",
            externo_id_canal: externoId,
            origem_dados: "ical_webquartos",
            ultima_sync_hospedin: new Date().toISOString(),
          });
          stats.criadas++;
          acoes.push({ acao: "criada", nome, cama, checkin, checkout });
        } else if (existente.checkin !== checkin || existente.checkout !== checkout) {
          await sb.from("reservas").update({ checkin, checkout, ultima_sync_hospedin: new Date().toISOString() }).eq("id", existente.id);
          stats.atualizadas++;
          acoes.push({ acao: "datas_atualizadas", nome, cama });
        }
      }
    } catch (e: any) {
      stats.erros++;
      erros.push({ url, cama, erro: e.message?.slice(0, 200) });
    }
  }

  await sb.from("auditoria_sync_hospedin").insert({
    rodou_em: new Date().toISOString(),
    duracao_ms: Date.now() - inicio,
    stats: { ...stats, fonte: "ical_webquartos" },
    acoes: acoes.slice(0, 50),
    erros,
  }).then(() => {}).catch(() => {});

  return new Response(JSON.stringify({ ok: true, stats, acoes, erros, duracao_ms: Date.now() - inicio }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
