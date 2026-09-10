export interface Explainer {
  title: string
  copy: string
  source: string
}

export const explainers: Explainer[] = [
  {
    title: 'Execution environment',
    copy: 'An execution environment is an isolated place where Lambda runs one invocation at a time. More simultaneous work requires more environments.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html',
  },
  {
    title: 'Cold start versus warm reuse',
    copy: 'A new on-demand environment completes Init before the handler runs. A warm idle environment can accept another request without Init.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html',
  },
  {
    title: 'Concurrency versus requests per second',
    copy: 'RPS describes how often requests arrive. Concurrency describes how many accepted requests are still in flight.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html',
  },
  {
    title: 'Account concurrency quota',
    copy: 'The account quota limits concurrent executions in a Region. The 1,000 value here is an adjustable example default, not a universal starting quota.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html',
  },
  {
    title: 'Concurrency scaling rate',
    copy: 'Lambda documents how fast each function can add environments or request-rate capacity. This simulation illustrates continuous best-effort refill with a deterministic token bucket.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/burst-concurrency.html',
  },
  {
    title: 'Throttling and 429',
    copy: 'A request that cannot be admitted receives 429 TooManyRequestsException. It never enters Init or Invoke and does not count as an invocation error.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html',
  },
  {
    title: 'Reserved concurrency',
    copy: 'Reserved concurrency protects capacity for a function and also caps that function. In this one-function model, the ceiling is the visible part.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html',
  },
  {
    title: 'Provisioned concurrency',
    copy: 'Provisioned concurrency prepares environments for a published version or alias before requests arrive. It is allocated and billed even while idle.',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html',
  },
]

export const assumptions = [
  'One Lambda function in one AWS Region',
  'Synchronous invocation only',
  'Constant handler duration',
  'No retries, client retries, or invocation failures',
  'No asynchronous queues or event source mappings',
  'No SnapStart or extensions',
  'No other functions using the account quota',
  'Illustrative Init and idle-retirement durations',
  'RPS limits applied smoothly per 50 ms step; AWS does not publish its sub-second admission algorithm',
  'Provisioned allocation reserves its requested quota throughout PREPARING in this model',
  'No provisioned environment recycling or reset-related cold starts',
]
