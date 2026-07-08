<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';

  // The two indexer lists (usenet/newznab, torrent/torznab) share this ONE
  // modal — only these per-mode bits differ. Add a mode, not another modal.
  const MODES = {
    newznab: { endpoint: '/api/indexers/test', label: 'indexer' },
    torznab: { endpoint: '/api/torznab/test', label: 'torrent indexer' },
  };

  const m = $state({ mode: 'newznab', editIndex: -1, name: '', url: '', apiKey: '', result: null, onSave: null });

  // onSave(ix, editIndex, mode) — the Settings page owns the lists.
  export function openIndexerModal(index, mode, existing, onSave) {
    m.mode = mode;
    m.editIndex = index;
    m.name = existing?.name || '';
    m.url = existing?.url || '';
    m.apiKey = existing?.apiKey || '';
    m.result = null;
    m.onSave = onSave;
    openModal('indexer');
  }

  export async function testIndexer(ix, endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: ix.name, url: ix.url, apiKey: ix.apiKey }),
      });
      return await res.json();
    } catch (e) { return { ok: false, message: String(e) }; }
  }
</script>

<script>
  import { trapFocus } from '../lib/dom.js';
  import Icon from '../lib/Icon.svelte';
  const open = $derived(modals.stack.includes('indexer'));

  let urlEl = $state(null);
  $effect(() => { if (open && urlEl) urlEl.focus(); });

  function readForm() {
    return { name: m.name.trim(), url: m.url.trim().replace(/\/+$/, ''), apiKey: m.apiKey.trim() };
  }

  async function test() {
    const ix = readForm();
    if (!ix.url) { m.result = { cls: 'is-bad', text: 'Enter a URL first.' }; return; }
    m.result = { cls: 'is-testing', text: 'Testing…' };
    const r = await testIndexer(ix, MODES[m.mode].endpoint);
    m.result = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.message };
  }

  function save() {
    const ix = readForm();
    if (!ix.url) { m.result = { cls: 'is-bad', text: 'A URL is required.' }; return; }
    if (!ix.name) ix.name = ix.url.replace(/^https?:\/\//, '');
    m.onSave?.(ix, m.editIndex, m.mode);
    closeModal('indexer');
  }
</script>

{#if open}
  <div id="indexer-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('indexer'); }}>
    <div class="modal__panel" use:trapFocus role="dialog" aria-label="Indexer">
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 id="indexer-modal-title" style="margin:0;">{(m.editIndex >= 0 ? 'Edit ' : 'Add ') + MODES[m.mode].label}</h3>
        <button id="indexer-modal-x" class="modal__x" aria-label="Close" onclick={() => closeModal('indexer')}><Icon name="close" /></button>
      </div>
      <div class="modal__body">
        <label class="field field--col"><span>Name</span><input id="ix-name" type="text" spellcheck="false" placeholder="NZBgeek" bind:value={m.name} /></label>
        <label class="field field--col"><span>URL</span><input id="ix-url" type="text" spellcheck="false" placeholder="https://api.nzbgeek.info" bind:this={urlEl} bind:value={m.url} /></label>
        <label class="field field--col"><span>API key</span><input id="ix-apikey" type="text" spellcheck="false" bind:value={m.apiKey} /></label>
        {#if m.result}
          <div id="ix-test-result" class="ix-result {m.result.cls}">{#if m.result.icon}<Icon name={m.result.icon} /> {/if}{m.result.text}</div>
        {/if}
      </div>
      <div class="modal__foot">
        <button id="ix-test" class="btn btn--ghost" type="button" onclick={test}>Test</button>
        <span class="modal__foot-spacer"></span>
        <button id="ix-cancel" class="btn btn--ghost" type="button" onclick={() => closeModal('indexer')}>Cancel</button>
        <button id="ix-save" class="btn btn--primary" type="button" onclick={save}>Save</button>
      </div>
    </div>
  </div>
{/if}
