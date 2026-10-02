import type { PreviewAppOps } from "../app-deployment/ops.ts";
import { previewAuthMode, type PreviewAuthSpec } from "@sprout/preview-env";
import type { SeedImageResult, SeedImageSpec } from "../app-deployment/seed.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { markStickyPreviewFailed } from "./mark-failed.ts";
import type { Result } from "./result.ts";
import {
  updatePreviewRow,
  utcIsoNow,
  type PreviewRow,
} from "./row.ts";
import type { Context, Tracer } from "@opentelemetry/api";
import type { BringUpPlan, PhaseTimer } from "./types.ts";
import { timed } from "./timing.ts";

export type SeedPhaseDeps = {
  db: StateDb;
  app: Pick<PreviewAppOps, "runSeed">;
  phaseTimer?: PhaseTimer;
  tracer?: Tracer;
  traceContext?: Context;
};

import type { PreviewDbPlan } from "./runtime.ts";

export type DeployEphemerals = {
  seed?: SeedImageSpec;
  reseed?: boolean;
  plan: PreviewDbPlan;
  fleetPending?: boolean;
};

export function seedWorkOutstanding(
  row: Pick<PreviewRow, "seededAt" | "seededSeedImage">,
  seed: { image: string } | undefined,
  reseed: boolean | undefined,
): boolean {
  if (seed === undefined) return false;
  if (reseed === true) return true;
  if (row.seededAt == null) return true;
  return row.seededSeedImage !== seed.image;
}

function planAfterPromote(fleetPending: boolean | undefined): BringUpPlan {
  return fleetPending === true ? "sync_close" : "close";
}

function seedFailureDetail(
  result: Extract<SeedImageResult, { ok: false }>,
): string | null {
  if (result.timedOut) return "timeout";
  if (result.exitCode != null) return `exit=${result.exitCode}`;
  return null;
}

async function runSeedPhase(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals & { seed: SeedImageSpec },
): Promise<Result<true>> {
  const { seed, plan } = ephemerals;
  await updatePreviewRow(
    deps.db,
    row,
    { status: "seeding", seededAt: null, updatedAt: utcIsoNow() },
    "preview_row_missing_on_seeding",
  );

  try {
    const seedResult: SeedImageResult = await deps.app.runSeed({
      slug: row.slug,
      prId: row.prId,
      image: seed.image,
      env: seed.env,
      args: seed.args,
      plan,
    });

    if (!seedResult.ok) {
      if (seedResult.timedOut) {
        console.warn("seed:failed", "timeout");
      } else {
        console.warn("seed:failed", seedResult.exitCode);
      }
      await markStickyPreviewFailed(
        deps.db,
        row.canonicalRepoId,
        row.prId,
        {
          error: "seed_failed",
          family: "seed_incomplete",
          detail: seedFailureDetail(seedResult),
          seedLog: seedResult.logs,
        },
      );
      return { ok: false, status: 500, error: "seed_failed" };
    }

    const seededAt = utcIsoNow();
    await updatePreviewRow(
      deps.db,
      row,
      {
        status: "seeding",
        seededAt,
        seededSeedImage: seed.image,
        bringUpPlan: planAfterPromote(ephemerals.fleetPending),
        lastError: null,
        lastErrorDetail: null,
        failureFamily: null,
        seedLog: null,
        updatedAt: seededAt,
      },
      "preview_row_missing_on_seeded",
    );
    return { ok: true, value: true };
  } catch (err) {
    console.warn("seed:failed", err);
    await markStickyPreviewFailed(deps.db, row.canonicalRepoId, row.prId, {
      error: "seed_failed",
      family: "seed_incomplete",
      detail: null,
      seedLog: "",
    });
    return { ok: false, status: 500, error: "seed_failed" };
  }
}

export async function promoteAfterHealthy(
  deps: SeedPhaseDeps,
  starting: PreviewRow,
  ephemerals: DeployEphemerals,
): Promise<Result<true>> {
  const { seed } = ephemerals;
  const shouldSeed = seedWorkOutstanding(starting, seed, ephemerals.reseed);

  if (shouldSeed && seed) {
    return timed(deps, "seed", () =>
      runSeedPhase(deps, starting, { ...ephemerals, seed }),
    );
  }

  await updatePreviewRow(
    deps.db,
    starting,
    {
      bringUpPlan: planAfterPromote(ephemerals.fleetPending),
      updatedAt: utcIsoNow(),
    },
    "preview_row_missing_on_promote",
  );
  return { ok: true, value: true };
}

export function canSeedWithoutAppReplace(
  row: PreviewRow,
  input: {
    appImage: string;
    hostname: string;
    auth?: PreviewAuthSpec;
  },
): boolean {
  return (
    row.containerId != null &&
    row.appImage === input.appImage &&
    row.hostname === input.hostname &&
    (row.authMode ?? "none") === previewAuthMode(input.auth)
  );
}

export async function resumeIncompleteSeed(
  deps: SeedPhaseDeps,
  row: PreviewRow,
  ephemerals: DeployEphemerals,
): Promise<Result<true>> {
  const seed = ephemerals.seed;
  if (!seed) {
    await markStickyPreviewFailed(deps.db, row.canonicalRepoId, row.prId, {
      error: "seed_image_required_to_resume_seeding",
      family: "seed_incomplete",
      detail: null,
    });
    return {
      ok: false,
      status: 422,
      error: "seed_image_required_to_resume_seeding",
    };
  }
  return timed(deps, "seed", () =>
    runSeedPhase(deps, row, { ...ephemerals, seed }),
  );
}
