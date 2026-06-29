import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt } from "@/lib/crypto";

function buildKeyPreview(encryptedKey: string | null): string | null {
  if (!encryptedKey) return null;
  try {
    const decrypted = decrypt(encryptedKey);
    if (decrypted.length <= 10) return null;
    const first = decrypted.slice(0, 6);
    const last = decrypted.slice(-4);
    return `${first}...${last}`;
  } catch {
    return null;
  }
}

export async function GET() {
  const providers = await prisma.provider.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      isActive: true,
      refreshIntervalMin: true,
      groupId: true,
      label: true,
      apiKey: true,
      createdAt: true,
      snapshots: {
        orderBy: { fetchedAt: "desc" },
        take: 1,
        select: {
          balance: true,
          totalCost: true,
          totalRequests: true,
          credits: true,
          fetchedAt: true,
        },
      },
    },
  });

  // Flatten latest snapshot into the provider object
  const result = providers.map((p) => {
    const { snapshots, apiKey, ...rest } = p;
    return {
      ...rest,
      keyPreview: buildKeyPreview(apiKey),
      latestSnapshot: snapshots[0] ?? null,
    };
  });

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  const {
    name,
    displayName,
    type = "builtin",
    apiKey,
    config,
    refreshIntervalMin,
    groupId: bodyGroupId,
    label,
  } = body;

  if (!name || !displayName) {
    return NextResponse.json(
      { error: "name and displayName are required" },
      { status: 400 }
    );
  }

  let groupId = bodyGroupId ?? undefined;

  if (!groupId) {
    const existingWithSameName = await prisma.provider.findFirst({
      where: { name },
      orderBy: { createdAt: "asc" },
    });

    if (existingWithSameName) {
      if (existingWithSameName.groupId) {
        groupId = existingWithSameName.groupId;
      } else {
        groupId = name;
        await prisma.provider.updateMany({
          where: { name, groupId: null },
          data: { groupId },
        });
      }
    }
  }

  const encryptedKey = apiKey ? encrypt(apiKey) : null;

  const provider = await prisma.provider.create({
    data: {
      name,
      displayName,
      type,
      apiKey: encryptedKey,
      config: config ?? undefined,
      refreshIntervalMin: refreshIntervalMin ?? 60,
      groupId,
      label,
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      isActive: true,
      refreshIntervalMin: true,
      groupId: true,
      label: true,
      createdAt: true,
    },
  });

  return NextResponse.json(provider, { status: 201 });
}
