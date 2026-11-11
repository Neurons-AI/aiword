# Neurons AI fork — engine for the AICoworker Office apps

This is the Neurons AI private mirror of [storytold/wordcraft](https://github.com/storytold/wordcraft)
(MIT OR Apache-2.0). It is the engine of **AI Word** (`skills/ai-word`). Its sisters:
`Neurons-AI/craft-i18n` (translations, a build input) and `Neurons-AI/gridcraft` (engine of AI Sheet).

## Branches

| Branch | What it is |
|---|---|
| `main` | Exactly upstream. Never commit here; it only fast-forwards from `upstream/main`. |
| `aiword` | Our patches on top of `main` (branding "AI Word", no Discord/community links, …). Builds ship from here. |

Keep every patch small and in `aiword` so a rebase on a new upstream stays easy.

## Remotes

```sh
git remote -v   # origin = Neurons-AI/wordcraft (ours), upstream = storytold/wordcraft
```

## Pull a new upstream version

```sh
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout aiword && git rebase main          # fix conflicts in our patches only
git push --force-with-lease origin aiword
```

Same for `craft-i18n` (it has no patches: just fast-forward `main`) and `gridcraft`.

## Build the web engine and ship it into AI Word

Needs rustc (see `rust-toolchain.toml`), the `wasm32-unknown-unknown` target and `trunk`.

```sh
cd apps/wordcraft-web
CRAFT_I18N_DIR=<path to Neurons-AI/craft-i18n checkout at the rev in craft-i18n.rev> trunk build --release
rm -rf <workspace>/skills/ai-word/assets/wordcraft && mkdir -p $_
cp -R ../../dist/web/. <workspace>/skills/ai-word/assets/wordcraft/
cp ../../LICENSE-MIT ../../NOTICE <workspace>/skills/ai-word/assets/wordcraft/
rm -f <workspace>/skills/ai-word/assets/wordcraft/.trunk-lock
```

A release build takes about 5–10 min on an M1 Max. Then validate the app
(`validate_app.mjs skills/ai-word --tier 0 --test`) and open it once in AICoworker.

## Our patches (branch `aiword`)

- Product name: every UI string goes through `i18n::tr`, which now passes the text through
  `i18n::brand` (WordCraft/ArtCraft → AI Word) — one place covers English and all 28 languages.
  Window titles, About, file metadata (docx app.xml, PDF creator/producer, HTML generator,
  default author) say AI Word too. Code identifiers, crate names, the `window.wordcraft` JS API
  and the control protocol keep their names (renaming them would break every rebase).
- Discord: hidden by default (`show_discord: false`), removed from File › backstage, the keytips
  and the About dialog.

License: keep `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` with every shipped build.
