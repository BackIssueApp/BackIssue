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
  import { t, st } from '../lib/i18n.svelte.js';

  const open = $derived(modals.stack.includes('issue'));
  const info = $derived(m.info && !m.info.error ? m.info : null);
  const dates = $derived(info
    ? [info.store_date && { label: t('issueModal.inStores'), value: info.store_date },
       info.cover_date && { label: t('issueModal.coverDate'), value: info.cover_date }].filter(Boolean)
    : []);

  /* ---- Where this issue sits in the run, so you can walk it without going
     back to the series page. The list is already loaded for the move picker. */
  const siblings = $derived(detail.det?.issues || []);
  const posIndex = $derived(siblings.findIndex((i) => i.cv_issue_id === m.cvIssueId));
  const posText = $derived(posIndex >= 0 && siblings.length ? t('issueModal.position', { index: posIndex + 1, total: siblings.length }) : '');
  function step(delta) {
    const next = siblings[posIndex + delta];
    if (next) openIssueInfo(next.cv_issue_id, next.number, { keepTab: true });
  }

  /* ---- Status: one word for what this issue is, shown on the cover. */
  const status = $derived(
    !info ? null
      : info.corrupt ? { text: t('issueModal.statusCorrupt'), kind: 'bad', icon: 'alert-triangle' }
      : info.owned ? { text: t('issueModal.statusOwned'), kind: 'ok', icon: 'check' }
      : { text: t('issueModal.statusNotDownloaded'), kind: 'none', icon: null },
  );

  /* ---- Tabs. Counts are the point: they say whether a tab is worth opening. */
  const chars = $derived(info?.character_credits?.map((c) => c.name) || []);
  const arcs = $derived(info?.story_arc_credits?.map((a) => a.name) || []);
  const teams = $derived(info?.team_credits?.map((t) => t.name) || []);
  const fileCount = $derived(info?.files?.length || 0);
  const tabs = $derived([
    { id: 'overview', label: t('issueModal.tabOverview'), count: '' },
    { id: 'credits', label: t('issueModal.tabCredits'), count: info?.credits?.length ? String(info.credits.length) : '' },
    { id: 'appearing', label: t('issueModal.tabAppearing'), count: chars.length + arcs.length + teams.length ? String(chars.length + arcs.length + teams.length) : '' },
    { id: 'files', label: t('issueModal.tabFiles'), count: fileCount ? String(fileCount) : '' },
  ]);

  // One row per role rather than one per person: "cover — Romita Jr., Menyz".
  // First-seen order, because that is the order a cover credits them.
  const creditGroups = $derived.by(() => {
    const roles = new Map();
    for (const c of info?.credits || []) {
      const r = c.role || t('issueModal.creditRole');
      roles.set(r, [...(roles.get(r) || []), c.name].filter(Boolean));
    }
    return [...roles].map(([role, names]) => ({ role, list: names }));
  });

  // Only facts that have a value — an empty grid cell says nothing.
  const facts = $derived([
    [t('issueModal.factRating'), info?.metron_rating],
    // A bare number is a dollar price; a source that prices in another
    // currency sends it with the sign or code attached.
    [t('issueModal.factCoverPrice'), info?.metron_price && (/^[\d.]+$/.test(String(info.metron_price)) ? '$' + info.metron_price : info.metron_price)],
    [t('issueModal.factFoc'), info?.metron_foc_date],
    [t('issueModal.factUpc'), info?.metron_upc],
    [t('issueModal.factIsbn'), info?.metron_isbn],
    [t('issueModal.factPageCount'), info?.metron_page_count],
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
    { label: t('issueModal.storyArcs'), tint: 'arc', kind: null, all: arcs, items: arcs },
    { label: t('issueModal.characters'), tint: 'char', kind: 'character', all: chars, items: showAllChars ? chars : chars.slice(0, CHAR_CAP) },
    { label: t('issueModal.teams'), tint: 'team', kind: 'team', all: teams, items: teams },
  ].filter((g) => g.all.length));

  const reprints = $derived(info?.metron_reprints?.map((r) => r.issue || r.name || r) || []);
  const variants = $derived(info?.metron_variants?.map((v) => v.name || t('issueModal.variantFallback')) || []);

  // Move a file that landed under the wrong issue (its number read wrongly)
  // to the right one — or undo a hand assignment. Same route the series
  // page's unmatched-file picker uses; the choice sticks through rescans.
  let movePick = $state({});
  const otherIssues = $derived(siblings.filter((i) => i.cv_issue_id !== m.cvIssueId));
  const issueChoice = (i) => {
    const label = `#${i.number}${i.title && i.title !== '#' + i.number ? ' · ' + i.title : ''}`;
    return i.owned ? t('issueModal.choiceOwned', { label }) : label;
  };
  const folderOf = (p) => String(p || '').replace(/[\\/][^\\/]+$/, '');
  async function setAssignment(f, cvIssueId) {
    const sid = f.series_id ?? detail.series?.id;
    if (!sid) return;
    const r = await apiPost(`/api/collection/${sid}/assign-file`, { path: f.path, cvIssueId }).catch((e) => ({ error: String(e) }));
    if (r?.error) return notify(r.error, 'error');
    notify(cvIssueId ? t('issueModal.fileMoved') : t('issueModal.assignmentCleared'), 'ok');
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
  // Stored values stay English (the server and tags expect them); the option
  // labels come from the metadata editor's catalog entries.
  const RATINGS = ['', 'Everyone', 'Teen', 'Teen Plus', 'Mature', 'Explicit', 'Adult'];
  const RATING_KEYS = { Everyone: 'ratingEveryone', Teen: 'ratingTeen', 'Teen Plus': 'ratingTeenPlus', Mature: 'ratingMature', Explicit: 'ratingExplicit', Adult: 'ratingAdult' };
  const ratingLabel = (r) => (r ? t('editMetadataModal.' + RATING_KEYS[r]) : '—');
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
    notify(t('issueModal.savedFields', { count: r.updated?.length || 0 }), 'ok');
    editing = false;
    await openIssueInfo(m.cvIssueId, ef.issue_number || m.number, { keepTab: true }); // re-render fresh
    reloadDetail();
  }
  async function resetEdit() {
    saving = true;
    const r = await apiPost(`/api/issue/${m.cvIssueId}/metadata`, { reset: true });
    saving = false;
    if (r?.error) return notify(r.error, 'error');
    notify(t('issueModal.editsReset'), 'ok');
    editing = false;
    await openIssueInfo(m.cvIssueId, m.number, { keepTab: true });
  }
