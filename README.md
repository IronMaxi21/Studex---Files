<div align="center">

<img src="Studex.icns" alt="Studex" width="96">

# Studex

**Everything you're revising, in one window.**

Notes, an infinite canvas, flashcards, your exam board's specification and the
revision timetable — one native Mac app, working offline, on your own disk.

[![Latest release](https://img.shields.io/badge/release-v1.2.0-5a4fcf)](https://github.com/IronMaxi21/Studex-releases/releases/latest)
[![macOS 13+](https://img.shields.io/badge/macOS-13%20Ventura%20or%20later-1c1a4a)](#requirements)
[![Apple silicon](https://img.shields.io/badge/Apple%20silicon-arm64-444)](#requirements)
[![Free to start](https://img.shields.io/badge/free-no%20card%20required-2e7d5b)](#free-vs-pro)

<a href="https://github.com/IronMaxi21/Studex-releases/releases/download/v1.2.0/Studex-1.2.0.dmg" target="_self"><img width="200" src="https://github.com/user-attachments/assets/e3179be1-8416-4b8a-b417-743e1ecc67d6" alt="Download for macOS" /></a>

Once downloaded, open the `.dmg` and move **Boring Notch** to your `/Applications` folder.

> [!IMPORTANT]
> We don't have an Apple Developer account (yet 👀), so macOS will warn you that Studex is from an unidentified developer on first launch. This is expected behavior.
>
> You'll need to bypass this before the app will open. You only need to do this once. Use one of the methods below.

---

#### Recommended: Terminal (Always Works)

This is the quickest and easiest method. It only requires a single command and works consistently for all users. System Settings can sometimes fail and won't work for non-admin users.

After moving Boring Notch to your Applications folder, run:

```bash
xattr -dr com.apple.quarantine /Applications/studex.app
```

Then open the app normally.

---

#### Alternative: System Settings

> [!NOTE]
> This method doesn't work for all users. If this doesn't work, use the Terminal method above.

1. Try to open the app — you'll see a security warning.
2. Click **OK** to dismiss it.
3. Open **System Settings** > **Privacy & Security**.
4. Scroll to the bottom and click **Open Anyway** next to the Boring Notch warning.
5. Confirm if prompted.

---


---

## What it does

Most revision setups are three apps that don't know about each other: notes in
one, cards in another, a timetable in a spreadsheet nobody updates after week
two. Studex is the one window where those are the same thing — a card
remembers the note it was cut from, and the timetable is built out of what you
actually keep getting wrong.

### Notes that build understanding

<img src="docs/img/app-library2.jpg" alt="A document open beside the subject rail" width="820">

- A real block editor — headings, bullets, numbered lists, to-dos, tables,
  quotes, code and images, nested as deep as the topic goes.
- **Two notes side by side.** Split the workspace and put the past paper next
  to your answer. Drag the divider; both halves stay live.
- **PDF and slide annotation.** Drop in lecture slides or a past paper and mark
  it up. Every annotation stays pinned to its page, and highlighted text
  becomes a card in two clicks.
- **Search that reaches inside** — one box over every title, paragraph, PDF and
  card in the library.

### A canvas for the messy thinking

<img src="docs/img/app-canvas.png" alt="An infinite canvas with ink, nodes and a flashcard" width="820">

Not every idea arrives in order. Spread it out first, tidy it into a document
once you can see the shape of it.

- Pressure-aware pen, highlighter and eraser for mechanisms, diagrams and
  working out.
- Nodes and connectors, so the links between ideas stay visible.
- Shapes, text, images, dragged-in PDF pages.
- Turn any node into a flashcard without leaving the board.

### Cards that come back when you'd forget

<img src="docs/img/app-review.jpg" alt="A card in review with Again, Hard, Good and Easy" width="820">

- Highlight a line in a note and it becomes a card, still attached to the note
  it came from.
- A real spaced-repetition algorithm with learning, review and relearning
  states. **Again · Hard · Good · Easy** each move the card's ease and
  interval; a lapsed card keeps a fifth of its interval rather than starting
  from nothing.
- **Test and Learn**, not just flipping — typed answers marked exactly,
  normally, or leniently about spelling.
- **Image occlusion** for diagrams, maps and labelled anatomy.
- A card only counts as *known* once it's holding a week or more. Everything
  below that is still learning, and the app says so.

### Your specification, marked out of five

<img src="docs/img/app-topics.jpg" alt="The topic matrix, each topic rated one to five" width="820">

- Drop in your exam board's specification — PDF, Word or plain text — and
  Studex reads the topic list out of it. **The file is parsed on your Mac.**
- Rate each topic as you honestly feel about it. The date to come back is
  calculated from that rating; you don't get to type it yourself.
- See the subject as a grid of confidence, or just what's due today.

### A plan you didn't have to write

<img src="docs/img/app-calendar.jpg" alt="Exams, deadlines and study blocks in the calendar" width="820">

- Exams, assignments, classes and study blocks in one calendar, each with a
  countdown and a readiness score.
- Studex lays a plan onto the evenings you said you were free, weighted by your
  own topic ratings and the cards you keep lapsing — weakest first — and shows
  you the whole thing **before** it writes a single event.
- Don't like the order? Reshuffle. Happy? Commit, and every block lands as a
  real event you can move.
- A focus timer that carries between notes and keeps its elapsed time on the
  server, so closing the lid doesn't lose the hour. Breaks aren't logged as
  study.

### Numbers that tell you what to do next

<img src="docs/img/app-statistics.jpg" alt="Streak, hours logged, recall accuracy and exam readiness" width="820">

Current streak (with freezes that bank up while you keep going), hours logged
by the focus timer, recall accuracy per subject, and a **Ready / On track /
Behind** reading for each exam.

### The parts nobody puts on a landing page

- **Local first.** Notes, canvases and due cards work with no signal at all and
  reconcile when you're back — revision by revision, not last-write-wins.
- **A real Mac app.** Native window, native menus, its own dock icon. Sign in
  on a second Mac and the same library is there.
- **Keyboard-first.** Create, search, switch subject, start a session and grade
  a card without reaching for the trackpad.
- **Sharing.** Read-only links to a note, a deck or a whole folder.
- **A real trash.** Deleted is recoverable, and doesn't count against your plan.

---

## Requirements

| | |
|---|---|
| Operating system | macOS 13 Ventura or later |
| Processor | Apple silicon (M1 or later) |
| Network | Optional — the app is fully usable offline |
| Account | Only needed to sync between Macs |

---

## Free vs Pro

Free is not a trial. It doesn't expire, and it doesn't ask for a card.

| | Free | Pro — £4.50/mo |
|---|---|---|
| Documents and notes | Unlimited | Unlimited |
| Flashcards and decks | Unlimited | Unlimited |
| Canvases | 3 | Unlimited |
| Imported PDFs | 5 | Unlimited |
| Spaced repetition, focus timer | ✓ | ✓ |
| Exam and assignment tracker | ✓ | ✓ |
| Revision timetable builder | ✓ | ✓ |
| Statistics history | ✓ | ✓ |
| PDF and slide annotation | Within the 5-PDF cap | Unlimited |
| Handwriting conversion | — | ✓ |
| Offline folder caching | — | Every folder |
| Sharing links, priority support | — | ✓ |

Yearly billing is two months free. Cancel any time: your library stays readable
and exportable — you just can't create past the Free caps until you're back
under them.

---

## Shortcuts worth learning first

| | |
|---|---|
| <kbd>⌘</kbd><kbd>1</kbd> | New canvas |
| <kbd>⌘</kbd><kbd>2</kbd> | New document |
| <kbd>⌘</kbd><kbd>3</kbd> | New deck |
| <kbd>⌘</kbd><kbd>K</kbd> | Search everything |
| <kbd>⌘</kbd><kbd>,</kbd> | Settings |

---

## Your data

Your library lives on your own disk. Sign in and it syncs between your Macs;
don't, and the app still works with no network at all. Specification files are
read on your machine, not uploaded. Export is always available, including if
you stop paying.

---

## Problems and requests

Open an [issue](https://github.com/IronMaxi21/Studex-releases/issues) with your
macOS version, the Studex version from **Studex → About**, and what you were
doing when it went wrong. Feature requests are welcome in the same place.

This repository carries the **releases and release notes**. The application
source is not public.
