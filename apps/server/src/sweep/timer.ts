export type SweepTimerOptions = {
  schedule: string;
  runPass: () => Promise<void>;
  onError?: (error: unknown) => void;
};

export type SweepTimerHandle = {
  stop: () => void;
};

export function startSweepTimer(options: SweepTimerOptions): SweepTimerHandle {
  // Bun.cron fires only after the previous handler settles, so passes never overlap.
  const job = Bun.cron(options.schedule, async () => {
    try {
      await options.runPass();
    } catch (error) {
      options.onError?.(error);
    }
  });
  return {
    stop() {
      job.stop();
    },
  };
}
