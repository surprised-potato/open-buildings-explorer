/**
 * A background simulation for reports, so the mobility reports can fill in without the Simulate view.
 * It runs the same MobilitySimulation headlessly over a fixed scenario (morning peak) in short
 * chunks so the page stays responsive, and is cached for the rest of the session.
 */
import { loadMobilityDataset } from '../utils/mobilityLoader';
import { getActiveSimulation, MobilitySimulation } from '../utils/mobilitySim';
import type { MobilitySimParams, MobilitySimStats } from '../utils/mobilityTypes';

export const BACKGROUND_SCENARIO = {
  startHour: 6.5,
  endHour: 8.5,
  agents: 9000,
  /** Real seconds per step x speed = 4 simulated seconds per step. */
  dtRealSec: 1 / 15,
  speed: 60,
} as const;

export const BACKGROUND_LABEL = `background run, 06:30 to 08:30, ${BACKGROUND_SCENARIO.agents.toLocaleString()} agents`;

export type ReportSimSource = 'live' | 'background';

let background: MobilitySimulation | null = null;
let backgroundStats: MobilitySimStats | null = null;
let running: Promise<void> | null = null;

/** The simulation the reports should read: the live one if it exists, else the finished background run. */
export function getReportSimulation(): { sim: MobilitySimulation; source: ReportSimSource } | null {
  const live = getActiveSimulation();
  if (live) return { sim: live, source: 'live' };
  if (background) return { sim: background, source: 'background' };
  return null;
}

export function getBackgroundStats(): MobilitySimStats | null {
  return backgroundStats;
}

export function isBackgroundRunning(): boolean {
  return running !== null;
}

function params(): MobilitySimParams {
  return {
    targetAgents: BACKGROUND_SCENARIO.agents,
    betaScale: 1,
    enabledModes: { walk: true, motorcycle: true, tricycle: true, car: true, puv: true },
    selectedBarangayName: null,
    barangayFilter: 'all',
    terrainEnabled: false,
    terrainExaggeration: 1,
    opacity: 1,
    congestionEnabled: true,
    congestionLoadScale: 1,
    colorMode: 'mode',
    gravityLambdaKm: 3,
    attrBlend: 0.5,
    gravityBalance: 0.5,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Run (or re-run) the background scenario. Resolves when finished; `onProgress` gets 0..1.
 * A second call while one is running joins the same run. Aborting leaves any earlier result intact.
 */
export function runBackgroundSimulation(
  base: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      const dataset = await loadMobilityDataset(base, signal);
      const sim = new MobilitySimulation(dataset, 20261127);
      const p = params();
      const dtSimHours = (BACKGROUND_SCENARIO.dtRealSec * BACKGROUND_SCENARIO.speed) / 3600;
      const total = Math.round((BACKGROUND_SCENARIO.endHour - BACKGROUND_SCENARIO.startHour) / dtSimHours);
      let hour: number = BACKGROUND_SCENARIO.startHour;
      let stats: MobilitySimStats | null = null;
      let done = 0;
      while (done < total) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const t0 = performance.now();
        while (done < total && performance.now() - t0 < 12) {
          stats = sim.step(BACKGROUND_SCENARIO.dtRealSec, BACKGROUND_SCENARIO.speed, hour, p);
          hour += dtSimHours;
          done += 1;
        }
        onProgress?.(done / total);
        await tick();
      }
      background = sim;
      backgroundStats = stats;
      onProgress?.(1);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Test hook. */
export function resetBackgroundSimulation(): void {
  background = null;
  backgroundStats = null;
  running = null;
}
