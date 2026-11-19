# How Open Study Studio works

This guide walks through the app one piece at a time, in plain English, and then lists questions an interviewer might ask about it.

## 1. The big picture

Think of the app as a private tutor with three helpers:

- a **librarian** who has read all your notes and can find the right page fast (`retrieval.js`),
- a **timetable planner** who decides what you study each day (`planner.js`),
- a **teacher** who explains, asks questions and marks answers (the AI model, reached through `llm.js` and `prompts.js`).

Everything they need is kept in a filing cabinet inside your own browser (`store.js`). The screen you click on is `app.js`.

There is no server. The web page is just files. When you open it, your browser runs the code, stores your data and talks to the AI provider directly.

## 2. Storing data in the browser (`store.js`)

Browsers have a built-in database called **IndexedDB**. It works like a dictionary: you save a value under a key and read it back later.

| Key | What's saved |
| --- | --- |
| `settings` | AI provider, API key, model |
| `profile` | Your name, course, modules, exam dates, study days |
| `progress` | For each topic: done or not, score, attempts, review date |
| `file:<id>` | One uploaded document, already split into chunks |
| `plan:<moduleId>` | The topic list for a module |
| `bank:<moduleId>` | Every practice question answered in that module |

**Why IndexedDB and not localStorage?** localStorage only holds about 5 MB of text. A few lecture PDFs can be bigger than that. IndexedDB can hold far more.

**Trade-off:** the data lives in one browser on one device. That's why there's a backup and restore button.

## 3. Reading notes and finding the right part (`retrieval.js`)

**Step 1: get the text out.** PDFs are read with pdf.js, Mozilla's PDF library, page by page. Text and caption files are read directly.

**Step 2: chunk it.** The text is cut into pieces of about 1,400 characters, keeping paragraphs together where possible. Small pieces mean the AI is sent only the relevant part, not the whole PDF.

**Step 3: search with BM25.** When you open a topic, say "Dropout", the app scores every chunk of that module's notes:

- A chunk scores higher if it contains the topic's words, like "dropout" and "overfitting". This is **term frequency**.
- Rare words count more than common ones. "Dropout" appearing in 2 of 200 chunks is a strong signal, while "model" appearing in 150 chunks isn't. This is **inverse document frequency**.
- Extra repeats help less and less. Saying "dropout" 20 times isn't 20 times better. The `k1` setting controls this.
- Long chunks are slightly penalised so they don't win just by containing more words. The `b` setting controls this.

The top 3 or 4 chunks are put into the prompt. Finding relevant text first and then generating an answer from it is called **retrieval-augmented generation (RAG)**.

**Why BM25 and not embeddings?** BM25 needs no extra AI calls, works offline and is easy to test. Its weakness is that it matches exact words. If your notes say "regularisation by randomly removing units" and never say "dropout", BM25 can miss it. Embeddings match meaning, so they'd be the next improvement.

## 4. Making the timetable (`planner.js`)

**Topics.** When you plan a module, the AI reads a sample of your notes and returns 8 to 18 topics, ordered from basics to advanced, each tagged as level 1, 2 or 3.

**Slots per day.** Minutes per day divided by 45, rounded. So 90 minutes means 2 topics a day.

**Which module goes first?** For each module the planner works out:

```
urgency = topics left / study days left before the exam
```

The module with the highest urgency gets the next slot. A module with 10 topics left and 5 days to go beats one with 10 topics and 50 days.

**Why nothing piles up.** The plan is never saved. It's calculated fresh from today every time. If you skip Tuesday, Wednesday doesn't show "4 overdue topics". It just shows the next 2.

**Reviews.** Under 70% on a topic sets a review date three days later. That's a simple form of **spaced repetition**: coming back to a weak topic after a gap helps it stick.

**Difficulty.** Practice difficulty goes from 1 (recall a definition) to 5 (a hard question combining ideas):

```
difficulty = 1 + floor(score / 22), plus 1 on a second attempt, kept between 1 and 5
```

The score used is your last score on that topic, or your module average, or 40% if you're brand new.

## 5. Talking to the AI (`llm.js` and `prompts.js`)

`complete(settings, prompt)` sends a prompt and returns the reply. It hides the differences between providers:

- **Gemini** is called at `generativelanguage.googleapis.com` with the key in the URL.
- **Claude** is called at `api.anthropic.com` with the key in a header.

**Streaming.** Lessons are long, so the reply is streamed using server-sent events. Text arrives in small pieces and the lesson appears word by word, so the student isn't staring at a spinner.

**JSON replies.** For topics, questions and marks, the prompt asks for JSON in a fixed shape, such as `{"marks":[{"score":7,"feedback":"..."}]}`. `parseJson()` strips code fences and takes the text between the first `{` and the last `}`, because models sometimes add a sentence before or after.

**Prompts in one file.** Every prompt lives in `prompts.js`, so improving the teaching style means editing one file.

**Marking.** The marking prompt includes the question, the model answer, a one-line mark scheme and the student's answer, and asks for a score out of 10 plus feedback. Giving the model the mark scheme makes marking more consistent. This is a form of **LLM-as-a-judge**.

## 6. Questions an interviewer might ask

**Why did you build it?**
I was studying for my MSc and preparing for interviews at the same time, and I wanted a tutor that used my own lecture notes and adapted to me. I designed it so any student can use it for their own course.

**What is RAG and why use it here?**
Retrieval-augmented generation means finding relevant text first and giving it to the model with the question. Here it keeps lessons tied to the student's course, with their lecturer's notation and examples, and reduces the chance of the model drifting off-syllabus.

**How would you know if the tutor is any good?**
I'd evaluate each part separately. For retrieval, I'd label which chunk should match a set of topics and measure how often it lands in the top 3. For marking, I'd compare the AI's scores with a human's on the same answers. For learning, I'd see whether scores on reviewed topics go up.

**What are the risks?**
The model can be wrong or mark inconsistently, so the app always shows a model answer and the student can retry. API keys in a browser are acceptable for a personal tool but not for a shared product, which would need a server. The app also sends notes to the AI provider, so students should check their university's rules on uploading course materials.

**What would you build next?**
Embedding-based search, OCR for scanned PDFs, sign-in with cloud sync, and an evaluation set for the marking.

**How did you test it?**
The planner and retrieval are pure functions with unit tests in `tests/`. For example, the tests check that a missed day doesn't create a backlog and that the nearer exam gets priority. I tested the AI steps end to end with a fake AI response, so the flow can be checked without spending API credits.
