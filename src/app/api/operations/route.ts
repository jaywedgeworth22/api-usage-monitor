import { NextResponse } from "next/server";
import { fetchOperationsHealth } from "@/lib/operations-health";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await fetchOperationsHealth(), {
    headers: { "Cache-Control": "no-store" },
  });
}
