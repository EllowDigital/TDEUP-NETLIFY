// src/app/api/admin/sync/route.ts
import { NextRequest } from "next/server";
import { postAdminSync } from "../../../../lib/api-handlers";

export async function POST(req: NextRequest) {
  // If your postAdminSync function doesn't require the req object,
  // you can just call it empty like this, but NextRequest still needs to be in the signature.
  return await postAdminSync();
}
