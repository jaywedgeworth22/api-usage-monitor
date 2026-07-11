import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeProjectBudgetStatus } from "@/lib/budget-status";

export async function GET() {
  try {
    const status = await computeProjectBudgetStatus();
    return NextResponse.json(status.projects);
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, description, monthlyBudgetUsd } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Project name is required" },
        { status: 400 }
      );
    }

    // Case-insensitive uniqueness: Project.name is only BINARY-unique in SQLite,
    // but project attribution resolves producer-supplied names case-insensitively
    // (project-resolver.ts). Allowing "Foo" and "foo" to coexist would make that
    // resolution ambiguous. The app-level check gives a friendly message; the
    // unique `nameKey` column is the real guarantee (it closes the race two
    // app-level checks can't — both would pass, but the second insert fails).
    const nameKey = String(name).trim().toLowerCase();
    const existing = await prisma.project.findMany({ select: { name: true } });
    if (existing.some((p) => p.name.trim().toLowerCase() === nameKey)) {
      return NextResponse.json(
        { error: "Project name already exists (names are case-insensitive)" },
        { status: 400 }
      );
    }

    const project = await prisma.project.create({
      data: {
        name,
        nameKey,
        description,
        monthlyBudgetUsd,
      },
    });

    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "Project name already exists (names are case-insensitive)" },
        { status: 409 }
      );
    }
    console.error("Failed to create project:", error);
    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 }
    );
  }
}
