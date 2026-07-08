<script>
  // Shared inline-SVG icon. Renders identically across devices (emoji/symbol
  // glyphs did not — especially on iOS/iPadOS). Usage: <Icon name="download" />,
  // <Icon name="star" fill />, <Icon name="check" size={16} />.
  import { ICON_PATHS } from './icons.js';
  let { name, size = 20, fill = false, class: cls = '' } = $props();
</script>

{#if ICON_PATHS[name]}
  <svg class="bi-icon {cls}" viewBox="0 0 24 24" width={size} height={size}
    fill={fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"
  >{@html ICON_PATHS[name]}</svg>
{/if}
