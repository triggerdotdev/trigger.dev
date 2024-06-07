#!/usr/bin/env node

const filename = process.argv[2];

if (!filename) {
  console.error("Usage: analyze_marqs.mjs <filename>");
  process.exit(1);
}

import fs from "fs/promises";
import util from "util";

(async () => {
  try {
    const input = await fs.readFile(filename, "utf-8");

    await processInput(input);
  } catch (err) {
    console.error(`Error reading file: ${err}`);
    process.exit(1);
  }
})();

// input is jsonl format, we want to split by line and then JSON parse each line
async function processInput(input) {
  const rows = [];
  const lines = input.split("\n");
  for (const line of lines) {
    if (!line) {
      continue;
    }

    const row = JSON.parse(line);

    // process each row
    rows.push(row);
  }

  const queueChoiceCounts = {};
  const queueMaxAges = {};
  const queueMaxSizes = {};
  const nextRangeOffsetCounts = {};
  const consumerStats = {};
  const rowsByConsumer = {};

  console.log(`Processed ${rows.length} rows`);

  // console.log(util.inspect(rows[0], { depth: 20 }));

  for (const row of rows) {
    const queueChoice = row.queueChoice;

    if (queueChoice) {
      if (!queueChoiceCounts[queueChoice]) {
        queueChoiceCounts[queueChoice] = 0;
      }
      queueChoiceCounts[queueChoice]++;
    }
  }

  for (const row of rows) {
    rowsByConsumer[row.consumerId] = rowsByConsumer[row.consumerId] || [];
    rowsByConsumer[row.consumerId].push(row);

    const queueChoice = row.queueChoice;

    if (!consumerStats[row.consumerId]) {
      consumerStats[row.consumerId] = {
        queueChoiceCounts: {},
        totalQueueChoices: 0,
        noQueueChoiceCount: 0,
      };
    }

    if (queueChoice) {
      const queueData = row.queuesWithScores.find((queue) => queue.queue === queueChoice);

      console.log(
        `[${row.timestamp}] -> ${queueChoice} [age:${queueData.age}] [size:${queueData.size}] [nextRange.offset=${row.nextRange.offset}] [queuesWithScores=${row.queuesWithScores.length}] [${row.consumerId}]`
      );

      if (!queueMaxAges[queueChoice] || queueData.age > queueMaxAges[queueChoice]) {
        queueMaxAges[queueChoice] = queueData.age;
      }

      if (!queueMaxSizes[queueChoice] || queueData.size > queueMaxSizes[queueChoice]) {
        queueMaxSizes[queueChoice] = queueData.size;
      }

      if (!consumerStats[row.consumerId].queueChoiceCounts[queueChoice]) {
        consumerStats[row.consumerId].queueChoiceCounts[queueChoice] = 0;
      }

      consumerStats[row.consumerId].queueChoiceCounts[queueChoice]++;
      consumerStats[row.consumerId].totalQueueChoices++;
    } else {
      console.log(
        `[${row.timestamp}] -> No queue choice [nextRange.offset=${row.nextRange.offset}] [queuesWithScores=${row.queuesWithScores.length}] [${row.consumerId}]`
      );

      consumerStats[row.consumerId].noQueueChoiceCount++;
    }

    if (!nextRangeOffsetCounts[row.nextRange.offset]) {
      nextRangeOffsetCounts[row.nextRange.offset] = 0;
    }

    nextRangeOffsetCounts[row.nextRange.offset]++;
  }

  console.log("Queue choice counts:");
  console.log(queueChoiceCounts);

  console.log("Queue max ages:");
  console.log(queueMaxAges);

  console.log("Queue max sizes:");
  console.log(queueMaxSizes);

  console.log("Next range offset counts:");
  console.log(nextRangeOffsetCounts);

  for (const consumerId in consumerStats) {
    console.log(`Consumer ${consumerId}:`);
    console.log(consumerStats[consumerId]);
  }

  for (const consumerId in rowsByConsumer) {
    console.log(`\n## Consumer ${consumerId}:`);

    for (const row of rowsByConsumer[consumerId]) {
      const queueChoice = row.queueChoice;

      if (queueChoice) {
        const queueData = row.queuesWithScores.find((queue) => queue.queue === queueChoice);

        console.log(
          `[${row.timestamp}] -> ${queueChoice} [age:${queueData.age}] [size:${queueData.size}] [nextRange.offset=${row.nextRange.offset}] [queuesWithScores=${row.queuesWithScores.length}] [${row.consumerId}]`
        );
      } else {
        console.log(
          `[${row.timestamp}] -> No queue choice [nextRange.offset=${row.nextRange.offset}] [queuesWithScores=${row.queuesWithScores.length}] [${row.consumerId}]`
        );
      }
    }
  }
}
