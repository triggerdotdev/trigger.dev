import { PlayIcon } from "@heroicons/react/20/solid";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { QueryScope } from "~/services/queryService.server";

/** A code block with an integrated "Try it" button */
export function TryableCodeBlock({
  code,
  onTry,
  className,
}: {
  code: string;
  onTry?: () => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <CodeBlock
        code={code}
        language="sql"
        showLineNumbers={false}
        showOpenInModal={false}
        className={onTry ? "rounded-b-none border-b-0 text-xs" : "text-xs"}
      />
      {onTry && (
        <div className="flex justify-end rounded-b-md border border-grid-bright p-1">
          <Button variant="minimal/small" onClick={onTry} LeadingIcon={PlayIcon}>
            Try it
          </Button>
        </div>
      )}
    </div>
  );
}

type FunctionDoc = { name: string; desc: string; example: string };

function FunctionCategory({ title, functions }: { title: string; functions: FunctionDoc[] }) {
  return (
    <div>
      <Paragraph variant="small/bright" className="mb-1">
        {title}
      </Paragraph>
      <div className="flex flex-wrap gap-1">
        {functions.map((fn) => (
          <SimpleTooltip
            key={fn.name}
            button={
              <code className="cursor-help rounded bg-charcoal-750 px-1.5 py-0.5 font-mono text-xxs text-indigo-400 transition-colors hover:bg-charcoal-700 hover:text-indigo-300">
                {fn.name}
              </code>
            }
            content={
              <div className="max-w-xs space-y-1">
                <div className="text-text-bright">{fn.desc}</div>
                <code className="block rounded bg-charcoal-800 px-1.5 py-1 font-mono text-xxs text-indigo-300">
                  {fn.example}
                </code>
              </div>
            }
          />
        ))}
      </div>
    </div>
  );
}

export function TRQLGuideContent({
  onTryExample,
}: {
  onTryExample: (query: string, scope: QueryScope) => void;
}) {
  return (
    <div className="space-y-6">
      <Paragraph variant="small/bright">
        TRQL is a query language for the Trigger platform. It is based on ClickHouse SQL and extends
        it with additional features.
      </Paragraph>
      {/* Table of contents */}
      <nav className="space-y-1 text-sm">
        <a href="#basic" className="block text-text-link hover:underline">
          Basic queries
        </a>
        <a href="#filtering" className="block text-text-link hover:underline">
          Filtering with WHERE
        </a>
        <a href="#sorting" className="block text-text-link hover:underline">
          Sorting &amp; limiting
        </a>
        <a href="#grouping" className="block text-text-link hover:underline">
          Grouping &amp; aggregation
        </a>
        <a href="#functions" className="block text-text-link hover:underline">
          Available functions
        </a>
      </nav>

      {/* Basic queries */}
      <section id="basic">
        <Header3 className="mb-2 text-text-bright">Basic queries</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Select columns from a table. Use <code className="text-xs">*</code> to select all columns,
          or list specific columns.
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT run_id, task_identifier, status
FROM runs
LIMIT 10`}
          onTry={() =>
            onTryExample(
              `SELECT run_id, task_identifier, status
FROM runs
LIMIT 10`,
              "environment"
            )
          }
        />
        <Paragraph variant="small" className="mt-3 text-text-dimmed">
          Alias columns with <code className="text-xs">AS</code>:
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT task_identifier AS task, count() AS total
FROM runs
GROUP BY task`}
          onTry={() =>
            onTryExample(
              `SELECT task_identifier AS task, count() AS total
FROM runs
GROUP BY task`,
              "environment"
            )
          }
          className="mt-1"
        />
      </section>

      {/* Filtering */}
      <section id="filtering">
        <Header3 className="mb-2 text-text-bright">Filtering with WHERE</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Use comparison operators: <code className="text-xs">=</code>,{" "}
          <code className="text-xs">!=</code>, <code className="text-xs">&lt;</code>,{" "}
          <code className="text-xs">&gt;</code>, <code className="text-xs">&lt;=</code>,{" "}
          <code className="text-xs">&gt;=</code>
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT * FROM runs
WHERE status = 'Failed'
  AND created_at > now() - INTERVAL 1 DAY`}
          onTry={() =>
            onTryExample(
              `SELECT * FROM runs
WHERE status = 'Failed'
  AND created_at > now() - INTERVAL 1 DAY`,
              "environment"
            )
          }
        />
        <Paragraph variant="small" className="mt-3 text-text-dimmed">
          Other operators:
        </Paragraph>
        <TryableCodeBlock
          code={`-- IN for multiple values
WHERE status IN ('Failed', 'Crashed')

-- LIKE for pattern matching (% = wildcard)
WHERE task_identifier LIKE 'email%'

-- ILIKE for case-insensitive matching
WHERE task_identifier ILIKE '%send%'

-- BETWEEN for ranges
WHERE created_at BETWEEN '2024-01-01' AND '2024-01-31'

-- NULL checks
WHERE completed_at IS NOT NULL`}
          className="mt-1"
        />
      </section>

      {/* Sorting & limiting */}
      <section id="sorting">
        <Header3 className="mb-2 text-text-bright">Sorting &amp; limiting</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Sort results with <code className="text-xs">ORDER BY</code> (ASC/DESC). Limit results with{" "}
          <code className="text-xs">LIMIT</code>.
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT run_id, compute_cost, created_at
FROM runs
ORDER BY compute_cost DESC, created_at ASC
LIMIT 50`}
          onTry={() =>
            onTryExample(
              `SELECT run_id, compute_cost, created_at
FROM runs
ORDER BY compute_cost DESC, created_at ASC
LIMIT 50`,
              "environment"
            )
          }
        />
      </section>

      {/* Grouping */}
      <section id="grouping">
        <Header3 className="mb-2 text-text-bright">Grouping &amp; aggregation</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Use <code className="text-xs">GROUP BY</code> with aggregate functions. Filter groups with{" "}
          <code className="text-xs">HAVING</code>.
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT
  task_identifier,
  status,
  count() AS run_count,
  avg(usage_duration) AS avg_duration
