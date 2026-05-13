#!/bin/bash
# ============================================================
# VALIDAR-DEPLOY — proteção contra regressões
#
# Roda ANTES de qualquer git push pra garantir que:
#   1. Todos os HTMLs críticos estão íntegros (têm </html>, </body>)
#   2. Funções críticas existem no código (botão Entrar, engrenagem, etc)
#   3. Nenhum arquivo foi truncado no caminho
#
# Uso: bash validar-deploy.sh
# Sai com código 0 = OK pra deployar | código != 0 = NÃO deploya
# ============================================================

set -e
cd "$(dirname "$0")"
ERROS=0

ok()    { echo "  ✅ $1"; }
falha() { echo "  ❌ $1"; ERROS=$((ERROS+1)); }
sec()   { echo ""; echo "━━━ $1"; }

sec "1) Integridade dos HTMLs críticos"
for f in index.html reservar.html minha-conta.html dominhas.html cleaner.html pms.html check-in.html analytics.html audit-completo.html conferir-reservas.html; do
  if [ ! -f "$f" ]; then
    falha "$f não existe"
    continue
  fi
  if ! grep -q "</html>" "$f"; then
    falha "$f não tem </html>"
    continue
  fi
  if ! grep -q "</body>" "$f"; then
    falha "$f não tem </body>"
    continue
  fi
  ok "$f íntegro ($(wc -l < "$f") linhas)"
done

sec "2) Botões / funções críticas"
# index.html
grep -q 'login-texto.*Entrar' index.html && ok "index: botão Entrar do login" || falha "index: SEM botão Entrar"
grep -q 'mostrarModuloProtegido' index.html && ok "index: engrenagem (mostrarModuloProtegido)" || falha "index: SEM engrenagem"
grep -q 'function abrirLogin' index.html && ok "index: função abrirLogin" || falha "index: SEM função abrirLogin"
grep -q 'tentarLogin' index.html && ok "index: função tentarLogin" || falha "index: SEM função tentarLogin"

# reservar.html
grep -q 'function loginPraReservar\|function buscarH' reservar.html && ok "reservar: funções de login" || falha "reservar: SEM funções de login"
grep -q 'gerar_checkout_infinitepay' reservar.html && ok "reservar: integração InfinitePay" || falha "reservar: SEM InfinitePay"
grep -q 'preencherResumoPR' reservar.html && ok "reservar: função preencherResumoPR" || falha "reservar: SEM preencherResumoPR"

# cleaner.html
grep -q 'verificar_cleaner_login' cleaner.html && ok "cleaner: RPC de login" || falha "cleaner: SEM RPC de login"

# dominhas.html
grep -q 'verificar_dominha_login' dominhas.html && ok "dominhas: RPC de login moradora" || falha "dominhas: SEM RPC de login"

# minha-conta.html
grep -q 'verificar_login' minha-conta.html && ok "minha-conta: RPC de login" || falha "minha-conta: SEM RPC de login"

# lista-espera.html
grep -q 'lista_espera' lista-espera.html && ok "lista-espera: insert na tabela" || falha "lista-espera: SEM insert"

sec "3) Tamanho mínimo (detecta truncamento abrupto)"
# Limites mínimos esperados (linhas)
declare -A LIMITES=(
  [index.html]=18000
  [reservar.html]=2800
  [pms.html]=4000
  [minha-conta.html]=850
  [dominhas.html]=1100
  [cleaner.html]=1300
)
for arquivo in "${!LIMITES[@]}"; do
  esperado="${LIMITES[$arquivo]}"
  atual=$(wc -l < "$arquivo" 2>/dev/null || echo 0)
  if [ "$atual" -lt "$esperado" ]; then
    falha "$arquivo: $atual linhas (esperado: ≥ $esperado) — pode estar truncado!"
  else
    ok "$arquivo: $atual linhas"
  fi
done

sec "4) Tags HTML balanceadas (sanity check)"
for f in index.html reservar.html minha-conta.html dominhas.html cleaner.html pms.html; do
  abrir=$(grep -c '<body' "$f" 2>/dev/null || echo 0)
  fechar=$(grep -c '</body>' "$f" 2>/dev/null || echo 0)
  if [ "$abrir" -ne "$fechar" ]; then
    falha "$f: <body>=$abrir != </body>=$fechar"
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ERROS" -eq 0 ]; then
  echo "✅ TUDO OK — pode deployar com segurança"
  exit 0
else
  echo "❌ $ERROS erro(s) encontrados — DEPLOY BLOQUEADO"
  echo ""
  echo "Pra recuperar a versão estável anterior:"
  echo "  cd /tmp/domus-deploy"
  echo "  git reset --hard v1.0-estavel"
  echo "  git push --force origin main"
  exit 1
fi
