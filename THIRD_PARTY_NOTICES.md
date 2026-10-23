# Third-party notices

This project bundles the following third-party code and assets. Each entry lists
the name, the version where one is visible in the repository, the license, and
the path. The full license text is kept next to the vendored files.

## Vendored in `public/vendor/`

| Name | Version | License | Path |
|---|---|---|---|
| OpenUI (bundle and styles) | 0.2.1 (from the file names) | MIT, Copyright (c) 2011-2024 Thesys Inc. | `public/vendor/openui/openui-bundle-0.2.1.min.js`, `public/vendor/openui/openui-styles-0.2.1.css`, license in `public/vendor/openui/LICENSE` |
| Nunito (variable font, latin and latin-ext subsets) | version not stated in the files | SIL Open Font License 1.1 | `public/vendor/fonts/nunito-latin-wght-normal.woff2`, `public/vendor/fonts/nunito-latin-ext-wght-normal.woff2`, license in `public/vendor/fonts/LICENSE-Nunito.txt` |
| Public Sans (variable font, latin and latin-ext subsets) | version not stated in the files | SIL Open Font License 1.1 | `public/vendor/fonts/public-sans-latin-wght-normal.woff2`, `public/vendor/fonts/public-sans-latin-ext-wght-normal.woff2`, license in `public/vendor/fonts/LICENSE-PublicSans.txt` |
| Font face declarations for the fonts above | — | same licenses as the fonts | `public/vendor/fonts/fonts.css` |

## Generated CSS

`public/ui.css` is generated from **daisyUI** and **Tailwind CSS** by the build in
`ui-build/` (`ui-build/package.json`, `ui-build/input.css`). It is committed so the
app needs no build step at runtime. The versions come from `ui-build/package.json`:

| Name | Version | License | Path |
|---|---|---|---|
| Tailwind CSS | ^4.3.3 (dev dependency) | MIT | generated into `public/ui.css` |
| daisyUI | ^5.7.50 (dev dependency) | MIT | generated into `public/ui.css` |
| @tailwindcss/cli | ^4.3.3 (dev dependency) | MIT | build tool only |

The generated file keeps Tailwind's license banner at the top. Rebuild it with
`cd ui-build && npm ci && npm run build`; the build dependencies are not needed at
runtime and are not vendored in the repository.

## Fonts referenced by `ui-build/`

`ui-build/package.json` lists `@fontsource-variable/nunito` as a dev dependency.
The font files it produces are copied into `public/vendor/fonts/` and are covered
by the Nunito entry above.

## Not included

No third-party JavaScript runs on the server: the app has no runtime npm
dependencies. No license is unclear at the time of writing; if one becomes
unclear, record it here as `TODO: verify`.
