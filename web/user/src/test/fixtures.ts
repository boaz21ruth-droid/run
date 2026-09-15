import type { Schemas } from "@werun/api-client";

export const halfMarathon: Schemas["PublicEvent"] = {
  slug: "phnom-penh-half-2026",
  name: "Phnom Penh Half Marathon 2026",
  city: "Phnom Penh",
  raceDate: "2026-11-15",
  categories: [
    {
      code: "21K",
      name: "Half marathon",
      distanceM: 21097,
      capacity: 800,
      startAt: "2026-11-14T23:00:00Z",
      cutoffAt: "2026-11-15T02:30:00Z",
    },
    {
      code: "10K",
      name: "Fun run",
      distanceM: 10000,
      capacity: 1200,
      startAt: "2026-11-14T23:30:00Z",
      cutoffAt: "2026-11-15T02:00:00Z",
    },
  ],
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function runnerSession(token = "tok-1"): Schemas["AppSession"] {
  return {
    token,
    expiresAt: "2099-01-01T00:00:00Z",
    user: { id: 1, telegramUserId: 10001, telegramUsername: "darasok", displayName: "Sok Dara", locale: "en" },
  };
}

export const daraProfile: Schemas["RunnerProfile"] = {
  id: 7,
  fullName: "Sok Dara",
  gender: "M",
  birthDate: "1990-05-01",
  nationality: "KH",
  idType: "NATIONAL_ID",
  idNoMasked: "******5678",
  phone: "+85512345678",
  email: "dara@example.com",
  emergencyName: "Sok Chenda",
  emergencyPhone: "+85598765432",
  tshirtSize: "M",
  isSelf: true,
};

type RouteHandler = (request: Request) => Response | Promise<Response>;

/** 按 "METHOD /api/path" 分发的假接口；遇到表里没有的请求直接抛错，便于发现多余请求 */
export function apiRoutes(table: Record<string, RouteHandler>): (request: Request) => Promise<Response> {
  return async (request) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handle = table[key];
    if (!handle) {
      throw new Error(`未预期的请求 ${key}`);
    }
    return handle(request);
  };
}
