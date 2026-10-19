<script>
  // Inline "this didn't load" state: what went wrong, plus a Retry. Pages show
  // it instead of their empty state, so an outage never reads as "nothing
  // here". compact = a slim strip; stale (default: compact) = older data is
  // still on screen, so the title says that rather than "couldn't load".
  import Icon from '../lib/Icon.svelte';
  import { t } from '../lib/i18n.svelte.js';

  let { error = '', onretry = null, compact = false, stale = compact } = $props();
</script>

<div class="loaderr" class:loaderr--compact={compact} role="alert">
  <Icon name="alert-triangle" size={compact ? 15 : 20} />
  <div class="loaderr__body">
    <div class="loaderr__title">{stale ? t('common.loadFailedStale') : t('common.loadFailed')}</div>
    {#if error}<div class="loaderr__detail">{error}</div>{/if}
  </div>
  {#if onretry}
    <button type="button" class="loaderr__retry" onclick={onretry}><Icon name="refresh" size={14} /> {t('common.retry')}</button>
  {/if}
</div>

<style>
  .loaderr { display: flex; align-items: center; gap: 12px; max-width: 560px; margin: 40px auto; padding: 14px 16px; border: 1px solid rgba(255, 90, 82, .35); border-radius: 10px; background: rgba(255, 90, 82, .08); color: var(--red); }
  .loaderr--compact { max-width: none; margin: 0 0 12px; padding: 8px 12px; }
  .loaderr__body { flex: 1; min-width: 0; }
  .loaderr__title { font: 600 13.5px var(--font-body); color: var(--text); }
  .loaderr__detail { margin-top: 2px; font: 12px var(--font-mono); color: var(--muted); overflow-wrap: anywhere; }
  .loaderr__retry { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--text); font: 600 12.5px var(--font-body); cursor: pointer; }
  .loaderr__retry:hover { border-color: var(--accent); }
</style>
