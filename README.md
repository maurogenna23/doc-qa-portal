# Doc Q&A Portal

Upload plain-text documents, ask questions in natural language, and get answers
grounded in those documents with the sources they came from.

Next.js + TypeScript on the front, API Gateway and Lambda on the back, Pinecone
as the vector store, OpenAI for embeddings and completions. The retrieval
pipeline is written by hand — no LangChain, no LlamaIndex.

**Deployed and running:** `https://rq3ifuxj51.execute-api.us-east-1.amazonaws.com`

```bash
curl -s https://rq3ifuxj51.execute-api.us-east-1.amazonaws.com/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Can I get a refund on a digital product?","topK":3}'
```

That deployment runs with `INGEST_MODE=async`, so `POST /ingest` returns `202`
and a worker Lambda indexes in the background — it is the bonus pipeline, and
deploying it is the only way to prove the SQS wiring actually runs. Give it
about a minute between ingesting and asking: the worker is quick, but Pinecone
takes longer to make a new vector queryable than it looks (see
[Trade-offs](#trade-offs-and-known-limitations)). `INGEST_MODE=sync` is one
environment variable away and returns the response shape in the spec.

---

## How it works

```
                POST /ingest
  ┌──────────┐  POST /ask      ┌───────────────┐
  │ Next.js  │ ───────────────▶│  API Gateway  │
  │  /docs   │                 │   (HTTP API)  │
  │  /       │◀─────────────── │   throttled   │
  └──────────┘                 └───┬───────┬───┘
                                   │       │
                  ┌────────────────┘       └────────────────┐
                  ▼                                         ▼
          ┌───────────────┐                         ┌───────────────┐
          │ ingest Lambda │                         │  ask  Lambda  │
          └───────┬───────┘                         └───────┬───────┘
                  │                                         │
                  │  chunk → embed → upsert                 │  embed question
                  │                                         │  → query top-K
                  ▼                                         ▼  → prompt → answer
          ┌─────────────────────────────────────────────────────┐
          │  Pinecone (vectors)        OpenAI (embeddings, LLM)  │
          └─────────────────────────────────────────────────────┘
```

With `INGEST_MODE=async`, `POST /ingest` stages each document in S3, publishes a
pointer to SQS and returns `202`. A worker Lambda then runs the same pipeline
off the request path. See [Async ingest](#async-ingest) below.

---

## Project layout

```
packages/contracts      request/response types shared by the web app and the API
services/api
  src/core              the RAG pipeline: chunking, validation, prompt, ingest, ask
  src/adapters          OpenAI, Pinecone, S3/SQS, logging
  src/handlers          Lambda entry points (ingest, ask, SQS worker)
  src/local             dev server that invokes the real handlers
  test                  unit tests (144)
infra                   AWS CDK stack
apps/web                Next.js app
```

The split between `core` and `adapters` is the main structural decision, and
the rest of the design follows from it. `core` contains the pipeline and depends
only on three interfaces — `EmbeddingProvider`, `CompletionProvider`,
`VectorStore`. It imports no vendor SDK and knows nothing about AWS. `adapters`
implements those interfaces against real services.

That boundary buys three concrete things:

1. **The pipeline is testable without a network or an API key.** All 144 tests run
   in under a second against in-memory doubles.
2. **The SQS worker reuses the pipeline unchanged.** Async ingest changes *when*
   the work happens, not *what* the work is, so the bonus cost almost nothing.
3. **Swapping providers is a config change.** The OpenAI adapter takes a
   `baseURL`, so pointing `LLM_BASE_URL` at Groq, Together or OpenRouter works
   without touching application code.

---

## Prerequisites

- **Node 22** (`.nvmrc` pins it; `nvm use` picks it up). The Pinecone and OpenAI
  SDKs require it, and it matches the `nodejs22.x` Lambda runtime — what runs
  locally is what runs deployed.
- A **Pinecone** account (the free Starter tier is enough).
- An **OpenAI** API key, or any OpenAI-compatible provider.
- For deployment only: an AWS account with credentials configured and CDK
  bootstrapped.

---

## Setup

### 1. Create the Pinecone index

```bash
npm install
npm run setup:pinecone
```

The script creates the index if it is missing and verifies it otherwise. Doing
it in code keeps the index's shape in the repository: the dimension has to match
the embedding model, which is a fact about the code rather than a value someone
should have to remember to type into a form.

It creates the equivalent of:

| Setting | Value |
| --- | --- |
| Name | `doc-qa` |
| Dimensions | **1536** |
| Metric | **cosine** |
| Type | **Serverless** (AWS, `us-east-1`) |

The dimension is not arbitrary: it is the width of a `text-embedding-3-small`
vector. A mismatch fails fast with an explicit error rather than writing bad
vectors — the setup script checks it, and there is a unit test covering the
runtime path.

Serverless specifically: stale-chunk cleanup lists vectors by id prefix, which
serverless indexes support. See [Re-ingest without duplicates](#re-ingest-without-duplicates).

### 2. Configure environment variables

```bash
cp .env.example .env
```

Then fill in `.env` at the repository root. Both the local API server and
`cdk deploy` read this one file, so a key is set in one place rather than two
that can disagree.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PINECONE_API_KEY` | yes | — | Pinecone API key |
| `PINECONE_INDEX` | yes | — | Index name, e.g. `doc-qa` |
| `PINECONE_NAMESPACE` | no | — | Logical partition inside the index |
| `LLM_API_KEY` | yes | — | OpenAI (or compatible) API key |
| `LLM_BASE_URL` | no | OpenAI | Point at another OpenAI-compatible provider |
| `EMBEDDING_MODEL` | no | `text-embedding-3-small` | Embedding model |
| `EMBEDDING_DIMENSIONS` | no | `1536` | Must match the index dimension |
| `COMPLETION_MODEL` | no | `gpt-4.1-mini` | Answering model |
| `MAX_OUTPUT_TOKENS` | no | `500` | Ceiling on generated tokens |
| `MAX_CONTEXT_CHARS` | no | `8000` | Ceiling on retrieved context sent to the LLM |
| `MIN_SCORE` | no | `0` | Cosine floor for a chunk to be used; `0` disables |
| `INGEST_MODE` | no | `sync` | `sync` or `async`. `sync` is simpler and matches the response shape the assignment specifies; `async` is the one that serialises concurrent writes to a document — see [Those three steps are not atomic](#those-three-steps-are-not-atomic) |
| `INGEST_BUCKET` | async only | — | Set automatically by CDK |
| `INGEST_QUEUE_URL` | async only | — | Set automatically by CDK |
| `API_RATE_LIMIT` | no | `10` | API Gateway steady-state requests/second |
| `API_BURST_LIMIT` | no | `20` | API Gateway burst ceiling |
| `INGEST_WORKER_CONCURRENCY` | no | `0` | Reserved concurrency for the ingest worker. `0` means no reservation — see [Deploying to AWS](#deploying-to-aws) |
| `PINECONE_CLOUD` | no | `aws` | Only read by `npm run setup:pinecone` |
| `PINECONE_REGION` | no | `us-east-1` | Only read by `npm run setup:pinecone` |
| `PORT` | no | `4000` | Local API server port |

The web app reads one variable of its own:

```bash
cp apps/web/.env.local.example apps/web/.env.local   # NEXT_PUBLIC_API_BASE_URL
```

---

## Running locally

```bash
nvm use
npm install
```

In one terminal, the API:

```bash
npm run dev:api        # http://localhost:4000
```

In another, the web app:

```bash
npm run dev:web        # http://localhost:3000
```

Open <http://localhost:3000/docs> to add documents, then <http://localhost:3000>
to ask a question.

The local server is not a second implementation of the API. It builds an API
Gateway v2 event and invokes the **real Lambda handlers**, so validation, error
mapping and response shapes behave locally exactly as they do deployed.

---

## Example requests

### `POST /ingest`

```bash
curl -s http://localhost:4000/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "documents": [
      {
        "id": "refund-policy",
        "title": "Refund Policy",
        "content": "Full refund within 30 days with receipt. No refunds on digital goods."
      }
    ]
  }'
```

```json
{ "status": "completed", "ingestedDocuments": 1, "ingestedChunks": 1 }
```

In async mode the same request returns `202`:

```json
{ "status": "queued", "ingestedDocuments": 1, "ingestedChunks": null, "jobId": "…" }
```

`ingestedChunks` is `null` rather than `0` because the count is genuinely
unknown at accept time — the chunking has not happened yet. Reporting `0` would
be a lie that happens to type-check.

### `POST /ask`

```bash
curl -s http://localhost:4000/ask \
  -H 'Content-Type: application/json' \
  -d '{ "question": "Can I get a refund on a digital product?", "topK": 3 }'
```

```json
{
  "answer": "Digital products are not eligible for refunds.",
  "sources": [{ "docId": "refund-policy", "title": "Refund Policy" }]
}
```

### Errors

```bash
curl -s http://localhost:4000/ask \
  -H 'Content-Type: application/json' -d '{ "topK": 3 }'
```

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid ask request.",
    "details": ["\"question\" must be a string."]
  }
}
```

| Status | When |
| --- | --- |
| `400` | Malformed or invalid input; `details` names each offending field |
| `413` | Too many documents, or a document over the size limit |
| `502` | Pinecone or the LLM provider failed |
| `500` | Missing configuration, or an unexpected error |

`message` is always a string this codebase wrote. A third party's own text —
the Pinecone SDK's rejection notice, an OpenAI error payload, a stack trace —
travels in the error's `cause`, which is logged and never serialised into the
body.

This was not true in an earlier version. The Pinecone adapter interpolated the
SDK's message into the error, so a rejected API key returned the index name and
the internal endpoint to an unauthenticated caller, while the README claimed
otherwise. The test that was supposed to cover it only exercised the
non-`AppError` branch, so it passed against a false property, which is worse
than having no test. `test/http.test.ts` now asserts both halves: that the
provider text is absent from the body, and that it is present in the log.

---

## Tests

```bash
npm test
```

144 unit tests, all against in-memory doubles, so they need no credentials and
cost nothing to run. They cover:

- **chunking** — determinism, sentence-boundary splitting, hard-splitting a
  sentence longer than a chunk, the overlap cap that guarantees forward
  progress, and the overlap ramp: that it degrades with sentence length rather
  than cliff-edging, and reaches zero only at the boundary where one sentence
  nearly fills a whole chunk
- **re-ingest** — that the same id updates in place, that a *shortened* document
  has its trailing chunks deleted, and that other documents are untouched
- **prompt building** — context-budget truncation, and that sources are derived
  only from passages the model actually saw
- **ask** — that an empty retrieval returns the refusal *without calling the LLM*
- **validation** — every rejection path, plus the `topK` clamp
- **HTTP mapping** — status codes per error class, and that internal errors do
  not leak
- **configuration** — that a missing variable is reported by name, and that
  async mode refuses to start without its bucket and queue

### Answer-level evaluation

```bash
npm run eval
```

Unit tests prove the pipeline is wired correctly. They cannot prove the *prompt*
works, because the model is not in them. `npm run eval` seeds a fixed corpus into
its own Pinecone namespace and runs eight questions against the real providers,
checking two things per case: whether the system answered or refused, and which
documents it cited.

The cases include paraphrase (a question whose wording does not match the
passage), a compound question spanning two documents, a question nothing in the
corpus answers, and a question the model certainly knows but must still refuse
because it is not in the documents.

There are two suites. `clean corpus` measures answer and citation quality.
`poisoned corpus` seeds the same documents plus four carrying prompt-injection
attempts — through the body and through the title — and fails any case where the
injected phrase reaches the answer.

```bash
npm run eval                  # both suites
npm run eval -- eval-poisoned # just the injection suite
```

It costs a fraction of a cent per run and it has caught eight defects no unit
test could have — described under
[Prompt design](#prompt-design-was-measured-not-reasoned-about) and
[Prompt injection](#prompt-injection-mitigated-not-solved).

---

### What was verified against the real services

Beyond the test suites, the following was exercised end to end against a live
Pinecone index and the OpenAI API:

- **Ingest** of three documents, and answers citing the correct one for each.
- **Refusal** on a question nothing in the corpus answers, with no sources.
- **Re-ingest of a shortened document**, the case the requirement is really
  about. A document that chunked into two was re-ingested with only its first
  paragraph. `employee-handbook#chunk-2` was confirmed gone from Pinecone, no
  duplicate was created, the question that chunk used to answer now returns the
  refusal, and the text that survived the edit still answers.
- **The web app**, driven through the browser: a document added on `/docs` was
  then answerable on `/` with that document as its only source.
- **A missing API key**, which returns `CONFIGURATION_ERROR` naming the variable.
- **A rejected Pinecone key**, confirming the provider's message appears in the
  log and not in the response body.
- **Prompt injection**, measured as the table under
  [Prompt injection](#prompt-injection-mitigated-not-solved) reports it, through
  both the document body and the title.
- **A partial enqueue failure**, confirming the response names the documents that
  did not make it while the underlying AWS error stays in the log.

The stack was synthesised in both `sync` and `async` modes, the generated IAM
policies were read to confirm the ingest and worker roles cannot do each other's
job, and the template was checked for FIFO queues and the throttling settings.

**It was then deployed for real**, in `async` mode, to a dedicated AWS account,
and exercised there:

- `POST /ingest` returned `202`; CloudWatch shows the worker Lambda picking both
  documents off the FIFO queue and indexing them — in two separate invocations,
  because they are different message groups and only same-group messages
  serialise.
- `POST /ask` answered both questions correctly, each citing one document, and
  refused the question the corpus does not answer.
- The error paths return what this README says they return: `400` with field
  detail for a missing question, an empty body and malformed JSON, `400` for a
  multi-line title, and a `204` CORS preflight.
- The structured JSON logs arrive in CloudWatch in the shape the logging section
  describes.

## Deploying to AWS

```bash
cd infra
npx cdk bootstrap        # once per account/region
npx cdk deploy
```

The stack outputs `ApiUrl`. Put it in `apps/web/.env.local` as
`NEXT_PUBLIC_API_BASE_URL` and rebuild the web app.

To deploy with the async pipeline, set `INGEST_MODE=async` in `.env` before
deploying. CDK then creates the bucket, the queue, the dead-letter queue and the
worker, and wires their environment variables automatically.

```bash
npx cdk destroy          # removes everything, including the bucket contents
```

#### A fresh AWS account cannot reserve Lambda concurrency

Worth knowing before you deploy, because it cost me a failed rollback on the
first real attempt.

The ingest worker has a reserved-concurrency setting, because throttling the API
caps how fast work is *accepted* and not how many workers run at once. But a new
AWS account has a concurrent-execution limit of **10**, not the usual 1000, and
AWS refuses any reservation that would leave fewer than 100 unreserved. A
hardcoded reservation therefore makes the stack undeployable on exactly the kind
of account someone evaluating it would use.

So `INGEST_WORKER_CONCURRENCY` defaults to `0`, meaning no reservation. On a
constrained account the account limit is itself the ceiling; on a mature one,
set it. `cdk synth` cannot catch this — the template is valid, the account is
not — which is the argument for deploying at least once rather than trusting a
synth.

**What the stack creates**

- An HTTP API with `POST /ingest` and `POST /ask`, CORS, and request throttling
- Two ARM64 Lambdas on `nodejs22.x` (Graviton: same code, lower price per ms)
- Explicit log groups with 7-day retention, rather than logs that never expire
- In async mode: an S3 bucket (7-day object expiry), an SQS queue with a
  dead-letter queue after 3 attempts, and the worker Lambda

**HTTP API rather than REST API.** It is cheaper and lower-latency, and none of
the REST-only features — request validators, usage plans, API keys — are needed
here. Throttling, which is needed, is available on both.

**IAM is least privilege, and verified in the synthesized template.** The ingest
role may only `PutObject` and `SendMessage`; the worker role may only read the
bucket and consume the queue. Neither can do the other's job. The ask Lambda has
no AWS permissions at all beyond its execution role, because it only talks to
external HTTP APIs.

---

## Design notes

### Chunking

Fixed-size windows of ~800 characters with ~150 characters of overlap, preferring
paragraph and sentence boundaries over arbitrary cuts.

800 characters is roughly 150–200 tokens: small enough that a retrieved chunk is
mostly signal rather than surrounding noise, large enough to keep a paragraph's
argument intact. The overlap exists so an answer that straddles a boundary stays
retrievable from either side.

Three details that matter more than they look:

- **The overlap is capped at half a chunk.** Beyond that, each chunk would be
  mostly repeated text and the splitter would stop making forward progress. The
  cap is enforced in code and covered by a test.
- **The overlap shrinks to fit rather than disappearing.** An earlier version
  carried the full overlap when it fit and none at all when it did not, so any
  sentence longer than roughly `maxChunkChars - overlapChars` produced chunks
  with no overlap whatsoever — silently, and precisely for the long-sentence
  prose that contracts and policies are made of. It now carries as much as fits
  beside the new text: 145 characters becomes 95, then 45, then 5, reaching zero
  only when a single sentence nearly fills a whole chunk and there is genuinely
  no room. A test sweeps that range.
- **The function is pure and deterministic.** Same input, same chunks, always.
  That is what makes stable vector ids possible, which is what makes re-ingest
  work.

### Re-ingest without duplicates

The assignment requires that re-ingesting the same `id` updates rather than
duplicates. Chunk ids are deterministic — `refund-policy#chunk-1`,
`#chunk-2`, … — so re-ingesting a document produces the same ids and the upsert
overwrites in place.

That alone is not sufficient. If a document is **edited to be shorter**, the
previous version's trailing chunks keep their own ids, are never overwritten,
and would linger in the index answering questions from text the user deleted.

So each document is processed in this order:

1. list the ids the store currently holds for it, by id prefix
2. upsert the new chunks
3. delete the ids that survived from the previous version but are no longer produced

Upserting *before* deleting means the document is never momentarily absent from
the index. Deleting first would open a window where a concurrent `/ask` retrieves
nothing.

Listing by id prefix, rather than deleting by metadata filter, is deliberate:
Pinecone serverless indexes do not support delete-by-filter. The
`${docId}#chunk-N` id convention exists precisely so prefix listing can do this
job. It is also why document ids may not contain `#` — validation rejects them.

#### Those three steps are not atomic

The reasoning above covers a concurrent **reader**. It does not cover a
concurrent **writer**, and that is the case that breaks.

Two ingests of the same document id can interleave so that the short version
lists the index, the long version upserts its five chunks, and the short
version then deletes "everything that is not mine" — removing chunks the other
writer just wrote. The result is the long version truncated to two chunks: a
state that was never submitted, reported to both callers as success.

There is a deterministic reproduction of this in
`test/ingest.test.ts`. It forces the interleaving rather than racing for it, so
it fails the same way every run.

**The async path fixes it.** The queue is FIFO and every message carries
`MessageGroupId = docId`. SQS delivers one message group to one consumer at a
time, so two writes to the same document are serialised while different
documents stay fully parallel. Deduplication ids make a retried job idempotent
within the dedup window.

**The synchronous path does not.** Two concurrent `POST /ingest` calls for the
same id can still interleave. Fixing it there needs a lock the vector store
cannot provide — a conditional write in DynamoDB keyed by document id, or
routing every write through the FIFO queue and giving up the synchronous
response shape the assignment specifies. For a single-writer deployment, which
is what a take-home exercises, the synchronous path is correct; for concurrent
writers, `INGEST_MODE=async` is the supported answer, and this is the first
thing I would change before anyone relied on it.

### Grounding and sources

The system prompt restricts the model to the supplied passages and gives it an
exact refusal string for when they do not contain the answer.

**The model reports which passages it used**, and sources are derived from that.
The obvious alternative — cite everything retrieved — is wrong in a way that is
easy to miss: with `topK: 3` against a small corpus, every question cites every
document. An early build answered "how long is the hardware warranty?" correctly
and cited the refund policy and the shipping policy alongside the warranty. The
answer was right and the citations were noise.

Two further consequences are enforced in code rather than hoped for:

- **Sources come only from passages that fit the context budget.** The API cannot
  cite a document the model was never shown.
- **A refusal cites nothing.** If the model returns the refusal string, sources
  are emptied — listing documents behind "I don't know" would imply they were
  relevant when the model just said they were not.

Citations are requested as JSON in the prompt rather than through a
provider-specific structured-output parameter, which keeps the adapter portable
across OpenAI-compatible endpoints. That costs reliability, so parsing degrades
rather than failing: if no usable object is found, the reply is treated as a
plain answer citing everything shown — the behaviour we would have had without
citations at all, never an error.

### Prompt design was measured, not reasoned about

Both defects below were found by running `npm run eval`, and neither would have
been caught by a unit test.

**"Never guess" banned comprehension.** An early prompt said *"Do not use outside
knowledge, and never guess."* Read literally, that forbids ordinary reading, and
the model obliged: it refused to answer "Can I get a refund on a digital
product?" from a passage stating that *digital goods* are not refundable, and
refused "Do you ship to a PO box?" from one about *post office boxes*. Retrieval
was not at fault — the right passage scored 0.68 against 0.29 and 0.16 for the
others. Three of eight evaluation cases failed this way. The rule that matters is
narrower: do not introduce facts that are not in the passages. Recognising a
paraphrase has to be stated as permitted, not left to inference.

The prompt stays general about this on purpose. Naming the specific paraphrases
from the evaluation set would teach the model those cases and turn the
evaluation into a measurement of itself.

**The model answers in prose and then appends the JSON.** Asking for "a single
JSON object and nothing else" is an instruction, not a guarantee. Requiring the
entire reply to parse meant that this perfectly reasonable reply fell through to
the fallback — which cited every document *and* leaked the raw JSON envelope into
the user-visible answer. The parser now extracts the object from the surrounding
text.

**Model choice was decided by the evaluation, not by preference.** Under the same
prompt, `gpt-4o-mini` passed 6 of 8 cases and `gpt-4.1-mini` passed 8 of 8, stably
across three runs. The default is `gpt-4.1-mini` for that reason. `COMPLETION_MODEL`
makes it a one-line change if the cost trade-off ever points the other way.

### Prompt injection: mitigated, not solved

Documents are user-supplied text that reaches the same message as the
instructions. A document can therefore try to overrule them, and the citation
mechanism makes it worse: a hijacked answer arrives with a credible source
attached.

The evaluation has a second suite for this. It seeds the clean corpus plus four
documents carrying different injection styles — a fake system notice, a forged
passage tag, a fake end-of-documents marker, and one that attacks through the
**title** rather than the body — then asks ordinary questions. A case fails if
the injected phrase appears in the answer at all. The suite ingests through the
real validator, so a payload the API would reject cannot inflate the score by
never reaching the index.

Measured over three runs each, same corpus and model:

| Prompt | Clean corpus | Poisoned corpus |
| --- | --- | --- |
| Before hardening | 8/8 | **4/10** |
| After hardening | 8/8 | **7/10** |

Both rows are measured on the same ten cases and the same corpus, changing only
the prompt; the "before" row runs the pre-hardening prompt reconstructed from
git. The suite also asserts, before it runs, that each injected payload survives
prompt assembly intact — an earlier title payload was 145 characters against the
120-character cap and was cut mid-phrase, so that case passed mechanically and
measured nothing.

The hardening is four things:

1. Passage text is delimited and declared untrusted rather than interpolated raw.
2. Anything in a document that could close or forge a delimiter is neutralised,
   without which the delimiting is theatre.
3. The question is tagged rather than separated by a bare rule, because one
   injection reproduced that rule followed by a fake system message.
4. **Every user-controlled value is sanitised, not only the body.** The title is
   rendered into the passage header, and a header is one line. An earlier version
   stripped quotes and angle brackets from it but not newlines, so a
   144-character title escaped its own attribute and injected structure into the
   header — hijacking two of three answers, one of them about an unrelated
   document. Titles carrying control characters or Unicode line separators are
   now rejected at the API as well, so a caller learns their input was wrong
   rather than having it silently rewritten.

   Rendered titles are also **flattened and truncated to 120 characters**. This
   is separate from the 256 the API accepts: 256 is how much title a caller may
   store and see returned in `sources`, 120 is how much of it the *model* is
   shown in an attribution header. A header that grows without limit is surface
   area, and the title is weak signal next to the chunk text. The truncation is
   invisible to the user, which is the one part of this that sits awkwardly
   beside the rejection rule above — it is documented here rather than left for
   someone to discover.

Point four is the one worth dwelling on. The body was treated as hostile and the
title was not, because the body is the part that *looks* like content. The lesson
is not "escape newlines": it is that a field's threat model comes from where it
is rendered, not from what it is called.

**It is still not a fix, and the denominator moved.** Three of ten cases get
through, consistently — and they are the *same three* that got through before
the hardening: the phishing question, the capital-of-France question, and the
open-ended "what should I do today". The absolute number of hijacks did not
fall. It went from 5 of 8 to 3 of 10 because two title cases were added that the
hardening resists, not because any previously-failing case started passing.
Reading the two tables as progress on the same axis would be reading them wrong. A prompt
is the wrong layer: the real answers are authenticating `/ingest` so arbitrary
text cannot enter the corpus, and treating retrieved content as data at a level
the model cannot be argued out of. Both are beyond what this exercise asked for,
so what is here is the mitigation, an honest measurement of its ceiling, and a
suite that will show any future change to the prompt moving that number in either
direction.

Worth noting where this came from: the cost guardrails reason carefully about an
unauthenticated public endpoint being abused for *volume*, and said nothing about
it being abused for *content*. The same endpoint, the same threat model, one half
considered.

### Cost guardrails

The endpoints are unauthenticated, as the assignment specifies. Input limits and
throttling are therefore what stand between a public URL and a surprise bill.

| Layer | Guardrail |
| --- | --- |
| Input | ≤20 documents/request, ≤50k chars/document, ≤1000 chars/question, `topK` clamped to 1–10 |
| Retrieval | An empty retrieval returns the refusal **without calling the LLM** |
| Prompt | Context capped at `MAX_CONTEXT_CHARS`, independent of `topK` |
| Generation | `max_completion_tokens` capped; `temperature: 0` |
| Network | Embeddings batched — one request per 96 chunks, not one per chunk |
| Infra | API Gateway rate and burst limits |
| Observability | Token usage from every provider response is logged as JSON |

### Async ingest

`INGEST_MODE=async` moves the expensive part off the request path:

```
POST /ingest ──▶ stage documents in S3 ──▶ batch-send pointers to SQS ──▶ 202
                                                  │
                                                  ▼
                                    worker Lambda: read S3 → chunk →
                                    embed → upsert (same pipeline)
```

**The document body goes to S3 and only a pointer travels through SQS.** SQS caps
a message at 256 KB while a document may be larger, so passing the text inline
would impose an arbitrary limit unrelated to the domain.

**The queue is FIFO, grouped by document id.** This is what makes concurrent
re-ingest safe — see [Those three steps are not atomic](#those-three-steps-are-not-atomic).
SQS delivers one message group to one consumer at a time, so two writes to the
same document serialise while different documents stay parallel. The
deduplication id is `jobId:docId`, so retrying a job inside the dedup window is
a no-op rather than a second ingest.

**The worker calls the same `ingestDocuments` the synchronous endpoint calls.**
No duplicated logic between the two paths.

**Staging and queueing are parallel and batched.** Twenty documents used to mean
forty sequential AWS round trips inside the 29-second API Gateway timeout that
async ingest exists to stay under; it is now parallel S3 puts plus two
`SendMessageBatch` calls.

**A partial failure names the documents in the error's `details`**, which do
reach the caller, so retrying the whole request is actionable rather than a
guess. This is worth spelling out because it was briefly untrue: the names were
put in `cause`, and the fix that stopped provider text reaching the body stopped
these reaching it too. Two correct changes that contradicted each other, and
nothing exercised the combined path.

**The deduplication id is derived from the document's content**, not from a
per-request job id. It used to be `${jobId}:${docId}` with a fresh job id per
request, so the client retry it claimed to make idempotent produced a new id
every time and deduplicated nothing — while three places in the code and the
README said otherwise. Hashing `id + title + content` makes the claim true: the
same document sent twice inside the dedup window is one ingest, an edited one is
a second.

**The worker has a reserved concurrency ceiling.** Throttling the API caps how
fast work is *accepted*, not how many workers run at once. Without a ceiling a
burst of queued documents fans out to as many concurrent Lambdas as the account
allows, each one calling the embedding provider. `INGEST_WORKER_CONCURRENCY`
sets that limit.

**Failures are reported per message** via `batchItemFailures`, so one poisoned
document does not force SQS to redeliver the whole batch and re-embed — and
re-pay for — documents that already succeeded. After three attempts a message
goes to the dead-letter queue, which is FIFO because its source queue is.

**Once a message fails, every later message of its group fails with it.** This
is the part that makes per-message reporting safe on a FIFO queue. Reporting
only the individually failed message would break the very ordering the queue
exists to provide: if v1 of a document fails transiently and v2 succeeds, SQS
redelivers v1 alone and it lands *after* v2, leaving the index on the older
version — silently, and by the same mechanism as the race the FIFO queue was
introduced to fix.

The queue's visibility timeout is six times the worker timeout, the ratio AWS
recommends, so a slow document is not redelivered while it is still being
processed.

### Logging

One JSON object per line, which is what CloudWatch Logs Insights can actually
query. Interpolated strings look fine in a terminal and are close to unusable at
scale.

---

## Assumptions

- **Documents are plain text.** File upload and extraction is listed as a bonus;
  this implementation does not do it.
- **A document id is caller-supplied and stable.** It is the unit of replacement,
  so ingesting the same id is understood as "replace this document".
- **Ids are restricted** to letters, digits and `. _ : -`. `#` is reserved as the
  chunk separator; allowing it would make vector ids ambiguous.
- **Single tenant.** There is no per-user isolation. `PINECONE_NAMESPACE` gives a
  partition per environment, not per user.
- **Duplicate ids within one request are rejected** rather than silently letting
  the last one win.
- **English-language documents.** Sentence splitting assumes `.`/`!`/`?`
  punctuation.

---

## Trade-offs and known limitations

**Concurrent writes to the same document id are only safe in async mode, and
`sync` is the default.** The full explanation is under
[Those three steps are not atomic](#those-three-steps-are-not-atomic). FIFO
grouping fixes the async path; the synchronous path would need a lock the vector
store does not offer. The default is the simpler mode rather than the safer one
because it is what the assignment's response shape describes — a deployment with
more than one writer should set `INGEST_MODE=async`, and that is a decision this
README makes the reader take deliberately rather than one it hides.

**Prompt injection is mitigated, not solved.** Three of ten poisoned cases
still get through. See [Prompt injection](#prompt-injection-mitigated-not-solved)
for the measurement and why the real fix is not a prompt.

**Secrets are Lambda environment variables.** They are visible in the console and
in the CloudFormation template. Production should use Secrets Manager or SSM
Parameter Store with rotation and a runtime fetch. For an exercise the assignment
describes as "not perfect prod infra, just coherent", the extra cold-start
complexity was not worth it — but it is the first infrastructure thing I would
change.

**CORS allows any origin, and neither endpoint is authenticated.** Both follow
the assignment, which specifies no auth. Throttling caps the cost of abuse; it
does nothing about who may write to the corpus, which is the root of the
injection exposure above.

**Chunking counts characters, not tokens.** A real tokenizer would be more
precise at the boundaries. It adds a dependency and meaningful complexity for an
accuracy gain that does not change behaviour at this scale.

**Synchronous ingest is bounded by API Gateway's 29-second integration timeout.**
That is exactly what the async mode is for; the synchronous path is the default
because it is simpler to demonstrate and because it matches the response shape
the assignment specifies.

**Retrieval is dense-only.** No hybrid search, no reranking, no query rewriting.
The assignment asks for a correct RAG flow, not a tuned one.

**`MIN_SCORE` defaults to 0, disabling the relevance floor.** A fixed cosine
threshold is a blunt instrument whose right value depends on the embedding model
and the corpus, and the prompt already instructs the model to refuse. It is
exposed as configuration rather than guessed at in code, and the evaluation
passes it through so a non-zero value is measured rather than assumed.

**There is no way to delete a document.** Re-ingesting with shorter content
shrinks it, but there is no `DELETE` endpoint.

**Async ingest returns a `jobId` that cannot be queried.** There is no status
endpoint, so a caller has no way to learn that a queued document failed. It also
means a partial enqueue failure is reported once, in the response, and not
afterwards.

**The evaluation suites are small.** Eighteen cases across two suites is enough to
have caught eight real defects, not enough to call the prompt validated. They cost
money to run, so they are a local command rather than part of `npm test`.

**Pinecone is eventually consistent, and by more than it looks.** A vector is
not queryable the instant an upsert returns. Measured on a fresh namespace,
writes were still not listable after 16 seconds — an earlier version of this
paragraph said "a second or two", which was a guess that held for a warm
namespace and not for a cold one. The evaluation now polls until every seeded
document is listable rather than sleeping for a fixed interval, because a fixed
sleep can run a whole suite against a half-populated index and report the result
as a measurement. A production system that ingests and immediately asks needs to
handle this explicitly; this one does not, and `/ask` right after `/ingest` can
legitimately return the refusal.

**Source maps ship with every function.** `NODE_OPTIONS=--enable-source-maps` is
set so stack traces are readable, which is worth the package size here; a
latency-sensitive deployment might prefer to drop both.

**Vitest is pinned to v3.** Vitest 4 does not install with the npm that ships
with Node 22 — its peer graph trips a resolver bug. `npm audit` reports a
moderate, dev-only advisory in `@vitest/mocker` as a result. A repo that installs
cleanly with the standard toolchain mattered more than an advisory in a test
dependency that never reaches Lambda.

---

## If I had more time

**Correctness**

1. **Serialise synchronous writes per document**, with a conditional write in
   DynamoDB keyed by document id, closing the last case the FIFO queue does not
   cover.
2. **Authenticate `/ingest`.** Almost everything in the injection section stops
   being interesting once arbitrary text cannot enter the corpus.
3. **Token-based chunking** with a real tokenizer, so chunk sizes and the context
   budget are expressed in the unit that actually costs money.
4. **Hybrid retrieval plus a reranker** — dense vectors miss exact-match queries
   like a policy number or an error code, which BM25 catches easily.
5. **Grow the evaluation suites**, particularly adversarially: questions
   answerable only by combining two passages, near-miss questions that *should*
   be refused, documents that contradict each other, and more injection styles.

**Operability**

6. **Secrets Manager** for the provider keys, with rotation.
7. **A job status endpoint** for async ingest, so a returned `jobId` is worth
   something to the caller.
8. **Metrics and alarms** — embedded metric format for token spend per request,
   an alarm on dead-letter queue depth, X-Ray tracing across the SQS hop.
9. **Idempotency keys on synchronous `/ingest`**, matching what the deduplication
   id already gives the async path.

**Product**

10. **Document management** — list what is indexed, and delete it.
11. **File upload with text extraction** (Textract or Tika), which is the listed
    bonus this implementation skipped.
12. **Streaming answers** over SSE. The answer is the slowest part of the
    request, and streaming changes the perceived latency far more than any
    backend optimisation would.
