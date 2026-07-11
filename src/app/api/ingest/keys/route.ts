import { NextRequest, NextResponse } from "next/server";
import { isUsageIngestAuthorized } from "@/lib/ingest-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!process.env.USAGE_INGEST_TOKEN?.trim()) {
    return NextResponse.json({ error: "Usage ingest is not configured" }, { status: 503 });
  }

  if (!isUsageIngestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { provider, keys } = body;
  
  if (!provider || typeof provider !== "string") {
    return NextResponse.json({ error: "Missing provider name" }, { status: 400 });
  }

  const normalizedProviderName = provider.trim().toLowerCase();

  // Find existing provider (case-insensitive)
  const existingProviders = await prisma.provider.findMany();
  const matchedProvider = existingProviders.find(
    (p) => p.name.toLowerCase() === normalizedProviderName || p.displayName.toLowerCase() === normalizedProviderName
  );

  if (matchedProvider) {
    await prisma.provider.update({
      where: { id: matchedProvider.id },
      data: {
        config: {
          ...(typeof matchedProvider.config === "object" && matchedProvider.config !== null ? matchedProvider.config : {}),
          ...keys
        }
      }
    });
  } else {
    // Create new provider if it doesn't exist
    await prisma.provider.create({
      data: {
        name: normalizedProviderName,
        displayName: provider.trim(),
        type: "builtin",
        config: keys
      }
    });
  }

  return NextResponse.json({ ok: true, message: "Keys synced successfully" }, { status: 200 });
}
