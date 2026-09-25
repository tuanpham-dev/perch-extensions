// Turning a cluster's per-ticket reports into one `qa-report` spec, and
// rendering it.
//
// The shape here is not ours - it is `qa-report`'s, and through it
// `combine_qa_reports.py`'s. Two details are what make the user's existing
// tooling keep working untouched:
//
//   * every ticket carries a `tag` of its cluster name, which is what the
//     combiner turns into a filter chip per cluster;
//   * every evidence path is relative to the SPEC FILE's own directory,
//     because that is what the combiner resolves against when it merges
//     several clusters' specs written from different worktrees.
//
// The agent never writes any of this. It files per-ticket reports; the
// extension derives the spec from them, so there is no bookkeeping step for a
// tired agent to skip near the end of a long run, and rebuilding is just
// running this again.
import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// A ticket nobody QA'd still belongs in the report - as `blocked`, which is
// qa-report's own way of saying "not verified, and here is why". Leaving it
// out would make a cluster's report quietly narrower than the cluster.
const NO_REPORT = "No QA report was filed for this ticket.";

function slug(text) {
  return (
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "cluster"
  );
}

function statusFor(ticket) {
  if (ticket?.qa?.status) return ticket.qa.status;
  // No report at all: say so rather than implying a verdict.
  return "blocked";
}

// Screenshots are copied to sit BESIDE the spec, in a screenshots/ folder,
// and referenced by a short relative path.
//
// The obvious alternative - pointing at the extension's own store - produces
// a path like ../../../../../home/you/.config/... that is correct today and
// broken the moment .backups is copied, shared or read from another machine.
// Keeping the pair together is also the convention the user's own reports
// already follow.
function evidenceFor(ticket, key, { batchId }) {
  const shots = [];
  for (const which of ["before", "after"]) {
    const shot = ticket?.qa?.[which];
    if (!shot) continue;
    const name = `${key}-${which}.${shot.ext}`;
    shots.push({
      image: path.join("screenshots", name),
      caption: `${which === "before" ? "Before" : "After"} - ${key}`,
      label: which,
      // Where to copy it from, stripped before the spec is written.
      _from: path.join(batchId, key, `${which}.${shot.ext}`),
    });
  }
  // Then whatever else the ticket needed, in the order it was reported. These
  // come last so a before/after pair still reads as a pair at the front of the
  // row, and an existing report is unchanged by the ones that carry none.
  for (const [i, shot] of (ticket?.qa?.shots ?? []).entries()) {
    if (!shot?.ext) continue;
    const label = shot.label || `shot-${i + 1}`;
    const name = `${key}-${label}.${shot.ext}`;
    shots.push({
      image: path.join("screenshots", name),
      // The agent's own words when it gave any; otherwise say which number it
      // is, which at least tells two unlabelled shots apart.
      caption: shot.caption || `${key} - ${i + 1}`,
      _from: path.join(batchId, key, `${label}.${shot.ext}`),
    });
  }
  return shots;
}

export function buildSpec(batch, cluster, { title = "" } = {}) {
  const tickets = cluster.keys.map((key) => {
    const ticket = batch.ticketStates[key];
    const row = batch.tickets[key];
    const qa = ticket?.qa ?? null;
    const entry = {
      id: key,
      title: row?.summary ?? key,
      url: row?.url ?? "",
      status: statusFor(ticket),
      // The cluster's name, which is what combine_qa_reports.py turns into a
      // filter chip.
      tag: cluster.name,
      summary: ticket?.summary ?? "",
      problem: qa?.problem?.length ? qa.problem : [],
      steps: qa?.steps?.length ? qa.steps : [],
      files: qa?.files?.length ? qa.files : [],
      notes: qa?.notes?.length ? [...qa.notes] : [],
      evidence: evidenceFor(ticket, key, { batchId: batch.id }),
    };
    // A blocked entry gets problem and notes and NO fix - that asymmetry is
    // how qa-report says "this one was not done, here is why", so a fix field
    // on it would read as work that happened.
    if (qa?.fix?.length && entry.status !== "blocked") entry.fix = qa.fix;
    if (!qa) {
      entry.problem = entry.problem.length ? entry.problem : [row?.summary ?? key];
      entry.notes.push(NO_REPORT);
    }
    if (ticket?.reason) entry.notes.push(ticket.reason);
    return entry;
  });

  return {
    title: title || `${batch.name} - ${cluster.name}`,
    slug: slug(cluster.name),
    tickets,
  };
}

// The primary worktree, resolved the way qa-report resolves it: the first
// entry of `git worktree list --porcelain`. A cluster runs in a LINKED
// worktree, and its report belongs with every other report for the
// repository, not in a checkout that is about to be removed.
export function primaryWorktree(cwd, run = runGit) {
  return run(["worktree", "list", "--porcelain"], cwd).then((out) => {
    const first = out.split("\n").find((line) => line.startsWith("worktree "));
    return first ? first.slice("worktree ".length).trim() : cwd;
  });
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 15_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

function runNode(script, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [script, ...args],
      { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)),
    );
    child.stdin?.end(input);
  });
}

// Writes the spec where the combiner looks, then renders it with whichever
// qa-report answered. Idempotent: both are rebuilt from the current reports
// every time, so running it again after more tickets land is safe.
export async function writeAndRender(batch, cluster, { evidenceDir, qaReportScript, repo, run = runGit, render = runNode }) {
  const primary = await primaryWorktree(repo, run).catch(() => repo);
  const specDir = path.join(primary, ".backups", "orchestration");
  await mkdir(specDir, { recursive: true });

  const spec = buildSpec(batch, cluster);

  // Copy each shot next to the spec, then drop the internal _from before it
  // is written - the file on disk is a plain qa-report spec.
  const shotDir = path.join(specDir, "screenshots");
  const needed = spec.tickets.flatMap((ticket) => ticket.evidence);
  if (needed.length > 0) await mkdir(shotDir, { recursive: true });
  for (const shot of needed) {
    try {
      await copyFile(path.join(evidenceDir, shot._from), path.join(specDir, shot.image));
    } catch (err) {
      // A shot the store no longer has must not stop the report; qa-report
      // refuses to render a missing image, so it is dropped with a note
      // rather than left dangling.
      shot.missing = true;
    }
    delete shot._from;
  }
  for (const ticket of spec.tickets) {
    const dropped = ticket.evidence.filter((shot) => shot.missing);
    ticket.evidence = ticket.evidence.filter((shot) => !shot.missing);
    if (dropped.length > 0) ticket.notes.push(`${dropped.length} screenshot(s) are no longer stored.`);
  }

  const specPath = path.join(specDir, `${slug(cluster.name)}-qa-spec.json`);
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);

  let reportPath = "";
  if (qaReportScript) {
    // Run it from the spec's own directory so its relative image paths
    // resolve, and let it choose its own output name under .backups/.
    const out = await render(qaReportScript, [specPath], specDir, "");
    const written = out.match(/(\S*\.html)\s*$/m);
    reportPath = written ? path.resolve(specDir, written[1]) : "";
  }
  return { specPath, reportPath };
}
