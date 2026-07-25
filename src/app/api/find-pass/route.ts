// src/app/api/find-pass/route.ts
import { NextRequest } from "next/server";
import { postFindPass } from "../../../lib/api-handlers";

export async function POST(req: NextRequest) {
  return await postFindPass(req);
}
