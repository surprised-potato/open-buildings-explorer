import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORTS } from '../reports/catalog';
import { aggregateCorridors, findStreet, NO_STREET, streetKey, type EdgeStreets } from '../reports/corridors';

const streets: EdgeStreets = {
  names: ['C. L. Montelibano Avenue', 'C.L. Montelibano Avenue', 'Burgos Street'],
  edge: [0, 1, 2, NO_STREET],
};
const len = [1, 1, 0.5, 9];
const load = {
  agents: [2, 4, 1, 99],
  pcu: [10, 30, 5, 999],
  vc: [0.5, 1.0, 0.2, 5],
  speedRatio: [0.8, 0.4, 1, 0.1],
};

describe('corridor roll-up', () => {
  it('merges spellings and skips unnamed edges', () => {
    const rows = aggregateCorridors(streets, len, load);
    expect(rows).toHaveLength(2);
    const m = findStreet(rows, 'Montelibano')!;
    expect(m.edges).toBe(2);
    expect(m.lengthKm).toBe(2);
    expect(m.agents).toBe(6);
    expect(m.pcu).toBe(40);
    expect(m.vcMean).toBeCloseTo(0.75);
    expect(m.vcMax).toBe(1);
    expect(m.speedRatio).toBeCloseTo(0.6);
  });

  it('normalises street keys', () => {
    expect(streetKey('C. L. Montelibano Avenue')).toBe(streetKey('C.L. Montelibano Avenue'));
  });

  it('builds the comparison report and reports unavailable data otherwise', () => {
    const def = REPORTS.find((r) => r.id === 'corridor-comparison')!;
    const base = { analytics: undefined, pois: {}, barangay: null, mobilityStats: null, property: null, zonalTierCounts: null, zonalTierLabels: null } as never;
    expect(def.build({ ...(base as object), corridors: null, corridorA: null, corridorB: null } as never).subtitle).toBe('Simulation data unavailable');
    const rows = aggregateCorridors(streets, len, load);
    const out = def.build({
      ...(base as object),
      corridors: { rows, takenAt: 0 },
      corridorA: streetKey('Burgos Street'),
      corridorB: findStreet(rows, 'Montelibano')!.key,
    } as never);
    expect(out.subtitle).toBe('Burgos Street vs C. L. Montelibano Avenue');
    expect(out.sections[0].table!.rows[1]).toEqual(['Load now (PCU, represented)', '5', '40']);
  });

  it('edge street file lines up with the network', () => {
    const d = JSON.parse(readFileSync('public/data/bacolod/mobility_edge_streets.json', 'utf8'));
    const zones = JSON.parse(readFileSync('public/data/bacolod/mobility_zones.json', 'utf8'));
    expect(d.edge).toHaveLength(zones.n_edges);
    expect(d.names.some((n: string) => /burgos/i.test(n))).toBe(true);
    expect(d.names.some((n: string) => /montelibano/i.test(n))).toBe(true);
  });
});
