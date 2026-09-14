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
