<script>
  import { t } from '../lib/i18n.svelte.js';
  // Catalog keys, resolved at render time so the label follows the language.
  const STATUS = {
    pending:     { key: 'badge.new',     cls: '' },
    queued:      { key: 'badge.queued',  cls: 'badge--queued' },
    grabbed:     { key: 'badge.sent',    cls: 'badge--queued' },
    downloading: { key: 'badge.saving',  cls: 'badge--downloading' },
    tagging:     { key: 'badge.tagging', cls: 'badge--tagging' },
    done:        { key: 'badge.saved',   cls: 'badge--done' },
    untagged:    { key: 'badge.noTags',  cls: 'badge--untagged' },
    corrupt:     { key: 'badge.corrupt', cls: 'badge--corrupt' },
    failed:      { key: 'badge.failed',  cls: 'badge--failed' },
  };
  let { status } = $props();
  const s = $derived(STATUS[status] || STATUS.pending);
</script>

<span class="badge {s.cls}"><span class="dot"></span>{t(s.key)}</span>
