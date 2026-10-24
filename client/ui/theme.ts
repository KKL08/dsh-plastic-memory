/**
 * 主题令牌（DESIGN.md「The Borrowed Palette Rule」）：颜色一律 `--pm-*`，指向宿主 `--dsw-alias-*`；
 * 银藤三档是唯一的颜色字面量。暗色跟 `body[data-ds-dark-theme]`，借来的令牌宿主已经换好，只需换银藤。
 * 宿主 10 款皮肤都通过覆盖 `--dsw-alias-*` 生效，这里自动跟随。
 */
export const themeCss = `
.pm-root {
  --pm-text: var(--dsw-alias-label-primary);
  --pm-text-2: var(--dsw-alias-label-secondary);
  --pm-text-3: var(--dsw-alias-label-tertiary);
  --pm-caption: var(--dsw-alias-label-caption);
  --pm-bg: var(--dsw-alias-bg-layer-1);
  --pm-bg-raised: var(--dsw-alias-bg-layer-3);
  --pm-bg-block: var(--dsw-alias-bg-module-platform);
  --pm-line: var(--dsw-alias-border-l2);
  --pm-line-card: var(--dsw-alias-border-l3);
  --pm-line-input: var(--dsw-alias-border-l4);
  --pm-line-soft: color-mix(in srgb, var(--dsw-alias-border-l2) 80%, transparent);
  --pm-hover: var(--dsw-alias-interactive-bg-hover);
  --pm-pressed: var(--dsw-alias-interactive-bg-active);
  --pm-track: var(--dsw-alias-interactive-bg-hover);
  --pm-warn: var(--dsw-alias-state-warn-primary);
  --pm-error: var(--dsw-alias-state-error-primary);
  --pm-success: var(--dsw-alias-state-success-primary);
  --pm-focus: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  --pm-on-error: var(--dsw-static-neutral-bluish-00);
  --pm-accent: #887FA8;
  --pm-accent-tint: #F2F0F9;
  --pm-accent-soft: #BFB9D4;
  color: var(--pm-text);
  font-size: 13px;
  line-height: 1.55;
}
body[data-ds-dark-theme] .pm-root {
  --pm-accent: #B0A8CB;
  --pm-accent-tint: #27252C;
  --pm-accent-soft: #645F77;
}
.pm-root *, .pm-root *::before, .pm-root *::after { box-sizing: border-box; }
.pm-root :is(button, [role='option'], [tabindex]):focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus);
  outline-offset: 2px;
}
.pm-link { padding: 0; border: 0; background: none; font: inherit; font-weight: 600; color: var(--pm-text); cursor: pointer; }
.pm-link:hover { text-decoration: underline; }
.pm-sep { font-style: normal; color: var(--pm-caption); margin: 0 6px; }
.pm-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
`
