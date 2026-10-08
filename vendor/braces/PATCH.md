# Local build dependency repair

Upstream: [micromatch/braces 3.0.3](https://github.com/micromatch/braces/tree/3.0.3), distributed by npm as `braces@3.0.3`. The upstream version and MIT LICENSE are unchanged.

This local copy repairs the uncontrolled recursion described in [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). The parser rejects more than 100 nested brace or parenthesis blocks. Recursive compile, expand and stringify walkers also bound directly supplied ASTs; the additional node level permits a leaf inside 100 parsed blocks.

Only `lib/parse.js`, `lib/compile.js`, `lib/expand.js` and `lib/stringify.js` differ from upstream executable source. The guards throw the same class of controlled syntax error as the existing input length guard. Ordinary patterns, quoted/escaped braces and 100 nested blocks remain supported.

`package.json` uses a local dev dependency and a `$braces` override so every dependency consumer resolves this copy. `.npmrc` enables `install-links` so a clean install copies package contents without Windows symlinks or upstream development dependencies. This is a source repair, not an advisory exclusion: npm audit can continue to report the unchanged upstream version until a fixed release exists. Replace the local copy with an upstream fixed release once available, retaining the security regression checks in `scripts/verify-build-dependencies.test.cjs`.
