import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseSubscriptionCreateInput } from "@/lib/subscription-input";
import {
  normalizeMonthlyUsd,
  isSubscriptionInterval,
  type SubscriptionInterval,
} from "@/lib/subscriptions";

// GET /api/subscriptions — list every subscription with provider/project labels
// and a monthly-equivalent cost (so mixed cadences are comparable).
export async function GET() {
  try {
    const subscriptions = await prisma.subscription.findMany({
      orderBy: [{ status: "asc" }, { nextRenewalAt: "asc" }],
      include: {
        provider: { select: { id: true, name: true, displayName: true } },
        project: { select: { id: true, name: true } },
      },
    });

    const result = subscriptions.map((sub) => {
      const interval: SubscriptionInterval = isSubscriptionInterval(sub.interval)
        ? sub.interval
        : "monthly";
      return {
        id: sub.id,
        name: sub.name,
        description: sub.description,
        costUsd: sub.costUsd,
        currency: sub.currency,
        interval: sub.interval,
        intervalCount: sub.intervalCount,
        monthlyEquivalentUsd: normalizeMonthlyUsd(sub.costUsd, interval, sub.intervalCount),
        anchorDay: sub.anchorDay,
        startDate: sub.startDate.toISOString(),
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        nextRenewalAt: sub.nextRenewalAt.toISOString(),
        autoRenew: sub.autoRenew,
        status: sub.status,
        notes: sub.notes,
        provider: sub.provider,
        project: sub.project,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch subscriptions:", error);
    return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let input;
  try {
    input = parseSubscriptionCreateInput(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const provider = await prisma.provider.findUnique({ where: { id: input.providerId } });
  if (!provider) {
    return NextResponse.json({ error: "providerId does not match a known provider" }, { status: 400 });
  }
  if (input.projectId) {
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) {
      return NextResponse.json({ error: "projectId does not match a known project" }, { status: 400 });
    }
  }

  try {
    const subscription = await prisma.subscription.create({
      data: {
        providerId: input.providerId,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        costUsd: input.costUsd,
        currency: input.currency,
        interval: input.interval,
        intervalCount: input.intervalCount,
        anchorDay: input.anchorDay,
        startDate: input.startDate,
        currentPeriodStart: input.currentPeriodStart,
        nextRenewalAt: input.nextRenewalAt,
        autoRenew: input.autoRenew,
        status: input.status,
        notes: input.notes,
      },
    });
    return NextResponse.json(subscription, { status: 201 });
  } catch (error) {
    console.error("Failed to create subscription:", error);
    return NextResponse.json({ error: "Failed to create subscription" }, { status: 500 });
  }
}
