// src/app/api/check-in/route.ts
import { NextRequest } from "next/server";
import { postCheckIn } from "../../../lib/api-handlers";

export async function POST(req: NextRequest) {
  return await postCheckIn(req);
}
