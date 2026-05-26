/**
 * Static-analysis contract test for visible-copy hygiene
 * (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2, kenji msg `08be08d8`).
 *
 * Background:
 *   WAWQAQ noticed `建文` showing up in his real chat surface
 *   (msg `1886c41b`). Tracing it back: the visual-smoke fixture
 *   seeded `personalization.displayName = '建文'` for screenshot
 *   determinism, but that placeholder name has no product
 *   meaning — a user opening a demo workspace (or anyone
 *   reviewing a baseline screenshot) sees a stranger's name as
 *   the "user" label.
 *
 *   Kenji also called out `WELCOME TO MAKA` (all-caps English
 *   eyebrow in `NeedsConnectionHero`) as inconsistent with the
 *   rest of the Chinese-first surface (msg `08be08d8` #4).
 *
 * This file is a grep-style gate that fails if either string
 * reappears in renderer/UI source. The runtime fix landed
 * separately (fixture displayName → '', eyebrow → '欢迎使用 Maka').
 *
 * Add new entries to `FORBIDDEN_VISIBLE_COPY` when a reviewer
 * calls out additional copy drift that should never reappear.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

// Cwd is `apps/desktop` when the test runs (per the existing
// sidebar-scroll-contract pattern).
const FILES_TO_SCAN = [
  resolve(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'),
  join(process.cwd(), 'src', 'renderer', 'OnboardingHero.tsx'),
  join(process.cwd(), 'src', 'renderer', 'onboarding-hero-copy.ts'),
  join(process.cwd(), 'src', 'main', 'visual-smoke-fixture.ts'),
];

interface ForbiddenCopy {
  /**
   * Pattern (regex) that must NOT appear in any scanned file.
   * Use a regex when the forbidden shape requires distinguishing
   * code-vs-comment context or mixed-language detection (e.g.
   * "uppercase English prefix followed by a Chinese character" —
   * a literal substring match would also flag the legitimate
   * all-English en-locale string).
   */
  needle: RegExp;
  /** Short human-readable label for the assertion message. */
  label: string;
  /** Human-readable why-it's-forbidden for the assertion message. */
  reason: string;
}

// Range: `[一-龥]` is the CJK Unified Ideographs block —
// matches any common Chinese character. Combined with an English
// prefix this catches "mixed-language eyebrow" without flagging
// pure-English en-locale strings.
const CJK_CHAR = '[\\u4e00-\\u9fa5]';

const FORBIDDEN_VISIBLE_COPY: ForbiddenCopy[] = [
  {
    label: 'placeholder Chinese personal name as fixture displayName',
    needle: /personalization\.displayName\s*=\s*'[一-龥]/,
    reason:
      "fixture must not seed a Chinese personal name as displayName — placeholder human names confuse users and reviewers (kenji `08be08d8`, WAWQAQ `1886c41b`). Default to empty string so the renderer fallback (`'你'`) shows in screenshots.",
  },
  {
    label: 'all-caps English-only hero eyebrow',
    needle: /<span>[A-Z][A-Z\s]{4,}<\/span>/,
    reason:
      "JSX `<span>` containing 5+ all-caps English chars is inconsistent with the Chinese-first onboarding surface (kenji `08be08d8` #4). Use a Chinese eyebrow to match the surrounding rhythm.",
  },
  {
    label: 'mixed-language eyebrow (English prefix + Chinese tail)',
    needle: new RegExp(`eyebrow:\\s*'[A-Z]+[^']*${CJK_CHAR}`),
    reason:
      "mixed-language eyebrow (English uppercase prefix followed by Chinese) drifted from the rest of the Chinese-first surface (kenji `08be08d8` #4). Use a Chinese-only eyebrow on zh-locale entries; en-locale entries staying all-English is fine.",
  },
];

describe('visible-copy hygiene contract (PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2)', () => {
  for (const entry of FORBIDDEN_VISIBLE_COPY) {
    it(`forbidden copy "${entry.label}" does NOT appear in any visible source file`, async () => {
      const offenders: Array<{ path: string; match: string }> = [];
      for (const path of FILES_TO_SCAN) {
        const src = await readFile(path, 'utf8');
        const match = entry.needle.exec(src);
        if (match) {
          offenders.push({ path, match: match[0]! });
        }
      }
      assert.equal(
        offenders.length,
        0,
        `forbidden copy pattern "${entry.label}" found:\n${offenders
          .map((o) => `  ${o.path}\n    matched: ${o.match}`)
          .join('\n')}\n\nreason: ${entry.reason}`,
      );
    });
  }
});
