// Minimal LCS line diff producing side-by-side rows for the audit report.

export function lineDiff(original, optimized) {
  const a = original.replace(/\n$/, '').split('\n');
  const b = optimized.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;

  // Guard against pathological sizes - fall back to positional pairing.
  if (n * m > 4_000_000) {
    const rows = [];
    for (let i = 0; i < Math.max(n, m); i++) {
      const same = a[i] === b[i];
      rows.push({
        left: i < n ? { n: i + 1, text: a[i], type: same ? 'same' : 'del' } : null,
        right: i < m ? { n: i + 1, text: b[i], type: same ? 'same' : 'add' } : null,
      });
    }
    return rows;
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', i, j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', i });
      i++;
    } else {
      ops.push({ type: 'add', j });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', i: i++ });
  while (j < m) ops.push({ type: 'add', j: j++ });

  // Pair adjacent delete/insert runs into "changed" rows.
  const rows = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'same') {
      const { i: li, j: rj } = ops[k];
      rows.push({ left: { n: li + 1, text: a[li], type: 'same' }, right: { n: rj + 1, text: b[rj], type: 'same' } });
      k++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (k < ops.length && ops[k].type !== 'same') {
      if (ops[k].type === 'del') dels.push(ops[k].i);
      else adds.push(ops[k].j);
      k++;
    }
    for (let r = 0; r < Math.max(dels.length, adds.length); r++) {
      rows.push({
        left: r < dels.length ? { n: dels[r] + 1, text: a[dels[r]], type: 'del' } : null,
        right: r < adds.length ? { n: adds[r] + 1, text: b[adds[r]], type: 'add' } : null,
      });
    }
  }
  return rows;
}

export function diffStats(rows) {
  return rows.reduce(
    (s, r) => {
      if (r.left?.type === 'del') s.removed++;
      if (r.right?.type === 'add') s.added++;
      return s;
    },
    { added: 0, removed: 0 },
  );
}
