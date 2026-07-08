<script module>
  // In-app replacement for window.confirm/prompt — those block the event loop
  // (freezing every poll) and can't be styled. Promise-based:
  //   await confirmDialog({ title, message, confirmLabel, danger })  → boolean
  //   await inputDialog({ title, message, value, textarea, placeholder }) → string | null
  //   await choiceDialog({ title, message, buttons: [{ label, value, danger }] }) → value | null
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import Icon from '../lib/Icon.svelte';

  const m = $state({ title: '', message: '', input: null, textarea: false, placeholder: '', buttons: [] });
  let resolvePending = null;

  function open(opts, resolve) {
    // Settle any dialog already up (treated as cancelled).
    if (resolvePending) resolvePending(null);
    m.title = opts.title || '';
    m.message = opts.message || '';
    m.input = opts.input != null ? String(opts.input) : null;
    m.textarea = !!opts.textarea;
    m.placeholder = opts.placeholder || '';
    m.buttons = opts.buttons;
    resolvePending = resolve;
    openModal('dialog');
  }

  // Called by the component (and by closeTopModal via the modal stack).
  export function settleDialog(value) {
    const r = resolvePending;
    resolvePending = null;
    closeModal('dialog');
    if (r) r(value);
  }

  export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'OK', danger = false } = {}) {
    return new Promise((resolve) => open({
      title, message,
      buttons: [
        { label: 'Cancel', value: null, ghost: true },
        { label: confirmLabel, value: true, danger },
      ],
    }, (v) => resolve(v === true)));
  }

  export function choiceDialog({ title = '', message = '', buttons = [] } = {}) {
    return new Promise((resolve) => open({
      title, message,
      buttons: [{ label: 'Cancel', value: null, ghost: true }, ...buttons],
    }, resolve));
  }

  export function inputDialog({ title = '', message = '', value = '', textarea = false, placeholder = '', confirmLabel = 'Save' } = {}) {
    return new Promise((resolve) => open({
      title, message, input: value, textarea, placeholder,
      buttons: [
        { label: 'Cancel', value: null, ghost: true },
        { label: confirmLabel, value: 'submit' },
      ],
    }, resolve));
  }
</script>

<script>
  import { trapFocus } from '../lib/dom.js';
  const open_ = $derived(modals.stack.includes('dialog'));

  // If Escape (closeTopModal) removed us from the stack, settle as cancelled.
  $effect(() => {
    if (!open_ && resolvePending) settleDialog(null);
  });

  let inputEl = $state(null);
  $effect(() => { if (open_ && inputEl) { inputEl.focus(); inputEl.select?.(); } });

  function pick(b) {
    if (b.value === 'submit' && m.input != null) settleDialog(m.input);
    else settleDialog(b.value);
  }
  function onKeydown(e) {
    if (e.key === 'Enter' && !m.textarea && m.input != null) { e.preventDefault(); settleDialog(m.input); }
  }
</script>

{#if open_}
  <div id="dialog-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) settleDialog(null); }}>
    <div class="modal__panel" use:trapFocus role="dialog" aria-label={m.title || 'Confirm'}>
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">{m.title}</h3>
        <button class="modal__x" aria-label="Close" onclick={() => settleDialog(null)}><Icon name="close" /></button>
      </div>
      <div class="modal__body">
        {#if m.message}<p class="dialog-message">{m.message}</p>{/if}
        {#if m.input != null}
          {#if m.textarea}
            <textarea class="dialog-input" rows="4" spellcheck="false" placeholder={m.placeholder} bind:this={inputEl} bind:value={m.input}></textarea>
          {:else}
            <input class="dialog-input" type="text" spellcheck="false" placeholder={m.placeholder} bind:this={inputEl} bind:value={m.input} onkeydown={onKeydown} />
          {/if}
        {/if}
      </div>
      <div class="modal__foot">
        {#each m.buttons as b, i (i)}
          {#if b.ghost}
            <button class="btn btn--ghost" onclick={() => pick(b)}>{b.label}</button>
            <span class="modal__foot-spacer"></span>
          {:else}
            <button class="btn {b.danger ? 'btn--ghost btn--danger' : 'btn--primary'}" onclick={() => pick(b)}>{b.label}</button>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}
