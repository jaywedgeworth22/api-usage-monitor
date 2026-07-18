import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const providers = await prisma.provider.findMany();
  const getProvider = (name: string) => providers.find(p => p.name.toLowerCase() === name.toLowerCase());

  const openai = getProvider("openai");
  if (openai) {
    await prisma.subscription.create({
      data: {
        providerId: openai.id,
        name: "OpenAI ChatGPT Plus",
        costUsd: 20.0,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2024-01-01T00:00:00Z"),
        currentPeriodStart: new Date("2024-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2024-08-01T00:00:00Z"),
        autoRenew: true,
        status: "active",
      }
    });
  }

  const mistral = getProvider("mistral");
  if (mistral) {
    await prisma.subscription.create({
      data: {
        providerId: mistral.id,
        name: "Mistral Commercial",
        costUsd: 15.0,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2024-01-01T00:00:00Z"),
        currentPeriodStart: new Date("2024-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2024-08-01T00:00:00Z"),
        autoRenew: true,
        status: "active",
      }
    });
  }

  const google = getProvider("google-ai");
  if (google) {
    await prisma.subscription.create({
      data: {
        providerId: google.id,
        name: "Google Cloud AI",
        costUsd: 25.0,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: new Date("2024-01-01T00:00:00Z"),
        currentPeriodStart: new Date("2024-07-01T00:00:00Z"),
        nextRenewalAt: new Date("2024-08-01T00:00:00Z"),
        autoRenew: true,
        status: "active",
      }
    });
  }

  console.log("Subscriptions imported successfully.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
