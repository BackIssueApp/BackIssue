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
  import { fmt, offsetWindow } from '../lib/util.js';
  import { navigate } from '../lib/router.svelte.js';
  import { filterIssues, groupBySeries, roleTally, runsOf, yearSpan } from '../lib/featuring.js';
  import Cover from './Cover.svelte';
  import Icon from '../lib/Icon.svelte';

  const KIND_ICON = { creator: 'edit', character: 'user', team: 'users' };

  /* A series this long reads as coverage, not as a list: 843 issues is the
     busiest creator in a 42k library, and one series can hold hundreds of them.
     Over BIG a group starts collapsed and expands into a number grid; switched
     to rows or covers it pages PAGE at a time. */
  const BIG = 24;
  const PAGE = 30;

  /* Every height below is also pinned in CSS (or set inline on the block), so
     the virtual window's spacers add up to the real column height. */
  const H_HEAD = 38, H_RUNS = 24, H_ROW = 46, H_MORE = 44, H_GAP = 10;
  const CELL = 30, CELL_GAP = 4, CELL_W = 44, BLOCK_PAD = 10;
  const TILE_H = 170, TILE_GAP = 12, TILE_W = 96;
  const INDENT = 22;

  const open = $derived(modals.stack.includes('featuring'));

  const blank = () => ({ q: '', ownedOnly: false, sort: 'series', view: 'list', role: '', collapsed: {}, mode: {}, shown: {} });
  const ui = $state(blank());

  let scroller = $state(null);
  let stream = $state(null);
  let scrollTop = $state(0);
  let viewH = $state(600);
  let bodyW = $state(620);

  const all = $derived(m.issues || []);
  const roles = $derived(m.kind === 'creator' ? roleTally(all) : []);
  const shownIssues = $derived(filterIssues(all, ui));
  const groups = $derived(groupBySeries(shownIssues, { sort: ui.sort }));

  const ownedCount = $derived(shownIssues.filter((i) => i.owned).length);
  const stats = $derived([
    { label: 'Issues', value: fmt(shownIssues.length) },
    { label: 'Series', value: fmt(groups.length) },
    { label: 'Owned', value: fmt(ownedCount), tone: ownedCount ? 'ok' : '' },
    { label: 'Years', value: yearSpan(shownIssues) || '—' },
  ]);

  const denseCols = $derived(Math.max(1, Math.floor((bodyW - INDENT) / (CELL_W + CELL_GAP))));
  const gridCols = $derived(Math.max(2, Math.floor((bodyW - INDENT) / (TILE_W + TILE_GAP))));

  /* One unit per series group: the heading and its own issues share a box,
     which is what lets the heading stick while they scroll past. A collapsed
     group costs one line, so even a few hundred series window cheaply. */
  const units = $derived.by(() => groups.map((g) => {
    const big = g.total > BIG;
    const collapsed = ui.collapsed[g.key] ?? big;
    const mode = ui.mode[g.key] ?? (big ? 'dense' : 'items');
    const body = collapsed ? 'none' : mode === 'dense' ? 'dense' : ui.view === 'grid' ? 'tiles' : 'rows';
    const limit = big && body !== 'dense' ? Math.min(g.total, ui.shown[g.key] ?? PAGE) : g.total;
    const items = limit < g.total ? g.items.slice(0, limit) : g.items;
    const left = g.total - items.length;

    let h = H_HEAD + (big ? H_RUNS : 0) + H_GAP;
    if (body === 'dense') {
      const r = Math.ceil(g.total / denseCols);
      h += r * CELL + (r - 1) * CELL_GAP + BLOCK_PAD;
    } else if (body === 'rows') {
      h += items.length * H_ROW + (left ? H_MORE : 0);
    } else if (body === 'tiles') {
      const r = Math.ceil(items.length / gridCols);
      h += r * TILE_H + (r - 1) * TILE_GAP + BLOCK_PAD + (left ? H_MORE : 0);
    }
    return {
      g, big, collapsed, body, items, left, h,
      runs: big ? runsOf(g.items.map((i) => i.issue_number)) : '',
    };
  }));

  const win = $derived(offsetWindow(units.map((u) => u.h), { viewH, scrollTop, overscan: 2 }));

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (scroller) scrollTop = scroller.scrollTop; });
  }

  // A fresh subject gets a fresh toolbar — the previous person's role filter
  // would otherwise hide everything.
  $effect(() => { void m.kind; void m.name; Object.assign(ui, blank()); });
  $effect(() => {
    void ui.q; void ui.ownedOnly; void ui.role; void ui.sort; void ui.view; void m.name;
    scrollTop = 0;
    if (scroller) scroller.scrollTop = 0;
  });
  $effect(() => {
    if (!scroller || !stream) return;
    const measure = () => {
      viewH = scroller.clientHeight || viewH;
      bodyW = stream.clientWidth || bodyW;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  function close() { closeModal('featuring'); }
  function go(i) { close(); openIssueInfo(i.cv_issue_id, i.issue_number); }
  function openSeries(g) { close(); navigate('/volume/' + Number(g.seriesId)); }
  function openTools() { close(); navigate('/tools'); }

  function toggle(u) { ui.collapsed[u.g.key] = !u.collapsed; }
  function setMode(u) { ui.mode[u.g.key] = u.body === 'dense' ? 'items' : 'dense'; }
  function more(u) { ui.shown[u.g.key] = u.items.length + PAGE; }
  function pickRole(r) { ui.role = ui.role === r ? '' : r; }

  const ownTone = (g) => (g.owned >= g.total ? 'is-all' : g.owned ? 'is-some' : 'is-none');
  const cellTitle = (i) => [
    `#${i.issue_number ?? '?'}`, i.title, i.cover_date,
    i.owned ? 'owned' : 'not owned', ui.role ? '' : i.role,
  ].filter(Boolean).join(' · ');
  const modeLabel = (u) => (u.body === 'dense' ? (ui.view === 'grid' ? 'Show as covers' : 'Show as rows') : 'Show as number grid');

  const hasResults = $derived(!m.loading && !m.failed && !!all.length);
  // True even when results do come back, so a short list isn't read as the
  // whole truth.
  const sparse = $derived(hasResults && m.kind !== 'creator');
</script>

{#if open}
  <div id="featuring-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div class="modal__panel fx" use:trapFocus role="dialog" aria-label="{LABEL[m.kind]} {m.name}">
      <div class="fx__head">
        <div class="fx__top">
          <span class="fx__icon fx__icon--{m.kind}"><Icon name={KIND_ICON[m.kind] || 'tag'} size={20} /></span>
          <div class="fx__who">
            <div class="fx__kind">{LABEL[m.kind] || 'In'}</div>
            <h3 class="fx__name">{m.name}</h3>
          </div>
          <button class="modal__x" aria-label="Close" onclick={close}><Icon name="close" /></button>
        </div>

        {#if hasResults}
          <div class="fx__stats">
            {#each stats as s (s.label)}
              <div class="fx__stat">
                <div class="fx__statk">{s.label}</div>
                <div class="fx__statv" class:is-ok={s.tone === 'ok'}>{s.value}</div>
              </div>
            {/each}
          </div>

          {#if roles.length > 1}
            <div class="fx__roles">
              <button class="fx__rolechip" class:is-on={!ui.role} onclick={() => { ui.role = ''; }}>
                All roles<span class="fx__rolen">{fmt(all.length)}</span>
              </button>
              {#each roles as r (r.role)}
                <button class="fx__rolechip" class:is-on={ui.role === r.role} onclick={() => pickRole(r.role)}>
                  {r.role}<span class="fx__rolen">{fmt(r.count)}</span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="fx__bar">
            <div class="fx__find">
              <Icon name="search" size={15} />
              <input placeholder="Filter by series or title…" spellcheck="false" bind:value={ui.q} />
            </div>
            <button class="btn btn--ghost btn--sm fx__toggle" class:is-on={ui.ownedOnly}
              aria-pressed={ui.ownedOnly} onclick={() => { ui.ownedOnly = !ui.ownedOnly; }}>
              <Icon name="check" size={14} /> Owned only
            </button>
            <div class="fx__seg">
              <button class:is-on={ui.sort === 'series'} onclick={() => { ui.sort = 'series'; }}>Series</button>
              <button class:is-on={ui.sort === 'recent'} onclick={() => { ui.sort = 'recent'; }}>Recent</button>
            </div>
            <div class="fx__seg">
              <button class="fx__segi" class:is-on={ui.view === 'list'} title="List" aria-label="List"
                onclick={() => { ui.view = 'list'; }}><Icon name="list" size={15} /></button>
              <button class="fx__segi" class:is-on={ui.view === 'grid'} title="Covers" aria-label="Covers"
                onclick={() => { ui.view = 'grid'; }}><Icon name="grid" size={15} /></button>
            </div>
          </div>
        {/if}
      </div>

      <div class="fx__body" bind:this={scroller} onscroll={onScroll}>
        <div class="fx__stream" bind:this={stream}>
          {#if m.loading}
            <div class="loading">Searching your collection…</div>
          {:else if m.failed}
            <div class="list-note">Could not search — is the app running?</div>
          {:else if !all.length}
            <!-- Almost always missing data rather than a real absence: ComicVine
                 records characters for a small share of issues, so say so instead
                 of implying the collection has none. -->
            <div class="fx__empty">
              <span class="fx__emptyicon"><Icon name={KIND_ICON[m.kind] || 'tag'} size={22} /></span>
              <div class="fx__emptyt">Nothing else in your collection lists {m.name}.</div>
              <p class="fx__hint">
                {#if m.kind === 'creator'}
                  Credits only exist for issues whose metadata has been downloaded — run <b>Tools → Download issue metadata</b> to cover the rest.
                {:else}
                  Character and team listings are sparse at the source: ComicVine records them for a small share of issues, and mostly recent ones.
                {/if}
              </p>
              {#if m.kind === 'creator'}
                <button class="btn btn--secondary btn--sm" onclick={openTools}>Open Tools</button>
              {/if}
            </div>
          {:else if !shownIssues.length}
            <div class="fx__none">No issues match these filters.</div>
          {:else}
            {#if win.padTop > 0}<div style="height:{win.padTop}px"></div>{/if}
            {#each units.slice(win.start, win.end) as u (u.g.key)}
              <div class="fx__group">
                <div class="fx__ghead" role="button" tabindex="0" onclick={() => toggle(u)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(u); } }}>
                  <span class="fx__chev" class:is-open={!u.collapsed}><Icon name="chevron-right" size={14} /></span>
                  <span class="fx__gname">{u.g.series}</span>
                  {#if u.g.years}<span class="fx__gyears">{u.g.years}</span>{/if}
                  <span class="fx__gown {ownTone(u.g)}">{u.g.owned}/{u.g.total} owned</span>
                  {#if u.g.seriesId != null}
                    <button class="fx__glink" title="Open series" aria-label="Open series"
                      onclick={(e) => { e.stopPropagation(); openSeries(u.g); }}><Icon name="book" size={15} /></button>
                  {/if}
                </div>

                {#if u.big}
                  <div class="fx__runs">
                    <span class="fx__gcount">{fmt(u.g.total)} issues</span>
                    <span class="fx__runstxt">{u.runs}</span>
                    {#if !u.collapsed}
                      <button class="fx__modesw" onclick={() => setMode(u)}>{modeLabel(u)}</button>
                    {/if}
                  </div>
                {/if}

                {#if u.body === 'dense'}
                  <div class="fx__dense" style="grid-template-columns:repeat({denseCols},1fr); grid-auto-rows:{CELL}px; gap:{CELL_GAP}px;">
                    {#each u.g.items as i (i.cv_issue_id)}
                      <button class="fx__cell" class:is-own={i.owned} title={cellTitle(i)} onclick={() => go(i)}>{i.issue_number ?? '?'}</button>
                    {/each}
                  </div>
                {:else if u.body === 'rows'}
                  <div class="fx__rows">
                    {#each u.items as i (i.cv_issue_id)}
                      <button class="fx__row" onclick={() => go(i)}>
                        <span class="fx__cover"><Cover coverUrl={i.image_url} title={u.g.series} /></span>
                        <span class="fx__rnum">#{i.issue_number ?? '?'}</span>
                        <span class="fx__rsub">{[i.title, i.cover_date].filter(Boolean).join(' · ')}</span>
                        {#if !ui.role && i.role}<span class="fx__role">{i.role}</span>{/if}
                        <span class="fx__dot" class:is-own={i.owned} title={i.owned ? 'Owned' : 'Not owned'}></span>
                      </button>
                    {/each}
                  </div>
                {:else if u.body === 'tiles'}
                  <div class="fx__tiles" style="grid-template-columns:repeat({gridCols},1fr); grid-auto-rows:{TILE_H}px; gap:{TILE_GAP}px;">
                    {#each u.items as i (i.cv_issue_id)}
                      <button class="fx__tile" class:is-dim={!i.owned} onclick={() => go(i)}>
                        <span class="fx__tilecv">
                          <Cover coverUrl={i.image_url} title={u.g.series} />
                          {#if i.owned}<span class="fx__tick"><Icon name="check" size={12} /></span>{/if}
                        </span>
                        <span class="fx__tilenum">#{i.issue_number ?? '?'}</span>
                        <span class="fx__tilesub">{i.title || i.cover_date || ''}</span>
                      </button>
                    {/each}
                  </div>
                {/if}

                {#if u.left > 0 && u.body !== 'dense' && u.body !== 'none'}
                  <div class="fx__moreline">
                    <button class="btn btn--ghost btn--sm" onclick={() => more(u)}>
                      Show {Math.min(PAGE, u.left)} more ({fmt(u.left)} left)
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
            {#if win.padBottom > 0}<div style="height:{win.padBottom}px"></div>{/if}

            {#if sparse}
              <div class="fx__note">
                <Icon name="info" size={15} />
                <span>Character and team listings are sparse at the source — ComicVine records them for a small share of issues, mostly recent ones — so this is likely incomplete.</span>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
