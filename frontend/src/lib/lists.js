// Choosing a reading list to add something to. Shared because the Library's
// bulk bar and a series page ask the same question, and it has to be asked the
// same way in both: pick an existing list, or make one on the spot.
import { apiGet, apiPost } from './api.js';
import { choiceDialog, inputDialog } from '../components/DialogModal.svelte';
import { notify } from './toasts.svelte.js';
import { t } from './i18n.svelte.js';

/**
 * @param {string} message   what is being added, in the user's terms
 * @param {string} newName   the name to offer for a list created here
 * @returns {Promise<number|null>} the chosen list id, or null if they backed out
 */
export async function pickList({ message, newName = '' }) {
  const r = await apiGet('/api/lists');
  if (r.error) { notify(r.error, 'error'); return null; }
  const buttons = (r.lists || []).map((l) => ({ label: t('lists.listChoice', { name: l.name, count: l.items }), value: l.id }));
  buttons.push({ label: t('lists.newList'), value: 'new' });
  const choice = await choiceDialog({ title: t('lists.addToList'), message, buttons });
  if (!choice) return null;
  if (choice !== 'new') return choice;

  const name = await inputDialog({ title: t('lists.newListTitle'), value: newName, confirmLabel: t('lists.create') });
  if (!name) return null;
  const c = await apiPost('/api/lists', { name });
  if (c.error) { notify(c.error, 'error'); return null; }
  return c.id;
}
