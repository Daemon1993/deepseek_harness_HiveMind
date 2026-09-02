import { readTeamConfigOptional } from "./config.ts";
import type {
  TeamCodeChange,
  TeamDailyInsight,
  TeamSessionAnalytics,
  TeamUser,
} from "./types.ts";

function parseModelOutput(
  value: unknown,
): TeamDailyInsight["insight"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const strings = (key: string): string[] =>
    Array.isArray(row[key])
      ? row[key]
          .filter((item): item is string => typeof item === "string")
          .slice(0, 12)
      : [];
  return typeof row.summary === "string"
    ? {
        summary: row.summary.slice(0, 800),
        completed: strings("completed"),
        inProgress: strings("inProgress"),
        blockers: strings("blockers"),
        topics: strings("topics"),
      }
    : undefined;
}

/** Build a privacy-minimized daily evidence snapshot from existing team data. */
export function dailyEvidence(
  sessions: readonly TeamSessionAnalytics[],
  commits: readonly TeamCodeChange[],
  start: number,
  end: number,
): TeamDailyInsight["evidence"] {
  return {
    sessions: sessions
      .filter(
        (session) =>
          session.lastActiveAt >= start && session.lastActiveAt < end,
      )
      .map((session) => ({
        title: session.title,
        ...(session.projectName === undefined
          ? {}
          : { projectName: session.projectName }),
        lastActiveAt: session.lastActiveAt,
        toolCalls: session.metrics.toolCalls,
        errors: session.metrics.errorCount,
      })),
    commits: commits
      .filter((commit) => commit.time >= start && commit.time < end)
      .map((commit) => ({
        ...(commit.subject === undefined ? {} : { subject: commit.subject }),
        ...(commit.gitRemote === undefined
          ? {}
          : { project: commit.gitRemote }),
        files: commit.files,
        insertions: commit.insertions,
        deletions: commit.deletions,
        time: commit.time,
      })),
  };
}

/** Ask the Server-only configured model for structured work facts. */
export async function summarizeDailyEvidence(
  user: TeamUser,
  workDate: string,
  evidence: TeamDailyInsight["evidence"],
): Promise<{ insight: TeamDailyInsight["insight"]; model?: string }> {
  const apiKey =
    (await readTeamConfigOptional("INSIGHT_API_KEY")) ??
    (await readTeamConfigOptional("DEEPSEEK_API_KEY"));
  const model =
    (await readTeamConfigOptional("INSIGHT_MODEL")) ?? "deepseek-chat";
  if (apiKey === undefined)
    throw new Error(
      "TEAM_INSIGHT_API_KEY (or DEEPSEEK_API_KEY) is not configured on the Server",
    );
  const configuredEndpoint =
    (await readTeamConfigOptional("INSIGHT_API_URL")) ??
    "https://api.deepseek.com/chat/completions";
  const baseEndpoint = configuredEndpoint.replace(/\/+$/u, "");
  const endpoint = baseEndpoint.endsWith("/chat/completions")
    ? baseEndpoint
    : `${baseEndpoint}/chat/completions`;
  const prompt = `你是企业研发工作事实提炼器。只根据证据输出 JSON，不能虚构。用户：${user.name}，日期：${workDate}。输出 {"summary":"","completed":[],"inProgress":[],"blockers":[],"topics":[]}。completed 表示有明确证据的完成事项；没有证据则数组为空。证据：${JSON.stringify(evidence)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok)
    throw new Error(
      `daily insight model request failed: HTTP ${String(response.status)}`,
    );
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (content === undefined)
    throw new Error("daily insight model returned no content");
  const insight = parseModelOutput(JSON.parse(content));
  if (insight === undefined)
    throw new Error("daily insight model returned invalid JSON fields");
  return { insight, model };
}
