// The live document is authoritative while a delayed save is still completing.
export function saveState(tab) {
  if (!tab?.doc) return null;
  if (tab.saving) return 'saving';
  if (tab.saveError) return 'failed';
  const matches = tab.doc.getValue() === tab.saved;
  if (tab.kind === 'draft') return tab.browserStored && matches ? 'browserSaved' : 'browserPending';
  if (!tab.handle) return 'unsaved';
  return matches ? 'diskSaved' : 'diskUnsaved';
}
