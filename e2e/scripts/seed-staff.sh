#!/usr/bin/env bash
# 在已启动的 deploy/compose.yaml 环境里创建端到端测试账号。可重复执行。
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE=(docker compose -f deploy/compose.yaml --env-file .env)
OPS_PASSWORD="${E2E_OPS_PASSWORD:-e2e-Ops-Password-1}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-e2e-Admin-Password-1}"
FINANCE_PASSWORD="${E2E_FINANCE_PASSWORD:-e2e-Finance-Password-1}"

staff_exists() {
  local username="$1"
  "${COMPOSE[@]}" exec -T postgres \
    psql -U werun -d werun -tAc "SELECT 1 FROM staff WHERE username = '${username}'" | grep -q '^1$'
}

create_staff() {
  local username="$1" full_name="$2" role="$3" password="$4"
  if staff_exists "$username"; then
    echo "skip ${username}: already exists"
    return
  fi
  printf '%s\n' "$password" | "${COMPOSE[@]}" exec -T api /werun create-staff \
    --username "$username" --full-name "$full_name" --role "$role" --password-stdin
  echo "created ${username} (${role})"
}

create_staff ops.e2e "OPS E2E" OPS "$OPS_PASSWORD"
create_staff admin.e2e "ADMIN E2E" ADMIN "$ADMIN_PASSWORD"
create_staff finance.e2e "FINANCE E2E" FINANCE "$FINANCE_PASSWORD"
