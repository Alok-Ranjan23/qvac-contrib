export interface FitRunner {
  executable: string
  runnerPath: string
}

let configured: FitRunner | null = null

export function useFitRunner(runner: FitRunner | null): void {
  configured = runner
}

export function configuredFitRunner(): FitRunner | null {
  return configured
}
