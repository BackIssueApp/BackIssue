<script module>
  // Account self-service: change your own password. openAccountModal() from
  // the sidebar's user menu.
  let openFn = () => {};
  export function openAccountModal() { openFn(); }
</script>

<script>
  import { apiPost } from '../lib/api.js';
  import Icon from '../lib/Icon.svelte';
  import { auth } from '../lib/auth.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { trapFocus } from '../lib/dom.js';

  let open = $state(false);
  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let error = $state('');
  openFn = () => { open = true; current = next = confirm = ''; error = ''; };

  async function submit() {
    error = '';
    if (next !== confirm) { error = 'new passwords do not match'; return; }
    const r = await apiPost('/api/auth/password', { current, next });
    if (r.error) { error = r.error; return; }
    open = false;
    notify('Password changed.', 'ok');
  }
</script>

{#if open}
  <div class="modal" onclick={(e) => { if (e.target === e.currentTarget) open = false; }} role="presentation">
    <div class="modal__panel" use:trapFocus role="dialog" aria-label="Account">
      <div class="modal__head"><h3>Account — {auth.user?.username}</h3>
        <button class="modal__x" aria-label="Close" onclick={() => { open = false; }}><Icon name="close" /></button></div>
      <form class="modal__body" onsubmit={(e) => { e.preventDefault(); submit(); }}>
        <label class="field field--col">Current password
          <input type="password" class="dialog-input" autocomplete="current-password" bind:value={current} required /></label>
        <label class="field field--col">New password (8+ characters)
          <input type="password" class="dialog-input" autocomplete="new-password" bind:value={next} required minlength="8" /></label>
        <label class="field field--col">Confirm new password
          <input type="password" class="dialog-input" autocomplete="new-password" bind:value={confirm} required /></label>
        {#if error}<div class="authgate__error">{error}</div>{/if}
        <div class="modal__foot" style="padding: 0; border: none;">
          <button type="button" class="btn btn--ghost" onclick={() => { open = false; }}>Cancel</button>
          <button class="btn btn--primary">Change password</button>
        </div>
      </form>
    </div>
  </div>
{/if}
