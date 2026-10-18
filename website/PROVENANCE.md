# Website screenshot provenance

Every screenshot in `website/assets/screens/` was captured from the real
Interleaf application by `tests/e2e/website-screenshots.spec.ts`. The app ran in a
fresh temporary profile created by the E2E helpers (`launchInterleaf`), with
network access disabled apart from a stubbed chat endpoint. That profile held
only the four books below. No personal library, database, document or earlier
screenshot was opened, copied or reused.

Before import, the spec checks each file against the SHA-256 recorded in
[`demo-library.json`](demo-library.json) and refuses to run if any file differs.
All four books were first checked on **26 September 2026**.

## Current capture

- **Captured:** 29 September 2026, from Interleaf **0.3.2** (a production
  `npm run build` of this repository), in a 1440 × 900 window at 2× scale.
- **Books:** the four files were downloaded again from the source URLs below on
  the same day. Each matched the recorded byte size and SHA-256 exactly, so the
  editions and licences above are unchanged.
- **Images:** all eight captures were replaced; no screenshot from an earlier
  capture was kept.

`website.screens.ts` re-encodes the captures as WebP at 960, 1600 and 2400
pixels wide, without metadata. The brand icons are resized from the app's own
`resources/icon.png`.

## The demo library

### 1. *Algorithms* — Jeff Erickson (programming PDF)

- **Edition:** 1st paperback edition, 13 June 2019 (ISBN 978-1-792-64483-2).
- **File:** <https://jeffe.cs.illinois.edu/teaching/algorithms/book/Algorithms-JeffE.pdf>
  - 25,055,430 bytes
  - SHA-256 `00295b82ff725c52a71351a0bb1ee1bdb1584e594a62395d3fb382aefd0f4d42`
- **Landing page:** <https://jeffe.cs.illinois.edu/teaching/algorithms/>
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Evidence:**
  - The landing page says the book is released under a "Creative Commons
    Attribution 4.0 International license". It notes that only *other* lecture
    notes on the site use a more restrictive NonCommercial licence.
  - The PDF's copyright page has the same licence and links to
    `http://creativecommons.org/licenses/by/4.0/`.
  - The page asks for attribution with a link back, directly or through
    `http://algorithms.wtf`.
- **Attribution used:** "Algorithms by Jeff Erickson, © 2019, licensed under CC BY
  4.0. http://algorithms.wtf". This appears on the site as the first credit, with
  both links.
- **Changes:** none. Screenshots show the unmodified pages at reduced size.
  Highlights and the note are Interleaf annotations overlaid on the page.

### 2. *Open Data Structures (in Java)* — Pat Morin (programming PDF)

- **Edition:** Edition 0.1G, screen PDF, generated 26 January 2015.
- **File:** <https://opendatastructures.org/ods-java-screen.pdf>
  - 1,853,333 bytes
  - SHA-256 `9448058ee235c85584a6754105a9a94d6bf25db1444e85fe984827e9ed3b970a`
- **Landing page:** <https://opendatastructures.org/>
- **Licence:** [CC BY 2.5 Canada](https://creativecommons.org/licenses/by/2.5/ca/).
- **Evidence:**
  - The landing page releases the book under a Creative Commons Attribution
    License, linked to `http://creativecommons.org/licenses/by/2.5/ca/`. It says
    "Users are free to copy, distribute, use, and adapt the text and source
    code, even commercially".
  - The book's introduction says it is released under a Creative Commons
    Attribution licence whose only condition is attribution.
- **Attribution used:** "Contains text from Open Data Structures (in Java) by Pat
  Morin, opendatastructures.org, licensed under CC BY 2.5 CA."
- **Changes:** none, as above.

### 3. *Alice's Adventures in Wonderland* — Lewis Carroll (Project Gutenberg)

- **Edition:** Project Gutenberg eBook #28885, released 19 May 2009, EPUB3 with
  images. It reproduces the 1907 edition illustrated by Arthur Rackham, with a
  proem by Austin Dobson.
- **File:** <https://www.gutenberg.org/ebooks/28885.epub3.images>
  - 1,475,294 bytes
  - SHA-256 `1a9a1a8e676daa6bf054700a5b98c777635f68da0c69407ebdd168a36a7104d8`
- **Landing page:** <https://www.gutenberg.org/ebooks/28885>
- **Licence:** public domain in the USA. The OPF records `<dc:rights>Public domain
  in the USA.</dc:rights>`. Carroll died in 1898, Rackham in 1939 and Dobson in
  1921. Project Gutenberg's terms: <https://www.gutenberg.org/policy/license.html>.
- **Changes:** none.

### 4. *Passages from the Life of a Philosopher* — Charles Babbage (Project Gutenberg)

- **Edition:** Project Gutenberg eBook #57532, released 18 July 2018, EPUB3 with
  images. It reproduces the 1864 London edition published by Longman, Green,
  Longman, Roberts, & Green.
- **File:** <https://www.gutenberg.org/ebooks/57532.epub3.images>
  - 738,706 bytes
  - SHA-256 `5bf3ea7e837b2851649fca9eee70b62e22a3b8393b60db6490edd170d2ac73d7`
- **Landing page:** <https://www.gutenberg.org/ebooks/57532>
- **Licence:** public domain in the USA. The OPF records `<dc:rights>Public domain
  in the USA.</dc:rights>`. Babbage died in 1871.
- **Changes:** none.

## Project Gutenberg notes

- The site uses screenshots of public-domain text. It does not redistribute
  either eBook file.
- "Project Gutenberg" is a registered trademark of the Project Gutenberg Literary
  Archive Foundation. The credits name it only to say where the texts came from,
  and link to its licence. Nothing on the site implies endorsement.
- A third candidate, *Flatland* (#201), was dropped. Its cover is generated by
  Project Gutenberg and carries the trademark.
- Interleaf shows EPUB covers on library cards as text placeholders, so no cover
  artwork appears in the screenshots.

## Sample AI content

The AI Chat screenshot shows a fixed answer written into the capture spec. A
stub of the OpenRouter completion endpoint returns it inside the test process,
using a dummy key that never leaves the machine. No model was called. The site
labels the image as a sample from a test fixture.

The Agent screenshot shows a drafted task only. No agent CLI was run: the spec
installs the repository's inert CLI fixture so the panel is populated.

## Personal-data check

The captures of 29 September 2026 were reviewed by eye, one by one. They show
only the four books, the demo annotations, the sample chat and the drafted agent
task. There are no file paths, user names or account details: the agent panel
shows "No folder selected", and the only providers named are the OpenRouter
stub in Chat and the inert Codex CLI fixture in the Agent panel. `tests/unit/website/website-site.spec.ts` also scans every shipped
text file for absolute home-directory paths.
