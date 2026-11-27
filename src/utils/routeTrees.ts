/** Shortest-path trees on the mobility graph, used to refresh hub trees with live congested times. */

export const NO_EDGE = 0xffff;

export interface OutAdjacency {
  /** CSR offsets, length nNodes + 1. */
  offs: Uint32Array;
  /** Edge ids grouped by source node. */
  edges: Uint16Array;
}

export function buildOutAdjacency(
  nNodes: number,
  edgeSrc: ArrayLike<number>,
  nEdges: number
): OutAdjacency {
  const offs = new Uint32Array(nNodes + 1);
  for (let e = 0; e < nEdges; e += 1) offs[edgeSrc[e] + 1] += 1;
  for (let i = 0; i < nNodes; i += 1) offs[i + 1] += offs[i];
  const fill = offs.slice(0, nNodes);
  const edges = new Uint16Array(nEdges);
  for (let e = 0; e < nEdges; e += 1) edges[fill[edgeSrc[e]]++] = e;
  return { offs, edges };
}

/** Reusable Dijkstra workspace (binary heap with lazy deletion). */
export class TreeSolver {
  private readonly dist: Float64Array;
  private readonly heapKey: Float64Array;
  private readonly heapNode: Int32Array;
  private heapSize = 0;

  constructor(
    private readonly nNodes: number,
    nEdges: number,
    private readonly adj: OutAdjacency,
    private readonly edgeDst: ArrayLike<number>
  ) {
    this.dist = new Float64Array(nNodes);
    // Each edge relaxation can push at most one entry.
    this.heapKey = new Float64Array(nEdges + 2);
    this.heapNode = new Int32Array(nEdges + 2);
  }

  private push(key: number, node: number): void {
    let i = this.heapSize++;
    const k = this.heapKey;
    const n = this.heapNode;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      n[i] = n[p];
      i = p;
    }
    k[i] = key;
    n[i] = node;
  }

  private pop(): void {
    const k = this.heapKey;
    const n = this.heapNode;
    const size = --this.heapSize;
    if (size === 0) return;
    const key = k[size];
    const node = n[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && k[c + 1] < k[c]) c += 1;
      if (k[c] >= key) break;
      k[i] = k[c];
      n[i] = n[c];
      i = c;
    }
    k[i] = key;
    n[i] = node;
  }

  /**
   * Shortest-path tree from `root` following edge direction. Writes the arriving edge of each node
   * into `prevOut[outOffset + node]` (NO_EDGE for the root and unreachable nodes). Edges with
   * weight >= `banned` are not traversed.
   */
  solve(
    root: number,
    weights: ArrayLike<number>,
    banned: number,
    prevOut: Uint16Array,
    outOffset: number
  ): void {
    const { dist, adj, edgeDst, nNodes } = this;
    dist.fill(Infinity);
    prevOut.fill(NO_EDGE, outOffset, outOffset + nNodes);
    dist[root] = 0;
    this.heapSize = 0;
    this.push(0, root);
    while (this.heapSize > 0) {
      const d = this.heapKey[0];
      const u = this.heapNode[0];
      this.pop();
      if (d > dist[u]) continue;
      for (let j = adj.offs[u]; j < adj.offs[u + 1]; j += 1) {
        const e = adj.edges[j];
        const w = weights[e];
        if (!(w < banned)) continue;
        const v = edgeDst[e];
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          prevOut[outOffset + v] = e;
          this.push(nd, v);
        }
      }
    }
  }
}