</script>

{#if open}
  <div id="issue-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('issue'); }}>
    <div class="modal__panel modal__panel--wide ix" use:trapFocus role="dialog" aria-label={t('issueModal.dialogLabel')}>
      <div class="modal__head ix__head">
        <h3 id="issue-modal-title" class="ix__title">
          <span class="ix__series">{detail.series?.title || t('issueModal.issueFallback')}</span>
          <span class="ix__num">#{m.number ?? '?'}</span>
        </h3>
        {#if posText}<span class="ix__pos">{posText}</span>{/if}
        <button class="ix__nav" aria-label={t('issueModal.prevIssue')} title={t('issueModal.prevIssue')}
          disabled={posIndex <= 0} onclick={() => step(-1)}><Icon name="chevron-left" size={16} /></button>
        <button class="ix__nav" aria-label={t('issueModal.nextIssue')} title={t('issueModal.nextIssue')}
          disabled={posIndex < 0 || posIndex >= siblings.length - 1} onclick={() => step(1)}><Icon name="chevron-right" size={16} /></button>
        {#if info && isTrusted() && !editing}
          <button class="btn btn--ghost btn--sm" title={t('issueModal.editTitle')} onclick={startEdit}><Icon name="edit" /> {t('common.edit')}</button>
        {/if}
        <button id="issue-modal-x" class="modal__x" aria-label={t('common.close')} onclick={() => closeModal('issue')}><Icon name="close" /></button>
      </div>

      <div id="issue-modal-body" class="ix__body">
        {#if m.loading}
          <div class="loading">{t('common.loading')}</div>
        {:else if m.failed}
          <div class="list-note">{t('issueModal.loadFailed')}</div>
        {:else if !info}
          <div class="list-note">{t('issueModal.noInfo')}</div>
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
                  {#if info.corrupt}<Icon name="refresh" /> {t('issueModal.replaceCorrupt')}
                  {:else if info.owned}<Icon name="refresh" /> {t('issueModal.redownload')}
                  {:else}<Icon name="download" /> {t('issueModal.download')}{/if}
                </button>
                {#if flags.anySource}
                  <button class="btn btn--ghost ix__act" onclick={searchSources}><Icon name="search" /> {t('issueModal.searchSources')}</button>
                {/if}
              {/if}

              {#if safeUrl(info.site_detail_url)}
                <a class="ix__cvlink" href={safeUrl(info.site_detail_url)} target="_blank" rel="noreferrer">{t('issueModal.viewSource')} <Icon name="external-link" size={13} /></a>
              {/if}
            </div>

            <!-- ===== Right ===== -->
            <div class="ix__right">
              {#if editing}
                <div class="ix__edithead">
                  <span class="ix__editt">{t('issueModal.editMetadata')}</span>
                  <span class="ix__editnote">{t('issueModal.editNote')}</span>
                </div>
                <div class="ix__row ix__row--title">
                  <label class="ix__field"><span>{t('common.title')} {#if edited('name')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <input type="text" class:is-edited={edited('name')} bind:value={ef.name} /></label>
                  <label class="ix__field"><span>{t('issueModal.fieldIssueNumber')} {#if edited('issue_number')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <input type="text" class:is-edited={edited('issue_number')} bind:value={ef.issue_number} /></label>
                </div>
                <div class="ix__row ix__row--quad">
                  <label class="ix__field"><span>{t('issueModal.coverDate')} {#if edited('cover_date')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <input type="text" placeholder={t('issueModal.datePlaceholder')} class:is-edited={edited('cover_date')} bind:value={ef.cover_date} /></label>
                  <label class="ix__field"><span>{t('issueModal.fieldStoreDate')} {#if edited('store_date')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <input type="text" placeholder={t('issueModal.datePlaceholder')} class:is-edited={edited('store_date')} bind:value={ef.store_date} /></label>
                  <label class="ix__field"><span>{t('issueModal.factRating')} {#if edited('metron_rating')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <select class:is-edited={edited('metron_rating')} bind:value={ef.metron_rating}>{#each RATINGS as r (r)}<option value={r}>{ratingLabel(r)}</option>{/each}</select></label>
                  <label class="ix__field"><span>{t('issueModal.factCoverPrice')} {#if edited('metron_price')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <input type="text" inputmode="decimal" placeholder="3.99" class:is-edited={edited('metron_price')} bind:value={ef.metron_price} /></label>
                </div>
                <div class="ix__row">
                  <label class="ix__field"><span>{t('issueModal.factUpc')} {#if edited('metron_upc')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <input type="text" class:is-edited={edited('metron_upc')} bind:value={ef.metron_upc} /></label>
                  <label class="ix__field"><span>{t('issueModal.factIsbn')} {#if edited('metron_isbn')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                    <input type="text" class:is-edited={edited('metron_isbn')} bind:value={ef.metron_isbn} /></label>
                </div>
                <label class="ix__field"><span>{t('issueModal.fieldDescription')} {#if edited('description')}<span class="ix__edited">{t('issueModal.edited')}</span>{/if}</span>
                  <textarea rows="5" class:is-edited={edited('description')} bind:value={ef.description}></textarea></label>
                <div class="ix__editactions">
                  {#if info.user_fields?.length}
                    <button class="btn ix__reset" disabled={saving} title={t('issueModal.resetTitle')} onclick={resetEdit}>{t('issueModal.resetAll')}</button>
                  {/if}
                  <span style="flex:1"></span>
                  <button class="btn btn--ghost" onclick={() => { editing = false; }}>{t('common.cancel')}</button>
                  <button class="btn btn--primary" disabled={saving} onclick={saveEdit}>{saving ? t('issueModal.saving') : t('common.save')}</button>
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
                    <div class="ix__sub">{t('issueModal.stories')}</div>
                    {#each info.metron_story_titles as s, i (s + i)}<div class="ix__story">{s}</div>{/each}
                  {/if}
                  {#if reprints.length}
                    <div class="ix__sub">{t('issueModal.reprintedIn')}</div>
                    {#each reprints as r, i (r + i)}<div class="ix__story">{r}</div>{/each}
                  {/if}
                  {#if variants.length}
                    <div class="ix__sub">{t('issueModal.variants')} · {variants.length}</div>
                    <div class="ix__chips">{#each variants as v, i (v + i)}<span class="ix__chip">{v}</span>{/each}</div>
                  {/if}
                  {#if !info.description && !facts.length && !info.metron_story_titles?.length && !variants.length}
                    <div class="list-note">{t('issueModal.noDetails')}</div>
                  {/if}

                {:else if m.tab === 'credits'}
                  {#if creditGroups.length}
                    <div class="ix__rows">
                      {#each creditGroups as c (c.role)}
                        <div class="ix__crow">
                          <span class="ix__crole">{c.role}</span>
                          <span class="ix__cnames">
                            {#each c.list as person, i (person + i)}<button class="ix__person" title={t('issueModal.findCredited', { person })}
                              onclick={() => openFeaturing('creator', person)}>{person}</button>{#if i < c.list.length - 1}<span class="ix__sep">, </span>{/if}{/each}
                          </span>
                        </div>
                      {/each}
                    </div>
                  {:else}<div class="list-note">{t('issueModal.noCredits')}</div>{/if}

                {:else if m.tab === 'appearing'}
                  {#if appearing.length}
                    {#each appearing as g (g.label)}
                      <div class="ix__sub">{g.label} · {g.all.length}</div>
                      <div class="ix__chips">
                        {#each g.items as item, i (item + i)}
                          {#if g.kind}
                            <button class="ix__chip ix__chip--{g.tint} ix__chip--link" title={t('issueModal.findElsewhere', { item })}
                              onclick={() => openFeaturing(g.kind, item)}>{item}</button>
                          {:else}
                            <span class="ix__chip ix__chip--{g.tint}">{item}</span>
                          {/if}
                        {/each}
                        {#if g.all.length > g.items.length}
                          <button class="ix__more" onclick={() => { showAllChars = true; }}>{t('issueModal.more', { count: g.all.length - g.items.length })}</button>
                        {/if}
                      </div>
                    {/each}
                  {:else}<div class="list-note">{t('issueModal.nothingAppearing')}</div>{/if}

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
                          {#if !f.valid}<span class="ix__flag ix__flag--bad">{t('issueModal.fileCorrupt')}</span>
                          {:else if !f.has_metadata}<span class="ix__flag">{t('issueModal.fileUntagged')}</span>
                          {:else}<span class="ix__flag ix__flag--ok">{t('issueModal.fileTagged')}</span>{/if}
                          {#if f.assigned}<span class="ix__flag">{t('issueModal.assignedByHand')}</span>{/if}
                        </div>
                        {#if !f.valid && f.error}<div class="ix__fileerr">{t('issueModal.reason', { error: st('errors', f.error) })}</div>{/if}
                        {#if (isTrusted() || can('library.manage')) && otherIssues.length}
                          <div class="ix__move">
                            <select aria-label={t('issueModal.moveAria', { name: f.name })} bind:value={movePick[f.path]}>
                              <option value="">{t('issueModal.moveTo')}</option>
                              {#each otherIssues as i (i.cv_issue_id)}<option value={i.cv_issue_id}>{issueChoice(i)}</option>{/each}
                            </select>
                            <button class="btn btn--ghost btn--sm" disabled={!movePick[f.path]} onclick={() => setAssignment(f, Number(movePick[f.path]))}>{t('issueModal.move')}</button>
                            {#if f.assigned}<button class="btn btn--ghost btn--sm" onclick={() => setAssignment(f, null)}>{t('issueModal.undoAssignment')}</button>{/if}
                          </div>
                        {/if}
                      </div>
                    {/each}
                  {:else}
                    <div class="ix__empty">{t('issueModal.notDownloadedYet')}</div>
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
