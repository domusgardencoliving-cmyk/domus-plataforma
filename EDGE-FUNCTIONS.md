# Edge Functions deployadas no Supabase

Inventário em 21/05/2026. **22 funções ACTIVE.**

## ⚠️ Aviso sobre versionamento

Algumas funções foram editadas direto no painel do Supabase Dashboard,
sem subir o source pro GitHub. O conteúdo retornado pela API é o **bundle**
(com dependências inline), que pode chegar a vários MB. Pra essas, o "source
de verdade" só existe no painel — **não dê push sobrescrevendo o arquivo do
repo achando que tá atualizando**.

## Funções com source no repo

| Slug | Source | Notas |
|---|---|---|
| ical-poll-booking | `edge_ical_poll_booking.ts` | Cron 5min |
| ical-poll-airbnb | `edge_ical_poll_airbnb.ts` | Cron 5min |
| ical-poll-webquartos | `edge_ical_poll_webquartos.ts` | Cron 5min |
| sync-completo-hospedin-pull | `edge_sync_completo_hospedin_pull.ts` | Cron 5min |
| sync-completo-hospedin-push | `edge_sync_completo_hospedin_push.ts` | Cron 1min |
| inter-emit-boleto | `edge_inter_emit_boleto.ts` | ⚠️ Versão deployada (556KB) é MAIOR que o repo (6KB) — alguém editou direto |
| enviar-voucher-email | `voucher_email_edge_function.ts` | |
| notificar-contrato-novo | `edge_notificar_contrato_novo.ts` | |
| webhook-zapsign | `edge_webhook_zapsign.ts` | |
| processar-aprovacao-contrato | `edge_processar_aprovacao_contrato.ts` | |
| pos-assinatura-contrato | `edge_pos_assinatura_contrato.ts` | |
| baixar-pdf-boleto | `edge_baixar_pdf_boleto.ts` | **NOVA 21/05** — wrapper com CORS pra Portal Dominhas |
| cancelar-e-reemitir-boleto | `edge_cancelar_e_reemitir_boleto.ts` | **NOVA 21/05** |
| send-whatsapp-fila | `edge_send_whatsapp_fila_v2.ts` | **NOVA 21/05** — v2 sem dependência supabase-js |

## Funções SEM source no repo (editadas direto no painel)

| Slug | Tamanho deployado | Função | Status |
|---|---|---|---|
| whatsapp-webhook | 535 KB | Webhook do Meta recebendo mensagens inbound | Ativa |
| sync-hospedin-names | **9 MB** | Sync nomes hóspedes | Ativa (esquisito tamanho) |
| quick-action | 107 KB | ??? | Ativa |
| test-meta-send | 4 KB | Teste envio Meta | Ativa |
| test-meta-debug | 5 KB | Debug Meta | Ativa |
| inspecionar-hospedin | 12 KB | Diagnóstico Hospedin | Ativa |
| ocr-notas | 12 KB | OCR de notas fiscais (mini mercado) | Ativa |
| webhook-infinitepay | 331 KB | Webhook InfinitePay | Ativa |

**Recomendação**: pras pequenas (≤15 KB), abrir cada uma no painel
Dashboard → Edge Functions → escolher a função → ver source → copiar
pra um arquivo `edge_<slug>.ts` no repo. Pras grandes (>100 KB), provavelmente
estão usando dependências do esm.sh bundled — manter o source no painel.

## Crons que disparam estas Edge Functions

| Cron | Frequência | Chama | Status |
|---|---|---|---|
| ical-poll-airbnb-cron | 5min | ical-poll-airbnb | OK |
| ical-poll-booking-cron | 5min | ical-poll-booking | OK |
| ical-poll-webquartos | 5min | ical-poll-webquartos | OK |
| sync-completo-pull | 5min | sync-completo-hospedin-pull | OK |
| sync-completo-push | 1min | sync-completo-hospedin-push | OK |
| sync-nomes-hospedin | 5min | sync-hospedin-names | OK |
| send-whatsapp-fila-5min | 5min | send-whatsapp-fila | ⏸️ **PAUSADO** até renovar WHATSAPP_TOKEN |

## Outros crons (não disparam Edge Function)

| Cron | Frequência | Função SQL |
|---|---|---|
| backup_diario_3h | diário 6h UTC | backup_diario_completo |
| fichas-omo-diario | diário 7h UTC | atualizar_fichas_omo |
| gerar_tarefas_limpeza_diario | diário 10h UTC | gerar_tarefas_limpeza |
| lembretes_boletos_dominhas_9h | diário 12h UTC | lembrar_boletos_dominhas |
| notificar_checkin_checkout_diario | diário 11h UTC | notificar_checkin_checkout |
| processar_fila_mensagens_5min | 5min | processar_fila_mensagens (move pendente→pronto) |
| processar-reservas-pendentes | 5min | processar_reservas_pendentes (cancela pré-reservas de 60-90min) |
| purgar_backups_4h | diário 7h UTC | purgar_backups_antigos |
| **purgar_logs_antigos_diario** | **diário 7h UTC** | **purgar_logs_antigos (NOVO 21/05)** |
