import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CorsHttpMethod, HttpApi, HttpMethod, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export type IngestMode = 'sync' | 'async';

export interface DocQaStackProps extends StackProps {
  /** Secrets are passed in at synth time; see the README for the production trade-off. */
  pineconeApiKey: string;
  pineconeIndex: string;
  pineconeNamespace?: string;
  llmApiKey: string;
  llmBaseUrl?: string;
  embeddingModel: string;
  embeddingDimensions: string;
  completionModel: string;
  maxOutputTokens: string;
  maxContextChars: string;
  minScore: string;
  /** 'async' adds the S3 bucket, the queue and the worker Lambda. */
  ingestMode: IngestMode;
  /** Steady-state requests per second allowed through the API. */
  rateLimit: number;
  burstLimit: number;
  /**
   * Ceiling on concurrent ingest workers, and so on concurrent provider calls.
   *
   * Zero means no reservation. That is the default, and it is not laziness: a
   * fresh AWS account has a concurrent-execution limit of 10 rather than the
   * usual 1000, and AWS refuses any reservation that would leave fewer than 100
   * unreserved. A hardcoded reservation therefore makes this stack impossible
   * to deploy on a new account — which is where anyone evaluating it will try
   * first. On such an account the account limit is itself the ceiling; on a
   * mature one, set this.
   */
  workerConcurrency: number;
}

const API_SOURCE = path.join(__dirname, '..', '..', 'services', 'api');
const REPO_ROOT = path.join(__dirname, '..', '..');

