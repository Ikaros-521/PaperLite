import { diffLines, diffWordsWithSpace } from 'diff';

// Bound expensive comparisons; even the fallback preserves every source line.
export function compareVersions(before, after) {
  const parts = diffLines(before, after, { timeout: 150, maxEditLength: 3000 }) || [
    { value: before, removed: true }, { value: after, added: true }
  ];
  const lines = value => value ? value.match(/[^\n]*\n|[^\n]+$/g) || [] : [];
  let oldLine = 0, newLine = 0, added = 0, removed = 0;
  const rows = [], changes = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (const text of lines(part.value)) rows.push({ left: text, right: text, oldLine: ++oldLine, newLine: ++newLine });
      continue;
    }
    changes.push(rows.length);
    const deleted = part.removed ? lines(part.value) : [];
    let inserted = part.added ? lines(part.value) : [];
    if (part.removed && parts[i + 1]?.added) inserted = lines(parts[++i].value);
    removed += deleted.length; added += inserted.length;
    for (let j = 0; j < Math.max(deleted.length, inserted.length); j++) {
      rows.push({ left: deleted[j], right: inserted[j], oldLine: j < deleted.length ? ++oldLine : null, newLine: j < inserted.length ? ++newLine : null, changed: true });
    }
  }
  return { rows, changes, added, removed };
}

export function inlineChanges(before, after) {
  if (before === undefined || after === undefined || before.length + after.length > 4000) return null;
  return diffWordsWithSpace(before, after, { timeout: 10 });
}
