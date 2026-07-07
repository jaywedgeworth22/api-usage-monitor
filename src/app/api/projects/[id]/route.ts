import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/provider-input";

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const existing = await prisma.project.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const updateData: Prisma.ProjectUpdateInput = {};

  if (body.name !== undefined) {
    const name = cleanOptionalString(body.name);
    if (!name) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    // Reject a rename that case-collides with another project (see the create
    // route + project-resolver.ts for why case-insensitive uniqueness matters).
    // The unique `nameKey` column is the atomic guarantee; this is the friendly
    // pre-check. A P2002 from the update is caught below as a backstop.
    const nameKey = name.trim().toLowerCase();
    const others = await prisma.project.findMany({
      where: { id: { not: id } },
      select: { name: true },
    });
    if (others.some((p) => p.name.trim().toLowerCase() === nameKey)) {
      return NextResponse.json(
        { error: "Project name already exists (names are case-insensitive)" },
        { status: 409 }
      );
    }
    updateData.name = name;
    updateData.nameKey = nameKey;
  }

  if (body.description !== undefined) {
    updateData.description = cleanOptionalString(body.description) ?? null;
  }

  if (body.monthlyBudgetUsd !== undefined) {
    if (body.monthlyBudgetUsd === null) {
      updateData.monthlyBudgetUsd = null;
    } else {
      const budget = Number(body.monthlyBudgetUsd);
      if (!Number.isFinite(budget) || budget < 0) {
        return NextResponse.json({ error: "monthlyBudgetUsd must be a positive number" }, { status: 400 });
      }
      updateData.monthlyBudgetUsd = budget;
    }
  }

  try {
    const project = await prisma.project.update({
      where: { id },
      data: updateData,
    });
    return NextResponse.json(project);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as any).code === 'P2002') {
      return NextResponse.json({ error: "Project with this name already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const existing = await prisma.project.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