export class DocQaStack extends Stack {
  constructor(scope: Construct, id: string, props: DocQaStackProps) {
    super(scope, id, props);

    const isAsync = props.ingestMode === 'async';

    // -----------------------------------------------------------------------
    // Async ingest transport: staged documents in S3, pointers in SQS.
    // Only created when async ingest is enabled, so the synchronous deployment
    // carries no unused resources.
    // -----------------------------------------------------------------------
    const ingestBucket = isAsync
      ? new Bucket(this, 'IngestBucket', {
          encryption: BucketEncryption.S3_MANAGED,
          blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          // Staged documents are a transport detail, not a system of record:
          // once a worker has indexed one, the copy in S3 has no further use.
          lifecycleRules: [{ expiration: Duration.days(7) }],
          // Take-home convenience so `cdk destroy` leaves nothing behind.
          removalPolicy: RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
        })
      : undefined;

    // FIFO, because the ingest pipeline is list -> upsert -> delete and those
    // three steps are not atomic. Two concurrent writes to the same document id
    // can interleave so that one deletes chunks the other just wrote, leaving a
    // version that was never submitted. Grouping messages by document id makes
    // SQS deliver one message group to one consumer at a time, which serialises
    // writes per document while leaving different documents fully parallel.
    // A FIFO queue's dead-letter queue must also be FIFO.
    const deadLetterQueue = isAsync
      ? new Queue(this, 'IngestDeadLetterQueue', {
          fifo: true,
          retentionPeriod: Duration.days(14),
        })
      : undefined;

    const ingestQueue =
      isAsync && deadLetterQueue !== undefined
        ? new Queue(this, 'IngestQueue', {
            fifo: true,
            // Deduplication ids are supplied explicitly, per job and document.
            contentBasedDeduplication: false,
            // Six times the worker timeout, the ratio AWS recommends so a slow
            // document is not redelivered while it is still being processed.
            visibilityTimeout: Duration.minutes(30),
            deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
          })
        : undefined;

    // -----------------------------------------------------------------------
    // Lambda functions
    // -----------------------------------------------------------------------
    const sharedEnvironment: Record<string, string> = {
      PINECONE_API_KEY: props.pineconeApiKey,
      PINECONE_INDEX: props.pineconeIndex,
      ...(props.pineconeNamespace === undefined
        ? {}
        : { PINECONE_NAMESPACE: props.pineconeNamespace }),
      LLM_API_KEY: props.llmApiKey,
      ...(props.llmBaseUrl === undefined ? {} : { LLM_BASE_URL: props.llmBaseUrl }),
      EMBEDDING_MODEL: props.embeddingModel,
      EMBEDDING_DIMENSIONS: props.embeddingDimensions,
      COMPLETION_MODEL: props.completionModel,
      MAX_OUTPUT_TOKENS: props.maxOutputTokens,
      MAX_CONTEXT_CHARS: props.maxContextChars,
      MIN_SCORE: props.minScore,
      // Keeps the SDK from re-resolving credentials on every warm invocation.
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      // Without this the bundled .map files are dead weight in every package:
      // the runtime ships them and never reads them, so stack traces stay
      // minified while the artefact carries megabytes of unused mapping.
      NODE_OPTIONS: '--enable-source-maps',
    };

    const createFunction = (
      id: string,
      entry: string,
      options: {
        timeout: Duration;
        memorySize: number;
        environment?: Record<string, string>;
        reservedConcurrentExecutions?: number;
      },
    ): NodejsFunction =>
      new NodejsFunction(this, id, {
        ...(options.reservedConcurrentExecutions === undefined
          ? {}
          : { reservedConcurrentExecutions: options.reservedConcurrentExecutions }),
        entry: path.join(API_SOURCE, entry),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        // Graviton: same code, lower price per millisecond.
        architecture: Architecture.ARM_64,
        timeout: options.timeout,
        memorySize: options.memorySize,
        environment: { ...sharedEnvironment, ...(options.environment ?? {}) },
        bundling: {
          format: OutputFormat.ESM,
          target: 'node22',
          minify: true,
          sourceMap: true,
          // ESM output needs these CommonJS globals shimmed for dependencies
          // that still reach for them.
          banner:
            "import{createRequire}from'module';const require=createRequire(import.meta.url);",
        },
        depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
        projectRoot: REPO_ROOT,
        logGroup: new LogGroup(this, `${id}Logs`, {
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

    const askFunction = createFunction('AskFunction', 'src/handlers/ask.ts', {
      // HTTP APIs cap integration latency at 30s; failing first is deliberate.
      timeout: Duration.seconds(29),
      memorySize: 512,
    });

    const ingestFunction = createFunction('IngestFunction', 'src/handlers/ingest.ts', {
      timeout: Duration.seconds(29),
      memorySize: 1024,
      environment: {
        INGEST_MODE: props.ingestMode,
        ...(ingestBucket === undefined ? {} : { INGEST_BUCKET: ingestBucket.bucketName }),
        ...(ingestQueue === undefined ? {} : { INGEST_QUEUE_URL: ingestQueue.queueUrl }),
      },
    });

    if (ingestBucket !== undefined && ingestQueue !== undefined) {
      const ingestWorker = createFunction('IngestWorkerFunction', 'src/handlers/ingestWorker.ts', {
        // Off the request path, so it can afford to embed a large document.
        timeout: Duration.minutes(5),
        memorySize: 1024,
        environment: { INGEST_MODE: 'sync' },
        // The throttle on the API caps how fast work is accepted, not how many
        // workers run at once. Without a reserved ceiling, a burst of queued
        // documents fans out to as many concurrent Lambdas as the account
        // allows, and every one of them calls the embedding provider.
        //
        // Zero disables the reservation; see the prop's documentation for why
        // that is the default.
        ...(props.workerConcurrency > 0
          ? { reservedConcurrentExecutions: props.workerConcurrency }
          : {}),
      });

      // Least privilege: the API may only stage and enqueue, the worker may
      // only read and consume. Neither can do the other's job.
      ingestBucket.grantPut(ingestFunction);
      ingestQueue.grantSendMessages(ingestFunction);
      ingestBucket.grantRead(ingestWorker);
      ingestQueue.grantConsumeMessages(ingestWorker);

      ingestWorker.addEventSource(
        new SqsEventSource(ingestQueue, {
          // FIFO allows at most 10 per batch.
          batchSize: 5,
          // Lets the worker fail one document without forcing SQS to redeliver
          // the whole batch and re-embed what already succeeded.
          reportBatchItemFailures: true,
        }),
      );

      new CfnOutput(this, 'IngestQueueUrl', { value: ingestQueue.queueUrl });
      new CfnOutput(this, 'IngestBucketName', { value: ingestBucket.bucketName });
    }

    // -----------------------------------------------------------------------
    // HTTP API
    // -----------------------------------------------------------------------
    const httpApi = new HttpApi(this, 'DocQaApi', {
      apiName: 'doc-qa-api',
      description: 'Doc Q&A ingest and ask endpoints',
      // The stage is created explicitly below so it can carry throttling.
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type'],
        maxAge: Duration.hours(1),
      },
    });

    httpApi.addRoutes({
      path: '/ingest',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('IngestIntegration', ingestFunction),
    });

    httpApi.addRoutes({
      path: '/ask',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('AskIntegration', askFunction),
    });

    // The endpoints are unauthenticated by design, and every call costs money
    // at the LLM provider. Throttling is the ceiling on that bill.
    const stage = new HttpStage(this, 'DefaultStage', {
      httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: props.rateLimit, burstLimit: props.burstLimit },
    });

    new CfnOutput(this, 'ApiUrl', {
      value: stage.url,
      description: 'Base URL for POST /ingest and POST /ask',
    });
  }
}
