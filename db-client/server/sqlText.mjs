// SQL text helpers that need to know where string literals, quoted names and
// comments are, so a keyword or a ";" inside one isn't mistaken for code.

// The text with every literal, quoted identifier and comment blanked out
// (same length, so offsets still line up). Handles '…' (with '' escapes),
// "…", `…`, PostgreSQL's $tag$…$tag$, -- and # line comments, and /* */.
export function blankLiterals(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && c !== "`") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += blank(sql.slice(i, j + 1));
      i = j + 1;
    } else if (two === "--" || c === "#") {
      const j = sql.indexOf("\n", i);
      const end = j === -1 ? n : j;
      out += blank(sql.slice(i, end));
      i = end;
    } else if (two === "/*") {
      const j = sql.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out += blank(sql.slice(i, end));
      i = end;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        const end = j === -1 ? n : j + tag.length;
        out += blank(sql.slice(i, end));
        i = end;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// The statements in a script, split on ";" outside literals and comments,
// without empty ones.
export function splitStatements(sql) {
  const blanked = blankLiterals(sql);
  const out = [];
  let start = 0;
  for (let i = 0; i <= blanked.length; i++) {
    if (i === blanked.length || blanked[i] === ";") {
      const stmt = sql.slice(start, i).trim();
      if (stmt && blankLiterals(stmt).trim()) out.push(stmt);
      start = i + 1;
    }
  }
  return out;
}

// Statements that would end or loosen the read-only transaction a read-only
// connection's queries run in, judged by how each statement starts (so a
// column named "release" or "begin" is fine). Refused outright on such a
// connection.
const TX_CONTROL =
  /^(commit|rollback|begin|start\s+transaction|end|savepoint|release|abort|set\s+(session\s+)?characteristics|set\s+transaction|set\s+(session\s+|global\s+|local\s+|@@)?(default_transaction_read_only|transaction_read_only|autocommit|tx_read_only|transaction_isolation|session\.transaction_read_only|global\.transaction_read_only)|reset(\s+all|\s+default_transaction_read_only|\s+transaction_read_only)?|discard|lock\s+tables?|unlock\s+tables|xa)\b/i;

export function txControlIn(sql) {
  for (const stmt of splitStatements(sql)) {
    const head = blankLiterals(stmt).trim();
    const m = TX_CONTROL.exec(head);
    if (m) return m[0].replace(/\s+/g, " ").toUpperCase();
  }
  return null;
}
