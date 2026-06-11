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

function brToISO(s: string): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function detectarPlataforma(code: string | null | undefined): { plataforma: string; canal: string } {
  const c = (code || "").toUpperCase();
  if (c.startsWith("VD:")) return { plataforma: "Direto", canal: "direto" };
  if (c.startsWith("BO:")) return { plataforma: "Booking", canal: "booking" };
  if (c.startsWith("AI:")) return { plataforma: "Airbnb", canal: "airbnb" };
  if (c.startsWith("HE:")) return { plataforma: "Hospedin", canal: "hospedin" };
  return { plataforma: "Hospedin", canal: "hospedin" };
}

Deno.serve(async (_req) => {
  const inicio = Date.now();
  const stats = { novas: 0, atualizadas: 0, canceladas: 0, inalteradas: 0, ignoradas: 0, erros: 0, processadas: 0 };
  const acoes: any[] = [];
  const erros: any[] = [];
  let totalHospedin = 0;
  let ondeParou = "inicio";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const EMAIL = Deno.env.get("HOSPEDIN_EMAIL")!;
  const PASSWORD = Deno.env.get("HOSPEDIN_PASSWORD")!;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    ondeParou = "login";
    const cookie = await loginHospedin(EMAIL, PASSWORD);

    // ===== API V2 (JWT) — valores que a listagem nao traz (descoberto 11/06/2026) =====
    let v2jwt: string | null = null;
    try {
      const rA = await fetchComTimeout("https://pms-api.hospedin.com/api/v2/authentication/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }, 15000, "auth-v2");
      const jA = await rA.json().catch(() => ({}));
      v2jwt = jA.token || jA.jwt || jA.access_token || (jA.data && (jA.data.token || jA.data.jwt)) || null;
      console.log("[sync-pull] auth API V2:", v2jwt ? "ok" : "falhou");
    } catch (_) { console.warn("[sync-pull] auth V2 indisponivel"); }
    if (!cookie) throw new Error("Login Hospedin falhou");
    console.log(`[main] login concluido em ${Date.now() - inicio}ms`);

    ondeParou = "fetch_lista";
    const tFetch = Date.now();
    const rLista = await fetchComTimeout(
      `${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/services/reservations.json`,
      { headers: { Cookie: cookie, accept: "application/json" } },
      TIMEOUT_FETCH_LISTA_MS,
      "lista-reservas"
    );
    if (!rLista.ok) throw new Error(`HTTP ${rLista.status} buscando reservas`);
    const listaHospedin: any[] = await rLista.json();
    totalHospedin = listaHospedin.length;
    console.log(`[main] lista: ${totalHospedin} reservas em ${Date.now() - tFetch}ms`);

    // Filtro janela -7 a +60 dias (alargado pra pegar cancelamentos recentes)
    const hoje = new Date();
    const dataMin = new Date(hoje.getTime() - 7 * 86400000);
    const dataMax = new Date(hoje.getTime() + 60 * 86400000);

    const elegiveis: any[] = [];
    for (const h of listaHospedin) {
      const checkin = brToISO(h.check_in);
      const checkout = brToISO(h.check_out);
      if (!checkin || !checkout) continue;
      const dtCheckin = new Date(checkin + "T12:00:00");
      const dtCheckout = new Date(checkout + "T12:00:00");
      if (dtCheckout < dataMin || dtCheckin > dataMax) continue;
      const cama = HOSPEDIN_PLACE_TO_CAMA[String(h.place_id)] || null;
      if (!cama) continue;
      elegiveis.push({ ...h, _checkin: checkin, _checkout: checkout, _cama: cama });
    }
    console.log(`[main] elegiveis: ${elegiveis.length} (de ${totalHospedin})`);

    ondeParou = "carregar_existentes";
    const idsHospedin = elegiveis.map((e) => String(e.id));
    const codes = elegiveis.map((e) => e.code).filter(Boolean);

    const tQ = Date.now();
    const { data: existentes, error: errEx } = await sb
      .from("reservas")
      .select("id, checkin, checkout, status, status_hospedin, cama, valor_total, hospede_nome, hospedin_id, codigo_externo, cancelado_em")
      .or(`hospedin_id.in.(${idsHospedin.join(",")}),codigo_externo.in.(${codes.map((c) => `"${c}"`).join(",")})`);
    if (errEx) throw new Error(`Erro carregando existentes: ${errEx.message}`);
    console.log(`[main] existentes carregados: ${(existentes || []).length} em ${Date.now() - tQ}ms`);

    const porHospedinId: Record<string, any> = {};
    const porCodigo: Record<string, any> = {};
    for (const r of existentes || []) {
      if (r.hospedin_id) porHospedinId[String(r.hospedin_id)] = r;
      if (r.codigo_externo) porCodigo[r.codigo_externo] = r;
    }

    // PRIORIDADE (10/06/2026): reservas NOVAS (sem match no DG) processam primeiro.
    // Antes a ordem era a da API e o corte de 30 deixava novas de fora pra sempre.
    elegiveis.sort((a: any, b: any) => {
      const aExiste = (porHospedinId[String(a.id)] || (a.code && porCodigo[a.code])) ? 1 : 0;
      const bExiste = (porHospedinId[String(b.id)] || (b.code && porCodigo[b.code])) ? 1 : 0;
      return aExiste - bExiste;
    });

    ondeParou = "loop_processamento";
    console.log(`[main] loop (limite ${MAX_RESERVAS_POR_EXECUCAO})`);

    for (const h of elegiveis) {
      if (stats.processadas >= MAX_RESERVAS_POR_EXECUCAO) {
        console.log(`[main] limite ${MAX_RESERVAS_POR_EXECUCAO} atingido, parando`);
        break;
      }

      try {
        const checkin = h._checkin;
        const checkout = h._checkout;
        const cama = h._cama;
        const { plataforma, canal } = detectarPlataforma(h.code);
        const hospedinId = String(h.id);
        const code = h.code || null;
        const nome = (h.guest_name || h.guest?.name || h.full_name || "Hospede Hospedin").trim();
        // GUARD anti-corrupcao (10/06/2026): full_name pode vir como "VD:001682 - Individual 3 - <guest>".
        // Se o guest real esta vazio, NUNCA sobrescrever nome local com o codigo.
        const rawGuest = String(h.guest_name || (h.guest && h.guest.name) || "").trim();
        let nomeReal = nome;
        if (!rawGuest && /^[A-Z]{2}:\d+/.test(nomeReal)) {
          // remove o prefixo "VD:001234 - " e depois o nome do lugar (que pode conter " - ")
          nomeReal = nomeReal.replace(/^[A-Z]{2}:\d+\s*-\s*/, "");
          const placeNome = String(h.place_name || "").trim();
          if (placeNome && nomeReal.startsWith(placeNome)) {
            nomeReal = nomeReal.slice(placeNome.length).replace(/^\s*-\s*/, "").trim();
          }
          // sobras tipo "Cama 7 -" ou só hifens nao sao nome
          if (/^(cama\s*\d*\s*-?\s*)$/i.test(nomeReal) || /^[-\s]*$/.test(nomeReal)) nomeReal = "";
        }
        const nomeEhReal = !!nomeReal && !/^[A-Z]{2}:\d+/.test(nomeReal);
        const tel = (h.guest_phone || h.guest?.phone || "").trim();
        // ============================================================
        // FIX BUG R$ 0,00 (Fukuya 24/05/2026):
        // Os campos h.total_value e h.daily_total NÃO existem na API
        // Hospedin. Os corretos (documentados em hospedin_api_mapa_completo.md)
        // são: total_amount, total_to_receive, total_amount_cents (em centavos),
        // total_daily_cents, daily_cents.
        // Tentativa em ordem de preferência. Se nada vier, NULL (não 0)
        // pra evidenciar que precisa ser preenchido manualmente.
        // ============================================================
        let valorTotal: number | null = null;
        if (h.total_amount != null && Number(h.total_amount) > 0) {
          valorTotal = Number(h.total_amount);
        } else if (h.total_to_receive != null && Number(h.total_to_receive) > 0) {
          valorTotal = Number(h.total_to_receive);
        } else if (h.total_amount_cents != null && Number(h.total_amount_cents) > 0) {
          valorTotal = Number(h.total_amount_cents) / 100;
        } else if (h.total_daily_cents != null && Number(h.total_daily_cents) > 0) {
          valorTotal = Number(h.total_daily_cents) / 100;
        } else if (h.daily_cents != null && Number(h.daily_cents) > 0) {
          // daily_cents é por noite — multiplicar pelo nº de noites real (checkin/checkout)
          // FIX: h._noites nunca era setado no preprocessamento, sempre caía no fallback 1
          const noitesCalc = Math.max(1, Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86400000));
          valorTotal = (Number(h.daily_cents) / 100) * noitesCalc;
        } else if (h.total_value != null && Number(h.total_value) > 0) {
          // legado — manter por segurança caso Hospedin volte a usar
          valorTotal = Number(h.total_value);
        } else if (h.daily_total != null && Number(h.daily_total) > 0) {
          valorTotal = Number(h.daily_total);
        }

        // FALLBACK PRINCIPAL 11/06/2026: API V2 individual tem os totais (em CENTAVOS)
        if ((valorTotal === null || !Number.isFinite(valorTotal) || valorTotal <= 0) && v2jwt) {
          try {
            const rV2 = await fetchComTimeout(`https://pms-api.hospedin.com/api/v2/23949/reservations/${hospedinId}`,
              { headers: { Authorization: `Bearer ${v2jwt}`, accept: "application/json" } }, 12000, `v2-${hospedinId}`);
            if (rV2.ok) {
              const dV2 = await rV2.json().catch(() => ({}));
              const hh = dV2.reservation || dV2.data || dV2;
              const cents = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n / 100 : null; };
              valorTotal = cents(hh.total_amount) || cents(hh.total_to_receive) || cents(hh.total_daily_cents) || null;
              if (!valorTotal && cents(hh.daily_cents)) {
                const noitesV2 = Math.max(1, Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86400000));
                valorTotal = Math.round(cents(hh.daily_cents)! * noitesV2 * 100) / 100;
              }
              if (valorTotal) console.log(`[sync-pull] valor via API V2 ${hospedinId}: R$ ${valorTotal}`);
            }
          } catch (eV2: any) { console.warn(`[sync-pull] V2 falhou ${hospedinId}: ${eV2.message}`); }
        }

        // diaria praticada (renovacao usa) = total / noites
        const noitesDiaria = Math.max(1, Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86400000));
        const diariaCalc = (valorTotal && valorTotal > 0) ? Math.round((valorTotal / noitesDiaria) * 100) / 100 : null;

        // FALLBACK 25/05/2026: Booking e Airbnb não retornam total no JSON da lista.
        // Faz fetch /edit/{id} pra pegar o campo input[name="reservation[daily]"].
        // Booking: aplica -13% (comissão). Airbnb: cheio.
        if ((valorTotal === null || !Number.isFinite(valorTotal) || valorTotal <= 0)
            && (plataforma === "Booking" || plataforma === "Airbnb")) {
          try {
            const noites = Math.max(1, Math.round((new Date(checkout).getTime() - new Date(checkin).getTime()) / 86400000));
            const rEdit = await fetchComTimeout(
              `${HOSPEDIN_BASE}/${HOSPEDIN_SLUG}/reservations/${hospedinId}/edit`,
              { headers: { Cookie: cookie, accept: "text/html" } },
              15000,
              `edit-${hospedinId}`
            );
            if (rEdit.ok) {
              const html = await rEdit.text();
              const m = html.match(/name="reservation\[daily\]"[^>]*value="([^"]+)"/);
              if (m && m[1]) {
                const dailyStr = m[1].replace(/\./g, "").replace(",", ".");
                const daily = parseFloat(dailyStr);
                if (Number.isFinite(daily) && daily > 0) {
                  const bruto = daily * noites;
                  const comissao = plataforma === "Booking" ? 0.13 : 0;
                  valorTotal = Math.round(bruto * (1 - comissao) * 100) / 100;
                  console.log(`[sync-pull] valor /edit ${hospedinId} ${plataforma}: daily=${daily} × ${noites}n = bruto R$ ${bruto.toFixed(2)} → líquido R$ ${valorTotal} (com=${comissao*100}%)`);
                }
              }
            }
          } catch (eEdit: any) {
            console.warn(`[sync-pull] erro pegando /edit pra ${hospedinId}: ${eEdit.message}`);
          }
        }

        // Se ainda for null, deixa como null (não 0) pra UI sinalizar
        if (valorTotal === null || !Number.isFinite(valorTotal) || valorTotal <= 0) {
          console.warn(`[sync-pull] valor_total não encontrado pra reserva ${hospedinId} (${nome}). Campos disponíveis:`, Object.keys(h).filter(k => k.includes('total') || k.includes('value') || k.includes('amount') || k.includes('cents') || k.includes('daily')).join(', '));
          valorTotal = null as any;
        }
        const statusHospedin = h.status || null;
        const statusDGMapeado = mapearStatusHospedinParaDG(statusHospedin);

        const existente = porHospedinId[hospedinId] || (code ? porCodigo[code] : null);

        if (existente) {
          // Comparação cuidadosa de valor: só considera "mudou" se temos um
          // valor novo válido (>0) que difere. Não sobrescreve valor existente
          // com null (preserva valor manual que a Gabi pode ter corrigido).
          const valorExistenteNum = Number(existente.valor_total || 0);
          const valorMudou = (valorTotal !== null && valorTotal > 0 && valorExistenteNum !== valorTotal);

          const precisaUpdate =
            existente.checkin !== checkin ||
            existente.checkout !== checkout ||
            existente.cama !== cama ||
            valorMudou ||
            (nomeEhReal && (existente.hospede_nome || "").trim() !== nomeReal) ||
            (existente.status_hospedin || "") !== (statusHospedin || "") ||
            // Se hospedin marcou canceled e DG ainda não tá cancelada → precisa update
            (statusHospedin === "canceled" && existente.status !== "cancelada");

          if (precisaUpdate) {
            const updatePayload: Record<string, any> = {
              checkin,
              checkout,
              cama,
              quarto: cama,
              // Só sobrescreve valor_total se temos valor novo válido
              ...(valorTotal !== null && valorTotal > 0 ? { valor_total: valorTotal } : {}),
              ...(diariaCalc ? { valor_diaria: diariaCalc } : {}),
              ...(nomeEhReal ? { hospede_nome: nomeReal } : {}),
              hospedin_id: hospedinId,
              codigo_externo: code,
              plataforma,
              canal_codigo: canal,
              status_hospedin: statusHospedin,
              ultima_sync_hospedin: new Date().toISOString(),
              status_sync_hospedin: "sincronizada",
              // FIX 25/05/2026: incluir telefone no UPDATE
              // Antes só o INSERT colocava hospede_contato — UPDATE não sobrescrevia,
              // então reservas antigas ficavam sem telefone mesmo o Hospedin tendo.
              // Agora: se o Hospedin retornou tel, sobrescreve. Se vier vazio, mantém.
              ...(tel ? { hospede_contato: tel } : {}),
            };

            // Se Hospedin diz que cancelou, propaga
            if (statusHospedin === "canceled" && existente.status !== "cancelada") {
              updatePayload.status = "cancelada";
              if (!existente.cancelado_em) {
                updatePayload.cancelado_em = new Date().toISOString();
              }
              stats.canceladas++;
              acoes.push({ acao: "cancelada", dg_id: existente.id, hospedin_id: hospedinId, nome });
            } else if (statusDGMapeado && statusDGMapeado !== existente.status) {
              // Propaga qualquer mudança de status: reservation→confirmada, check_in→check-in, etc
              updatePayload.status = statusDGMapeado;
              stats.atualizadas++;
              acoes.push({ acao: "status_" + statusDGMapeado, dg_id: existente.id, hospedin_id: hospedinId, nome });
            } else {
              stats.atualizadas++;
              acoes.push({ acao: "atualizada", dg_id: existente.id, hospedin_id: hospedinId, nome });
            }

            await sb.from("reservas").update(updatePayload).eq("id", existente.id);
          } else {
            stats.inalteradas++;
          }
        } else {
          // Nova reserva (não existia no DG)
          // Se vier já cancelada, criar como cancelada
          const statusInicial =
            statusHospedin === "canceled" ? "cancelada" : statusDGMapeado || "pre_reserva";

          const insertPayload: Record<string, any> = {
            hospede_nome: nomeEhReal ? nomeReal : (nome || "Hospede Hospedin"),
            hospede_contato: tel,
            cama,
            quarto: cama,
            checkin,
            checkout,
            status: statusInicial,
            status_hospedin: statusHospedin,
            valor_total: (valorTotal !== null && valorTotal !== undefined) ? valorTotal : 0, // FIX 10/06: API sem valor NAO pode impedir a reserva de existir (caso Nicole Sena)
            ...(diariaCalc ? { valor_diaria: diariaCalc } : {}),
            plataforma,
            canal_codigo: canal,
            hospedin_id: hospedinId,
            codigo_externo: code,
            ultima_sync_hospedin: new Date().toISOString(),
            status_sync_hospedin: "sincronizada",
            observacoes: `Importada do Hospedin pelo sync pull em ${new Date().toISOString().slice(0, 10)}. JA_EXISTE_HOSPEDIN — nao duplicar.`,
          };
          if (statusHospedin === "canceled") {
            insertPayload.cancelado_em = new Date().toISOString();
          }

          const { data: nova, error: errInsert } = await sb
            .from("reservas")
            .insert(insertPayload)
            .select("id")
            .single();

          if (errInsert) {
            stats.erros++;
            erros.push({ hospedin_id: hospedinId, nome, erro: errInsert.message?.slice(0, 200) });
          } else {
            stats.novas++;
            acoes.push({ acao: "criada_no_dg", dg_id: nova?.id, hospedin_id: hospedinId, nome, cama, status: statusInicial });
          }
        }
        stats.processadas++;
      } catch (e: any) {
        stats.erros++;
        erros.push({ hospedin_id: h?.id, erro: (e.message || String(e)).slice(0, 200) });
      }
    }

    ondeParou = "fim";
    console.log(`[main] loop concluido em ${Date.now() - inicio}ms`);
  } catch (e: any) {
    console.log(`[main] erro fatal em ${ondeParou}: ${e.message}`);
    erros.push({ etapa: ondeParou, erro: (e.message || String(e)).slice(0, 300) });
  } finally {
    try {
      await sb.from("auditoria_sync_hospedin").insert({
        rodou_em: new Date().toISOString(),
        duracao_ms: Date.now() - inicio,
        stats: {
          ...stats,
          direcao: "pull_hospedin_pra_dg",
          versao: "v9_status_correto",
          total_hospedin: totalHospedin,
          onde_parou: ondeParou,
        },
        acoes: acoes.slice(0, 50),
        erros,
      });
      console.log("[main] auditoria gravada");
    } catch (e: any) {
      console.log(`[main] erro gravando auditoria: ${e.message}`);
    }
  }

  return new Response(
    JSON.stringify(
      { ok: erros.length === 0, duracao_ms: Date.now() - inicio, stats, ondeParou, acoes: acoes.slice(0, 30), erros },
      null,
      2
    ),
    { headers: { "Content-Type": "application/json" } }
  );
});
