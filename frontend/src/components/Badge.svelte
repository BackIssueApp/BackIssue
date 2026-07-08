<script>
  const STATUS = {
    pending:     { label: 'new',    cls: '' },
    queued:      { label: 'queued', cls: 'badge--queued' },
    grabbed:     { label: 'sent',   cls: 'badge--queued' },
    downloading: { label: 'saving', cls: 'badge--downloading' },
    tagging:     { label: 'tagging', cls: 'badge--tagging' },
    done:        { label: 'saved',  cls: 'badge--done' },
    untagged:    { label: 'no tags', cls: 'badge--untagged' },
    corrupt:     { label: 'corrupt', cls: 'badge--corrupt' },
    failed:      { label: 'failed', cls: 'badge--failed' },
  };
  let { status } = $props();
  const s = $derived(STATUS[status] || STATUS.pending);
</script>

<span class="badge {s.cls}"><span class="dot"></span>{s.label}</span>
