// Laying commits out into lanes: the part of a commit graph that isn't
// drawing.
//
// The algorithm is the usual one. Walk the commits top-down (they arrive in
// --topo-order, so a commit is always seen before its parents) keeping an
// ordered list of "lanes", each holding the hash of the commit that lane is
// currently waiting for:
//
//   - A commit takes the leftmost lane already waiting for it. If no lane is
//     waiting (it's the tip of a branch), it takes the first free slot.
//   - Its FIRST parent inherits that lane, so a branch keeps one column for
//     its whole length.
//   - Every other parent (a merge) either joins a lane already waiting for
//     it, or opens a new one.
//   - Once two lanes are waiting for the SAME commit, they are known to
//     converge: the rightmost is freed there and then, drawn sloping into
//     the one that survives. Waiting until the shared commit is actually
//     drawn would keep a column reserved for rows that don't need it, and
//     the graph would be wider than git's own --graph for the same history.
//   - Trailing free lanes are dropped so the graph narrows again.
//
// Each row records the edges leaving it downward, which is what the renderer
// draws: a straight line for a lane that continues, a curve for a lane that
// merges into or branches out of another.

export interface GraphCommit {
  hash: string;
  parents: string[];
}

// straight  this lane continues into the next row
// merge     leaves this commit's dot for another lane below (a merge parent)
// branch    arrives at this commit's dot from a lane above
// converge  a lane passing this row that is now known to join another one
export type EdgeKind = "straight" | "merge" | "branch" | "converge";

export interface GraphEdge {
  // Lane this edge leaves from (the commit's own lane), and the lane it
  // arrives in on the next row.
  fromLane: number;
  toLane: number;
  color: number;
  kind: EdgeKind;
}

export interface GraphRow {
  hash: string;
  lane: number;
  color: number;
  // Lanes passing this row untouched, drawn as straight lines behind it.
  through: { lane: number; color: number }[];
  edges: GraphEdge[];
}

// Twelve is enough that adjacent lanes rarely repeat a color, and few enough
// that every one can be a color that reads on both themes.
export const LANE_COLORS = 12;

interface Lane {
  // The commit this lane is waiting to draw, or null when the lane is free.
  hash: string | null;
  color: number;
}

export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: Lane[] = [];
  const rows: GraphRow[] = [];
  let nextColor = 0;

  const freeSlot = (): number => {
    const i = lanes.findIndex((l) => l.hash === null);
    if (i !== -1) return i;
    lanes.push({ hash: null, color: 0 });
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // The lane already waiting for this commit, if any.
    let lane = lanes.findIndex((l) => l.hash === commit.hash);
    let color: number;
    if (lane === -1) {
      lane = freeSlot();
      color = nextColor % LANE_COLORS;
      nextColor++;
    } else {
      color = lanes[lane].color;
    }
    lanes[lane] = { hash: commit.hash, color };

    const edges: GraphEdge[] = [];

    // Any other lane still waiting for this commit arrives at this dot.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i].hash === commit.hash) {
        edges.push({ fromLane: i, toLane: lane, color: lanes[i].color, kind: "branch" });
        lanes[i] = { hash: null, color: lanes[i].color };
      }
    }

    // The first parent keeps this lane; the others open or join their own.
    const [first, ...rest] = commit.parents;
    if (first) {
      lanes[lane] = { hash: first, color };
      edges.push({ fromLane: lane, toLane: lane, color, kind: "straight" });
    } else {
      // A root commit: the lane ends here.
      lanes[lane] = { hash: null, color };
    }

    for (const parent of rest) {
      const existing = lanes.findIndex((l) => l.hash === parent);
      if (existing !== -1) {
        edges.push({ fromLane: lane, toLane: existing, color: lanes[existing].color, kind: "merge" });
        continue;
      }
      const slot = freeSlot();
      const parentColor = nextColor % LANE_COLORS;
      nextColor++;
      lanes[slot] = { hash: parent, color: parentColor };
      edges.push({ fromLane: lane, toLane: slot, color: parentColor, kind: "merge" });
    }

    // Two lanes waiting for one commit will converge; free the rightmost
    // now and draw it sloping into the leftmost across this row.
    const waiting = new Map<string, number>();
    for (let i = 0; i < lanes.length; i++) {
      const hash = lanes[i].hash;
      if (!hash) continue;
      const kept = waiting.get(hash);
      if (kept === undefined) {
        waiting.set(hash, i);
        continue;
      }
      edges.push({ fromLane: i, toLane: kept, color: lanes[i].color, kind: "converge" });
      lanes[i] = { hash: null, color: lanes[i].color };
    }

    // Everything still live other than this commit's own lane passes behind
    // the row as a straight line. Computed after the two passes above so a
    // lane that just ended or converged isn't drawn twice.
    const converged = new Set(edges.filter((e) => e.kind === "converge").map((e) => e.fromLane));
    const through = lanes
      .map((l, i) => ({ lane: i, color: l.color, hash: l.hash }))
      .filter((l) => l.hash !== null && l.lane !== lane && !converged.has(l.lane))
      .map(({ lane: i, color: c }) => ({ lane: i, color: c }));

    // Lanes to the right of the last live one are dropped so the graph
    // narrows again after a branch is merged.
    while (lanes.length > 0 && lanes[lanes.length - 1].hash === null) lanes.pop();

    rows.push({ hash: commit.hash, lane, color, through, edges });
  }

  return rows;
}

// The widest the graph gets, for sizing its column.
export function maxLanes(rows: GraphRow[]): number {
  let max = 1;
  for (const row of rows) {
    const lanes = [row.lane, ...row.through.map((t) => t.lane), ...row.edges.map((e) => e.toLane)];
    for (const lane of lanes) max = Math.max(max, lane + 1);
  }
  return max;
}
