import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { parseProviderUpdateInput, readJsonBody } from "@/lib/provider-input";
import { buildProviderAlertState } from "@/lib/provider-alerts";
import { toPrismaProviderPlanData } from "@/lib/provider-plan";

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
      groupId: true,
      label: true,
      allocations: {
        select: {
          projectId: true,
          percentage: true,
        },
      },
      plan: true,
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
      createdAt: true,
    },
  });

  if (!provider) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { snapshots, ...rest } = provider;
  const latestSnapshot = snapshots[0] ?? null;
  const alertState = buildProviderAlertState({
    isActive: provider.isActive,
    refreshIntervalMin: provider.refreshIntervalMin,
    plan: provider.plan,
    latestSnapshot,
  });

  return NextResponse.json({
    ...rest,
    latestSnapshot,
    alerts: alertState.alerts,
    estimatedMonthlyCostUsd: alertState.estimatedMonthlyCostUsd,
    billingMode: alertState.billingMode,
  });
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

  let input;
  try {
    input = parseProviderUpdateInput(await readJsonBody(request));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const updateData: Prisma.ProviderUpdateInput = {};
  if (input.displayName !== undefined) updateData.displayName = input.displayName;
  if (input.config !== undefined) {
    updateData.config =
      input.config === null
        ? Prisma.JsonNull
        : (input.config as Prisma.InputJsonObject);
  }
  if (input.isActive !== undefined) updateData.isActive = input.isActive;
  if (input.refreshIntervalMin !== undefined) {
    updateData.refreshIntervalMin = input.refreshIntervalMin;
  }
  if (input.groupId !== undefined) updateData.groupId = input.groupId;
  if (input.label !== undefined) updateData.label = input.label;
  if (input.apiKey !== undefined) {
    updateData.apiKey = encrypt(input.apiKey);
  }
  if (input.plan !== undefined) {
    const planData = toPrismaProviderPlanData(input.plan);
    updateData.plan = {
      upsert: {
        create: planData,
        update: planData,
      },
    };
  }
  if (input.allocations !== undefined) {
    updateData.allocations = {
      deleteMany: {},
      create: input.allocations.map((a) => ({
        projectId: a.projectId,
        percentage: a.percentage,
      })),
    };
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
      groupId: true,
      label: true,
      allocations: {
        select: {
          projectId: true,
          percentage: true,
        },
      },
      plan: true,
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
