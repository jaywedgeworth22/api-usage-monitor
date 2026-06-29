import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const provider = await prisma.provider.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      isActive: true,
      config: true,
      refreshIntervalMin: true,
      createdAt: true,
    },
  });

  if (!provider) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(provider);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const existing = await prisma.provider.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { displayName, apiKey, config, isActive, refreshIntervalMin } = body;

  const updateData: Record<string, unknown> = {};
  if (displayName !== undefined) updateData.displayName = displayName;
  if (config !== undefined) updateData.config = config;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (refreshIntervalMin !== undefined)
    updateData.refreshIntervalMin = refreshIntervalMin;
  if (apiKey !== undefined && apiKey !== "") {
    updateData.apiKey = encrypt(apiKey);
  }

  const provider = await prisma.provider.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      isActive: true,
      refreshIntervalMin: true,
      createdAt: true,
    },
  });

  return NextResponse.json(provider);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const existing = await prisma.provider.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.provider.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
