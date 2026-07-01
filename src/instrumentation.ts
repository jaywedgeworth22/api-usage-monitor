export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
  startUsagePollingScheduler();
}
