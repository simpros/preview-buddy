export type Config = {
  githubWebhookSecret: string;
  gitlabWebhookSecret: string;
  pbDatabaseUrl: string;
  pbDbPrefix: string;
  pbTtlHours: number;
  pbPort: number;
};

export function loadConfig(): Config {
  const pbDatabaseUrl = process.env.PB_DATABASE_URL;
  if (!pbDatabaseUrl) {
    throw new Error("PB_DATABASE_URL is required");
  }

  return {
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    gitlabWebhookSecret: process.env.GITLAB_WEBHOOK_SECRET ?? "",
    pbDatabaseUrl,
    pbDbPrefix: process.env.PB_DB_PREFIX ?? "prev_pr",
    pbTtlHours: Number(process.env.PB_TTL_HOURS ?? "72"),
    pbPort: Number(process.env.PB_PORT ?? "7331"),
  };
}

export function configSummary(config: Config): Record<string, string | number> {
  return {
    pbDatabaseUrl: redactUrl(config.pbDatabaseUrl),
    pbDbPrefix: config.pbDbPrefix,
    pbTtlHours: config.pbTtlHours,
    pbPort: config.pbPort,
    githubWebhookSecret: config.githubWebhookSecret ? "[set]" : "[unset]",
    gitlabWebhookSecret: config.gitlabWebhookSecret ? "[set]" : "[unset]",
  };
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid url]";
  }
}
