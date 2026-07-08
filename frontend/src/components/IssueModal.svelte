<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';

  const m = $state({ cvIssueId: null, number: null, info: null, loading: false, failed: false });

  export async function openIssueInfo(cvIssueId, number) {
    m.cvIssueId = cvIssueId;
    m.number = number;
    m.info = null;
    m.loading = true;
    m.failed = false;
    openModal('issue');
    try { m.info = await (await fetch('/api/issue/' + cvIssueId)).json(); }
    catch { m.failed = true; }
    m.loading = false;
  }
</script>

<script>
  import { detail, flags, downloadCvIssues, redownloadCvIssues, reloadDetail } from '../lib/store.svelte.js';
  import { sanitizeHtml, safeUrl } from '../lib/util.js';
  import { openSourceSearch } from './SourceSearchModal.svelte';
  import { apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { trapFocus } from '../lib/dom.js';
  import { can, isTrusted } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('issue'));
  const info = $derived(m.info && !m.info.error ? m.info : null);
  const dates = $derived(info
    ? [info.store_date && ('In stores ' + info.store_date), info.cover_date && ('Cover date ' + info.cover_date)].filter(Boolean)
    : []);

  async function download() {
    closeModal('issue');
    if (info.owned || info.corrupt) await redownloadCvIssues([m.cvIssueId]);
    else await downloadCvIssues([m.cvIssueId]);
  }
  function searchSources() {
    closeModal('issue');
    openSourceSearch(m.cvIssueId, m.number);
  }

  /* ---- Metadata editor (trusted): edit-in-place; edits lock against refreshes. */
  let editing = $state(false);
  let ef = $state({});
  let saving = $state(false);
  function startEdit() {
    ef = {
      name: info?.name || '', issue_number: info?.number || '',
      cover_date: info?.cover_date || '', store_date: info?.store_date || '',
      description: String(info?.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      metron_rating: info?.metron_rating || '', metron_price: info?.metron_price || '',
      metron_upc: info?.metron_upc || '', metron_isbn: info?.metron_isbn || '',
    };
    editing = true;
  }
  async function saveEdit() {
    const orig = {
      name: info?.name || '', issue_number: info?.number || '',
      cover_date: info?.cover_date || '', store_date: info?.store_date || '',
      description: String(info?.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      metron_rating: info?.metron_rating || '', metron_price: info?.metron_price || '',
      metron_upc: info?.metron_upc || '', metron_isbn: info?.metron_isbn || '',
    };
    const fields = {};
    for (const [k, v] of Object.entries(ef)) if (String(v) !== String(orig[k])) fields[k] = v;
    if (!Object.keys(fields).length) { editing = false; return; }
    saving = true;
    const r = await apiPost(`/api/issue/${m.cvIssueId}/metadata`, { fields });
    saving = false;
    if (r?.error) return notify(r.error, 'error');
    notify(`Saved ${r.updated?.length || 0} field(s) — locked against refreshes until reset.`, 'ok');
    editing = false;
    await openIssueInfo(m.cvIssueId, ef.issue_number || m.number); // re-render fresh
    reloadDetail();
  }
  async function resetEdit() {
    saving = true;
    const r = await apiPost(`/api/issue/${m.cvIssueId}/metadata`, { reset: true });
    saving = false;
    if (r?.error) return notify(r.error, 'error');
    notify('Edits reset — refresh metadata to restore source values.', 'ok');
    editing = false;
    await openIssueInfo(m.cvIssueId, m.number);
  }
</script>

{#if open}
  <div id="issue-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('issue'); }}>
    <div class="modal__panel modal__panel--wide" use:trapFocus role="dialog" aria-label="Issue information">
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <h3 id="issue-modal-title" style="margin:0;flex:1;">{detail.series?.title || 'Issue'} #{m.number ?? '?'}</h3>
        {#if info && isTrusted() && !editing}
          <button class="btn btn--ghost btn--sm" title="Edit this issue's metadata — edits survive refreshes" onclick={startEdit}><Icon name="edit" /> Edit</button>
        {/if}
        <button id="issue-modal-x" class="modal__x" aria-label="Close" onclick={() => closeModal('issue')}><Icon name="close" /></button>
      </div>
      <div id="issue-modal-body" class="issue-info">
        {#if m.loading}
          <div class="loading">Loading…</div>
        {:else if m.failed}
          <div class="list-note">Could not load issue info — is the app running?</div>
        {:else if !info}
          <div class="list-note">No ComicVine info for this issue.</div>
        {:else if editing}
          <!-- Metadata editor: edited fields lock against refreshes until reset. -->
          <div class="em-form">
            <div class="em-grid">
              <label class="em-field"><span>Title {#if info.user_fields?.includes('name')}<span class="em-edited">edited</span>{/if}</span>
                <input type="text" bind:value={ef.name} /></label>
              <label class="em-field"><span>Issue number {#if info.user_fields?.includes('issue_number')}<span class="em-edited">edited</span>{/if}</span>
                <input type="text" bind:value={ef.issue_number} /></label>
            </div>
            <div class="em-grid em-grid--quad">
              <label class="em-field"><span>Cover date</span><input type="text" placeholder="YYYY-MM-DD" bind:value={ef.cover_date} /></label>
              <label class="em-field"><span>Store date</span><input type="text" placeholder="YYYY-MM-DD" bind:value={ef.store_date} /></label>
              <label class="em-field"><span>Rating</span>
                <select bind:value={ef.metron_rating}>{#each ['', 'Everyone', 'Teen', 'Teen Plus', 'Mature', 'Explicit', 'Adult'] as r (r)}<option value={r}>{r || '—'}</option>{/each}</select></label>
              <label class="em-field"><span>Cover price</span><input type="text" inputmode="decimal" bind:value={ef.metron_price} placeholder="3.99" /></label>
            </div>
            <div class="em-grid">
              <label class="em-field"><span>UPC</span><input type="text" bind:value={ef.metron_upc} /></label>
              <label class="em-field"><span>ISBN</span><input type="text" bind:value={ef.metron_isbn} /></label>
            </div>
            <label class="em-field"><span>Description {#if info.user_fields?.includes('description')}<span class="em-edited">edited</span>{/if}</span>
              <textarea rows="4" bind:value={ef.description}></textarea></label>
          </div>
          <div class="editmeta__actions">
            {#if info.user_fields?.length}<button class="btn btn--ghost" disabled={saving} title="Drop every edit on this issue — the next refresh restores source values" onclick={resetEdit}>Reset all edits</button>{/if}
            <span style="flex:1"></span>
            <button class="btn btn--ghost" onclick={() => { editing = false; }}>Cancel</button>
            <button class="btn btn--primary" disabled={saving} onclick={saveEdit}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        {:else}
          <div class="ii-top">
            {#if info.image_url}<img class="ii-cover" src={info.image_url} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
            <div class="ii-head">
              {#if info.name}<div class="ii-name">{info.name}</div>{/if}
              {#if dates.length}<div class="ii-dates">{dates.join(' · ')}</div>{/if}
              <div class="ii-statusrow">
                {#if info.corrupt}<span class="ii-flag ii-flag--bad">corrupt</span>
                {:else if info.owned}<span class="ii-flag ii-flag--ok">owned</span>
                {:else}<span class="ii-flag">not downloaded</span>{/if}
              </div>
            </div>
          </div>
          {#if can('downloads.grab')}
            <div class="ii-actions">
              <button class="btn btn--primary ii-dl" onclick={download}>
                {#if info.corrupt}<Icon name="refresh" /> Replace corrupt file{:else if info.owned}<Icon name="refresh" /> Re-download{:else}<Icon name="download" /> Download{/if}</button>
              {#if flags.anySource}
                <button class="btn btn--ghost ii-usenet" onclick={searchSources}><Icon name="search" /> Search sources</button>
              {/if}
            </div>
          {/if}
          {#if info.metron_price || info.metron_upc || info.metron_isbn || info.metron_rating || info.metron_story_titles?.length || info.metron_reprints?.length || info.metron_variants?.length}
            <!-- Enriched metadata (Metron via the metadata endpoint). -->
            <div class="ii-h">Details</div>
            <div class="ii-enrich">
              {#if info.metron_rating}<span class="ii-cred"><b>rating</b> {info.metron_rating}</span>{/if}
              {#if info.metron_price}<span class="ii-cred"><b>cover price</b> ${info.metron_price}</span>{/if}
              {#if info.metron_upc}<span class="ii-cred"><b>UPC</b> {info.metron_upc}</span>{/if}
              {#if info.metron_isbn}<span class="ii-cred"><b>ISBN</b> {info.metron_isbn}</span>{/if}
              {#if info.metron_foc_date}<span class="ii-cred"><b>final order cutoff</b> {info.metron_foc_date}</span>{/if}
              {#if info.metron_story_titles?.length}
                <span class="ii-cred"><b>stor{info.metron_story_titles.length === 1 ? 'y' : 'ies'}</b> {info.metron_story_titles.join(' · ')}</span>
              {/if}
              {#if info.metron_reprints?.length}
                <span class="ii-cred"><b>reprinted in</b> {info.metron_reprints.map((r) => r.issue || r.name || r).join(' · ')}</span>
              {/if}
              {#if info.metron_variants?.length}
                <span class="ii-cred"><b>variant{info.metron_variants.length === 1 ? '' : 's'}</b> {info.metron_variants.map((v) => v.name || 'variant').slice(0, 6).join(' · ')}{info.metron_variants.length > 6 ? ` +${info.metron_variants.length - 6} more` : ''}</span>
              {/if}
            </div>
          {/if}
          {#if info.story_arc_credits?.length || info.character_credits?.length || info.team_credits?.length}
            <div class="ii-h">Appearing</div>
            <div class="ii-enrich">
              {#if info.story_arc_credits?.length}
                <span class="ii-cred"><b>arc{info.story_arc_credits.length === 1 ? '' : 's'}</b> {info.story_arc_credits.map((a) => a.name).join(' · ')}</span>
              {/if}
              {#if info.character_credits?.length}
                <span class="ii-cred"><b>characters</b> {info.character_credits.slice(0, 10).map((c) => c.name).join(' · ')}{info.character_credits.length > 10 ? ` +${info.character_credits.length - 10} more` : ''}</span>
              {/if}
              {#if info.team_credits?.length}
                <span class="ii-cred"><b>teams</b> {info.team_credits.slice(0, 5).map((t) => t.name).join(' · ')}{info.team_credits.length > 5 ? ` +${info.team_credits.length - 5} more` : ''}</span>
              {/if}
            </div>
          {/if}
          {#if info.credits && info.credits.length}
            <div class="ii-h">Credits</div>
            <div class="ii-credits">
              {#each info.credits as c, i (i)}
                <span class="ii-cred"><b>{c.role || 'credit'}</b> {c.name || ''}</span>
              {/each}
            </div>
          {/if}
          {#if info.description}
            <div class="ii-h">Description</div>
            <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitized above -->
            <div class="ii-desc">{@html sanitizeHtml(info.description)}</div>
          {/if}
          <div class="ii-h">On disk</div>
          {#if info.files && info.files.length}
            <div class="ii-files">
              {#each info.files as f (f.path)}
                <div class="ii-file" class:is-bad={!f.valid} title={f.path}>
                  {#if f.valid}<Icon name="check" />{:else}<Icon name="alert-triangle" />{/if} {f.name}
                  {#if !f.valid}<span class="ii-flag ii-flag--bad">corrupt</span>
                  {:else if !f.has_metadata}<span class="ii-flag">untagged</span>{/if}
                  {#if !f.valid && f.error}<div class="ii-error">Reason: {f.error}</div>{/if}
                </div>
              {/each}
            </div>
          {:else}
            <div class="ii-files ii-missing">Not downloaded yet.</div>
          {/if}
          {#if safeUrl(info.site_detail_url)}
            <a class="ii-cvlink" href={safeUrl(info.site_detail_url)} target="_blank" rel="noreferrer">View on ComicVine <Icon name="external-link" /></a>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}
