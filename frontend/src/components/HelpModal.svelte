<script module>
  // Contextual help: the header's "?" opens this, showing what the CURRENT
  // page does and how to use it. openHelp() from Header.
  let openFn = () => {};
  export function openHelp() { openFn(); }

  // Help content keyed by route. `match` picks the entry for a path; the first
  // match wins, so put more specific patterns first. Each entry is a title +
  // sections ({ h, p } — heading + paragraph). Kept as data so it's easy to
  // extend as pages change.
  export const HELP = [
    { test: (p) => /^\/volume\//.test(p), title: 'Series', sections: [
      { h: 'What this is', p: 'Every issue ComicVine lists for this series. Owned issues show a cover and green check; missing ones are yours to download.' },
      { h: 'Reading & downloading', p: 'Use the download button on a row (or select several and “Download selected”) to download missing issues. Owned issues show reader actions (read, mark read) if the reader plugin is on.' },
      { h: 'List vs grid', p: 'Toggle grid/list at the top. The list view adds cover date, page count, file size, and the file format per issue; the grid shows covers.' },
      { h: 'Managing it', p: 'With library-management rights you can Refresh from ComicVine, Fix the match, Scan the folder, Tag files, set the location, add alt search names, or Remove the series. “Add to list” puts the selection (or the whole series) on a reading list.' },
    ] },
    { test: (p) => p === '/', title: 'Library', sections: [
      { h: 'What this is', p: 'Every series you track. Each shows how many issues you own vs. how many exist, with a progress bar.' },
      { h: 'Finding things', p: 'The top search box filters your collection. The filter chips narrow to Incomplete, Not followed, Problems, or Unmatched (no ComicVine match yet); the sort menu orders A–Z, recently added, or most-missing.' },
      { h: 'Views', p: 'Grid is a poster wall; list is a dense table showing publisher, year, download activity, latest issue date, and size on disk.' },
      { h: 'Adding & bulk actions', p: '“+ Add” searches ComicVine and adds a series (which, by default, immediately queues its issues to download). “Select” enables bulk follow/unfollow, download-missing, and remove.' },
    ] },
    { test: (p) => p === '/wanted', title: 'Wanted', sections: [
      { h: 'What this is', p: 'Every missing issue across your whole collection, grouped by series — your backlog of things to download.' },
      { h: 'Using it', p: 'Download an individual issue, or “Download shown” to queue everything matching the current filters (capped per pass). Filter to followed-only or hide unreleased issues.' },
    ] },
    { test: (p) => p === '/queue', title: 'Download queue', sections: [
      { h: 'What this is', p: 'What’s downloading now and what’s waiting. The active item shows a progress bar with speed and source.' },
      { h: 'Controls', p: 'Pause/resume the queue, clear queued items, or retry/clear failed ones (library-management rights). The × on a row cancels that download and removes it from the client.' },
      { h: 'After a restart', p: 'A queue that was mid-download resumes automatically when the app starts.' },
    ] },
    { test: (p) => p === '/releases', title: 'Releases', sections: [
      { h: 'What this is', p: 'New comics shipping this week (browse other weeks with the arrows). Issues of series you track are flagged, and can be added or downloaded right here.' },
    ] },
    { test: (p) => p === '/lists', title: 'Reading lists', sections: [
      { h: 'What this is', p: 'Personal, ordered lists of issues — hand-built or imported from a ComicVine story arc. Lists are private to your account.' },
      { h: 'Building a list', p: 'Create one, then add issues from any series page (“Add to list”). Reorder with the up/down controls. Items you don’t own show a download button, or “+ Add series” if the whole series isn’t in your library yet.' },
      { h: 'Story arcs', p: '“Import story arc” searches ComicVine and pulls an arc’s issues in cover-date reading order — great for crossovers that span several series.' },
    ] },
    { test: (p) => p === '/history', title: 'History', sections: [
      { h: 'What this is', p: 'A log of issues imported into your library — what came in, when, and from which source. Filter by source at the top.' },
    ] },
    { test: (p) => p === '/stats', title: 'Stats', sections: [
      { h: 'What this is', p: 'A snapshot of your collection — totals by publisher, completeness, file counts and sizes.' },
    ] },
    { test: (p) => p === '/users', title: 'Users & roles', sections: [
      { h: 'Accounts', p: 'Create accounts, assign roles, disable, or delete them. Toggle self-registration (new signups start as viewers). At least one admin must always remain.' },
      { h: 'Roles & permissions', p: 'Built-in roles (Viewer, Trusted, Admin) grant increasing permissions. Create a custom role and tick exactly the permissions it should hold — including permissions that plugins register (reading, OPDS, requests, etc.).' },
    ] },
    { test: (p) => p === '/plugins', title: 'Plugins', sections: [
      { h: 'What this is', p: 'Everything installed under the plugins folder, with what each one registered (routes, sources, jobs, UI). Enable or disable each; changes apply after a restart.' },
      { h: 'Restart', p: 'The “Restart now” button restarts the app so plugin changes take effect.' },
    ] },
    { test: (p) => p === '/jobs', title: 'Jobs', sections: [
      { h: 'What this is', p: 'Background tasks (release checks, ComicVine matching, crawls, backfills) and their schedules. Edit a task’s cron schedule, toggle it, or run it now.' },
    ] },
    { test: (p) => p === '/tools', title: 'Tools', sections: [
      { h: 'What this is', p: 'One-off library maintenance: scan everything, tag untagged files, convert CBR→CBZ, remove duplicates, and verify archives for corruption.' },
    ] },
    { test: (p) => p === '/logs', title: 'Logs', sections: [
      { h: 'What this is', p: 'Recent application messages — useful when a download or tag fails. Filter by level and category, or clear the buffer.' },
    ] },
    { test: (p) => p === '/settings', title: 'Settings', sections: [
      { h: 'What this is', p: 'App configuration: library root folders, download format and behavior, ComicVine key, indexers/download clients, notifications, and plugin settings.' },
      { h: 'Download on add', p: 'Under Downloading, “Download on add” controls whether adding a series immediately queues its issues (on by default).' },
    ] },
    { test: (p) => p === '/import', title: 'Import', sections: [
      { h: 'What this is', p: 'Bring an existing comic library on disk into BackIssue: scan your folders, review the matched candidates, and confirm to file them under ComicVine series.' },
    ] },
  ];
</script>

<script>
  import { route } from '../lib/router.svelte.js';
  import Icon from '../lib/Icon.svelte';
  import { trapFocus } from '../lib/dom.js';
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';

  // In the modals stack so the app's Escape handler closes it like other modals.
  openFn = () => openModal('help');
  const open = $derived(modals.stack.includes('help'));
  const close = () => closeModal('help');

  const entry = $derived(HELP.find((h) => h.test(route.path)) || {
    title: 'BackIssue', sections: [{ h: 'This page', p: 'No page-specific help yet — pick a section from the left menu.' }],
  });
</script>

{#if open}
  <div class="modal" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <div class="modal__panel help-panel" use:trapFocus role="dialog" aria-label="Help">
      <div class="modal__head"><h3>Help · {entry.title}</h3>
        <button class="modal__x" aria-label="Close" onclick={close}><Icon name="close" /></button></div>
      <div class="modal__body help-body">
        {#each entry.sections as s (s.h)}
          <div class="help-sec">
            <div class="help-sec__h">{s.h}</div>
            <p class="help-sec__p">{s.p}</p>
          </div>
        {/each}
        <p class="help-foot">Tip: press <kbd>Esc</kbd> to close. Buttons you don’t see may need a higher permission.</p>
      </div>
    </div>
  </div>
{/if}
