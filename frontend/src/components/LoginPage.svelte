<script>
  // Full-screen auth gate: sign in, or register when self-service signups are
  // enabled. Also reused (via `mode="secure"`) from open mode to create the
  // first admin account.
  import { auth, login, register } from '../lib/auth.svelte.js';

  let { mode = 'login', oncancel = null } = $props(); // 'login' | 'secure'
  let tab = $state(mode === 'secure' ? 'register' : 'login');
  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let error = $state('');
  let busy = $state(false);

  const securing = $derived(mode === 'secure');
  const canRegister = $derived(securing || auth.registration);

  async function submit() {
    error = '';
    if (tab === 'register') {
      if (password !== confirm) { error = 'passwords do not match'; return; }
    }
    busy = true;
    try {
      if (tab === 'register') await register(username.trim(), password);
      else await login(username.trim(), password);
      if (securing) location.reload(); // re-enter as the new admin, cleanly
    } catch (e) {
      error = String(e.message || e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="authgate">
  <div class="authgate__card">
    <div class="brand"><span class="brand__logo">BACKISSUE</span></div>
    {#if securing}
      <p class="authgate__intro">Welcome to BackIssue. Create your account to get started — it becomes the <b>admin</b>, and signing in will be required from then on.</p>
    {:else if canRegister}
      <div class="authgate__tabs">
        <button class="authgate__tab" class:is-active={tab === 'login'} onclick={() => { tab = 'login'; error = ''; }}>Sign in</button>
        <button class="authgate__tab" class:is-active={tab === 'register'} onclick={() => { tab = 'register'; error = ''; }}>Create account</button>
      </div>
    {/if}

    <form class="authgate__form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <label>Username
        <input type="text" autocomplete="username" bind:value={username} required minlength="2" maxlength="32" />
      </label>
      <label>Password
        <input type="password" autocomplete={tab === 'register' ? 'new-password' : 'current-password'} bind:value={password} required minlength={tab === 'register' ? 8 : 1} />
      </label>
      {#if tab === 'register'}
        <label>Confirm password
          <input type="password" autocomplete="new-password" bind:value={confirm} required />
        </label>
      {/if}
      {#if error}<div class="authgate__error">{error}</div>{/if}
      <button class="btn btn--primary authgate__submit" disabled={busy}>
        {busy ? '…' : securing ? 'Create admin account' : tab === 'register' ? 'Create account' : 'Sign in'}</button>
      {#if securing && oncancel}
        <button type="button" class="btn btn--ghost" onclick={oncancel}>Cancel</button>
      {/if}
    </form>

    {#if !securing && !canRegister}
      <p class="authgate__note">Registration is disabled — ask an admin for an account.</p>
    {/if}
  </div>
</div>
