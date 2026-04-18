#!/usr/bin/env bash
# =============================================================================
# OpenBrain — DigitalOcean setup script
# Tested on Ubuntu 22.04 / 24.04
#
# Usage:
#   # Interactive (prompts for all values):
#   bash setup.sh
#
#   # Non-interactive (set vars before running):
#   export DOMAIN="brain.example.com"
#   export PORT=3000
#   export DB_PASS="$(openssl rand -hex 16)"
#   export OPENROUTER_API_KEY="sk-or-v1-..."
#   export DISCORD_PUBLIC_KEY="abc123..."
#   export MCP_ACCESS_KEY="$(openssl rand -hex 32)"
#   bash setup.sh
# =============================================================================
set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── Must run as root ───────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run this script as root (e.g. sudo bash setup.sh)"

# Use the terminal for prompts when this script is piped to bash.
PROMPT_TTY=""
[[ -r /dev/tty ]] && PROMPT_TTY="/dev/tty"

# ── Configuration — override via env or answer prompts ────────────────────────
prompt_read() {
  local varname="$1" prompt="$2" default="$3" secret="${4:-}" val=""
  if [[ -z "$PROMPT_TTY" ]]; then
    if [[ -n "$default" ]]; then
      val="$default"
      warn "No interactive terminal detected; using default for ${varname}."
    else
      die "${varname} is required when running non-interactively. Export ${varname} before running setup.sh."
    fi
  else
    if [[ -n "$secret" ]]; then
      read -rsp "$prompt [${default}]: " val < "$PROMPT_TTY"
      echo
    else
      read -rp "$prompt [${default}]: " val < "$PROMPT_TTY"
    fi
    val="${val:-$default}"
  fi
  printf -v "$varname" '%s' "$val"
}

prompt_if_empty() {
  local varname="$1" prompt="$2" default="$3" secret="${4:-}"
  if [[ -z "${!varname:-}" ]]; then
    prompt_read "$varname" "$prompt" "$default" "$secret"
  fi
}

echo ""
echo "============================================================"
echo "  OpenBrain — DigitalOcean installer"
echo "============================================================"
echo ""

REPO_URL="${REPO_URL:-https://github.com/itsMattShull/openbrain-do.git}"
APP_DIR="${APP_DIR:-/var/www/openbrain}"
DB_NAME="${DB_NAME:-openbrain}"
DB_USER="${DB_USER:-openbrain}"

prompt_if_empty DOMAIN         "Domain or server IP (e.g. brain.example.com or 1.2.3.4)" "$(curl -s ifconfig.me 2>/dev/null || echo '127.0.0.1')"
prompt_if_empty PORT           "Express app port" "3000"
prompt_if_empty DB_PASS        "PostgreSQL password for user '${DB_USER}'" "$(openssl rand -hex 16)" secret
prompt_if_empty OPENROUTER_API_KEY   "OpenRouter API key" ""
prompt_if_empty DISCORD_PUBLIC_KEY   "Discord application public key (hex)" ""
prompt_if_empty MCP_ACCESS_KEY       "MCP access key (leave blank to auto-generate)" "$(openssl rand -hex 32)"

[[ -n "$OPENROUTER_API_KEY" ]] || die "OPENROUTER_API_KEY is required"
[[ -n "$DISCORD_PUBLIC_KEY" ]] || die "DISCORD_PUBLIC_KEY is required"
[[ -n "$MCP_ACCESS_KEY"     ]] || die "MCP_ACCESS_KEY is required"

SETUP_SSL="no"
# Only offer SSL if DOMAIN looks like a hostname (not an IP)
if [[ "$DOMAIN" =~ ^[a-zA-Z] ]]; then
  prompt_read ssl_choice "Set up SSL with Let's Encrypt? (y/n)" "y"
  [[ "$ssl_choice" == "y" ]] && SETUP_SSL="yes"
fi

echo ""
info "Configuration summary:"
echo "  Repo:     $REPO_URL"
echo "  App dir:  $APP_DIR"
echo "  Domain:   $DOMAIN"
echo "  Port:     $PORT"
echo "  DB name:  $DB_NAME  (user: $DB_USER)"
echo "  SSL:      $SETUP_SSL"
echo ""
prompt_read confirm "Proceed? (y/n)" "y"
[[ "$confirm" == "y" ]] || { info "Aborted."; exit 0; }

# ── System packages ────────────────────────────────────────────────────────────
info "Updating package lists..."
apt-get update -qq

info "Installing base dependencies..."
apt-get install -y -qq curl git nginx certbot python3-certbot-nginx \
  postgresql postgresql-contrib lsb-release ca-certificates gnupg

# ── Node.js 20 (via NodeSource) ────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  info "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
success "Node.js $(node --version)"

