<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { apiGet } from '../lib/api.js';

  const m = $state({ kind: '', name: '', issues: null, loading: false, failed: false });

  const LABEL = { creator: 'Credited on', character: 'Appears in', team: 'Appears in' };

  /** Every issue in the collection crediting this person, or featuring this
   *  character or team. Opened from a chip in the issue modal. */
  export async function openFeaturing(kind, name) {
    m.kind = kind; m.name = name;
    m.issues = null; m.loading = true; m.failed = false;
    openModal('featuring');
    try {
      const r = await apiGet(`/api/issues/featuring?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
      if (r?.error) { m.failed = true; } else { m.issues = r.issues || []; }
    } catch { m.failed = true; }
    m.loading = false;
  }
  export { LABEL };
</script>

<script>
  import { openIssueInfo } from './IssueModal.svelte';
  import { trapFocus } from '../lib/dom.js';
  import { fmt } from '../lib/util.js';
  import Cover from './Cover.svelte';
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('featuring'));
  const ownedCount = $derived((m.issues || []).filter((i) => i.owned).length);
  // Credited roles differ per issue (writer here, cover there), so the role
  // rides on the row rather than the heading.
  function go(i) {
    closeModal('featuring');
    openIssueInfo(i.cv_issue_id, i.issue_number);
  }
</script>

{#if open}
  <div id="featuring-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('featuring'); }}>
    <div class="modal__panel modal__panel--wide fx" use:trapFocus role="dialog" aria-label="{LABEL[m.kind]} {m.name}">
      <div class="modal__head fx__head">
        <h3 class="fx__title">
          <span class="fx__kind">{LABEL[m.kind] || 'In'}</span>
          <span class="fx__name">{m.name}</span>
        </h3>
        {#if m.issues}
          <span class="fx__count">{fmt(m.issues.length)} issue{m.issues.length === 1 ? '' : 's'}{ownedCount ? ` · ${fmt(ownedCount)} owned` : ''}</span>
        {/if}
        <button class="modal__x" aria-label="Close" onclick={() => closeModal('featuring')}><Icon name="close" /></button>
      </div>
      <div class="fx__body">
        {#if m.loading}
          <div class="loading">Searching your collection…</div>
        {:else if m.failed}
          <div class="list-note">Could not search — is the app running?</div>
        {:else if !m.issues?.length}
          <!-- Almost always missing data rather than a real absence: ComicVine
               records characters for a small share of issues, so say so instead
               of implying the collection has none. -->
          <div class="fx__empty">
            <div>Nothing else in your collection lists {m.name}.</div>
            <div class="fx__hint">
              {#if m.kind === 'creator'}
                Credits only exist for issues whose metadata has been downloaded — run <b>Tools → Download issue metadata</b> to cover the rest.
              {:else}
                Character and team listings are sparse at the source: ComicVine records them for a small share of issues, and mostly recent ones.
              {/if}
            </div>
          </div>
        {:else}
          <div class="fx__list">
            {#each m.issues as i (i.cv_issue_id)}
              <button class="fx__row" onclick={() => go(i)}>
                <div class="fx__cover"><Cover coverUrl={i.image_url} title={i.series || '?'} /></div>
                <div class="fx__main">
                  <div class="fx__series">{i.series || 'Unknown series'} <span class="fx__num">#{i.issue_number ?? '?'}</span></div>
                  <div class="fx__sub">{[i.title, i.cover_date].filter(Boolean).join(' · ')}</div>
                </div>
                {#if i.role}<span class="fx__role">{i.role}</span>{/if}
                {#if i.owned}<span class="fx__owned">Owned</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
