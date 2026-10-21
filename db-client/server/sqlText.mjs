// SQL text helpers that need to know where string literals, quoted names and
// comments are, so a keyword or a ";" inside one isn't mistaken for code.

// The text with every literal, quoted identifier and comment blanked out
// (same length, so offsets still line up). Each engine quotes differently,
// and reading one engine's text by another's rules hides code inside what
// looks like a literal - so the dialect matters:
//
//   postgres  '…' with only '' escapes (a backslash is an ordinary character)
//             unless written E'…'; "…" names; $tag$…$tag$; -- comments;
//             /* */ comments that nest. # is an operator, not a comment.
//   mysql     '…' and "…" with \ and doubled escapes; `…` names; # comments;
//             -- comments only when followed by whitespace (1--1 is
//             arithmetic); /*! … */ and /*+ … */ hold code, so only their
//             markers are blanked.
//   generic   (SQLite and anything else) every form above, the permissive
//             way: fine for splitting a script, not for safety checks.
//
// Self-contained (no outer references): engines/sqlite.mjs embeds its
// source in a worker.
export function blankLiterals(sql, dialect = "generic") {
  let out = "";
  let i = 0;
  const n = sql.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const pg = dialect === "postgres";
  const my = dialect === "mysql";
  const quoteEnd = (start, q, backslash) => {
    let j = start + 1;
    while (j < n) {
      if (backslash && sql[j] === "\\") {
        j += 2;
        continue;
      }
      if (sql[j] === q) {
        if (sql[j + 1] === q) {
          j += 2;
          continue;
        }
        return j;
      }
      j++;
    }
    return n - 1;
  };
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (pg && (c === "E" || c === "e") && sql[i + 1] === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      // E'…' escape string: backslashes escape.
      const j = quoteEnd(i + 1, "'", true);
      out += c + blank(sql.slice(i + 1, j + 1));
      i = j + 1;
    } else if (c === "'" || c === '"' || (c === "`" && !pg)) {
      const backslash = my ? c !== "`" : pg ? false : c !== "`";
      const j = quoteEnd(i, c, backslash);
      out += blank(sql.slice(i, j + 1));
      i = j + 1;
    } else if (two === "--" && (!my || /[\s]/.test(sql[i + 2] ?? " "))) {
      const j = sql.indexOf("\n", i);
      const end = j === -1 ? n : j;
      out += blank(sql.slice(i, end));
      i = end;
    } else if (c === "#" && !pg) {
      const j = sql.indexOf("\n", i);
      const end = j === -1 ? n : j;
      out += blank(sql.slice(i, end));
      i = end;
    } else if (my && (sql.startsWith("/*!", i) || sql.startsWith("/*+", i))) {
      // Executable comment: its contents run. Blank only the markers (and
      // a version number right after "/*!").
      const m = /^\/\*[!+]\d*/.exec(sql.slice(i));
      out += blank(m[0]);
      i += m[0].length;
      const close = sql.indexOf("*/", i);
      if (close !== -1) {
        out += sql.slice(i, close) + "  ";
        i = close + 2;
      }
    } else if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (pg && sql.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if (c === "$" && !my) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
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
export function splitStatements(sql, dialect = "generic") {
  const blanked = blankLiterals(sql, dialect);
  const out = [];
  let start = 0;
  for (let i = 0; i <= blanked.length; i++) {
    if (i === blanked.length || blanked[i] === ";") {
      const stmt = sql.slice(start, i).trim();
      if (stmt && blankLiterals(stmt, dialect).trim()) out.push(stmt);
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

export function txControlIn(sql, dialect = "generic") {
  for (const stmt of splitStatements(sql, dialect)) {
    const head = blankLiterals(stmt, dialect).trim();
    const m = TX_CONTROL.exec(head);
    if (m) return m[0].replace(/\s+/g, " ").toUpperCase();
  }
  return null;
}

// What a read-only connection may start a statement with. The read-only
// transaction already refuses table writes; this list also keeps out what
// that transaction doesn't stop: MySQL DDL (which commits on its own,
// ending the transaction first), CALL into a procedure, and the like.
const READ_STATEMENT = /^(\(|select|with|show|explain|describe|desc|values|table|set|use|fetch)\b|^\(/i;

// Calls and clauses that reach past the read-only transaction: a shell
// command, a file on the database server, or a second connection that isn't
// read-only.
const ESCAPES = {
  postgres: /\b(dblink\w*|lo_export|lo_import|pg_file_\w+|pg_logdir_ls)\s*\(|\bto\s+program\b/i,
  mysql: /\binto\s+(outfile|dumpfile)\b|\bset\s+(global|persist|persist_only)\b|@@global\./i,
};

// Why a read-only connection must refuse this script, or null when it may
// run (inside the read-only transaction). Judged on the text with literals
// and comments blanked by the engine's own rules.
export function readOnlyViolation(sql, dialect) {
  const tx = txControlIn(sql, dialect);
  if (tx) return `${tx} would leave the read-only transaction`;
  for (const stmt of splitStatements(sql, dialect)) {
    const code = blankLiterals(stmt, dialect).trim();
    if (!READ_STATEMENT.test(code)) return `${code.split(/\s+/)[0].toUpperCase()} isn't a read`;
    const escape = ESCAPES[dialect]?.exec(code);
    if (escape) return `${escape[0].replace(/\s+/g, " ").toUpperCase()} reaches outside the read-only transaction`;
  }
  return null;
}
