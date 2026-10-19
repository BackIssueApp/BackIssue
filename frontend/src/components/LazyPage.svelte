<script>
  // A section page that lives in its own chunk: fetched the first time it is
  // opened, then kept mounted like the eager pages (its state and polls behave
  // the same once loaded). Pages that hold plugin mount points (Settings,
  // System's tools grid, Profile, the Library) stay eager in App.svelte —
  // plugins look those up the moment they load.
  import LoadError from './LoadError.svelte';

  let { load, active = false } = $props();

  let Page = $state(null);
  let error = $state('');
  let loading = false;
  async function fetchPage() {
    if (loading || Page) return;
    loading = true;
    error = '';
    try { Page = (await load()).default; }
    catch (e) { error = String(e?.message || e); }
    finally { loading = false; }
  }
  $effect(() => { if (active && !Page) fetchPage(); });
</script>

{#if Page}
  <Page {active} />
{:else if active && error}
  <!-- Usually a chunk from before an update: a reload fetches the new one. -->
  <LoadError {error} onretry={() => location.reload()} />
{/if}
