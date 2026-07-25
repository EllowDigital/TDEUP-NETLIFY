// src/app/api/register/route.ts
import { NextRequest } from "next/server";
import { postRegister } from "../../../lib/api-handlers";

export async function POST(req: NextRequest) {
  return await postRegister(req);
}
