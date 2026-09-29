# Doc Q&A Portal

Upload plain-text documents, ask questions in natural language, and get answers
grounded in those documents with the sources they came from.

Next.js + TypeScript on the front, API Gateway and Lambda on the back, Pinecone
as the vector store, OpenAI for embeddings and completions. The retrieval
pipeline is written by hand — no LangChain, no LlamaIndex.

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
  test                  unit tests (79)
infra                   AWS CDK stack
apps/web                Next.js app
```

The split between `core` and `adapters` is the main structural decision, and
the rest of the design follows from it. `core` contains the pipeline and depends
only on three interfaces — `EmbeddingProvider`, `CompletionProvider`,
`VectorStore`. It imports no vendor SDK and knows nothing about AWS. `adapters`
implements those interfaces against real services.

That boundary buys three concrete things:

1. **The pipeline is testable without a network or an API key.** All 72 tests run
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

In the Pinecone console, create an index with:

| Setting | Value |
| --- | --- |
| Name | `doc-qa` |
| Dimensions | **1536** |
| Metric | **cosine** |
| Type | **Serverless** (AWS, `us-east-1`) |

The dimension is not arbitrary: it is the width of a `text-embedding-3-small`
vector. A mismatch fails fast with an explicit error rather than writing bad
vectors — there is a test covering that case.

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
| `COMPLETION_MODEL` | no | `gpt-4o-mini` | Answering model |
| `MAX_OUTPUT_TOKENS` | no | `500` | Ceiling on generated tokens |
| `MAX_CONTEXT_CHARS` | no | `8000` | Ceiling on retrieved context sent to the LLM |
| `MIN_SCORE` | no | `0` | Cosine floor for a chunk to be used; `0` disables |
| `INGEST_MODE` | no | `sync` | `sync` or `async` |
| `INGEST_BUCKET` | async only | — | Set automatically by CDK |
| `INGEST_QUEUE_URL` | async only | — | Set automatically by CDK |
| `API_RATE_LIMIT` | no | `10` | API Gateway steady-state requests/second |
| `API_BURST_LIMIT` | no | `20` | API Gateway burst ceiling |
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

An unexpected error always returns a generic message. Provider payloads and
stack traces go to the log, never to the response body — there is a test
asserting an API key in an error message cannot leak to the caller.

---

## Tests

```bash
npm test
```

79 unit tests, all against in-memory doubles, so they need no credentials and
cost nothing to run. They cover:

- **chunking** — determinism, the overlap invariant across every consecutive
  pair, sentence-boundary splitting, hard-splitting a sentence longer than a
  chunk, and the overlap cap that guarantees forward progress
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

---

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

Two details that matter more than they look:

- **The overlap is capped at half a chunk.** Beyond that, each chunk would be
  mostly repeated text and the splitter would stop making forward progress. The
  cap is enforced in code and covered by a test.
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

### Grounding and sources

The system prompt restricts the model to the supplied passages and gives it an
exact refusal string for when they do not contain the answer.

Two consequences are enforced in code rather than hoped for:

- **Sources come from the passages that fit the context budget**, not from
  everything retrieved. The API cannot cite a document the model never saw.
- **A refusal cites nothing.** If the model returns the refusal string, sources
  are emptied — listing documents behind "I don't know" would imply they were
  relevant when the model just said they were not.

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
POST /ingest ──▶ write document to S3 ──▶ publish pointer to SQS ──▶ 202 Accepted
                                                  │
                                                  ▼
                                    worker Lambda: read S3 → chunk →
                                    embed → upsert (same pipeline)
```

**The document body goes to S3 and only a pointer travels through SQS.** SQS caps
a message at 256 KB while a document may be larger, so passing the text inline
would impose an arbitrary limit unrelated to the domain.

**The worker calls the same `ingestDocuments` the synchronous endpoint calls.**
No duplicated logic between the two paths.

**Failures are reported per message** via `batchItemFailures`, so one poisoned
document does not force SQS to redeliver the whole batch and re-embed — and
re-pay for — documents that already succeeded. After three attempts a message
goes to the dead-letter queue.

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

**Secrets are Lambda environment variables.** They are visible in the console and
in the CloudFormation template. Production should use Secrets Manager or SSM
Parameter Store with rotation and a runtime fetch. For an exercise the assignment
describes as "not perfect prod infra, just coherent", the extra cold-start
complexity was not worth it — but it is the first thing I would change.

**CORS allows any origin.** Correct for an exercise with no auth and no fixed
frontend domain; it should be the actual origin in production.

**Chunking counts characters, not tokens.** A real tokenizer would be more
precise at the boundaries. It adds a dependency and meaningful complexity for an
accuracy gain that does not change behaviour at this scale.

**Synchronous ingest is bounded by API Gateway's 29-second integration timeout.**
That is exactly what the async mode is for; the synchronous path is the default
because it is simpler to demonstrate.

**Retrieval is dense-only.** No hybrid search, no reranking, no query rewriting.
The assignment asks for a correct RAG flow, not a tuned one.

**`MIN_SCORE` defaults to 0, disabling the relevance floor.** A fixed cosine
threshold is a blunt instrument whose right value depends on the embedding model
and the corpus, and the prompt already instructs the model to refuse. It is
exposed as configuration rather than guessed at in code.

**There is no way to delete a document.** Re-ingesting with shorter content
shrinks it, but there is no `DELETE` endpoint.

**Async ingest returns a `jobId` that cannot be queried.** There is no status
endpoint, so a caller has no way to learn that a queued document failed.

**No integration tests against real Pinecone and OpenAI.** They would need
credentials and cost money per run. The ports make the seam obvious, so they are
straightforward to add behind an environment flag.

**Vitest is pinned to v3.** Vitest 4 does not install with the npm that ships
with Node 22 — its peer graph trips a resolver bug. `npm audit` reports a
moderate, dev-only advisory in `@vitest/mocker` as a result. A repo that installs
cleanly with the standard toolchain mattered more than an advisory in a test
dependency that never reaches Lambda.

---

## If I had more time

**Correctness and retrieval quality**

1. **Token-based chunking** with a real tokenizer, so chunk sizes and the context
   budget are expressed in the unit that actually costs money.
2. **Hybrid retrieval plus a reranker** — dense vectors miss exact-match queries
   like a policy number or an error code, which BM25 catches easily.
3. **Answer-level evaluation.** A small fixed set of question/expected-source
   pairs, run in CI, would turn "the answer looked right" into a regression test.

**Operability**

4. **Secrets Manager** for the provider keys, with rotation.
5. **A job status endpoint** for async ingest, so a returned `jobId` is worth
   something to the caller.
6. **Metrics and alarms** — embedded metric format for token spend per request,
   an alarm on dead-letter queue depth, X-Ray tracing across the SQS hop.
7. **Idempotency keys on `/ingest`**, so a client retry after a timeout does not
   re-embed and re-pay for work that already succeeded.

**Product**

8. **Document management** — list what is indexed, and delete it.
9. **File upload with text extraction** (Textract or Tika), which is the listed
   bonus this implementation skipped.
10. **Streaming answers** over SSE. The answer is the slowest part of the
    request, and streaming changes the perceived latency far more than any
    backend optimisation would.
