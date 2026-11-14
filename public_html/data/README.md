# Word data

Used by Wordle (`wordle-<lang>-valid.txt`: the valid guesses, one lowercase word per line, sorted) and bundled into the
Worker through `src/games/data/` (`wordle-en.js`, `wordle-tr.js`: valid guesses plus the secret-word pool,
`typing-words-*.js`: common words for the typing test, `typing-quotes.js`: quotations and proverbs).
The secret-word pools are deliberately NOT served as static files. `src/games/data/build-lists.mjs` regenerates the lists
(it needs the npm packages and downloads listed below; it is not part of the Worker bundle).

Sources and licences
- English dictionary: `word-list` by Sindre Sorhus (MIT) for the valid 5-letter guesses.
- Turkish dictionary: Zemberek `master-dictionary.dict` (Apache-2.0, github.com/ahmetaa/zemberek-nlp) for root words and
  parts of speech, plus `an-array-of-turkish-words` (MIT) for further forms.
- Word frequencies (to pick common secret words and typing words): FrequencyWords by Hermit Dave
  (github.com/hermitdave/FrequencyWords, code MIT, content CC-BY-SA 4.0, derived from OpenSubtitles). The selected word
  lists are derived from it: attribution is given here.
- Offensive words and first names are removed from the answer pools using `naughty-words` (CC-BY-4.0) and
  `@stdlib/datasets-male-first-names-en` / `female-first-names-en` (Apache-2.0), plus a hand-written exclusion list.
- Quotations: public domain authors (Shakespeare, Franklin, Lincoln, Emerson, Twain, Dickinson and others) and traditional
  Turkish proverbs (atasozleri).

Answer pools: English about 1300 and Turkish about 1500 common words (Turkish pool: nouns, adjectives and adverbs that are
dictionary roots, so verb forms and inflections are not secret words). Valid guesses are broader and, for Turkish, include
common inflected forms. All words are lower case in the language's own rules (Turkish dotless i / dotted i).
