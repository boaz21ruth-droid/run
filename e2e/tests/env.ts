export const USER_URL = process.env.E2E_USER_URL ?? "http://werun.localhost";
export const ADMIN_URL = process.env.E2E_ADMIN_URL ?? "http://admin.werun.localhost";

export const OPS = {
  username: "ops.e2e",
  password: process.env.E2E_OPS_PASSWORD ?? "e2e-Ops-Password-1",
};

export const ADMIN = {
  username: "admin.e2e",
  password: process.env.E2E_ADMIN_PASSWORD ?? "e2e-Admin-Password-1",
};
