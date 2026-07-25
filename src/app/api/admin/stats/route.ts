// src/app/api/admin/stats/route.ts
import { NextRequest } from "next/server";
import { getAdminStats } from "../../../../lib/api-handlers";

export async function GET(req: NextRequest) {
  return await getAdminStats();
}