FROM runs
GROUP BY task_identifier, status
HAVING run_count > 10
ORDER BY run_count DESC`}
          onTry={() =>
            onTryExample(
              `SELECT
  task_identifier,
  status,
  count() AS run_count,
  avg(usage_duration) AS avg_duration
FROM runs
GROUP BY task_identifier, status
HAVING run_count > 10
ORDER BY run_count DESC`,
              "environment"
            )
          }
        />
      </section>

      {/* Functions */}
      <section id="functions">
        <Header3 className="mb-2 text-text-bright">Available functions</Header3>
        <Paragraph variant="extra-small" className="mb-3 text-text-dimmed">
          Hover over any function to see its description and example usage.
        </Paragraph>

        <div className="space-y-4">
          {/* Aggregate functions */}
          <FunctionCategory
            title="Aggregate functions"
            functions={[
              { name: "count()", desc: "Count rows", example: "count()" },
              {
                name: "countIf(col, cond)",
                desc: "Count rows matching condition",
                example: "countIf(status, status = 'Failed')",
              },
              {
                name: "countDistinct(col)",
                desc: "Count unique values",
                example: "countDistinct(task_identifier)",
              },
              { name: "sum(col)", desc: "Sum of values", example: "sum(compute_cost)" },
              {
                name: "sumIf(col, cond)",
                desc: "Sum values matching condition",
                example: "sumIf(compute_cost, status = 'Completed')",
              },
              { name: "avg(col)", desc: "Average of values", example: "avg(usage_duration)" },
              { name: "min(col)", desc: "Minimum value", example: "min(created_at)" },
              { name: "max(col)", desc: "Maximum value", example: "max(compute_cost)" },
              {
                name: "uniq(col)",
                desc: "Approximate unique count (fast)",
                example: "uniq(task_identifier)",
              },
              { name: "uniqExact(col)", desc: "Exact unique count", example: "uniqExact(run_id)" },
              {
                name: "any(col)",
                desc: "Any arbitrary value from group",
                example: "any(task_identifier)",
              },
              {
                name: "anyLast(col)",
                desc: "Last value encountered in group",
                example: "anyLast(status)",
              },
              {
                name: "argMin(arg, val)",
                desc: "Value of arg at minimum val",
                example: "argMin(run_id, created_at)",
              },
              {
                name: "argMax(arg, val)",
                desc: "Value of arg at maximum val",
                example: "argMax(run_id, compute_cost)",
              },
              {
                name: "median(col)",
                desc: "Median value (50th percentile)",
                example: "median(usage_duration)",
              },
              {
                name: "quantile(p)(col)",
                desc: "Value at percentile p (0-1)",
                example: "quantile(0.95)(usage_duration)",
              },
              {
                name: "stddevPop(col)",
                desc: "Population standard deviation",
                example: "stddevPop(usage_duration)",
              },
              {
                name: "stddevSamp(col)",
                desc: "Sample standard deviation",
                example: "stddevSamp(usage_duration)",
              },
              {
                name: "groupArray(col)",
                desc: "Collect values into array",
                example: "groupArray(run_id)",
              },
              {
                name: "groupUniqArray(col)",
                desc: "Collect unique values into array",
                example: "groupUniqArray(status)",
              },
              {
                name: "topK(k)(col)",
                desc: "Top k most frequent values",
                example: "topK(5)(task_identifier)",
              },
            ]}
          />

          {/* String functions */}
          <FunctionCategory
            title="String functions"
            functions={[
              {
                name: "length(s)",
                desc: "Length of string in bytes",
                example: "length(task_identifier)",
              },
              {
                name: "lengthUTF8(s)",
                desc: "Length in UTF-8 characters",
                example: "lengthUTF8(task_identifier)",
              },
              { name: "empty(s)", desc: "Returns 1 if string is empty", example: "empty(error)" },
              {
                name: "notEmpty(s)",
                desc: "Returns 1 if string is not empty",
                example: "notEmpty(task_identifier)",
              },
              { name: "lower(s)", desc: "Convert to lowercase", example: "lower(status)" },
              { name: "upper(s)", desc: "Convert to uppercase", example: "upper(status)" },
              { name: "reverse(s)", desc: "Reverse string", example: "reverse(run_id)" },
              {
                name: "concat(s1, s2, ...)",
                desc: "Concatenate strings",
                example: "concat(task_identifier, '-', status)",
              },
              {
                name: "substring(s, offset, len)",
                desc: "Extract substring (1-indexed)",
                example: "substring(run_id, 1, 10)",
              },
              { name: "left(s, n)", desc: "First n characters", example: "left(run_id, 10)" },
              { name: "right(s, n)", desc: "Last n characters", example: "right(run_id, 8)" },
              {
                name: "trim(s)",
                desc: "Remove leading/trailing whitespace",
                example: "trim(task_identifier)",
              },
              {
                name: "trimLeft(s)",
                desc: "Remove leading whitespace",
                example: "trimLeft(task_identifier)",
              },
              {
                name: "trimRight(s)",
                desc: "Remove trailing whitespace",
                example: "trimRight(task_identifier)",
              },
              {
                name: "leftPad(s, len, char)",
                desc: "Pad string on left",
                example: "leftPad(toString(attempt), 3, '0')",
              },
              {
                name: "rightPad(s, len, char)",
                desc: "Pad string on right",
                example: "rightPad(status, 15, ' ')",
              },
              {
                name: "startsWith(s, prefix)",
                desc: "Check if starts with prefix",
                example: "startsWith(task_identifier, 'email')",
              },
              {
                name: "endsWith(s, suffix)",
                desc: "Check if ends with suffix",
                example: "endsWith(run_id, 'abc')",
              },
              {
                name: "position(haystack, needle)",
                desc: "Position of substring (0 if not found)",
                example: "position(task_identifier, 'send')",
              },
              {
                name: "replace(s, from, to)",
                desc: "Replace all occurrences",
                example: "replace(status, '_', '-')",
              },
              {
                name: "replaceOne(s, from, to)",
                desc: "Replace first occurrence",
                example: "replaceOne(task_identifier, '-', '_')",
              },
              {
                name: "replaceRegexpAll(s, pattern, repl)",
                desc: "Replace using regex",
                example: "replaceRegexpAll(run_id, '[0-9]', 'X')",
              },
              {
                name: "match(s, pattern)",
                desc: "Regex match (returns 0 or 1)",
                example: "match(task_identifier, '^email.*')",
              },
              {
                name: "extract(s, pattern)",
                desc: "Extract first regex match",
                example: "extract(task_identifier, '[a-z]+')",
              },
              {
                name: "extractAll(s, pattern)",
                desc: "Extract all regex matches as array",
                example: "extractAll(task_identifier, '[a-z]+')",
              },
              {
                name: "like(s, pattern)",
                desc: "SQL LIKE pattern match",
                example: "like(task_identifier, '%email%')",
              },
              {
                name: "ilike(s, pattern)",
                desc: "Case-insensitive LIKE",
                example: "ilike(task_identifier, '%EMAIL%')",
              },
              {
                name: "splitByChar(sep, s)",
                desc: "Split by character",
                example: "splitByChar('-', task_identifier)",
              },
              {
                name: "splitByString(sep, s)",
                desc: "Split by string",
                example: "splitByString('::', task_identifier)",
              },
              {
                name: "arrayStringConcat(arr, sep)",
                desc: "Join array to string",
                example: "arrayStringConcat(tags, ', ')",
              },
              {
                name: "base64Encode(s)",
                desc: "Encode to base64",
                example: "base64Encode(run_id)",
              },
              {
                name: "base64Decode(s)",
                desc: "Decode from base64",
                example: "base64Decode(encoded_value)",
              },
              { name: "repeat(s, n)", desc: "Repeat string n times", example: "repeat('-', 10)" },
              {
                name: "format(pattern, args...)",
                desc: "Format string with placeholders",
                example: "format('{} - {}', task_identifier, status)",
              },
            ]}
          />

          {/* Date/time functions */}
          <FunctionCategory
            title="Date/time functions"
            functions={[
              { name: "now()", desc: "Current date and time", example: "now()" },
              { name: "today()", desc: "Current date", example: "today()" },
              { name: "yesterday()", desc: "Yesterday's date", example: "yesterday()" },
              { name: "toYear(dt)", desc: "Extract year", example: "toYear(created_at)" },
              {
                name: "toQuarter(dt)",
                desc: "Extract quarter (1-4)",
                example: "toQuarter(created_at)",
              },
              { name: "toMonth(dt)", desc: "Extract month (1-12)", example: "toMonth(created_at)" },
              {
                name: "toDayOfMonth(dt)",
                desc: "Extract day of month (1-31)",
                example: "toDayOfMonth(created_at)",
              },
              {
                name: "toDayOfWeek(dt)",
                desc: "Day of week (1=Monday, 7=Sunday)",
                example: "toDayOfWeek(created_at)",
              },
              { name: "toHour(dt)", desc: "Extract hour (0-23)", example: "toHour(created_at)" },
              {
                name: "toMinute(dt)",
                desc: "Extract minute (0-59)",
                example: "toMinute(created_at)",
              },
              {
                name: "toSecond(dt)",
                desc: "Extract second (0-59)",
                example: "toSecond(created_at)",
              },
              {
                name: "toDate(dt)",
                desc: "Convert to date (strip time)",
                example: "toDate(created_at)",
              },
              {
                name: "toDateTime(x)",
                desc: "Convert to datetime",
                example: "toDateTime('2024-01-15 10:30:00')",
              },
              {
                name: "toStartOfYear(dt)",
                desc: "First day of year",
                example: "toStartOfYear(created_at)",
              },
              {
                name: "toStartOfQuarter(dt)",
                desc: "First day of quarter",
                example: "toStartOfQuarter(created_at)",
              },
              {
                name: "toStartOfMonth(dt)",
                desc: "First day of month",
                example: "toStartOfMonth(created_at)",
              },
              {
                name: "toStartOfWeek(dt)",
                desc: "Start of week (Monday)",
                example: "toStartOfWeek(created_at)",
              },
              { name: "toMonday(dt)", desc: "Monday of the week", example: "toMonday(created_at)" },
              {
                name: "toStartOfDay(dt)",
                desc: "Start of day (midnight)",
                example: "toStartOfDay(created_at)",
              },
              {
                name: "toStartOfHour(dt)",
                desc: "Start of hour",
                example: "toStartOfHour(created_at)",
              },
              {
                name: "toStartOfMinute(dt)",
                desc: "Start of minute",
                example: "toStartOfMinute(created_at)",
              },
              {
                name: "toStartOfFiveMinutes(dt)",
                desc: "Round to 5-minute interval",
                example: "toStartOfFiveMinutes(created_at)",
              },
              {
                name: "toStartOfFifteenMinutes(dt)",
                desc: "Round to 15-minute interval",
                example: "toStartOfFifteenMinutes(created_at)",
              },
              {
                name: "toStartOfInterval(dt, INTERVAL n unit)",
                desc: "Round to custom interval",
                example: "toStartOfInterval(created_at, INTERVAL 30 MINUTE)",
              },
              {
                name: "toUnixTimestamp(dt)",
                desc: "Convert to Unix timestamp",
                example: "toUnixTimestamp(created_at)",
              },
              {
                name: "dateDiff(unit, start, end)",
                desc: "Difference between dates",
                example: "dateDiff('minute', started_at, completed_at)",
              },
              {
                name: "dateAdd(unit, n, dt)",
                desc: "Add time to date",
                example: "dateAdd('day', 7, created_at)",
              },
              {
                name: "dateSub(unit, n, dt)",
                desc: "Subtract time from date",
                example: "dateSub('hour', 1, created_at)",
              },
              {
                name: "dateTrunc(unit, dt)",
                desc: "Truncate to unit",
                example: "dateTrunc('month', created_at)",
              },
              { name: "addDays(dt, n)", desc: "Add n days", example: "addDays(created_at, 7)" },
              { name: "addHours(dt, n)", desc: "Add n hours", example: "addHours(created_at, 24)" },
              {
                name: "addMinutes(dt, n)",
                desc: "Add n minutes",
                example: "addMinutes(created_at, 30)",
              },
              {
                name: "subtractDays(dt, n)",
                desc: "Subtract n days",
                example: "subtractDays(now(), 7)",
              },
              {
                name: "subtractHours(dt, n)",
                desc: "Subtract n hours",
                example: "subtractHours(now(), 1)",
              },
              {
                name: "formatDateTime(dt, format)",
                desc: "Format datetime as string",
                example: "formatDateTime(created_at, '%Y-%m-%d %H:%M')",
              },
              {
                name: "parseDateTimeBestEffort(s)",
                desc: "Parse string to datetime",
                example: "parseDateTimeBestEffort('2024-01-15')",
              },
              {
                name: "toTimeZone(dt, tz)",
                desc: "Convert to timezone",
                example: "toTimeZone(created_at, 'America/New_York')",
              },
            ]}
          />

          {/* Conditional & null functions */}
          <FunctionCategory
            title="Conditional & null functions"
            functions={[
              {
                name: "if(cond, then, else)",
                desc: "Conditional expression",
                example: "if(status = 'Failed', 1, 0)",
              },
              {
                name: "multiIf(c1, t1, c2, t2, ..., else)",
                desc: "Multiple conditions (like CASE)",
                example: "multiIf(status = 'Completed', 'ok', status = 'Failed', 'bad', 'other')",
              },
              {
                name: "coalesce(a, b, ...)",
                desc: "First non-null value",
                example: "coalesce(completed_at, created_at)",
              },
              {
                name: "ifNull(x, alt)",
                desc: "Return alt if x is null",
                example: "ifNull(completed_at, now())",
              },
              {
                name: "nullIf(x, y)",
                desc: "Return null if x equals y",
                example: "nullIf(status, 'Pending')",
              },
              {
                name: "isNull(x)",
                desc: "Check if value is null",
                example: "isNull(completed_at)",
              },
              {
                name: "isNotNull(x)",
                desc: "Check if value is not null",
                example: "isNotNull(completed_at)",
              },
              {
                name: "assumeNotNull(x)",
                desc: "Treat nullable as non-null",
                example: "assumeNotNull(completed_at)",
              },
            ]}
          />

          {/* Arithmetic & math */}
          <FunctionCategory
            title="Arithmetic & math functions"
            functions={[
              {
                name: "plus(a, b)",
                desc: "Addition (a + b)",
                example: "plus(compute_cost, invocation_cost)",
              },
              {
                name: "minus(a, b)",
                desc: "Subtraction (a - b)",
                example: "minus(completed_at, started_at)",
              },
              {
                name: "multiply(a, b)",
                desc: "Multiplication (a * b)",
                example: "multiply(usage_duration, 2)",
              },
              {
                name: "divide(a, b)",
                desc: "Division (a / b)",
                example: "divide(compute_cost, usage_duration)",
              },
              {
                name: "intDiv(a, b)",
                desc: "Integer division",
                example: "intDiv(usage_duration, 1000)",
              },
              { name: "modulo(a, b)", desc: "Modulo (a % b)", example: "modulo(attempt, 2)" },
              { name: "abs(x)", desc: "Absolute value", example: "abs(compute_cost)" },
              { name: "sign(x)", desc: "Sign (-1, 0, or 1)", example: "sign(compute_cost)" },
              { name: "sqrt(x)", desc: "Square root", example: "sqrt(usage_duration)" },
              { name: "pow(x, y)", desc: "Power (x^y)", example: "pow(2, attempt)" },
              {
                name: "round(x, n)",
                desc: "Round to n decimal places",
                example: "round(compute_cost, 4)",
              },
              { name: "floor(x)", desc: "Round down", example: "floor(compute_cost * 100)" },
              { name: "ceil(x)", desc: "Round up", example: "ceil(compute_cost * 100)" },
              { name: "trunc(x)", desc: "Truncate towards zero", example: "trunc(compute_cost)" },
              { name: "exp(x)", desc: "Exponential (e^x)", example: "exp(1)" },
              { name: "log(x)", desc: "Natural logarithm", example: "log(usage_duration)" },
              { name: "log10(x)", desc: "Base-10 logarithm", example: "log10(usage_duration)" },
              {
                name: "least(a, b)",
                desc: "Minimum of two values",
                example: "least(usage_duration, 10000)",
              },
              {
                name: "greatest(a, b)",
                desc: "Maximum of two values",
                example: "greatest(usage_duration, 0)",
              },
            ]}
          />

          {/* Array functions */}
          <FunctionCategory
            title="Array functions"
            functions={[
              {
                name: "array(a, b, ...)",
                desc: "Create array from values",
                example: "array('a', 'b', 'c')",
              },
              {
                name: "range(start, end)",
                desc: "Generate array of numbers",
                example: "range(1, 10)",
              },
              { name: "length(arr)", desc: "Number of elements", example: "length(tags)" },
              { name: "empty(arr)", desc: "Check if array is empty", example: "empty(tags)" },
              {
                name: "has(arr, elem)",
                desc: "Check if array contains element",
                example: "has(tags, 'important')",
              },
              {
                name: "hasAll(arr1, arr2)",
                desc: "Check if arr1 contains all of arr2",
                example: "hasAll(tags, array('a', 'b'))",
              },
              {
                name: "hasAny(arr1, arr2)",
                desc: "Check if arr1 contains any of arr2",
                example: "hasAny(tags, array('urgent', 'high'))",
              },
              {
                name: "indexOf(arr, elem)",
                desc: "Index of element (1-based, 0 if not found)",
                example: "indexOf(tags, 'important')",
              },
              {
                name: "arrayElement(arr, n)",
                desc: "Get nth element (1-based)",
                example: "arrayElement(tags, 1)",
              },
              { name: "arrayJoin(arr)", desc: "Expand array to rows", example: "arrayJoin(tags)" },
              {
                name: "arraySlice(arr, offset, length)",
                desc: "Get slice of array",
                example: "arraySlice(tags, 1, 3)",
              },
              {
                name: "arrayPushBack(arr, elem)",
                desc: "Append element to array",
                example: "arrayPushBack(tags, 'new')",
              },
              {
                name: "arrayPushFront(arr, elem)",
                desc: "Prepend element to array",
                example: "arrayPushFront(tags, 'first')",
              },
              { name: "arraySort(arr)", desc: "Sort array ascending", example: "arraySort(tags)" },
              {
                name: "arrayReverseSort(arr)",
                desc: "Sort array descending",
                example: "arrayReverseSort(tags)",
              },
              {
                name: "arrayReverse(arr)",
                desc: "Reverse array order",
                example: "arrayReverse(tags)",
              },
              { name: "arrayUniq(arr)", desc: "Remove duplicates", example: "arrayUniq(tags)" },
              {
                name: "arrayDistinct(arr)",
                desc: "Remove duplicates (preserves order)",
                example: "arrayDistinct(tags)",
              },
              {
                name: "arrayFlatten(arr)",
                desc: "Flatten nested arrays",
                example: "arrayFlatten([[1,2], [3,4]])",
              },
              {
                name: "arrayFilter(func, arr)",
                desc: "Filter array by condition",
                example: "arrayFilter(x -> x > 0, arr)",
              },
              {
                name: "arrayMap(func, arr)",
                desc: "Transform each element",
                example: "arrayMap(x -> x * 2, arr)",
              },
              {
                name: "arrayMin(arr)",
                desc: "Minimum element",
                example: "arrayMin(array(1, 2, 3))",
              },
              {
                name: "arrayMax(arr)",
                desc: "Maximum element",
                example: "arrayMax(array(1, 2, 3))",
              },
              {
                name: "arraySum(arr)",
                desc: "Sum of elements",
                example: "arraySum(array(1, 2, 3))",
              },
              {
                name: "arrayAvg(arr)",
                desc: "Average of elements",
                example: "arrayAvg(array(1, 2, 3))",
              },
            ]}
          />

          {/* JSON functions */}
          <FunctionCategory
            title="JSON functions"
            functions={[
              {
                name: "JSONHas(json, key)",
                desc: "Check if key exists",
                example: "JSONHas(output, 'result')",
              },
              {
                name: "JSONLength(json)",
                desc: "Number of elements/keys",
                example: "JSONLength(output)",
              },
              {
                name: "JSONType(json, key)",
                desc: "Type of JSON value",
                example: "JSONType(output, 'data')",
              },
              {
                name: "JSONExtractString(json, key)",
                desc: "Extract as string",
                example: "JSONExtractString(output, 'message')",
              },
              {
                name: "JSONExtractInt(json, key)",
                desc: "Extract as integer",
                example: "JSONExtractInt(output, 'count')",
              },
              {
                name: "JSONExtractFloat(json, key)",
                desc: "Extract as float",
                example: "JSONExtractFloat(output, 'score')",
              },
              {
                name: "JSONExtractBool(json, key)",
                desc: "Extract as boolean",
                example: "JSONExtractBool(output, 'success')",
              },
              {
                name: "JSONExtractRaw(json, key)",
                desc: "Extract as raw JSON string",
                example: "JSONExtractRaw(output, 'data')",
              },
              {
                name: "JSONExtractArrayRaw(json, key)",
                desc: "Extract array as strings",
                example: "JSONExtractArrayRaw(output, 'items')",
              },
              {
                name: "JSONExtractKeys(json)",
                desc: "Get all keys as array",
                example: "JSONExtractKeys(output)",
              },
              {
                name: "toJSONString(value)",
                desc: "Convert to JSON string",
                example: "toJSONString(map('a', 1))",
              },
            ]}
          />

          {/* Type conversion */}
          <FunctionCategory
            title="Type conversion functions"
            functions={[
              { name: "toString(x)", desc: "Convert to string", example: "toString(attempt)" },
              { name: "toInt32(x)", desc: "Convert to 32-bit integer", example: "toInt32('123')" },
              {
                name: "toInt64(x)",
                desc: "Convert to 64-bit integer",
                example: "toInt64(usage_duration)",
              },
              {
                name: "toFloat64(x)",
                desc: "Convert to 64-bit float",
                example: "toFloat64('3.14')",
              },
              {
                name: "toDecimal64(x, scale)",
                desc: "Convert to decimal",
                example: "toDecimal64(compute_cost, 6)",
              },
              { name: "toDate(x)", desc: "Convert to date", example: "toDate('2024-01-15')" },
              {
                name: "toDateOrNull(x)",
                desc: "Convert to date (null on error)",
                example: "toDateOrNull(some_string)",
              },
              {
                name: "toDateTime(x)",
                desc: "Convert to datetime",
                example: "toDateTime('2024-01-15 10:30:00')",
              },
              {
                name: "toDateTimeOrNull(x)",
                desc: "Convert to datetime (null on error)",
                example: "toDateTimeOrNull(some_string)",
              },
              { name: "toUUID(x)", desc: "Convert to UUID", example: "toUUID(uuid_string)" },
              {
                name: "toTypeName(x)",
                desc: "Get type name as string",
                example: "toTypeName(created_at)",
              },
            ]}
          />

          {/* Comparison & logical */}
          <FunctionCategory
            title="Comparison & logical functions"
            functions={[
              {
                name: "equals(a, b)",
                desc: "Equal (a = b)",
                example: "equals(status, 'Completed')",
              },
              {
                name: "notEquals(a, b)",
                desc: "Not equal (a != b)",
                example: "notEquals(status, 'Failed')",
              },
              { name: "less(a, b)", desc: "Less than (a < b)", example: "less(attempt, 3)" },
              {
                name: "greater(a, b)",
                desc: "Greater than (a > b)",
                example: "greater(usage_duration, 1000)",
              },
              {
                name: "lessOrEquals(a, b)",
                desc: "Less than or equal (a <= b)",
                example: "lessOrEquals(attempt, 5)",
              },
              {
                name: "greaterOrEquals(a, b)",
                desc: "Greater than or equal (a >= b)",
                example: "greaterOrEquals(usage_duration, 0)",
              },
              {
                name: "and(a, b, ...)",
                desc: "Logical AND",
                example: "and(status = 'Failed', attempt > 1)",
              },
              {
                name: "or(a, b, ...)",
                desc: "Logical OR",
                example: "or(status = 'Failed', status = 'Crashed')",
              },
              { name: "not(x)", desc: "Logical NOT", example: "not(is_test)" },
              {
                name: "in(x, set)",
                desc: "Check if x is in set",
                example: "in(status, ('Failed', 'Crashed'))",
              },
            ]}
          />

          {/* Hash functions */}
          <FunctionCategory
            title="Hash functions"
            functions={[
              { name: "MD5(s)", desc: "MD5 hash (16 bytes)", example: "hex(MD5(run_id))" },
              {
                name: "SHA256(s)",
                desc: "SHA-256 hash (32 bytes)",
                example: "hex(SHA256(run_id))",
              },
              {
                name: "sipHash64(s)",
                desc: "Fast 64-bit hash",
                example: "sipHash64(task_identifier)",
              },
              { name: "cityHash64(s)", desc: "CityHash 64-bit", example: "cityHash64(run_id)" },
              { name: "xxHash64(s)", desc: "xxHash 64-bit", example: "xxHash64(task_identifier)" },
              { name: "hex(s)", desc: "Convert to hex string", example: "hex(MD5(run_id))" },
              { name: "unhex(s)", desc: "Convert from hex string", example: "unhex('48656C6C6F')" },
            ]}
          />

          {/* UUID & utility */}
          <FunctionCategory
            title="UUID & utility functions"
            functions={[
              {
                name: "generateUUIDv4()",
                desc: "Generate random UUID",
                example: "generateUUIDv4()",
              },
              {
                name: "isFinite(x)",
                desc: "Check if number is finite",
                example: "isFinite(compute_cost)",
              },
              { name: "isNaN(x)", desc: "Check if value is NaN", example: "isNaN(compute_cost)" },
              {
                name: "formatReadableSize(bytes)",
                desc: "Format bytes as human-readable",
                example: "formatReadableSize(1024)",
              },
              {
                name: "formatReadableQuantity(n)",
                desc: "Format number with suffixes (K, M, etc)",
                example: "formatReadableQuantity(1500000)",
              },
              {
                name: "formatReadableTimeDelta(seconds)",
                desc: "Format seconds as duration",
                example: "formatReadableTimeDelta(3661)",
              },
              {
                name: "runningDifference(col)",
                desc: "Difference from previous row",
                example: "runningDifference(usage_duration)",
              },
              {
                name: "neighbor(col, offset)",
                desc: "Value from row at offset",
                example: "neighbor(created_at, -1)",
              },
            ]}
          />

          {/* Tuple & map functions */}
          <FunctionCategory
            title="Tuple & map functions"
            functions={[
              {
                name: "tuple(a, b, ...)",
                desc: "Create tuple",
                example: "tuple(task_identifier, status)",
              },
              {
                name: "tupleElement(tuple, n)",
                desc: "Get nth element (1-based)",
                example: "tupleElement(t, 1)",
              },
              {
                name: "map(k1, v1, k2, v2, ...)",
                desc: "Create map from key-value pairs",
                example: "map('a', 1, 'b', 2)",
              },
              {
                name: "mapFromArrays(keys, values)",
                desc: "Create map from two arrays",
                example: "mapFromArrays(['a', 'b'], [1, 2])",
              },
              {
                name: "mapContains(map, key)",
                desc: "Check if map has key",
                example: "mapContains(m, 'key')",
              },
              { name: "mapKeys(map)", desc: "Get all keys as array", example: "mapKeys(m)" },
              { name: "mapValues(map)", desc: "Get all values as array", example: "mapValues(m)" },
            ]}
          />

          {/* Window functions */}
          <FunctionCategory
            title="Window functions"
            functions={[
              {
                name: "row_number()",
                desc: "Row number within partition",
                example: "row_number() OVER (ORDER BY created_at)",
              },
              {
                name: "rank()",
                desc: "Rank with gaps for ties",
                example: "rank() OVER (ORDER BY compute_cost DESC)",
              },
              {
                name: "dense_rank()",
                desc: "Rank without gaps",
                example: "dense_rank() OVER (ORDER BY compute_cost DESC)",
              },
              {
                name: "first_value(col)",
                desc: "First value in window",
                example: "first_value(status) OVER (PARTITION BY task_identifier)",
              },
              {
                name: "last_value(col)",
                desc: "Last value in window",
                example: "last_value(status) OVER (PARTITION BY task_identifier)",
              },
              {
                name: "lag(col, offset, default)",
                desc: "Value from previous row",
                example: "lag(created_at, 1) OVER (ORDER BY created_at)",
              },
              {
                name: "lead(col, offset, default)",
                desc: "Value from next row",
                example: "lead(created_at, 1) OVER (ORDER BY created_at)",
              },
            ]}
          />

          {/* Interval functions */}
          <FunctionCategory
            title="Interval functions"
            functions={[
              {
                name: "toIntervalSecond(n)",
                desc: "Create n-second interval",
                example: "toIntervalSecond(30)",
              },
              {
                name: "toIntervalMinute(n)",
                desc: "Create n-minute interval",
                example: "toIntervalMinute(5)",
              },
              {
                name: "toIntervalHour(n)",
                desc: "Create n-hour interval",
                example: "toIntervalHour(1)",
              },
              {
                name: "toIntervalDay(n)",
                desc: "Create n-day interval",
                example: "toIntervalDay(7)",
              },
              {
                name: "toIntervalWeek(n)",
                desc: "Create n-week interval",
                example: "toIntervalWeek(2)",
              },
              {
                name: "toIntervalMonth(n)",
                desc: "Create n-month interval",
                example: "toIntervalMonth(1)",
              },
              {
                name: "toIntervalYear(n)",
                desc: "Create n-year interval",
                example: "toIntervalYear(1)",
              },
            ]}
          />
        </div>
      </section>
    </div>
  );
}

