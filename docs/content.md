# Feed content: language, categories, taste and filters

Fresh writes short cards from the stories its sources find. What language those cards are in, who
they are written for, which categories exist and what is filtered out all come from configuration
and data files, with neutral English defaults. This page lists the keys, the files and how to
change the language.

## Content language

```json
{
  "fresh": {
    "content": { "language": "English", "languageCode": "en", "locale": "en-US" }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `fresh.content.language` | `English` | The language name that goes into every prompt ("German", "Brazilian Portuguese"). |
| `fresh.content.languageCode` | `en` | ISO code. It selects the per-language files below and is stored on glossary decisions. |
| `fresh.content.locale` | `en-US` | BCP 47 locale, for formatting done with `Intl`. |

The UI language is a separate axis (`public/locales/`, see `docs/i18n.md`); this section only
concerns the cards.

## Categories

```json
{
  "fresh": {
    "categories": [
      {
        "id": "ai",
        "label": "AI",
        "halfLifeHours": 18,
        "keywords": { "pos": "\\b(model|llm|agent)\\b", "neg": "\\b(agi|valuation)\\b" }
      }
    ]
  }
}
```

- `id` is the value stored on a card and used by the client; `label` is what the reader sees.
- `halfLifeHours` is how fast a story in that category goes stale in the ranking.
- `keywords.pos` and `keywords.neg` are regular expressions as **strings**, compiled with the `i`
  flag. They raise or lower a story before a model has looked at it, and stand in when no model
  answers. An invalid expression is a configuration error.
- The whole list replaces the defaults; there is no merge per category.

Without `fresh.categories`, `<dataDir>/categories.json` is used, and without that the shipped
defaults: `tech` (Technology), `ai` (AI) and `security` (Security).

## Reader profile (taste)

```json
{ "fresh": { "taste": { "profile": "file:taste.md" } } }
```

The profile is plain text handed to the classifier as the reader's state and to the writer as the
`{{profile}}` slot. It is either the text itself or a `file:` reference **inside the data
directory** (the same path rules as a secret file; `..` and absolute paths are refused). Without
`fresh.taste.profile`, `<dataDir>/taste.md` is read; without that, a short neutral profile applies.

## Filter packs

```json
{ "fresh": { "filters": { "packs": ["en"] } } }
```

A pack is a JSON file of rules:

```json
{
  "id": "en",
  "lang": "en",
  "rules": [
    { "name": "affiliate", "action": "drop", "test": "\\b(affiliate|referral link)\\b" },
    { "name": "laptop", "action": "soft", "test": "\\b(laptops?|ultrabooks?)\\b" },
    { "name": "homelab", "action": "soft", "unless": "ai-tool", "test": "\\b(homelab|proxmox)\\b" },
    { "name": "ai-tool", "action": "allow", "test": "\\b(ai|llm|agent)\\b" },
    { "name": "console-business", "action": "category", "cats": ["console"], "test": "\\b(units sold|layoffs?)\\b" }
  ]
}
```

| Action | Effect |
|---|---|
| `drop` | The story is never shown. |
| `soft` | The story is dropped unless an `allow` rule matches (the reader's topics). |
| `allow` | Marks the story as on topic, so `soft` rules do not apply. Also named by `unless`. |
| `category` | Like `drop`, but only for the categories in `cats`. |

`unless` names another rule that cancels this one. `lang` restricts a pack to posts of that
language when the source knows it (an `X` post with `lang:de`, for example); a pack without `lang`
applies to everything.

The shipped pack is `src/fresh/filters/en.json`. A file `<dataDir>/filters/<id>.json` with the same
`id` replaces it, and other ids add packs. A pack that is listed but missing, or that cannot be
parsed, is skipped with a warning.

The "meta-sentence" check (a card that talks about the text instead of the story) is a separate
list: `src/fresh/filters/meta.<code>.json`, replaced by `<dataDir>/filters/meta.<code>.json`. A
language with no list is not checked at all.

## Writer limits

```json
{ "fresh": { "writer": { "titleMax": 90, "summaryMaxWords": 55, "whyMaxWords": 18 } } }
```

These are the limits the prompt states and the cheap checks enforce (a title a little over the
limit is still accepted, so a model that rounds up is not punished).

## The writer's answer

The writer answers with a JSON array whose objects are:

```json
{ "id": "...", "title": "...", "summary": "...", "why": "...", "topics": ["..."], "substance": true }
```

## Prompt templates

`src/fresh/prompts/*.md` holds the prompts in English with `{{slots}}`:

| Template | Slots |
|---|---|
| `writer.md` | `language`, `profile`, `categories`, `schema`, `titleMax`, `summaryMaxWords`, `whyMaxWords` |
| `quality.md` | `language`, `profile` |
| `terms.md` | `language` |
| `dedupe.md` | none |
| `threads.md` | none |

`render(name, vars)` in `src/fresh/prompts.js` fills them. An unknown slot, or a value for a slot
the template does not use, throws: a typo becomes a test failure instead of `{{typo}}` reaching a
model.

## Glossary

The glossary decides which English technical terms stay English in a card. Its shipped seed is
`src/fresh/glossary/en.json` (`keep` terms, `candidates` to ask a model about, `typos`). A
deployment in another language adds `<dataDir>/glossary.<code>.json` with `translate` entries
(`{ "term": "privacy", "form": "..." }`); the export script below writes one from an older profile.

## Time zone

```json
{ "timezone": "UTC" }
```

One IANA name, validated at start-up. It is used for the daily usage counters, for the day key of
the Fresh usage record and for the quiet hours of notifications.

## Data files, in one place

| File | What it holds |
|---|---|
| `<dataDir>/categories.json` | The category list (same shape as `fresh.categories`). |
| `<dataDir>/taste.md` | The reader profile text. |
| `<dataDir>/filters/<id>.json` | A filter pack (replaces the shipped pack of that id). |
| `<dataDir>/filters/meta.<code>.json` | The meta-sentence patterns of a language. |
| `<dataDir>/glossary.<code>.json` | Seed terms and renderings of a language. |

## Database

The card's own-language title is stored in `title_local` (it was `title_id`). The rename runs once
when the store opens: the database file is copied to `<db>.pre-title-local.bak` first, then the
column is renamed inside a transaction. An in-memory database is not copied. The API payload keeps
the field name the client already reads (`title`), so `public/` needed no change.
