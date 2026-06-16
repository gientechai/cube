#!/usr/bin/env node

/*
 * PROTOTYPE - throwaway logic probe.
 *
 * Question: can Kingbase Oracle Placeholder Normalization convert Oracle-style
 * bind tokens to Postgres-compatible placeholders while preserving parameter
 * order and avoiding quoted SQL text?
 */

const readline = require('readline');

const scenarios = [
  {
    name: 'filters',
    sql: 'select * from orders where status = :"?" and amount > :"?"',
    values: ['paid', 100],
  },
  {
    name: 'repeated named bind',
    sql: 'select * from orders where created_at >= :"from" and updated_at >= :"from"',
    values: ['2026-01-01'],
  },
  {
    name: 'in list',
    sql: 'select * from orders where id in (:"?", :"?", :"?")',
    values: [10, 20, 30],
  },
  {
    name: 'quoted literals',
    sql: "select ':\"?\"' as literal, name from users where name = :\"?\" and note = 'keep :\"name\"'",
    values: ['Ada'],
  },
  {
    name: 'timestamp cast',
    sql: 'select * from events where ts >= TO_TIMESTAMP_TZ(:"?", \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\')',
    values: ['2026-06-16T00:00:00.000Z'],
  },
  {
    name: 'double quoted identifier',
    sql: 'select :"?" as bind_value, "literal :""?""" as odd_identifier from dual',
    values: ['value'],
  },
  {
    name: 'comments',
    sql: 'select :"?" as bind_value -- keep :"?" in line comment\nfrom dual /* keep :"?" in block comment */',
    values: ['value'],
  },
];

function normalizeKingbaseOraclePlaceholders(sql, values) {
  let nextIndex = 0;
  const named = new Map();
  let output = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      output += ch;
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      output += ch;
      if (ch === '*' && next === '/') {
        output += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (ch === "'") {
      output += ch;
      if (!inDoubleQuote && inSingleQuote && next === "'") {
        output += next;
        i++;
      } else if (!inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (!inSingleQuote && ch === '"') {
      output += ch;
      if (inDoubleQuote && next === '"') {
        output += next;
        i++;
      } else {
        inDoubleQuote = !inDoubleQuote;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === '-' && next === '-') {
      output += ch + next;
      i++;
      inLineComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === '/' && next === '*') {
      output += ch + next;
      i++;
      inBlockComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === ':' && next === '"') {
      const end = sql.indexOf('"', i + 2);
      if (end !== -1) {
        const token = sql.slice(i + 2, end);
        if (token === '?') {
          output += `$${++nextIndex}`;
        } else {
          if (!named.has(token)) {
            named.set(token, ++nextIndex);
          }
          output += `$${named.get(token)}`;
        }
        i = end;
        continue;
      }
    }

    output += ch;
  }

  return {
    sql: output,
    values,
    consumedPlaceholders: nextIndex,
    valueCount: values.length,
    status: nextIndex === values.length ? 'ok' : 'needs policy',
  };
}

let selected = 0;
let last = normalizeKingbaseOraclePlaceholders(scenarios[selected].sql, scenarios[selected].values);

function render() {
  console.clear();
  const scenario = scenarios[selected];
  console.log('\x1b[1mKingbase Oracle Placeholder Normalization Prototype\x1b[0m');
  console.log('\x1b[2mPROTOTYPE - throwaway; validates binding-boundary behavior only.\x1b[0m\n');
  console.log(`\x1b[1mScenario\x1b[0m: ${scenario.name}`);
  console.log(`\x1b[1mInput SQL\x1b[0m:\n${scenario.sql}\n`);
  console.log(`\x1b[1mInput values\x1b[0m:\n${JSON.stringify(scenario.values, null, 2)}\n`);
  console.log(`\x1b[1mNormalized state\x1b[0m:\n${JSON.stringify(last, null, 2)}\n`);
  console.log('\x1b[1mKeys\x1b[0m: [n] next  [p] previous  [r] rerun  [q] quit');
}

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on('keypress', (_, key) => {
  if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
    process.exit(0);
  }
  if (key.name === 'n') {
    selected = (selected + 1) % scenarios.length;
  }
  if (key.name === 'p') {
    selected = (selected + scenarios.length - 1) % scenarios.length;
  }
  last = normalizeKingbaseOraclePlaceholders(scenarios[selected].sql, scenarios[selected].values);
  render();
});

render();
