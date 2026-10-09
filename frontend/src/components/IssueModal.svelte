<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { patchIssueMeta } from '../lib/store.svelte.js';

  // `tab` lives here, not in the component, so opening an issue can decide
  // whether to keep it: stepping to the next issue stays on the tab you were
  // reading, opening a new issue from the series page starts at Overview.
  const m = $state({ cvIssueId: null, number: null, info: null, loading: false, failed: false, tab: 'overview' });

  export async function openIssueInfo(cvIssueId, number, { keepTab = false } = {}) {
    m.cvIssueId = cvIssueId;
    m.number = number;
    m.info = null;
    m.loading = true;
    m.failed = false;
    if (!keepTab) m.tab = 'overview';
    openModal('issue');
    try {
      m.info = await (await fetch('/api/issue/' + cvIssueId)).json();
      // The fetch just cached this issue's detail server-side — reflect the
      // cover/title on the open series grid immediately, no refresh needed.
      patchIssueMeta(cvIssueId, m.info);
    }
    catch { m.failed = true; }
    m.loading = false;
  }
</script>

<script>
  import { detail, flags, downloadCvIssues, redownloadCvIssues, reloadDetail } from '../lib/store.svelte.js';
  import { issueActions, issueActionsTick } from '../lib/plugins.svelte.js';
  import { sanitizeHtml, safeUrl } from '../lib/util.js';
  import { openSourceSearch } from './SourceSearchModal.svelte';
  import { apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { trapFocus } from '../lib/dom.js';
  import { can, isTrusted } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';
  import { openFeaturing } from './FeaturingModal.svelte';

  const open = $derived(modals.stack.includes('issue'));
  const info = $derived(m.info && !m.info.error ? m.info : null);
  const dates = $derived(info
    ? [info.store_date && { label: 'In stores', value: info.store_date },
       info.cover_date && { label: 'Cover date', value: info.cover_date }].filter(Boolean)
    : []);

  /* ---- Where this issue sits in the run, so you can walk it without going
     back to the series page. The list is already loaded for the move picker. */
  const siblings = $derived(detail.det?.issues || []);
  const posIndex = $derived(siblings.findIndex((i) => i.cv_issue_id === m.cvIssueId));
  const posText = $derived(posIndex >= 0 && siblings.length ? `${posIndex + 1} of ${siblings.length}` : '');
  function step(delta) {
    const next = siblings[posIndex + delta];
    if (next) openIssueInfo(next.cv_issue_id, next.number, { keepTab: true });
  }

  /* ---- Status: one word for what this issue is, shown on the cover. */
  const status = $derived(
    !info ? null
      : info.corrupt ? { text: 'Corrupt', kind: 'bad', icon: 'alert-triangle' }
      : info.owned ? { text: 'Owned', kind: 'ok', icon: 'check' }
      : { text: 'Not downloaded', kind: 'none', icon: null },
  );

  /* ---- Tabs. Counts are the point: they say whether a tab is worth opening. */
  const chars = $derived(info?.character_credits?.map((c) => c.name) || []);
  const arcs = $derived(info?.story_arc_credits?.map((a) => a.name) || []);
  const teams = $derived(info?.team_credits?.map((t) => t.name) || []);
  const fileCount = $derived(info?.files?.length || 0);
  const tabs = $derived([
    { id: 'overview', label: 'Overview', count: '' },
    { id: 'credits', label: 'Credits', count: info?.credits?.length ? String(info.credits.length) : '' },
    { id: 'appearing', label: 'Appearing', count: chars.length + arcs.length + teams.length ? String(chars.length + arcs.length + teams.length) : '' },
    { id: 'files', label: 'Files', count: fileCount ? String(fileCount) : '' },
  ]);

  // One row per role rather than one per person: "cover — Romita Jr., Menyz".
  // First-seen order, because that is the order a cover credits them.
  const creditGroups = $derived.by(() => {
    const roles = new Map();
    for (const c of info?.credits || []) {
      const r = c.role || 'credit';
      roles.set(r, [...(roles.get(r) || []), c.name].filter(Boolean));
    }
    return [...roles].map(([role, names]) => ({ role, list: names }));
  });

  // Only facts that have a value — an empty grid cell says nothing.
  const facts = $derived([
    ['Rating', info?.metron_rating],
    ['Cover price', info?.metron_price && '$' + info.metron_price],
    ['Final order cutoff', info?.metron_foc_date],
    ['UPC', info?.metron_upc],
    ['ISBN', info?.metron_isbn],
    ['Page count', info?.metron_page_count],
  ].filter(([, v]) => v).map(([label, value]) => ({ label, value })));

  // Reading is the point of an owned issue, so the reader's own open action
  // leads the column — found by id, not hard-coded, so the plugin still owns
  // its label, icon and behaviour. Without the plugin nothing claims the lead
  // and the download button takes it.
  const READ_ACTION = 'reader';
  const hasRead = $derived(info ? issueActions.some((a) => a.id === READ_ACTION && (!a.when || a.when({ ...info, cv_issue_id: m.cvIssueId }))) : false);

  const CHAR_CAP = 10;
  let showAllChars = $state(false);
  $effect(() => { void m.cvIssueId; showAllChars = false; });   // per issue
  const appearing = $derived([
    // `kind` is what the chip looks up; story arcs have no lookup of their own,
    // so those chips stay plain text rather than pretending to be clickable.
    { label: 'Story arcs', tint: 'arc', kind: null, all: arcs, items: arcs },
    { label: 'Characters', tint: 'char', kind: 'character', all: chars, items: showAllChars ? chars : chars.slice(0, CHAR_CAP) },
    { label: 'Teams', tint: 'team', kind: 'team', all: teams, items: teams },
  ].filter((g) => g.all.length));

  const reprints = $derived(info?.metron_reprints?.map((r) => r.issue || r.name || r) || []);
  const variants = $derived(info?.metron_variants?.map((v) => v.name || 'variant') || []);

  // Move a file that landed under the wrong issue (its number read wrongly)
  // to the right one — or undo a hand assignment. Same route the series
  // page's unmatched-file picker uses; the choice sticks through rescans.
  let movePick = $state({});
  const otherIssues = $derived(siblings.filter((i) => i.cv_issue_id !== m.cvIssueId));
  const issueChoice = (i) => `#${i.number}${i.title && i.title !== '#' + i.number ? ' · ' + i.title : ''}${i.owned ? ' (owned)' : ''}`;
  const folderOf = (p) => String(p || '').replace(/[\\/][^\\/]+$/, '');
  async function setAssignment(f, cvIssueId) {
    const sid = f.series_id ?? detail.series?.id;
    if (!sid) return;
    const r = await apiPost(`/api/collection/${sid}/assign-file`, { path: f.path, cvIssueId }).catch((e) => ({ error: String(e) }));
    if (r?.error) return notify(r.error, 'error');
    notify(cvIssueId ? 'File moved to that issue — the assignment is remembered through rescans.' : 'Assignment cleared — the file links by its number again.', 'ok');
    delete movePick[f.path];
    await openIssueInfo(m.cvIssueId, m.number, { keepTab: true });
    reloadDetail();
  }

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
  const EDIT_FIELDS = ['name', 'issue_number', 'cover_date', 'store_date', 'description', 'metron_rating', 'metron_price', 'metron_upc', 'metron_isbn'];
  const RATINGS = ['', 'Everyone', 'Teen', 'Teen Plus', 'Mature', 'Explicit', 'Adult'];
  let editing = $state(false);
  let ef = $state({});
  let saving = $state(false);
  const plainDesc = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const editSnapshot = () => ({
    name: info?.name || '', issue_number: info?.number || '',
    cover_date: info?.cover_date || '', store_date: info?.store_date || '',
    description: plainDesc(info?.description),
    metron_rating: info?.metron_rating || '', metron_price: info?.metron_price || '',
    metron_upc: info?.metron_upc || '', metron_isbn: info?.metron_isbn || '',
  });
  // Every editable field shows its edited state, not just the three that used to.
  const edited = (f) => !!info?.user_fields?.includes(f);
  function startEdit() { ef = editSnapshot(); editing = true; }
  async function saveEdit() {
    const orig = editSnapshot();
    const fields = {};
    for (const [k, v] of Object.entries(ef)) if (String(v) !== String(orig[k])) fields[k] = v;
    if (!Object.keys(fields).length) { editing = false; return; }
    saving = true;
    const r = await apiPost(`/api/issue/${m.cvIssueId}/metadata`, { fields });
    saving = false;
    if (r?.error) return notify(r.error, 'error');
    notify(`Saved ${r.updated?.length || 0} field(s) — locked against refreshes until reset.`, 'ok');
    editing = false;
    await openIssueInfo(m.cvIssueId, ef.issue_number || m.number, { keepTab: true }); // re-render fresh
    reloadDetail();
  }
  async function resetEdit() {
    saving = true;
    const r = await apiPost(`/api/issue/${m.cvIssueId}/metadata`, { reset: true });
    saving = false;
    if (r?.error) return notify(r.error, 'error');
    notify('Edits reset — refresh metadata to restore source values.', 'ok');
    editing = false;
    await openIssueInfo(m.cvIssueId, m.number, { keepTab: true });
  }
</script>

{#if open}
  <div id="issue-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('issue'); }}>
    <div class="modal__panel modal__panel--wide ix" use:trapFocus role="dialog" aria-label="Issue information">
      <div class="modal__head ix__head">
        <h3 id="issue-modal-title" class="ix__title">
          <span class="ix__series">{detail.series?.title || 'Issue'}</span>
          <span class="ix__num">#{m.number ?? '?'}</span>
        </h3>
        {#if posText}<span class="ix__pos">{posText}</span>{/if}
        <button class="ix__nav" aria-label="Previous issue" title="Previous issue"
          disabled={posIndex <= 0} onclick={() => step(-1)}><Icon name="chevron-left" size={16} /></button>
        <button class="ix__nav" aria-label="Next issue" title="Next issue"
          disabled={posIndex < 0 || posIndex >= siblings.length - 1} onclick={() => step(1)}><Icon name="chevron-right" size={16} /></button>
        {#if info && isTrusted() && !editing}
          <button class="btn btn--ghost btn--sm" title="Edit this issue's metadata — edits survive refreshes" onclick={startEdit}><Icon name="edit" /> Edit</button>
        {/if}
        <button id="issue-modal-x" class="modal__x" aria-label="Close" onclick={() => closeModal('issue')}><Icon name="close" /></button>
      </div>

      <div id="issue-modal-body" class="ix__body">
        {#if m.loading}
          <div class="loading">Loading…</div>
        {:else if m.failed}
          <div class="list-note">Could not load issue info — is the app running?</div>
        {:else if !info}
          <div class="list-note">No ComicVine info for this issue.</div>
        {:else}
          <div class="ix__grid">
            <!-- ===== Left: cover + every action, so actions never scroll away ===== -->
            <div class="ix__left">
              <div class="ix__cover">
                {#if info.image_url}
                  <img src={info.image_url} alt="" loading="lazy" referrerpolicy="no-referrer" />
                {:else}
                  <span class="ix__covernum">#{m.number ?? '?'}</span>
                {/if}
                {#if status}
                  <span class="ix__status ix__status--{status.kind}">
                    {#if status.icon}<Icon name={status.icon} size={13} />{/if}{status.text}
                  </span>
                {/if}
              </div>

              <!-- The reader plugin's per-issue actions (Read, mark read, read
                   later). Rendered from the registry, never hard-coded: with no
                   reader installed the download action becomes the top of the
                   column on its own. -->
              {#if issueActions.length}
                {@const issue = { ...info, cv_issue_id: m.cvIssueId }}
                <!-- Read leads the column, so it is first in it too; everything
                     else keeps the order its plugin registered. -->
                {@const shown = issueActions.filter((a) => !a.when || a.when(issue))
                  .sort((x, y) => (y.id === READ_ACTION) - (x.id === READ_ACTION))}
                {#each shown as a (a.id + ':' + issueActionsTick.n)}
                  <button class="btn {a.id === READ_ACTION ? 'btn--primary ix__act--lead' : 'btn--ghost'} ix__act"
                    onclick={() => { closeModal('issue'); a.run(issue, detail.series); }}>
                    {@html typeof a.icon === 'function' ? a.icon(issue) : a.icon}
                    {typeof a.title === 'function' ? a.title(issue) : a.title}
                  </button>
                {/each}
              {/if}

              {#if can('downloads.grab')}
                <!-- A corrupt file is the loudest problem here, so replacing it
                     leads; an owned, healthy issue demotes re-download. -->
                <button class="btn ix__act {info.corrupt ? 'ix__act--danger ix__act--lead' : (info.owned && hasRead) ? 'btn--ghost' : 'btn--primary ix__act--lead'}"
                  onclick={download}>
                  {#if info.corrupt}<Icon name="refresh" /> Replace corrupt file
                  {:else if info.owned}<Icon name="refresh" /> Re-download
                  {:else}<Icon name="download" /> Download{/if}
                </button>
                {#if flags.anySource}
                  <button class="btn btn--ghost ix__act" onclick={searchSources}><Icon name="search" /> Search sources</button>
                {/if}
              {/if}

              {#if safeUrl(info.site_detail_url)}
                <a class="ix__cvlink" href={safeUrl(info.site_detail_url)} target="_blank" rel="noreferrer">View on ComicVine <Icon name="external-link" size={13} /></a>
              {/if}
            </div>

            <!-- ===== Right ===== -->
            <div class="ix__right">
              {#if editing}
                <div class="ix__edithead">
                  <span class="ix__editt">Edit metadata</span>
                  <span class="ix__editnote">Edited fields are locked against refreshes until reset.</span>
                </div>
                <div class="ix__row ix__row--title">
                  <label class="ix__field"><span>Title {#if edited('name')}<span class="ix__edited">edited</span>{/if}</span>
                    <input type="text" class:is-edited={edited('name')} bind:value={ef.name} /></label>
                  <label class="ix__field"><span>Issue number {#if edited('issue_number')}<span class="ix__edited">edited</span>{/if}</span>
                    <input type="text" class:is-edited={edited('issue_number')} bind:value={ef.issue_number} /></label>
                </div>
                <div class="ix__row ix__row--quad">
                  <label class="ix__field"><span>Cover date {#if edited('cover_date')}<span class="ix__edited">edited</span>{/if}</span>
                    <input type="text" placeholder="YYYY-MM-DD" class:is-edited={edited('cover_date')} bind:value={ef.cover_date} /></label>
                  <label class="ix__field"><span>Store date {#if edited('store_date')}<span class="ix__edited">edited</span>{/if}</span>
                    <input type="text" placeholder="YYYY-MM-DD" class:is-edited={edited('store_date')} bind:value={ef.store_date} /></label>
                  <label class="ix__field"><span>Rating {#if edited('metron_rating')}<span class="ix__edited">edited</span>{/if}</span>
                    <select class:is-edited={edited('metron_rating')} bind:value={ef.metron_rating}>{#each RATINGS as r (r)}<option value={r}>{r || '—'}</option>{/each}</select></label>
                  <label class="ix__field"><span>Cover price {#if edited('metron_price')}<span class="ix__edited">edited</span>{/if}</span>
                    <input type="text" inputmode="decimal" placeholder="3.99" class:is-edited={edited('metron_price')} bind:value={ef.metron_price} /></label>
                </div>
                <div class="ix__row">
                  <label class="ix__field"><span>UPC {#if edited('metron_upc')}<span class="ix__edited">edited</span>{/if}</span>
                    <input type="text" class:is-edited={edited('metron_upc')} bind:value={ef.metron_upc} /></label>
                  <label class="ix__field"><span>ISBN {#if edited('metron_isbn')}<span class="ix__edited">edited</span>{/if}</span>
                    <input type="text" class:is-edited={edited('metron_isbn')} bind:value={ef.metron_isbn} /></label>
                </div>
                <label class="ix__field"><span>Description {#if edited('description')}<span class="ix__edited">edited</span>{/if}</span>
                  <textarea rows="5" class:is-edited={edited('description')} bind:value={ef.description}></textarea></label>
                <div class="ix__editactions">
                  {#if info.user_fields?.length}
                    <button class="btn ix__reset" disabled={saving} title="Drop every edit on this issue — the next refresh restores source values" onclick={resetEdit}>Reset all edits</button>
                  {/if}
                  <span style="flex:1"></span>
                  <button class="btn btn--ghost" onclick={() => { editing = false; }}>Cancel</button>
                  <button class="btn btn--primary" disabled={saving} onclick={saveEdit}>{saving ? 'Saving…' : 'Save'}</button>
                </div>
              {:else}
                {#if info.name}<div class="ix__name">{info.name}</div>{/if}
                {#if dates.length}
                  <div class="ix__dates">{#each dates as d (d.label)}<span>{d.label} <b>{d.value}</b></span>{/each}</div>
                {/if}

                <div class="ix__tabs" role="tablist">
                  {#each tabs as t (t.id)}
                    <button class="ix__tab" class:is-on={m.tab === t.id} role="tab" aria-selected={m.tab === t.id}
                      onclick={() => { m.tab = t.id; }}>{t.label}{#if t.count}<span class="ix__tabn">{t.count}</span>{/if}</button>
                  {/each}
                </div>

                {#if m.tab === 'overview'}
                  {#if info.description}
                    <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitized above -->
                    <div class="ix__desc">{@html sanitizeHtml(info.description)}</div>
                  {/if}
                  {#if facts.length}
                    <div class="ix__facts">
                      {#each facts as f (f.label)}
                        <div class="ix__fact"><div class="ix__factk">{f.label}</div><div class="ix__factv">{f.value}</div></div>
                      {/each}
                    </div>
                  {/if}
                  {#if info.metron_story_titles?.length}
                    <div class="ix__sub">Stories</div>
                    {#each info.metron_story_titles as s, i (s + i)}<div class="ix__story">{s}</div>{/each}
                  {/if}
                  {#if reprints.length}
                    <div class="ix__sub">Reprinted in</div>
                    {#each reprints as r, i (r + i)}<div class="ix__story">{r}</div>{/each}
                  {/if}
                  {#if variants.length}
                    <div class="ix__sub">Variants · {variants.length}</div>
                    <div class="ix__chips">{#each variants as v, i (v + i)}<span class="ix__chip">{v}</span>{/each}</div>
                  {/if}
                  {#if !info.description && !facts.length && !info.metron_story_titles?.length && !variants.length}
                    <div class="list-note">No details for this issue yet.</div>
                  {/if}

                {:else if m.tab === 'credits'}
                  {#if creditGroups.length}
                    <div class="ix__rows">
                      {#each creditGroups as c (c.role)}
                        <div class="ix__crow">
                          <span class="ix__crole">{c.role}</span>
                          <span class="ix__cnames">
                            {#each c.list as person, i (person + i)}<button class="ix__person" title="Find other issues credited to {person}"
                              onclick={() => openFeaturing('creator', person)}>{person}</button>{#if i < c.list.length - 1}<span class="ix__sep">, </span>{/if}{/each}
                          </span>
                        </div>
                      {/each}
                    </div>
                  {:else}<div class="list-note">No credits for this issue.</div>{/if}

                {:else if m.tab === 'appearing'}
                  {#if appearing.length}
                    {#each appearing as g (g.label)}
                      <div class="ix__sub">{g.label} · {g.all.length}</div>
                      <div class="ix__chips">
                        {#each g.items as item, i (item + i)}
                          {#if g.kind}
                            <button class="ix__chip ix__chip--{g.tint} ix__chip--link" title="Find {item} elsewhere in your collection"
                              onclick={() => openFeaturing(g.kind, item)}>{item}</button>
                          {:else}
                            <span class="ix__chip ix__chip--{g.tint}">{item}</span>
                          {/if}
                        {/each}
                        {#if g.all.length > g.items.length}
                          <button class="ix__more" onclick={() => { showAllChars = true; }}>+{g.all.length - g.items.length} more</button>
                        {/if}
                      </div>
                    {/each}
                  {:else}<div class="list-note">Nothing recorded as appearing in this issue.</div>{/if}

                {:else if m.tab === 'files'}
                  {#if info.files?.length}
                    {#each info.files as f (f.path)}
                      <div class="ix__file" class:is-bad={!f.valid}>
                        <div class="ix__filetop">
                          <span class="ix__fileicon" class:is-bad={!f.valid}>
                            <Icon name={f.valid ? 'check' : 'alert-triangle'} size={15} />
                          </span>
                          <div class="ix__filemain">
                            <div class="ix__filename" title={f.path}>{f.name}</div>
                            <div class="ix__filedir" title={f.path}>{folderOf(f.path)}</div>
                          </div>
                          {#if !f.valid}<span class="ix__flag ix__flag--bad">Corrupt</span>
                          {:else if !f.has_metadata}<span class="ix__flag">Untagged</span>
                          {:else}<span class="ix__flag ix__flag--ok">Tagged</span>{/if}
                          {#if f.assigned}<span class="ix__flag">Assigned by hand</span>{/if}
                        </div>
                        {#if !f.valid && f.error}<div class="ix__fileerr">Reason: {f.error}</div>{/if}
                        {#if (isTrusted() || can('library.manage')) && otherIssues.length}
                          <div class="ix__move">
                            <select aria-label="Move {f.name} to another issue" bind:value={movePick[f.path]}>
                              <option value="">Move to another issue…</option>
                              {#each otherIssues as i (i.cv_issue_id)}<option value={i.cv_issue_id}>{issueChoice(i)}</option>{/each}
                            </select>
                            <button class="btn btn--ghost btn--sm" disabled={!movePick[f.path]} onclick={() => setAssignment(f, Number(movePick[f.path]))}>Move</button>
                            {#if f.assigned}<button class="btn btn--ghost btn--sm" onclick={() => setAssignment(f, null)}>Undo assignment</button>{/if}
                          </div>
                        {/if}
                      </div>
                    {/each}
                  {:else}
                    <div class="ix__empty">Not downloaded yet.</div>
                  {/if}
                {/if}
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
