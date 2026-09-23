/**
 * One option per map, maximising the total, with as few repeats as the numbers
 * allow: none when there are at least as many distinct options as maps,
 * otherwise exactly the shortfall - six duos over seven maps means one duo
 * plays twice, not three of them.
 *
 * This used to be a depth-first search with a bound, which is exponential:
 * an 18-map pool with ten duos left it 10^18 branches to walk, and it froze
 * the web server for hours. It is an assignment problem, so it is solved as
 * one - a min-cost flow:
 *
 *   source -> each map (1)
 *   map -> each of its options (1, cost -value)
 *   option -> sink (1)                  its one free use
 *   option -> repeats -> sink (the shortfall, shared)
 *
 * Every map gets an option, no option is used twice except through the shared
 * repeats, and the total is the largest there is. Exact, and polynomial:
 * well under a millisecond at pool sizes.
 */
export function assignSpread<T extends { playerIds: readonly string[]; value: number }>(
  perMap: ReadonlyArray<ReadonlyArray<T>>,
): Array<T | null> {
  const n = perMap.length;
  if (n === 0) return [];
  const keyOf = (g: T) => [...g.playerIds].sort().join('|');

  const groupIndex = new Map<string, number>();
  for (const options of perMap) for (const g of options) if (!groupIndex.has(keyOf(g))) groupIndex.set(keyOf(g), groupIndex.size);
  const groups = groupIndex.size;
  const repeatsAllowed = Math.max(0, n - groups);

  // Nodes: source, maps, groups, the repeat pool, sink.
  const SOURCE = 0;
  const mapNode = (i: number) => 1 + i;
  const groupNode = (g: number) => 1 + n + g;
  const REPEATS = 1 + n + groups;
  const SINK = REPEATS + 1;
  const graph = new MinCostFlow(SINK + 1);

  for (let i = 0; i < n; i++) graph.addEdge(SOURCE, mapNode(i), 1, 0);
  const choice: Array<Array<{ edge: number; option: T }>> = perMap.map(() => []);
  perMap.forEach((options, i) => {
    // Only a map's best option per group can matter.
    const best = new Map<number, T>();
    for (const option of options) {
      const g = groupIndex.get(keyOf(option))!;
      const held = best.get(g);
      if (!held || valueOf(option) > valueOf(held)) best.set(g, option);
    }
    for (const [g, option] of best) {
      choice[i]!.push({ edge: graph.addEdge(mapNode(i), groupNode(g), 1, -valueOf(option)), option });
    }
  });
  for (let g = 0; g < groups; g++) {
    graph.addEdge(groupNode(g), SINK, 1, 0);
    if (repeatsAllowed > 0) graph.addEdge(groupNode(g), REPEATS, n, 0);
  }
  if (repeatsAllowed > 0) graph.addEdge(REPEATS, SINK, repeatsAllowed, 0);

  graph.run(SOURCE, SINK);
  return choice.map((options) => options.find((c) => graph.flowOn(c.edge) > 0)?.option ?? null);
}

/** A value that cannot be compared counts as nothing, rather than switching the optimisation off. */
const valueOf = (option: { value: number }) => (Number.isFinite(option.value) ? option.value : 0);

/** Successive shortest paths, Bellman-Ford on the residual graph (costs here are negative). */
class MinCostFlow {
  private readonly to: number[] = [];
  private readonly cap: number[] = [];
  private readonly cost: number[] = [];
  private readonly adjacent: number[][];

  constructor(private readonly nodes: number) {
    this.adjacent = Array.from({ length: nodes }, () => []);
  }

  /** Returns the edge's id; its reverse is id ^ 1. */
  addEdge(from: number, to: number, capacity: number, cost: number): number {
    const id = this.to.length;
    this.to.push(to, from);
    this.cap.push(capacity, 0);
    this.cost.push(cost, -cost);
    this.adjacent[from]!.push(id);
    this.adjacent[to]!.push(id + 1);
    return id;
  }

  flowOn(edge: number): number {
    return this.cap[edge ^ 1]!;
  }

  run(source: number, sink: number): void {
    const EPS = 1e-12;
    for (;;) {
      const dist = new Array<number>(this.nodes).fill(Infinity);
      const via = new Array<number>(this.nodes).fill(-1);
      dist[source] = 0;
      // Bellman-Ford: at most nodes - 1 rounds, stopping early once nothing improves.
      for (let round = 0; round < this.nodes - 1; round++) {
        let changed = false;
        for (let u = 0; u < this.nodes; u++) {
          if (dist[u] === Infinity) continue;
          for (const e of this.adjacent[u]!) {
            if (this.cap[e]! <= 0) continue;
            const v = this.to[e]!;
            const next = dist[u]! + this.cost[e]!;
            if (next < dist[v]! - EPS) {
              dist[v] = next;
              via[v] = e;
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
      if (dist[sink] === Infinity) return;

      let push = Infinity;
      for (let v = sink; v !== source; v = this.to[via[v]! ^ 1]!) push = Math.min(push, this.cap[via[v]!]!);
      for (let v = sink; v !== source; v = this.to[via[v]! ^ 1]!) {
        this.cap[via[v]!]! -= push;
        this.cap[via[v]! ^ 1]! += push;
      }
    }
  }
}
