<script>
  import { toasts, dismiss, holdToast } from '../lib/toasts.svelte.js';
</script>

<div id="toasts">
  {#each toasts as t (t.id)}
    <!-- Errors announce assertively; pointer-over pauses the auto-dismiss. -->
    <div class="toast toast--{t.type}" class:toast--out={t.out}
      onclick={() => dismiss(t.id)}
      onpointerenter={() => holdToast(t.id, true)}
      onpointerleave={() => holdToast(t.id, false)}
      role={t.type === 'error' ? 'alert' : 'status'}>{t.msg}</div>
  {/each}
</div>
