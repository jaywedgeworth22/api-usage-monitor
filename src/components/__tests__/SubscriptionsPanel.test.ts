import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SubscriptionsPanel from "@/components/SubscriptionsPanel";

describe("SubscriptionsPanel", () => {
  it("shows the effective expired state and known term end without changing stored status", () => {
    const html = renderToStaticMarkup(
      createElement(SubscriptionsPanel, {
        subscriptions: [
          {
            id: "ended",
            name: "Ended plan",
            description: null,
            costUsd: 10,
            currency: "USD",
            interval: "annual",
            intervalCount: 1,
            monthlyEquivalentUsd: 10 / 12,
            anchorDay: null,
            startDate: "2019-01-01T00:00:00.000Z",
            currentPeriodStart: "2019-01-01T00:00:00.000Z",
            nextRenewalAt: "2020-01-01T00:00:00.000Z",
            autoRenew: false,
            status: "active",
            effectiveStatus: "expired",
            notes: null,
            externalBillingSource: null,
            externalBillingId: null,
            knobEnv: null,
            freeTierKnobEnv: null,
            provider: { id: "provider", name: "demo", displayName: "Demo" },
            project: null,
          },
        ],
        onAdd: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        deleteConfirm: null,
        setDeleteConfirm: vi.fn(),
        actionLoading: null,
      })
    );

    expect(html).toContain("expired");
    expect(html).toContain("ended");
  });
});
