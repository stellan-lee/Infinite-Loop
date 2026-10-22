# Bundled fonts

The application bundles unmodified variable TrueType fonts from the official
[Google Fonts repository](https://github.com/google/fonts). `next/font/local`
emits them into the production build without contacting Google Fonts. The full
upstream files retain their character coverage; they have not been subsetted.

## Newsreader

Source revision: `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5`.

- [Newsreader[opsz,wght].ttf](https://github.com/google/fonts/blob/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/newsreader/Newsreader%5Bopsz%2Cwght%5D.ttf)
  → `app/fonts/newsreader/Newsreader-Regular.ttf`
- [Newsreader-Italic[opsz,wght].ttf](https://github.com/google/fonts/blob/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/newsreader/Newsreader-Italic%5Bopsz%2Cwght%5D.ttf)
  → `app/fonts/newsreader/Newsreader-Italic.ttf`
- [Original license](https://github.com/google/fonts/blob/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/newsreader/OFL.txt),
  included at [newsreader/OFL.txt](newsreader/OFL.txt).

Both files contain weight (200–800) and optical-size (6–72) variation axes.
The application exposes weights 300–600, including the previously requested
300, 400, 500, and 600, in normal and italic styles. The root layout pins the
inherited `opsz` setting to 16 to preserve the previous Google Fonts face's
fixed optical size. JetBrains Mono has no optical-size axis and ignores it;
font weights continue to follow CSS `font-weight`.

## JetBrains Mono

Source revision: `6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da`.

- [JetBrainsMono[wght].ttf](https://github.com/google/fonts/blob/6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf)
  → `app/fonts/jetbrainsmono/JetBrainsMono-Regular.ttf`
- [Original license](https://github.com/google/fonts/blob/6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/OFL.txt),
  included at [jetbrainsmono/OFL.txt](jetbrainsmono/OFL.txt).

The file contains a weight axis (100–800). The application exposes weights
300–700, including the previously requested 300, 400, 500, and 700, in normal style.

## Integrity

SHA-256 of the unmodified font files:

```text
8a08d13f8a6c0d51be379a60af84f945f65369a67e509ee3c3bdcc421254d7c1  Newsreader-Regular.ttf
796668611f80b64d5adf182fde3b6f29ed83b4e7cbec7b96937e84ac01364792  Newsreader-Italic.ttf
48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda  JetBrainsMono-Regular.ttf
```

The license notices live in `public/font-licenses` so that they accompany the
emitted font assets in production distributions that copy `.next` and `public`.
