//src/app/api/admin/export/route.ts
import { NextRequest } from "next/server";
import { getAdminExport } from "../../../../lib/api-handlers";

export async function GET(req: NextRequest) {
  return await getAdminExport(req);
}
