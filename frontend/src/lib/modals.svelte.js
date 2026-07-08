// Which modals are open, as a stack (last opened = topmost). Each modal
// component registers here so Escape can close the topmost one.
export const modals = $state({ stack: [] });

export function openModal(name) {
  const i = modals.stack.indexOf(name);
  if (i >= 0) modals.stack.splice(i, 1);
  modals.stack.push(name);
}

export function closeModal(name) {
  const i = modals.stack.indexOf(name);
  if (i >= 0) modals.stack.splice(i, 1);
}

export function isModalOpen(name) { return modals.stack.includes(name); }

// Close the topmost open modal; returns false when none was open.
export function closeTopModal() {
  if (!modals.stack.length) return false;
  modals.stack.pop();
  return true;
}
