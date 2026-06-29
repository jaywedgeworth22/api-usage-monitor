import {
  emptyResult,
  errorResult,
  fetchJson,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const projectId = config?.projectId as string | undefined;
  const host =
    (config?.host as string | undefined) || "https://api.cloud.llamaindex.ai";

  const url = projectId
    ? `${host.replace(/\/$/, "")}/api/v1/projects/${projectId}`
    : `${host.replace(/\/$/, "")}/api/v1/projects`;

  const res = await fetchJson(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as
    | { projects?: unknown[] }
    | { project?: unknown }
    | unknown[];

  const projects = Array.isArray(data)
    ? data
    : Array.isArray((data as { projects?: unknown[] }).projects)
      ? (data as { projects: unknown[] }).projects
      : (data as { project?: unknown }).project
        ? [(data as { project: unknown }).project]
        : [];

  return {
    balance: null,
    totalCost: null,
    totalRequests: projects.length > 0 ? projects.length : null,
    credits: null,
    rawData: {
      projects,
      note: "LlamaIndex Cloud does not expose remaining credits via API. Key validated via projects endpoint.",
    },
  };
}