# ── pgvector extension ─────────────────────────────────────────────────────────
PG_VERSION=$(pg_lsclusters -h | awk '{print $1}' | head -1)
info "Installing pgvector for PostgreSQL ${PG_VERSION}..."
if ! apt-get install -y -qq "postgresql-${PG_VERSION}-pgvector" 2>/dev/null; then
  # Fallback: build from source
  warn "Package not found, building pgvector from source..."
  apt-get install -y -qq build-essential "postgresql-server-dev-${PG_VERSION}" git
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://github.com/pgvector/pgvector.git "$tmpdir/pgvector"
  make -C "$tmpdir/pgvector" -j"$(nproc)"
  make -C "$tmpdir/pgvector" install
  rm -rf "$tmpdir"
fi
success "pgvector installed"

# ── PM2 (process manager) ──────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "Installing PM2..."
  npm install -g pm2 --quiet
fi
success "PM2 $(pm2 --version)"

# ── PostgreSQL — database & user ───────────────────────────────────────────────
info "Configuring PostgreSQL..."
systemctl enable postgresql
systemctl start postgresql

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" \
  | grep -q 1 || sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" \
  | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

success "PostgreSQL database '${DB_NAME}' ready"

# ── PostgreSQL extensions (must be created by superuser) ───────────────────────
info "Enabling PostgreSQL extensions..."
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;"
success "Extension 'vector' enabled in '${DB_NAME}'"

# ── Clone / update the application ────────────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
  info "Updating existing install at ${APP_DIR}..."
  git -C "$APP_DIR" pull --ff-only
else
  info "Cloning ${REPO_URL} → ${APP_DIR}..."
  git clone "$REPO_URL" "$APP_DIR"
fi

# ── npm install ────────────────────────────────────────────────────────────────
info "Installing npm dependencies..."
npm install --prefix "$APP_DIR" --omit=dev --quiet
success "Dependencies installed"

# ── Environment file ───────────────────────────────────────────────────────────
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"

cat > "${APP_DIR}/.env" <<EOF
PORT=${PORT}
DATABASE_URL=${DATABASE_URL}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
DISCORD_PUBLIC_KEY=${DISCORD_PUBLIC_KEY}
MCP_ACCESS_KEY=${MCP_ACCESS_KEY}
EOF
chmod 600 "${APP_DIR}/.env"
success ".env written to ${APP_DIR}/.env"

# ── Run database schema ────────────────────────────────────────────────────────
info "Applying database schema..."
# Force TCP so PostgreSQL uses password auth instead of local peer auth.
PGPASSWORD="$DB_PASS" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -f "${APP_DIR}/sql/schema.sql"
success "Schema applied"

# ── Apply migrations in order ──────────────────────────────────────────────────
# schema.sql uses CREATE TABLE IF NOT EXISTS, so pre-existing tables never pick
# up newly added columns. Apply every migration (all idempotent) so upgraded
# installs stay in sync with the current schema.
if compgen -G "${APP_DIR}/sql/migrations/*.sql" > /dev/null; then
  info "Applying database migrations..."
  for migration in "${APP_DIR}"/sql/migrations/*.sql; do
    info "  → $(basename "$migration")"
    PGPASSWORD="$DB_PASS" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -f "$migration"
  done
  success "Migrations applied"
fi

# ── PM2 log directory ──────────────────────────────────────────────────────────
mkdir -p /var/log/openbrain
chown -R "$(logname 2>/dev/null || echo root)":root /var/log/openbrain 2>/dev/null || true

# ── nginx configuration ────────────────────────────────────────────────────────
info "Configuring nginx..."
NGINX_CONF="/etc/nginx/sites-available/openbrain"
sed \
  -e "s|{{SERVER_NAME}}|${DOMAIN}|g" \
  -e "s|{{APP_PORT}}|${PORT}|g" \
  "${APP_DIR}/nginx.conf.template" > "$NGINX_CONF"

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/openbrain
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t
systemctl enable nginx
systemctl reload nginx
success "nginx configured for ${DOMAIN}"

# ── Optional SSL via Let's Encrypt ────────────────────────────────────────────
if [[ "$SETUP_SSL" == "yes" ]]; then
  info "Requesting Let's Encrypt certificate for ${DOMAIN}..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect
  success "SSL certificate installed"
fi

# ── Start application with PM2 ─────────────────────────────────────────────────
info "Starting OpenBrain with PM2..."
cd "$APP_DIR"
pm2 delete openbrain 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# Enable PM2 to start on boot
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root || true
pm2 save
success "OpenBrain is running"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo -e "${GREEN}  OpenBrain is live!${NC}"
echo "============================================================"
echo ""
echo "  Ingest (Discord webhook):  http${SETUP_SSL/#yes/s}://${DOMAIN}/ingest"
echo "  MCP endpoint:              http${SETUP_SSL/#yes/s}://${DOMAIN}/mcp"
echo "  Health check:              http${SETUP_SSL/#yes/s}://${DOMAIN}/health"
echo ""
echo "  MCP access key:   ${MCP_ACCESS_KEY}"
echo ""
echo "  View logs:   pm2 logs openbrain"
echo "  Restart:     pm2 restart openbrain"
echo "  Status:      pm2 status"
echo ""
echo "  Next step: register ${DOMAIN}/ingest as your Discord"
echo "  application Interactions Endpoint URL."
echo ""
