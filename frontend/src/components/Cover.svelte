<script>
  // A cover element: halftone placeholder with initials, plus the real image on
  // top (hidden if it fails to load — the image host occasionally 403s).
  import { initials } from '../lib/util.js';
  let { coverUrl = null, title = '' } = $props();
  let failed = $state(false);
  $effect(() => { void coverUrl; failed = false; }); // a new url gets a fresh try
</script>

<div class="cover">
  <div class="cover__ph">{initials(title)}</div>
  {#if coverUrl && !failed}
    <img loading="lazy" alt="" referrerpolicy="no-referrer" src={coverUrl} onerror={() => { failed = true; }} />
  {/if}
</div>
